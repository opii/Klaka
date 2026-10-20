//! Prijem događaja (`spec/events.md`): `POST /v1/events` iz browsera, `POST /v1/ingest` sa
//! backenda portala. Upis u PostgreSQL ide kroz [`Store`], da bi se handleri testirali bez baze.

use std::collections::{HashMap, HashSet};
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

pub use klaka_db::{Batch, MIGRATOR, PgStore, Row, Source, Store, maintain_partitions};

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
        .map(|e| Row::from_event(&e, net(&e)))
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
        Some(h) => net::last_forwarded(headers.get_all(h).iter().next_back()?.to_str().ok()?),
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
