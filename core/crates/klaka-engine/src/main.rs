//! Detektori kohorti; presude upisuje u Valkey (SDK ih čita) i u audit (PostgreSQL).
//!
//! Konfiguracija iz okruženja:
//! - `KLAKA_POSTGRES_URL`, `KLAKA_VALKEY_URL`  (obavezno)
//! - `KLAKA_ENGINE_INTERVAL_S`   koliko često se detektori pokreću (podrazumevano 10)
//! - `KLAKA_ENGINE_WINDOW_S`     prozor posmatranja (600)
//! - `KLAKA_ENGINE_MIN_VOTES`, `KLAKA_ENGINE_MIN_VIDS`, `KLAKA_ENGINE_MIN_FLAGGED_SHARE`
//!   pragovi detektora: glasova, prikaza i udeo označenih prikaza (5, 3, 0.8)
//! - `KLAKA_ENGINE_TTL_S`        trajanje presude (3600)

use std::str::FromStr;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use klaka_db::MIGRATOR;
use klaka_engine::{
    Config, GHOST_VIEWS, NetVerdict, UNREAD_VOTES, detectors, ghost_cohorts, group_by_net,
    issue_net_shadow, unread_cohorts,
};
use serde_json::json;
use sqlx::PgPool;

#[tokio::main]
async fn main() {
    let db_url = std::env::var("KLAKA_POSTGRES_URL")
        .unwrap_or_else(|_| fail("KLAKA_POSTGRES_URL nije postavljen"));
    let valkey_url = std::env::var("KLAKA_VALKEY_URL")
        .unwrap_or_else(|_| fail("KLAKA_VALKEY_URL nije postavljen"));
    let interval = Duration::from_secs(env("KLAKA_ENGINE_INTERVAL_S", 10));
    let cfg = Config {
        window: Duration::from_secs(env("KLAKA_ENGINE_WINDOW_S", 600)),
        min_votes: env("KLAKA_ENGINE_MIN_VOTES", 5),
        min_vids: env("KLAKA_ENGINE_MIN_VIDS", 3),
        min_flagged_share: env("KLAKA_ENGINE_MIN_FLAGGED_SHARE", 0.8),
        ttl: Duration::from_secs(env("KLAKA_ENGINE_TTL_S", 3600)),
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

    eprintln!(
        "klaka-engine: detektori {GHOST_VIEWS}, {UNREAD_VOTES}; svakih {}s, prozor {}s",
        interval.as_secs(),
        cfg.window.as_secs()
    );
    let mut tick = tokio::time::interval(interval);
    loop {
        tokio::select! {
            _ = tick.tick() => {}
            _ = tokio::signal::ctrl_c() => return,
        }
        let mut cohorts = Vec::new();
        for (name, found) in [
            (GHOST_VIEWS, ghost_cohorts(&pool, &cfg).await),
            (UNREAD_VOTES, unread_cohorts(&pool, &cfg).await),
        ] {
            match found {
                Ok(c) => cohorts.extend(c),
                Err(e) => eprintln!("klaka-engine: detektor {name}: {e}"),
            }
        }
        for ((portal, net), cohorts) in group_by_net(cohorts) {
            let detector = detectors(&cohorts);
            let evidence = json!({
                "window_s": cfg.window.as_secs(),
                "cohorts": cohorts.iter().map(|c| json!({
                    "detector": c.detector, "target": c.target,
                    "votes": c.votes, "vids": c.vids, "flagged": c.flagged,
                })).collect::<Vec<_>>(),
            });
            let verdict = NetVerdict {
                portal: &portal,
                net: &net,
                detector: &detector,
                evidence,
            };
            match issue_net_shadow(&pool, &mut valkey, verdict, &cfg, now_ms()).await {
                Ok(Some(rev)) => eprintln!(
                    "klaka-engine: presuda shadow {portal} {net} (rev {rev}, {detector}): {} kohorti, {} glasova",
                    cohorts.len(),
                    cohorts.iter().map(|c| c.votes).sum::<i64>()
                ),
                Ok(None) => {}
                Err(e) => eprintln!("klaka-engine: presuda {portal} {net} nije upisana: {e}"),
            }
        }
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
