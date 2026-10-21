//! Detektori kohorti; presude upisuje u Valkey (SDK ih čita) i u audit (PostgreSQL).
//!
//! Konfiguracija iz okruženja:
//! - `KLAKA_POSTGRES_URL`, `KLAKA_VALKEY_URL`  (obavezno)
//! - `KLAKA_ENGINE_INTERVAL_S`   koliko često se detektori pokreću (podrazumevano 10)
//! - `KLAKA_ENGINE_WINDOW_S`     prozor posmatranja (600)
//! - `KLAKA_ENGINE_MIN_VOTES`, `KLAKA_ENGINE_MIN_VIDS`, `KLAKA_ENGINE_MIN_FLAGGED_SHARE`
//!   pragovi detektora: glasova, prikaza i udeo označenih prikaza (5, 3, 0.8)
//! - `KLAKA_ENGINE_MIN_POSTS`, `KLAKA_ENGINE_MIN_LIFT`, `KLAKA_ENGINE_MAX_P`
//!   usmereni glasovi i deljeni šabloni: postova, odnos prema organskom udelu, binomni rep (2, 3, 1e-4)
//! - `KLAKA_ENGINE_MIN_COMMENTS`  detektori komentara: najmanje komentara iz prefiksa (5)
//! - `KLAKA_ENGINE_MAX_TEXT_DISTANCE`, `KLAKA_ENGINE_MIN_MINHASH`
//!   deljeni šabloni: kosinusna udaljenost za parafrazu, MinHash za kopiju (0.2, 0.5)
//! - `KLAKA_ENGINE_TEMPLATE_DAYS` deljeni šabloni: parafraza se traži među komentarima iz
//!   ovoliko dana unazad, preko HNSW indeksa (7, docs/llm.md §5a)
//! - `KLAKA_ENGINE_COVOTE_S`, `KLAKA_ENGINE_MIN_JACCARD`, `KLAKA_ENGINE_MIN_PARTNERS`,
//!   `KLAKA_ENGINE_MIN_COHORT_NETS`, `KLAKA_ENGINE_PROMOTION_S`
//!   usklađeni glasovi: razmak, sličnost skupova, partnera, prefiksa, prozor promocije
//!   (120, 0.5, 2, 5, 600)
//! - `KLAKA_OLLAMA_URL`, `KLAKA_EMBED_MODEL`  embeddings komentara (bez njih: samo MinHash)
//! - `KLAKA_RETENTION_DAYS`      koliko dugo se čuvaju embeddings, kao i događaji (30)
//! - `KLAKA_ENGINE_TTL_S`        trajanje presude (3600)
//! - `KLAKA_ENGINE_RETRO_S`      naknadni shadow: akcije prefiksa iz ovoliko sekundi pre presude
//!   (podrazumevano isto kao prozor)

use std::str::FromStr;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use klaka_db::MIGRATOR;
use klaka_engine::comments::{
    COORDINATED_TEMPLATES, SHARED_TEMPLATES, UNWRITTEN_COMMENTS, embed_pending, purge_embeddings,
    template_cohorts, unwritten_cohorts,
};
use klaka_engine::coordinated::{COORDINATED_VOTES, coordinated_cohorts, nets};
use klaka_engine::{
    Config, FOCUSED_VOTES, Finding, GHOST_VIEWS, NetVerdict, UNREAD_VOTES, detectors,
    focused_cohorts, ghost_cohorts, group_by_net, issue_net_shadow, unread_cohorts,
};
use klaka_llm::{Embedder, Ollama};
use serde_json::json;
use sqlx::PgPool;

#[tokio::main]
async fn main() {
    let db_url = std::env::var("KLAKA_POSTGRES_URL")
        .unwrap_or_else(|_| fail("KLAKA_POSTGRES_URL nije postavljen"));
    let valkey_url = std::env::var("KLAKA_VALKEY_URL")
        .unwrap_or_else(|_| fail("KLAKA_VALKEY_URL nije postavljen"));
    let interval = Duration::from_secs(env("KLAKA_ENGINE_INTERVAL_S", 10));
    let window_s = env("KLAKA_ENGINE_WINDOW_S", 600);
    let cfg = Config {
        window: Duration::from_secs(window_s),
        min_votes: env("KLAKA_ENGINE_MIN_VOTES", 5),
        min_vids: env("KLAKA_ENGINE_MIN_VIDS", 3),
        min_flagged_share: env("KLAKA_ENGINE_MIN_FLAGGED_SHARE", 0.8),
        min_posts: env("KLAKA_ENGINE_MIN_POSTS", 2),
        min_lift: env("KLAKA_ENGINE_MIN_LIFT", 3.0),
        max_p_value: env("KLAKA_ENGINE_MAX_P", 1e-4),
        min_comments: env("KLAKA_ENGINE_MIN_COMMENTS", 5),
        max_text_distance: env("KLAKA_ENGINE_MAX_TEXT_DISTANCE", 0.2),
        min_minhash: env("KLAKA_ENGINE_MIN_MINHASH", 0.5),
        covote: Duration::from_secs(env("KLAKA_ENGINE_COVOTE_S", 120)),
        min_jaccard: env("KLAKA_ENGINE_MIN_JACCARD", 0.5),
        min_partners: env("KLAKA_ENGINE_MIN_PARTNERS", 2),
        min_cohort_nets: env("KLAKA_ENGINE_MIN_COHORT_NETS", 5),
        promotion: Duration::from_secs(env("KLAKA_ENGINE_PROMOTION_S", 600)),
        template_lookback: Duration::from_secs(env("KLAKA_ENGINE_TEMPLATE_DAYS", 7) * 24 * 3600),
        ttl: Duration::from_secs(env("KLAKA_ENGINE_TTL_S", 3600)),
        retro: Duration::from_secs(env("KLAKA_ENGINE_RETRO_S", window_s)),
    };

    let pool = PgPool::connect(&db_url)
        .await
        .unwrap_or_else(|e| fail(&format!("baza: {e}")));
    MIGRATOR
        .run(&pool)
        .await
        .unwrap_or_else(|e| fail(&format!("migracije: {e}")));
    let client = redis::Client::open(valkey_url).unwrap_or_else(|e| fail(&format!("valkey: {e}")));
    let mut valkey = client
        .get_multiplexed_async_connection()
        .await
        .unwrap_or_else(|e| fail(&format!("valkey: {e}")));

    let ollama_url = std::env::var("KLAKA_OLLAMA_URL").ok();
    let embed_model = std::env::var("KLAKA_EMBED_MODEL").unwrap_or_else(|_| "bge-m3".to_owned());
    let retention_days: i32 = env("KLAKA_RETENTION_DAYS", 30);
    let mut embedder: Option<Ollama> = None;
    let mut embed_error: Option<String> = None;

    eprintln!(
        "klaka-engine: detektori {GHOST_VIEWS}, {UNREAD_VOTES}, {FOCUSED_VOTES}, \
         {COORDINATED_VOTES}, {UNWRITTEN_COMMENTS}, {SHARED_TEMPLATES}; svakih {}s, prozor {}s",
        interval.as_secs(),
        cfg.window.as_secs()
    );
    let mut tick = tokio::time::interval(interval);
    loop {
        tokio::select! {
            _ = tick.tick() => {}
            _ = tokio::signal::ctrl_c() => return,
        }
        // Embeddings novih komentara pre detektora. Bez Ollama-e šabloni rade samo preko
        // MinHash-a (kopije); veza se ponovo pokušava svaki krug.
        if let Some(url) = &ollama_url {
            if embedder.is_none() {
                match Ollama::connect(url, &embed_model, EMBED_TIMEOUT).await {
                    Ok(e) => {
                        eprintln!("klaka-engine: embeddings {}", e.model());
                        embedder = Some(e);
                        embed_error = None;
                    }
                    Err(e) => warn_once(&mut embed_error, format!("embeddings nedostupni: {e}")),
                }
            }
            if let Some(e) = &embedder {
                if let Err(err) = embed_pending(&pool, e, &cfg, EMBED_BATCH).await {
                    warn_once(&mut embed_error, format!("embeddings: {err}"));
                }
            }
        }
        if let Err(e) = purge_embeddings(&pool, retention_days).await {
            eprintln!("klaka-engine: brisanje starih embeddings-a: {e}");
        }

        let mut findings = Vec::new();
        collect(GHOST_VIEWS, ghost_cohorts(&pool, &cfg).await, &mut findings);
        collect(
            UNREAD_VOTES,
            unread_cohorts(&pool, &cfg).await,
            &mut findings,
        );
        collect(
            UNWRITTEN_COMMENTS,
            unwritten_cohorts(&pool, &cfg).await,
            &mut findings,
        );
        // Grafovi prvo: prefiksi njihovih kohorti (rasuta klaka) ne ulaze u organski udeo
        // detektora po prefiksu.
        let coordinated = coordinated_cohorts(&pool, &cfg).await;
        let mut graph = nets(coordinated.as_deref().unwrap_or_default());
        let model = embedder.as_ref().map(|e| e.model());
        match template_cohorts(&pool, &cfg, model, &graph).await {
            Ok(t) => {
                graph.extend(nets(&t.members));
                findings.extend(t.cohorts.into_iter().map(Finding::from));
                findings.extend(
                    t.members
                        .into_iter()
                        .map(|m| m.finding(COORDINATED_TEMPLATES)),
                );
            }
            Err(e) => eprintln!("klaka-engine: detektor {SHARED_TEMPLATES}: {e}"),
        }
        collect(COORDINATED_VOTES, coordinated, &mut findings);
        collect(
            FOCUSED_VOTES,
            focused_cohorts(&pool, &cfg, &graph).await,
            &mut findings,
        );
        for ((portal, net), findings) in group_by_net(findings) {
            let detector = detectors(&findings);
            let evidence = json!({
                "window_s": cfg.window.as_secs(),
                "cohorts": findings.iter().map(|f| f.evidence.clone()).collect::<Vec<_>>(),
            });
            let verdict = NetVerdict {
                portal: &portal,
                net: &net,
                detector: &detector,
                evidence,
            };
            match issue_net_shadow(&pool, &mut valkey, verdict, &cfg, now_ms()).await {
                Ok(Some(i)) if i.top_up => eprintln!(
                    "klaka-engine: dopuna naknadnog shadow-a {portal} {net} (rev {}): {} komentara, \
                     {} glasova stiglo posle presude",
                    i.rev, i.retro_comments, i.retro_votes
                ),
                Ok(Some(i)) => eprintln!(
                    "klaka-engine: presuda shadow {portal} {net} (rev {}, {detector}): {} kohorti, \
                     {} akcija; naknadno {} komentara, {} glasova",
                    i.rev,
                    findings.len(),
                    findings.iter().map(|f| f.votes).sum::<i64>(),
                    i.retro_comments,
                    i.retro_votes
                ),
                Ok(None) => {}
                Err(e) => eprintln!("klaka-engine: presuda {portal} {net} nije upisana: {e}"),
            }
        }
    }
}

const EMBED_TIMEOUT: Duration = Duration::from_secs(60);
const EMBED_BATCH: i64 = 32;

/// Ista greška se ne ponavlja u logu svakog kruga.
fn warn_once(last: &mut Option<String>, msg: String) {
    if last.as_deref() != Some(msg.as_str()) {
        eprintln!("klaka-engine: {msg}");
        *last = Some(msg);
    }
}

/// Nalazi jednog detektora; greška jednog ne zaustavlja ostale.
fn collect<T: Into<Finding>>(
    name: &str,
    found: Result<Vec<T>, sqlx::Error>,
    out: &mut Vec<Finding>,
) {
    match found {
        Ok(c) => out.extend(c.into_iter().map(Into::into)),
        Err(e) => eprintln!("klaka-engine: detektor {name}: {e}"),
    }
}

fn now_ms() -> i64 {
    let d = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("sat pre 1970");
    i64::try_from(d.as_millis()).expect("vreme van opsega i64")
}

fn env<T: FromStr>(name: &str, default: T) -> T {
    match std::env::var(name) {
        Ok(v) => v
            .parse()
            .unwrap_or_else(|_| fail(&format!("{name}: neispravna vrednost"))),
        Err(_) => default,
    }
}

fn fail(msg: &str) -> ! {
    eprintln!("klaka-engine: {msg}");
    std::process::exit(1)
}
