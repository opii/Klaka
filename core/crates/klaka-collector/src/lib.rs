//! Prijem događaja (`spec/events.md`): `POST /v1/events` iz browsera, `POST /v1/ingest` sa
//! backenda portala. Upis u PostgreSQL ide kroz [`Store`], da bi se handleri testirali bez baze.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use axum::Router;
use axum::body::Bytes;
use axum::extract::{ConnectInfo, DefaultBodyLimit, State};
use axum::http::{HeaderMap, HeaderName, Method, StatusCode, header};
use axum::routing::{get, post};
use klaka_core::events::{BrowserEvent, Envelope, Event, MAX_BODY, ServerEvent};
use klaka_core::net;
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use tower_http::cors::{Any, CorsLayer};

pub struct Config {
    /// Portali čije događaje iz browsera primamo; ostali se tiho odbacuju.
    pub portals: HashSet<String>,
    /// API ključ → portal. Isti portal može imati više ključeva (rotacija).
    pub api_keys: Vec<(String, String)>,
    /// Zaglavlje u koje pouzdani proxy upisuje IP klijenta (npr. `x-forwarded-for`; važi
    /// poslednja vrednost). Bez njega: adresa TCP veze.
    pub client_ip_header: Option<HeaderName>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Browser,
    Server,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Browser => "browser",
            Self::Server => "server",
        }
    }
}

/// Jedan red tabele `events`.
#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    pub kind: &'static str,
    pub t: i64,
    pub vid: Option<String>,
    pub post: Option<String>,
    pub net: Option<String>,
    pub data: Value,
}

impl Row {
    fn new<E: Event>(e: &E, net: Option<String>) -> Self {
        Self {
            kind: e.kind(),
            t: e.t(),
            vid: e.vid().map(str::to_owned),
            post: e.post().map(str::to_owned),
            net,
            data: serde_json::to_value(e).expect("događaj se uvek serijalizuje"),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Batch {
    pub portal: String,
    pub source: Source,
    pub rows: Vec<Row>,
}

pub trait Store: Send + Sync + 'static {
    fn insert(&self, batch: Batch) -> impl Future<Output = Result<(), sqlx::Error>> + Send;
}

pub struct PgStore(pub PgPool);

impl Store for PgStore {
    async fn insert(&self, b: Batch) -> Result<(), sqlx::Error> {
        let n = b.rows.len();
        let (mut kind, mut t, mut vid, mut post, mut net, mut data) = (
            Vec::with_capacity(n),
            Vec::with_capacity(n),
            Vec::with_capacity(n),
            Vec::with_capacity(n),
            Vec::with_capacity(n),
            Vec::with_capacity(n),
        );
        for r in b.rows {
            kind.push(r.kind);
            t.push(r.t);
            vid.push(r.vid);
            post.push(r.post);
            net.push(r.net);
            data.push(r.data);
        }
        sqlx::query(
            "INSERT INTO events (portal, source, type, t, vid, post, net, data)
             SELECT $1, $2, * FROM UNNEST($3::text[], $4::int8[], $5::text[], $6::text[], $7::text[], $8::jsonb[])",
        )
        .bind(b.portal)
        .bind(b.source.as_str())
        .bind(kind)
        .bind(t)
        .bind(vid)
        .bind(post)
        .bind(net)
        .bind(data)
        .execute(&self.0)
        .await?;
        Ok(())
    }
}

/// Pravi particije unapred i briše stare (`klaka_event_partitions` iz migracije).
/// Vraća promene, npr. `created events_20261021`.
pub async fn maintain_partitions(
    pool: &PgPool,
    retention_days: i32,
) -> Result<Vec<String>, sqlx::Error> {
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT action, partition FROM klaka_event_partitions($1, 2)")
            .bind(retention_days)
            .fetch_all(pool)
            .await?;
    Ok(rows.into_iter().map(|(a, p)| format!("{a} {p}")).collect())
}

pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("../../migrations");

/// Brojači od poslednjeg čitanja ([`Stats::take`]). Bez sadržaja događaja i bez IP-ja.
#[derive(Default)]
pub struct Stats {
    pub accepted: AtomicU64,
    pub rejected: AtomicU64,
    pub store_errors: AtomicU64,
}

impl Stats {
    pub fn take(&self) -> (u64, u64, u64) {
        (
            self.accepted.swap(0, Ordering::Relaxed),
            self.rejected.swap(0, Ordering::Relaxed),
            self.store_errors.swap(0, Ordering::Relaxed),
        )
    }
}

struct AppState<S> {
    portals: HashSet<String>,
    /// SHA-256(ključ) → portal: poređenje ide preko heša, ne preko samog ključa.
    keys: HashMap<[u8; 32], String>,
    client_ip_header: Option<HeaderName>,
    store: S,
    stats: Arc<Stats>,
}

pub fn app<S: Store>(cfg: Config, store: S, stats: Arc<Stats>) -> Router {
    let state = Arc::new(AppState {
        portals: cfg.portals,
        keys: cfg
            .api_keys
            .into_iter()
            .map(|(key, portal)| (sha256(&key), portal))
            .collect(),
        client_ip_header: cfg.client_ip_header,
        store,
        stats,
    });

    // `sendBeacon` sa `text/plain` ne traži CORS, ali `fetch(…, {keepalive})` sa drugim tipom
    // traži preflight. Odgovor ionako ne nosi ništa.
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::POST])
        .allow_headers([header::CONTENT_TYPE]);

    Router::new()
        .route("/v1/events", post(events::<S>).layer(cors))
        .route("/v1/ingest", post(ingest::<S>))
        .route("/healthz", get(|| async { "ok" }))
        .layer(DefaultBodyLimit::max(MAX_BODY))
        .with_state(state)
}

/// Browser ne saznaje ništa: `204` za svaku parsabilnu kovertu, šta god da se desi posle (§1).
async fn events<S: Store>(
    State(st): State<Arc<AppState<S>>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Bytes,
) -> StatusCode {
    let Ok(env) = Envelope::parse(&body) else {
        return StatusCode::BAD_REQUEST;
    };
    if !st.portals.contains(&env.portal) {
        st.stats
            .rejected
            .fetch_add(env.events.len() as u64, Ordering::Relaxed);
        return StatusCode::NO_CONTENT;
    }
    // IP → prefiks odmah; pun IP ne ide dalje od ove linije.
    let net = client_ip(&st, peer, &headers).map(net::prefix);
    let rows = parse_rows::<BrowserEvent>(&st.stats, env.events, |_| net.clone());
    store(&st, env.portal, Source::Browser, rows).await;
    StatusCode::NO_CONTENT
}

/// Portal je pouzdan izvor i sme da sazna da upis nije uspeo (`503`), da bi SDK odlučio
/// šta sa baferom.
async fn ingest<S: Store>(
    State(st): State<Arc<AppState<S>>>,
    headers: HeaderMap,
    body: Bytes,
) -> StatusCode {
    let Some(portal) = bearer(&headers).and_then(|k| st.keys.get(&sha256(k))) else {
        return StatusCode::UNAUTHORIZED;
    };
    let Ok(env) = Envelope::parse(&body) else {
        return StatusCode::BAD_REQUEST;
    };
    if &env.portal != portal {
        return StatusCode::FORBIDDEN;
    }
    let rows = parse_rows::<ServerEvent>(&st.stats, env.events, |e| match e {
        ServerEvent::Vote(v) => Some(v.action.net.clone()),
        ServerEvent::Comment(c) => Some(c.action.net.clone()),
        _ => None,
    });
    if store(&st, env.portal, Source::Server, rows).await {
        StatusCode::NO_CONTENT
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    }
}

fn parse_rows<E>(stats: &Stats, events: Vec<Value>, net: impl Fn(&E) -> Option<String>) -> Vec<Row>
where
    E: Event + for<'de> serde::Deserialize<'de>,
{
    let total = events.len();
    let rows: Vec<Row> = events
        .into_iter()
        .filter_map(|v| E::parse(v).ok())
        .map(|e| Row::new(&e, net(&e)))
        .collect();
    stats
        .rejected
        .fetch_add((total - rows.len()) as u64, Ordering::Relaxed);
    rows
}

/// `true` ako je upis uspeo ili nije bilo šta da se upiše.
async fn store<S: Store>(st: &AppState<S>, portal: String, source: Source, rows: Vec<Row>) -> bool {
    if rows.is_empty() {
        return true;
    }
    let n = rows.len() as u64;
    match st
        .store
        .insert(Batch {
            portal,
            source,
            rows,
        })
        .await
    {
        Ok(()) => {
            st.stats.accepted.fetch_add(n, Ordering::Relaxed);
            true
        }
        Err(e) => {
            st.stats.store_errors.fetch_add(n, Ordering::Relaxed);
            eprintln!("klaka-collector: upis {n} događaja nije uspeo: {e}");
            false
        }
    }
}

fn client_ip<S>(st: &AppState<S>, peer: SocketAddr, headers: &HeaderMap) -> Option<IpAddr> {
    match &st.client_ip_header {
        None => Some(peer.ip()),
        // Poslednju vrednost dopisuje naš proxy; ranije je mogao da upiše bilo ko.
        Some(h) => headers
            .get_all(h)
            .iter()
            .next_back()?
            .to_str()
            .ok()?
            .rsplit(',')
            .next()?
            .trim()
            .parse()
            .ok(),
    }
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
        .filter(|k| !k.is_empty())
}

fn sha256(s: &str) -> [u8; 32] {
    Sha256::digest(s.as_bytes()).into()
}
