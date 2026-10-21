//! UI recenzenta (`spec/verdicts.md` §6): red za pregled, dokazi presude, potvrda ili
//! odbacivanje.
//!
//! Poseban listener — nikad na adresi javnog `/v1/view` — sa HTTP Basic prijavom (ime i token
//! recenzenta). Forma šalje `POST` samo sa istog origin-a (zaštita od CSRF-a: browser bi Basic
//! podatke poslao i sa tuđe stranice). Bez JavaScript-a: CSP zabranjuje skripte, a askama
//! escape-uje sve što dolazi od korisnika portala (tekst komentara, pseudonim).

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use askama::Template;
use axum::extract::{Form, Path, Query, Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{Html, IntoResponse, Redirect, Response};
use axum::routing::{get, post};
use axum::{Extension, Router};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use klaka_core::verdict::{net_key, value};
use serde::Deserialize;
use serde_json::Value;
use sqlx::PgPool;

pub struct Review {
    pub pool: PgPool,
    pub valkey: redis::Client,
    /// Recenzenti: (ime, token).
    pub reviewers: Vec<(String, String)>,
}

pub fn router(review: Review) -> Router {
    let state = Arc::new(review);
    Router::new()
        .route("/", get(queue))
        .route("/presude/{id}", get(detail))
        .route("/presude/{id}/odluka", post(decide))
        .layer(middleware::from_fn_with_state(state.clone(), guard))
        .with_state(state)
}

/// Prijavljeni recenzent.
#[derive(Clone)]
struct Reviewer(String);

/// Prijava, CSRF i zaglavlja za svaki odgovor.
async fn guard(State(review): State<Arc<Review>>, mut req: Request, next: Next) -> Response {
    let mut res = match login(&review, req.headers()) {
        None => (
            StatusCode::UNAUTHORIZED,
            [(
                header::WWW_AUTHENTICATE,
                "Basic realm=\"klaka\", charset=\"UTF-8\"",
            )],
            "prijava recenzenta",
        )
            .into_response(),
        Some(_) if req.method() == Method::POST && !same_origin(req.headers()) => {
            (StatusCode::FORBIDDEN, "zahtev nije sa ove stranice").into_response()
        }
        Some(name) => {
            req.extensions_mut().insert(Reviewer(name));
            next.run(req).await
        }
    };
    let h = res.headers_mut();
    h.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(
            "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; \
             frame-ancestors 'none'; base-uri 'none'",
        ),
    );
    h.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    res
}

/// Ime recenzenta iz `Authorization: Basic`, ako se token poklapa.
fn login(review: &Review, headers: &HeaderMap) -> Option<String> {
    let raw = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let decoded = STANDARD.decode(raw.strip_prefix("Basic ")?.trim()).ok()?;
    let (name, token) = std::str::from_utf8(&decoded).ok()?.split_once(':')?;
    let mut found = None;
    for (n, t) in &review.reviewers {
        // Svi tokeni se porede do kraja: vreme odgovora ne otkriva koji se poklopio.
        if same_bytes(n.as_bytes(), name.as_bytes()) & same_bytes(t.as_bytes(), token.as_bytes()) {
            found = Some(n.clone());
        }
    }
    found
}

fn same_bytes(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// `Origin` forme mora biti ova stranica (`Host`).
fn same_origin(headers: &HeaderMap) -> bool {
    let (Some(origin), Some(host)) = (
        headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()),
        headers.get(header::HOST).and_then(|v| v.to_str().ok()),
    ) else {
        return false;
    };
    origin
        .strip_prefix("http://")
        .or_else(|| origin.strip_prefix("https://"))
        == Some(host)
}

type Failure = (StatusCode, String);

fn db(e: sqlx::Error) -> Failure {
    eprintln!("klaka-api: recenzent: baza: {e}");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        "baza nije dostupna".into(),
    )
}

fn page(t: impl Template) -> Result<Response, Failure> {
    t.render().map(|h| Html(h).into_response()).map_err(|e| {
        eprintln!("klaka-api: recenzent: šablon: {e}");
        (StatusCode::INTERNAL_SERVER_ERROR, "greška u prikazu".into())
    })
}

// --- red za pregled ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct QueueQuery {
    sve: Option<String>,
}

#[derive(sqlx::FromRow)]
struct QueueRow {
    id: i64,
    created: String,
    portal: String,
    net: String,
    detector: String,
    retro_comments: i64,
    retro_votes: i64,
    decision: Option<String>,
    reviewer: Option<String>,
    roles: Option<String>,
}

struct Row {
    id: i64,
    created: String,
    portal: String,
    net: String,
    detectors: String,
    retro_comments: i64,
    retro_votes: i64,
    status: String,
    roles: String,
}

#[derive(Template)]
#[template(path = "queue.html")]
struct Queue {
    reviewer: String,
    all: bool,
    rows: Vec<Row>,
    confirmed: i64,
    rejected: i64,
    precision: String,
}

async fn queue(
    State(review): State<Arc<Review>>,
    Extension(Reviewer(reviewer)): Extension<Reviewer>,
    Query(q): Query<QueueQuery>,
) -> Result<Response, Failure> {
    let all = q.sve.is_some();
    // Nepregledane prvo; presude `none` su odluke recenzenta, ne stavke reda.
    let rows: Vec<QueueRow> = sqlx::query_as(
        "SELECT v.id, to_char(v.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS created,
                    v.portal, v.key AS net, v.detector,
                    (SELECT count(*) FROM verdict_retro r
                     WHERE r.verdict_id = v.id AND r.kind = 'comment') AS retro_comments,
                    (SELECT count(*) FROM verdict_retro r
                     WHERE r.verdict_id = v.id AND r.kind = 'vote') AS retro_votes,
                    d.decision, d.reviewer,
                    (SELECT string_agg(r, ', ') FROM jsonb_array_elements_text(s.role->'uloge') r)
                        AS roles
             FROM verdicts v
             LEFT JOIN cohort_summary s ON s.verdict_id = v.id
             LEFT JOIN LATERAL (
                 SELECT decision, reviewer FROM verdict_review
                 WHERE verdict_id = v.id ORDER BY decided_at DESC LIMIT 1
             ) d ON true
             WHERE v.action = 'shadow' AND ($1 OR d.decision IS NULL)
             ORDER BY d.decision IS NULL DESC, v.created_at DESC
             LIMIT 200",
    )
    .bind(all)
    .fetch_all(&review.pool)
    .await
    .map_err(db)?;
    let (confirmed, rejected): (i64, i64) = sqlx::query_as(
        "SELECT count(*) FILTER (WHERE decision = 'confirm'), count(*) FILTER (WHERE decision = 'reject')
         FROM (SELECT DISTINCT ON (verdict_id) decision FROM verdict_review
               ORDER BY verdict_id, decided_at DESC) d",
    )
    .fetch_one(&review.pool)
    .await
    .map_err(db)?;
    let precision = match confirmed + rejected {
        0 => "—".to_owned(),
        n => format!("{:.0}%", 100.0 * confirmed as f64 / n as f64),
    };
    let rows = rows
        .into_iter()
        .map(|r| Row {
            id: r.id,
            status: status(r.decision.as_deref(), r.reviewer.as_deref()),
            detectors: detector_names(&r.detector),
            created: r.created,
            portal: r.portal,
            net: r.net,
            retro_comments: r.retro_comments,
            retro_votes: r.retro_votes,
            roles: r
                .roles
                .filter(|r| !r.is_empty())
                .unwrap_or_else(|| "—".into()),
        })
        .collect();
    page(Queue {
        reviewer,
        all,
        rows,
        confirmed,
        rejected,
        precision,
    })
}

fn status(decision: Option<&str>, who: Option<&str>) -> String {
    match (decision, who) {
        (Some("confirm"), Some(w)) => format!("potvrđena ({w})"),
        (Some("reject"), Some(w)) => format!("odbačena ({w})"),
        _ => "nepregledana".to_owned(),
    }
}

/// Imena detektora kao u rečniku (`docs/recnik.md`), uz ime iz koda.
fn detector_name(d: &str) -> String {
    let name = match d {
        "ghost-views" => "prikazi-duhovi",
        "unread-votes" => "nečitani glasovi",
        "focused-votes" => "usmereni glasovi",
        "coordinated-votes" => "usklađeni glasovi",
        "unwritten-comments" => "nenapisani komentari",
        "shared-templates" => "deljeni šabloni",
        "coordinated-templates" => "usklađeni šabloni",
        other => return other.to_owned(),
    };
    format!("{name} ({d})")
}

fn detector_names(joined: &str) -> String {
    joined
        .split('+')
        .map(detector_name)
        .collect::<Vec<_>>()
        .join(", ")
}

// --- detalj presude ---------------------------------------------------------------------------

struct Cohort {
    detector: String,
    fields: Vec<(String, String)>,
}

struct CommentRow {
    at: String,
    post: String,
    author: String,
    text: String,
    decision: String,
    retro: bool,
}

struct VoteRow {
    post: String,
    target: String,
    dir: String,
    votes: i64,
}

/// Opis kohorte iz modela (G2/G3, `klaka-engine` `describe.rs`): savetodavno.
struct Summary {
    /// Stanje kad opisa nema (čeka, nema komentara, nije uspeo); prazno kad ima.
    state: String,
    fields: Vec<(String, String)>,
    meta: String,
}

struct ReviewRow {
    at: String,
    reviewer: String,
    decision: String,
    note: String,
}

#[derive(Template)]
#[template(path = "verdict.html")]
struct Detail {
    reviewer: String,
    id: i64,
    created: String,
    portal: String,
    net: String,
    rev: i32,
    until: String,
    detectors: String,
    window_s: i64,
    state: String,
    cohorts: Vec<Cohort>,
    retro_comments: i64,
    retro_votes: i64,
    comments: Vec<CommentRow>,
    votes: Vec<VoteRow>,
    reviews: Vec<ReviewRow>,
    summary: Summary,
    /// Uloge kohorte i razlozi (`klaka-engine` `role.rs`); prazno dok nisu izračunate.
    roles: Vec<String>,
    role_reasons: Vec<String>,
    role_known: bool,
    role_note: String,
}

/// Uzorak akcija prefiksa iz prozora dokaza.
const SAMPLE: i64 = 50;

async fn detail(
    State(review): State<Arc<Review>>,
    Extension(Reviewer(reviewer)): Extension<Reviewer>,
    Path(id): Path<i64>,
) -> Result<Response, Failure> {
    let pool = &review.pool;
    let found: Option<(String, String, String, i32, String, String, Value)> = sqlx::query_as(
        "SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'), portal, key, rev,
                to_char(to_timestamp(until_ms / 1000.0) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
                detector, evidence
         FROM verdicts WHERE id = $1 AND action = 'shadow'",
    )
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(db)?;
    let Some((created, portal, net, rev, until, detector, evidence)) = found else {
        return Err((StatusCode::NOT_FOUND, "nema takve presude".into()));
    };
    let window_s = evidence["window_s"].as_i64().unwrap_or(0);

    // Stanje ključa sada: poslednja presuda za prefiks.
    let (action, valid): (String, bool) = sqlx::query_as(
        "SELECT action, until_ms > (extract(epoch FROM now()) * 1000)::bigint FROM verdicts
         WHERE portal = $1 AND key_kind = 'net' AND key = $2 ORDER BY created_at DESC LIMIT 1",
    )
    .bind(&portal)
    .bind(&net)
    .fetch_one(pool)
    .await
    .map_err(db)?;
    let state = match (action.as_str(), valid) {
        ("shadow", true) => "važi: shadow",
        ("none", true) => "odbačena: none do isteka roka",
        _ => "istekla",
    }
    .to_owned();

    let (retro_comments, retro_votes): (i64, i64) = sqlx::query_as(
        "SELECT count(*) FILTER (WHERE kind = 'comment'), count(*) FILTER (WHERE kind = 'vote')
         FROM verdict_retro WHERE verdict_id = $1",
    )
    .bind(id)
    .fetch_one(pool)
    .await
    .map_err(db)?;

    // Prozor dokaza: `window_s` pre presude.
    let comments: Vec<(String, String, String, String, String, bool)> = sqlx::query_as(
        "WITH v AS (SELECT portal, key, created_at FROM verdicts WHERE id = $1)
         SELECT to_char(e.recv_at AT TIME ZONE 'UTC', 'HH24:MI:SS'), e.post,
                coalesce(e.data->>'author', ''), coalesce(e.data->>'text', ''),
                coalesce(e.data->>'decision', ''),
                EXISTS (SELECT 1 FROM verdict_retro r
                        WHERE r.verdict_id = $1 AND r.comment = e.data->>'comment')
         FROM events e, v
         WHERE e.portal = v.portal AND e.net = v.key AND e.type = 'comment' AND e.source = 'server'
           AND e.recv_at > v.created_at - make_interval(secs => $2) AND e.recv_at <= v.created_at
         ORDER BY e.recv_at LIMIT $3",
    )
    .bind(id)
    .bind(window_s as f64)
    .bind(SAMPLE)
    .fetch_all(pool)
    .await
    .map_err(db)?;
    let votes: Vec<(String, String, Option<i32>, i64)> = sqlx::query_as(
        "WITH v AS (SELECT portal, key, created_at FROM verdicts WHERE id = $1)
         SELECT e.post, coalesce(e.data->>'target', ''), (e.data->>'dir')::int, count(*)
         FROM events e, v
         WHERE e.portal = v.portal AND e.net = v.key AND e.type = 'vote' AND e.source = 'server'
           AND e.recv_at > v.created_at - make_interval(secs => $2) AND e.recv_at <= v.created_at
         GROUP BY 1, 2, 3 ORDER BY 4 DESC, 1, 2 LIMIT $3",
    )
    .bind(id)
    .bind(window_s as f64)
    .bind(SAMPLE)
    .fetch_all(pool)
    .await
    .map_err(db)?;
    let reviews: Vec<(String, String, String, Option<String>)> = sqlx::query_as(
        "SELECT to_char(decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'), reviewer, decision, note
         FROM verdict_review WHERE verdict_id = $1 ORDER BY decided_at DESC",
    )
    .bind(id)
    .fetch_all(pool)
    .await
    .map_err(db)?;

    let summary: Option<SummaryRow> = sqlx::query_as(
        "SELECT status, output, model, prompt_version, latency_ms, error
         FROM cohort_summary WHERE verdict_id = $1",
    )
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(db)?;
    let pending = summary.as_ref().is_some_and(|r| r.0 == "pending");
    let summary = summary_view(summary);
    let role: Option<Option<Value>> =
        sqlx::query_scalar("SELECT role FROM cohort_summary WHERE verdict_id = $1")
            .bind(id)
            .fetch_optional(pool)
            .await
            .map_err(db)?;
    let strings = |v: &Value, k: &str| -> Vec<String> {
        v[k].as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default()
    };
    let role = role.flatten();
    let role_known = role.is_some();
    // Uloga bez opisa dok opis čeka: iz glasova, preračunava se kad opis stigne.
    let role_note = role
        .as_ref()
        .filter(|r| pending && r["uz_opis"] == Value::Bool(false))
        .map(|_| "privremena — iz glasova; preračunava se kad stigne opis modela".to_owned())
        .unwrap_or_default();
    let (roles, role_reasons) = match role {
        Some(r) => (strings(&r, "uloge"), strings(&r, "razlozi")),
        None => (Vec::new(), Vec::new()),
    };

    let cohorts = evidence["cohorts"]
        .as_array()
        .map(|cs| cs.iter().map(cohort).collect())
        .unwrap_or_default();
    page(Detail {
        reviewer,
        id,
        created,
        portal,
        net,
        rev,
        until,
        detectors: detector_names(&detector),
        window_s,
        state,
        cohorts,
        retro_comments,
        retro_votes,
        comments: comments
            .into_iter()
            .map(|(at, post, author, text, decision, retro)| CommentRow {
                at,
                post,
                author,
                text,
                decision,
                retro,
            })
            .collect(),
        votes: votes
            .into_iter()
            .map(|(post, target, dir, votes)| VoteRow {
                post,
                target,
                dir: direction(dir.map(i64::from)),
                votes,
            })
            .collect(),
        reviews: reviews
            .into_iter()
            .map(|(at, reviewer, decision, note)| ReviewRow {
                at,
                reviewer,
                decision: match decision.as_str() {
                    "confirm" => "potvrdio".into(),
                    _ => "odbacio".into(),
                },
                note: note.unwrap_or_default(),
            })
            .collect(),
        summary,
        roles,
        role_reasons,
        role_known,
        role_note,
    })
}

/// (status, izlaz, model, verzija prompta, trajanje u ms, greška)
type SummaryRow = (
    String,
    Option<Value>,
    Option<String>,
    Option<String>,
    Option<i64>,
    Option<String>,
);

fn summary_view(row: Option<SummaryRow>) -> Summary {
    let empty = |state: String| Summary {
        state,
        fields: Vec::new(),
        meta: String::new(),
    };
    let Some((status, output, model, prompt, latency, error)) = row else {
        return empty("nema opisa (presuda je starija od opisa ili model nije podešen)".into());
    };
    match (status.as_str(), output) {
        ("done", Some(out)) => {
            let fields = [
                ("poruka", "poruka grupe"),
                ("stav", "stav"),
                ("kohezija", "kohezija"),
                ("toksicnost", "toksičnost"),
                ("hvale", "komentara hvali"),
                ("napadaju", "komentara napada"),
                ("skrecu", "komentara skreće"),
                ("sazetak", "sažetak"),
            ]
            .into_iter()
            // Opis starije verzije prompta nema sva polja.
            .filter_map(|(k, label)| {
                let v = match &out[k] {
                    Value::String(s) => s.clone(),
                    Value::Number(n) => n.to_string(),
                    _ => return None,
                };
                Some((label.to_owned(), v))
            })
            .collect();
            let seconds = latency.map(|ms| format!(", {:.1} s", ms as f64 / 1000.0));
            Summary {
                state: String::new(),
                fields,
                meta: format!(
                    "model {}, prompt {}{}",
                    model.unwrap_or_default(),
                    prompt.unwrap_or_default(),
                    seconds.unwrap_or_default()
                ),
            }
        }
        ("pending", _) => empty("čeka model".into()),
        // Zatvoren bez modela: razlog (opis nije uključen) ili nema komentara.
        ("skipped", _) => empty(error.unwrap_or_else(|| {
            "prefiks nema komentara u prozoru dokaza — nema šta da se opiše".into()
        })),
        _ => empty(format!(
            "opis nije uspeo: {}",
            error.unwrap_or_else(|| "nepoznata greška".into())
        )),
    }
}

fn direction(dir: Option<i64>) -> String {
    match dir {
        Some(1) => "za".into(),
        Some(-1) => "protiv".into(),
        other => other.map(|d| d.to_string()).unwrap_or_default(),
    }
}

/// Redosled polja dokaza: obim, pa šta je nađeno, pa poređenje sa publikom; ostala posle.
const FIELD_ORDER: [&str; 17] = [
    "comments",
    "votes",
    "net_votes",
    "vids",
    "posts",
    "flagged",
    "templated",
    "copies",
    "target_author",
    "dir",
    "elements",
    "partners",
    "cohort_nets",
    "share",
    "baseline",
    "lift",
    "p_value",
];

/// Dokazi jednog nalaza, sa imenima polja kao u izveštaju.
fn cohort(c: &Value) -> Cohort {
    let detector = detector_name(c["detector"].as_str().unwrap_or("?"));
    let mut fields: Vec<_> = c
        .as_object()
        .map(|m| m.iter().filter(|(k, _)| k.as_str() != "detector").collect())
        .unwrap_or_default();
    let rank = |k: &str| {
        FIELD_ORDER
            .iter()
            .position(|&f| f == k)
            .unwrap_or(FIELD_ORDER.len())
    };
    fields.sort_by_key(|(k, _)| rank(k));
    let fields = fields
        .into_iter()
        .map(|(k, v)| (field_label(k), field_value(k, v)))
        .collect();
    Cohort { detector, fields }
}

fn field_label(k: &str) -> String {
    match k {
        "comments" => "komentara",
        "votes" => "glasova",
        "vids" => "prikaza",
        "posts" => "postova",
        "flagged" => "označenih",
        "templated" => "šablonskih",
        "copies" => "od toga kopija",
        "baseline" => "organski udeo",
        "share" => "udeo",
        "lift" => "lift (prema organskom)",
        "p_value" => "p-vrednost",
        "elements" => "elemenata",
        "partners" => "partnera u grafu",
        "cohort_nets" => "prefiksa u kohorti",
        "net_votes" => "glasova prefiksa",
        "target_author" => "autor cilja",
        "dir" => "smer",
        other => other,
    }
    .to_owned()
}

fn field_value(k: &str, v: &Value) -> String {
    match v {
        Value::Number(n) if k == "dir" => direction(n.as_i64()),
        Value::Number(n) if n.is_f64() => {
            let x = n.as_f64().unwrap_or(f64::NAN);
            if x != 0.0 && x.abs() < 1e-3 {
                format!("{x:.1e}")
            } else {
                let s = format!("{x:.3}");
                s.trim_end_matches('0').trim_end_matches('.').to_owned()
            }
        }
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

// --- odluka -----------------------------------------------------------------------------------

#[derive(Deserialize)]
struct DecisionForm {
    decision: String,
    #[serde(default)]
    note: String,
}

const NOTE_MAX: usize = 500;

/// Potvrda je samo oznaka. Odbacivanje uz oznaku i zaustavi presudu, ako još važi: nova revizija
/// `none` za prefiks, do isteka roka koliko je trajala presuda, u Valkey i u audit — engine je do
/// tada ne obnavlja ni ne dopunjuje. Naknadno skinute akcije ostaju skinute (§5).
async fn decide(
    State(review): State<Arc<Review>>,
    Extension(Reviewer(reviewer)): Extension<Reviewer>,
    Path(id): Path<i64>,
    Form(form): Form<DecisionForm>,
) -> Result<Response, Failure> {
    if !matches!(form.decision.as_str(), "confirm" | "reject") {
        return Err((StatusCode::BAD_REQUEST, "nepoznata odluka".into()));
    }
    let note = form.note.trim();
    if note.chars().count() > NOTE_MAX {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("napomena duža od {NOTE_MAX} znakova"),
        ));
    }
    let mut tx = review.pool.begin().await.map_err(db)?;
    let verdict: Option<(String, String, i64)> = sqlx::query_as(
        "SELECT portal, key, until_ms - (extract(epoch FROM created_at) * 1000)::bigint
         FROM verdicts WHERE id = $1 AND action = 'shadow'",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(db)?;
    let Some((portal, net, length_ms)) = verdict else {
        return Err((StatusCode::NOT_FOUND, "nema takve presude".into()));
    };
    sqlx::query(
        "INSERT INTO verdict_review (verdict_id, decision, reviewer, note) VALUES ($1, $2, $3, $4)",
    )
    .bind(id)
    .bind(&form.decision)
    .bind(&reviewer)
    .bind((!note.is_empty()).then_some(note))
    .execute(&mut *tx)
    .await
    .map_err(db)?;

    if form.decision == "reject" {
        // Isti red zaključava i engine (`issue_net_shadow`), pa se presuda i odbacivanje ne mimoilaze.
        let last: (i64, i32, String) = sqlx::query_as(
            "SELECT until_ms, rev, action FROM verdicts
             WHERE portal = $1 AND key_kind = 'net' AND key = $2
             ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
        )
        .bind(&portal)
        .bind(&net)
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
        let now = now_ms();
        if last.2 == "shadow" && last.0 > now {
            let until = now + length_ms.max(1);
            let rev = last.1 + 1;
            sqlx::query(
                "INSERT INTO verdicts (portal, key_kind, key, action, until_ms, rev, detector, evidence)
                 VALUES ($1, 'net', $2, 'none', $3, $4, 'review', $5)",
            )
            .bind(&portal)
            .bind(&net)
            .bind(until)
            .bind(rev)
            .bind(serde_json::json!({"review": {"verdict": id, "reviewer": reviewer}}))
            .execute(&mut *tx)
            .await
            .map_err(db)?;
            let valkey = async {
                let mut c = review.valkey.get_multiplexed_async_connection().await?;
                redis::cmd("SET")
                    .arg(net_key(&portal, &net))
                    .arg(value("none", until, rev))
                    .arg("PX")
                    .arg(until - now)
                    .query_async::<()>(&mut c)
                    .await
            };
            // Kao kod engine-a: bez upisa u Valkey nema ni zapisa u audit-u.
            valkey.await.map_err(|e| {
                eprintln!("klaka-api: recenzent: valkey: {e}");
                (
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Valkey nije dostupan — presuda nije odbačena".to_owned(),
                )
            })?;
        }
    }
    tx.commit().await.map_err(db)?;
    Ok(Redirect::to(&format!("/presude/{id}")).into_response())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}
