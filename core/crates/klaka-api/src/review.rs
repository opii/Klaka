//! UI recenzenta (`spec/verdicts.md` §6): red za pregled, dokazi presude, potvrda ili
//! odbacivanje.
//!
//! Poseban listener — nikad na adresi javnog `/v1/view` — sa HTTP Basic prijavom (ime i token
//! recenzenta). Forma šalje `POST` samo sa istog origin-a (zaštita od CSRF-a: browser bi Basic
//! podatke poslao i sa tuđe stranice). Bez JavaScript-a: CSP zabranjuje skripte, a askama
//! escape-uje sve što dolazi od korisnika portala (tekst komentara, pseudonim).

use std::collections::{BTreeMap, BTreeSet};
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
        .route("/kohorte/{id}", get(cohort_page))
        .route("/kohorte/{id}/odluka", post(decide_cohort))
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
    cohort: Option<i64>,
}

/// Jedinica pregleda: kohorta iz grafa (sve njene presude) ili pojedinačna presuda.
struct Row {
    href: String,
    created: String,
    portal: String,
    /// Prefiks, ili „kohorta #c: n prefiksa".
    label: String,
    detectors: String,
    retro_comments: i64,
    retro_votes: i64,
    status: String,
    roles: String,
    /// Bar jedna presuda jedinice još nema odluku.
    open: bool,
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

/// Presude (bez odluka recenzenta, `none`), sa poslednjom odlukom i ulogom.
const VERDICT_ROWS: &str =
    "SELECT v.id, to_char(v.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS created,
            v.portal, v.key AS net, v.detector,
            (SELECT count(*) FROM verdict_retro r
             WHERE r.verdict_id = v.id AND r.kind = 'comment') AS retro_comments,
            (SELECT count(*) FROM verdict_retro r
             WHERE r.verdict_id = v.id AND r.kind = 'vote') AS retro_votes,
            d.decision, d.reviewer,
            (SELECT string_agg(r, ', ') FROM jsonb_array_elements_text(s.role->'uloge') r)
                AS roles,
            v.cohort
     FROM verdicts v
     LEFT JOIN cohort_summary s ON s.verdict_id = v.id
     LEFT JOIN LATERAL (
         SELECT decision, reviewer FROM verdict_review
         WHERE verdict_id = v.id ORDER BY decided_at DESC LIMIT 1
     ) d ON true
     WHERE v.action = 'shadow'";

/// Najviše jedinica u redu; presuda koje se gledaju da bi se sklopile.
const QUEUE_UNITS: usize = 200;
const QUEUE_VERDICTS: i64 = 2_000;

async fn queue(
    State(review): State<Arc<Review>>,
    Extension(Reviewer(reviewer)): Extension<Reviewer>,
    Query(q): Query<QueueQuery>,
) -> Result<Response, Failure> {
    let all = q.sve.is_some();
    let rows: Vec<QueueRow> = sqlx::query_as(&format!(
        "{VERDICT_ROWS} ORDER BY v.created_at DESC LIMIT $1"
    ))
    .bind(QUEUE_VERDICTS)
    .fetch_all(&review.pool)
    .await
    .map_err(db)?;
    // Kohorta iz grafa je jedna stavka: recenzent odlučuje o njoj, ne o 16 prefiksa posebno.
    let mut units: Vec<Row> = Vec::new();
    let mut cohorts: BTreeMap<i64, Vec<QueueRow>> = BTreeMap::new();
    for r in rows {
        match r.cohort {
            Some(c) => cohorts.entry(c).or_default().push(r),
            None => units.push(single(r)),
        }
    }
    units.extend(cohorts.into_iter().map(|(c, m)| cohort_row(c, &m)));
    units.retain(|u| all || u.open);
    // Nepregledane prvo, pa novije.
    units.sort_by(|a, b| b.open.cmp(&a.open).then_with(|| b.created.cmp(&a.created)));
    units.truncate(QUEUE_UNITS);

    // Preciznost reda po jedinici (koncept §11: udeo prijavljenih kohorti koje recenzent potvrdi).
    let (confirmed, rejected): (i64, i64) = sqlx::query_as(
        "SELECT count(*) FILTER (WHERE decision = 'confirm'), count(*) FILTER (WHERE decision = 'reject')
         FROM (SELECT DISTINCT ON (unit) decision FROM (
                   SELECT CASE WHEN v.cohort IS NULL THEN 'p' || v.id ELSE 'k' || v.cohort END AS unit,
                          r.decision, r.decided_at
                   FROM verdict_review r JOIN verdicts v ON v.id = r.verdict_id
               ) x ORDER BY unit, decided_at DESC) d",
    )
    .fetch_one(&review.pool)
    .await
    .map_err(db)?;
    let precision = match confirmed + rejected {
        0 => "—".to_owned(),
        n => format!("{:.0}%", 100.0 * confirmed as f64 / n as f64),
    };
    page(Queue {
        reviewer,
        all,
        rows: units,
        confirmed,
        rejected,
        precision,
    })
}

fn single(r: QueueRow) -> Row {
    Row {
        href: format!("/presude/{}", r.id),
        status: status(r.decision.as_deref(), r.reviewer.as_deref()),
        open: r.decision.is_none(),
        detectors: detector_names(&r.detector),
        created: r.created,
        portal: r.portal,
        label: r.net,
        retro_comments: r.retro_comments,
        retro_votes: r.retro_votes,
        roles: r
            .roles
            .filter(|r| !r.is_empty())
            .unwrap_or_else(|| "—".into()),
    }
}

/// Kohorta kao jedna stavka: svi njeni detektori i uloge, zbir naknadnog shadow-a, stanje
/// pregleda (nepregledana, potvrđena/odbačena, ili delimično).
fn cohort_row(c: i64, members: &[QueueRow]) -> Row {
    let nets: BTreeSet<&str> = members.iter().map(|m| m.net.as_str()).collect();
    let detectors: BTreeSet<&str> = members.iter().flat_map(|m| m.detector.split('+')).collect();
    let roles: BTreeSet<&str> = members
        .iter()
        .filter_map(|m| m.roles.as_deref())
        .flat_map(|r| r.split(", "))
        .filter(|r| !r.is_empty())
        .collect();
    let decided: Vec<&QueueRow> = members.iter().filter(|m| m.decision.is_some()).collect();
    let status = if decided.is_empty() {
        "nepregledana".to_owned()
    } else if decided.len() == members.len()
        && decided.iter().all(|m| m.decision == decided[0].decision)
    {
        status(
            decided[0].decision.as_deref(),
            decided[0].reviewer.as_deref(),
        )
    } else {
        format!("delimično ({}/{})", decided.len(), members.len())
    };
    Row {
        href: format!("/kohorte/{c}"),
        created: members
            .iter()
            .map(|m| m.created.clone())
            .min()
            .unwrap_or_default(),
        portal: members[0].portal.clone(),
        label: format!("kohorta #{c}: {} prefiksa", nets.len()),
        detectors: detector_names(&detectors.into_iter().collect::<Vec<_>>().join("+")),
        retro_comments: members.iter().map(|m| m.retro_comments).sum(),
        retro_votes: members.iter().map(|m| m.retro_votes).sum(),
        roles: if roles.is_empty() {
            "—".into()
        } else {
            roles.into_iter().collect::<Vec<_>>().join(", ")
        },
        open: decided.len() < members.len(),
        status,
    }
}

// --- kohorta ----------------------------------------------------------------------------------

#[derive(Template)]
#[template(path = "cohort.html")]
struct CohortPage {
    reviewer: String,
    id: i64,
    portal: String,
    members: Vec<Row>,
    nets: usize,
    open: usize,
    summary: Summary,
}

async fn cohort_page(
    State(review): State<Arc<Review>>,
    Extension(Reviewer(reviewer)): Extension<Reviewer>,
    Path(id): Path<i64>,
) -> Result<Response, Failure> {
    let rows: Vec<QueueRow> = sqlx::query_as(&format!(
        "{VERDICT_ROWS} AND v.cohort = $1 ORDER BY v.created_at"
    ))
    .bind(id)
    .fetch_all(&review.pool)
    .await
    .map_err(db)?;
    if rows.is_empty() {
        return Err((StatusCode::NOT_FOUND, "nema takve kohorte".into()));
    }
    // Opis je zajednički za celu kohortu: uzima se gotov, ako ga ima.
    let summary: Option<SummaryRow> = sqlx::query_as(
        "SELECT s.status, s.output, s.model, s.prompt_version, s.latency_ms, s.error
         FROM cohort_summary s JOIN verdicts v ON v.id = s.verdict_id
         WHERE v.cohort = $1
         ORDER BY (s.status = 'done') DESC, s.done_at DESC NULLS LAST LIMIT 1",
    )
    .bind(id)
    .fetch_optional(&review.pool)
    .await
    .map_err(db)?;
    let nets = rows
        .iter()
        .map(|r| r.net.as_str())
        .collect::<BTreeSet<_>>()
        .len();
    let portal = rows[0].portal.clone();
    let members: Vec<Row> = rows.into_iter().map(single).collect();
    let open = members.iter().filter(|m| m.open).count();
    page(CohortPage {
        reviewer,
        id,
        portal,
        members,
        nets,
        open,
        summary: summary_view(summary),
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
    /// Kohorta iz grafa: „#12 — 16 prefiksa"; prazno za presudu detektora po prefiksu.
    cohort: String,
    cohort_href: String,
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
    let cohort_info: Option<(i64, i64)> = sqlx::query_as(
        "SELECT v.cohort, (SELECT count(DISTINCT w.key) FROM verdicts w
                           WHERE w.cohort = v.cohort AND w.action = 'shadow')
         FROM verdicts v WHERE v.id = $1 AND v.cohort IS NOT NULL",
    )
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(db)?;
    let cohort_href = cohort_info
        .map(|(c, _)| format!("/kohorte/{c}"))
        .unwrap_or_default();
    let cohort_info = cohort_info
        .map(|(c, n)| format!("#{c} — {n} prefiksa, jedan opis modela za celu kohortu"))
        .unwrap_or_default();
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
        cohort: cohort_info,
        cohort_href,
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

/// Odluka iz forme: poznata, napomena u granici.
fn checked(form: &DecisionForm) -> Result<(&str, &str), Failure> {
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
    Ok((&form.decision, note))
}

async fn decide(
    State(review): State<Arc<Review>>,
    Extension(Reviewer(reviewer)): Extension<Reviewer>,
    Path(id): Path<i64>,
    Form(form): Form<DecisionForm>,
) -> Result<Response, Failure> {
    let (decision, note) = checked(&form)?;
    apply(&review, &[id], decision, &reviewer, note).await?;
    Ok(Redirect::to(&format!("/presude/{id}")).into_response())
}

/// Odluka o celoj kohorti: ista odluka za svaku njenu presudu.
async fn decide_cohort(
    State(review): State<Arc<Review>>,
    Extension(Reviewer(reviewer)): Extension<Reviewer>,
    Path(id): Path<i64>,
    Form(form): Form<DecisionForm>,
) -> Result<Response, Failure> {
    let (decision, note) = checked(&form)?;
    let ids: Vec<i64> = sqlx::query_scalar(
        "SELECT id FROM verdicts WHERE cohort = $1 AND action = 'shadow' ORDER BY id",
    )
    .bind(id)
    .fetch_all(&review.pool)
    .await
    .map_err(db)?;
    if ids.is_empty() {
        return Err((StatusCode::NOT_FOUND, "nema takve kohorte".into()));
    }
    apply(&review, &ids, decision, &reviewer, note).await?;
    Ok(Redirect::to(&format!("/kohorte/{id}")).into_response())
}

/// Potvrda je samo oznaka. Odbacivanje uz oznaku i zaustavi presudu prefiksa, ako još važi: nova
/// revizija `none`, do isteka roka koliko je trajala presuda, u Valkey i u audit — engine je do
/// tada ne obnavlja ni ne dopunjuje. Naknadno skinute akcije ostaju skinute (§5). Sve presude
/// odluke (kohorta) u jednoj transakciji i jednim `MULTI`: bez upisa u Valkey nema ni zapisa u
/// audit-u, ni za jedan prefiks.
async fn apply(
    review: &Review,
    ids: &[i64],
    decision: &str,
    reviewer: &str,
    note: &str,
) -> Result<(), Failure> {
    let mut tx = review.pool.begin().await.map_err(db)?;
    // Prefiks → (trajanje presude, presuda); BTreeMap: isti redosled zaključavanja kao engine.
    let mut keys: BTreeMap<(String, String), (i64, i64)> = BTreeMap::new();
    for &id in ids {
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
        .bind(decision)
        .bind(reviewer)
        .bind((!note.is_empty()).then_some(note))
        .execute(&mut *tx)
        .await
        .map_err(db)?;
        keys.entry((portal, net)).or_insert((length_ms, id));
    }

    if decision == "reject" {
        let now = now_ms();
        let mut sets = Vec::new();
        for ((portal, net), &(length_ms, id)) in &keys {
            // Isti red zaključava i engine (`issue_net_shadow`): presuda i odbacivanje se ne mimoilaze.
            let last: (i64, i32, String) = sqlx::query_as(
                "SELECT until_ms, rev, action FROM verdicts
                 WHERE portal = $1 AND key_kind = 'net' AND key = $2
                 ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
            )
            .bind(portal)
            .bind(net)
            .fetch_one(&mut *tx)
            .await
            .map_err(db)?;
            if last.2 != "shadow" || last.0 <= now {
                continue;
            }
            let until = now + length_ms.max(1);
            let rev = last.1 + 1;
            sqlx::query(
                "INSERT INTO verdicts (portal, key_kind, key, action, until_ms, rev, detector, evidence)
                 VALUES ($1, 'net', $2, 'none', $3, $4, 'review', $5)",
            )
            .bind(portal)
            .bind(net)
            .bind(until)
            .bind(rev)
            .bind(serde_json::json!({"review": {"verdict": id, "reviewer": reviewer}}))
            .execute(&mut *tx)
            .await
            .map_err(db)?;
            sets.push((net_key(portal, net), value("none", until, rev), until - now));
        }
        if !sets.is_empty() {
            let valkey = async {
                let mut c = review.valkey.get_multiplexed_async_connection().await?;
                let mut pipe = redis::pipe();
                pipe.atomic();
                for (key, val, px) in &sets {
                    pipe.cmd("SET").arg(key).arg(val).arg("PX").arg(px).ignore();
                }
                pipe.query_async::<()>(&mut c).await
            };
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
    Ok(())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}
