//! Prima događaje iz browsera i SDK-ova, upisuje u PostgreSQL (particije po danu).
//!
//! Konfiguracija iz okruženja:
//! - `KLAKA_COLLECTOR_ADDR`    adresa (podrazumevano `0.0.0.0:8080`)
//! - `KLAKA_POSTGRES_URL`      baza (obavezno)
//! - `KLAKA_PORTALS`           portali, odvojeni zarezom (podrazumevano `demo.local`)
//! - `KLAKA_API_KEYS`          `portal=ključ`, odvojeni zarezom; bez njih `/v1/ingest` odbija sve
//! - `KLAKA_CLIENT_IP_HEADER`  zaglavlje sa IP-jem klijenta iza pouzdanog proxy-ja (npr. `x-forwarded-for`)
//! - `KLAKA_RETENTION_DAYS`    koliko dana se čuvaju događaji (podrazumevano 30)

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::http::HeaderName;
use klaka_collector::{Config, MIGRATOR, PgStore, Stats, app, maintain_partitions};
use sqlx::PgPool;

const MAINTENANCE_EVERY: Duration = Duration::from_secs(3600);

#[tokio::main]
async fn main() {
    let addr = env_or("KLAKA_COLLECTOR_ADDR", "0.0.0.0:8080");
    let db_url = std::env::var("KLAKA_POSTGRES_URL")
        .unwrap_or_else(|_| fail("KLAKA_POSTGRES_URL nije postavljen"));
    let retention: i32 = env_or("KLAKA_RETENTION_DAYS", "30")
        .parse()
        .ok()
        .filter(|d| *d >= 1)
        .unwrap_or_else(|| fail("KLAKA_RETENTION_DAYS mora biti ceo broj ≥ 1"));
    let cfg = Config {
        portals: list("KLAKA_PORTALS", "demo.local").collect(),
        api_keys: list("KLAKA_API_KEYS", "")
            .map(|kv| match kv.split_once('=') {
                Some((p, k)) if !p.is_empty() && !k.is_empty() => (k.to_owned(), p.to_owned()),
                // Bez ispisa vrednosti: sadrži ključ.
                _ => fail("KLAKA_API_KEYS: očekivano `portal=ključ`"),
            })
            .collect(),
        client_ip_header: std::env::var("KLAKA_CLIENT_IP_HEADER")
            .ok()
            .filter(|h| !h.trim().is_empty())
            .map(|h| {
                HeaderName::try_from(h.trim())
                    .unwrap_or_else(|_| fail("KLAKA_CLIENT_IP_HEADER nije ispravno ime zaglavlja"))
            }),
    };
    if cfg.api_keys.is_empty() {
        eprintln!("UPOZORENJE: KLAKA_API_KEYS nije postavljen — /v1/ingest odbija sve zahteve");
    }

    let pool = PgPool::connect(&db_url)
        .await
        .unwrap_or_else(|e| fail(&format!("baza: {e}")));
    MIGRATOR
        .run(&pool)
        .await
        .unwrap_or_else(|e| fail(&format!("migracije: {e}")));
    // Particija za danas mora da postoji pre prvog upisa.
    maintain(&pool, retention)
        .await
        .unwrap_or_else(|e| fail(&format!("particije: {e}")));

    let stats = Arc::new(Stats::default());
    tokio::spawn(maintenance_loop(pool.clone(), retention, stats.clone()));

    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .unwrap_or_else(|e| fail(&format!("ne mogu da slušam na {addr}: {e}")));
    eprintln!("klaka-collector sluša na {addr}");
    let app = app(cfg, PgStore(pool), stats);
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown())
    .await
    .unwrap_or_else(|e| fail(&format!("server: {e}")));
}

async fn maintenance_loop(pool: PgPool, retention: i32, stats: Arc<Stats>) {
    let mut tick = tokio::time::interval(MAINTENANCE_EVERY);
    tick.tick().await;
    loop {
        tick.tick().await;
        if let Err(e) = maintain(&pool, retention).await {
            eprintln!("klaka-collector: održavanje particija nije uspelo: {e}");
        }
        let (accepted, rejected, errors) = stats.take();
        eprintln!(
            "klaka-collector: poslednji sat — upisano {accepted}, odbačeno {rejected}, greške upisa {errors}"
        );
    }
}

async fn maintain(pool: &PgPool, retention: i32) -> Result<(), sqlx::Error> {
    for change in maintain_partitions(pool, retention).await? {
        eprintln!("klaka-collector: particija {change}");
    }
    Ok(())
}

async fn shutdown() {
    let ctrl_c = async {
        tokio::signal::ctrl_c().await.ok();
    };
    #[cfg(unix)]
    let term = async {
        if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! { _ = ctrl_c => {}, _ = term => {} }
}

fn list(name: &str, default: &str) -> impl Iterator<Item = String> {
    env_or(name, default)
        .split(',')
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .into_iter()
}

fn env_or(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.to_owned())
}

fn fail(msg: &str) -> ! {
    eprintln!("klaka-collector: {msg}");
    std::process::exit(1)
}
