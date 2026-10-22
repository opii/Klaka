//! Izdavanje tokena pregleda, upravljanje presudama, UI recenzenta (askama).
//!
//! Konfiguracija iz okruženja:
//! - `KLAKA_API_ADDR`          adresa (podrazumevano `0.0.0.0:8081`)
//! - `KLAKA_PORTALS`           portali, odvojeni zarezom (podrazumevano `demo.local`)
//! - `KLAKA_SIGNING_KID`       ID ključa (podrazumevano `dev-1`)
//! - `KLAKA_SIGNING_SEED`      Ed25519 seed, base64url 32 bajta; bez njega privremeni ključ
//! - `KLAKA_POSTGRES_URL`      beleženje izdatih prikaza; bez njega se ne beleže
//! - `KLAKA_CLIENT_IP_HEADER`  zaglavlje sa IP-jem klijenta iza pouzdanog proxy-ja
//! - `KLAKA_REVIEW_TOKENS`     recenzenti, `ime:token` odvojeni zarezom (token ≥ 16 znakova);
//!   bez njih nema UI-ja recenzenta. Traži i `KLAKA_POSTGRES_URL` i `KLAKA_VALKEY_URL`.
//! - `KLAKA_REVIEW_ADDR`       adresa UI-ja recenzenta (podrazumevano `0.0.0.0:8083`) — poseban
//!   listener, nikad javna adresa `/v1/view`
//! - `KLAKA_PORTAL_LINKS`      javne adrese portala za linkove sa presude na komentar,
//!   `portal=http://…` odvojeni zarezom (npr. `demo.local=http://localhost:18082`)

use std::net::SocketAddr;

use axum::http::HeaderName;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::SigningKey;
use klaka_api::issued::IssuedLog;
use klaka_api::review::{self, Review};
use klaka_api::{Config, app};
use klaka_core::token::valid_kid;
use klaka_db::{MIGRATOR, PgStore};
use sqlx::postgres::PgPoolOptions;

#[tokio::main]
async fn main() {
    let addr = env_or("KLAKA_API_ADDR", "0.0.0.0:8081");
    let kid = env_or("KLAKA_SIGNING_KID", "dev-1");
    if !valid_kid(&kid) {
        fail(&format!(
            "KLAKA_SIGNING_KID `{kid}` nije u obliku [a-z0-9-]{{1,32}}"
        ));
    }
    let portals = env_or("KLAKA_PORTALS", "demo.local")
        .split(',')
        .map(|p| p.trim().to_owned())
        .filter(|p| !p.is_empty())
        .collect();

    let cfg = Config {
        kid,
        signing_key: signing_key(),
        portals,
        client_ip_header: std::env::var("KLAKA_CLIENT_IP_HEADER")
            .ok()
            .filter(|h| !h.trim().is_empty())
            .map(|h| {
                HeaderName::try_from(h.trim())
                    .unwrap_or_else(|_| fail("KLAKA_CLIENT_IP_HEADER nije ispravno ime zaglavlja"))
            }),
        issued: issued_log().await,
    };
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .unwrap_or_else(|e| fail(&format!("ne mogu da slušam na {addr}: {e}")));
    eprintln!("klaka-api sluša na {addr}");
    let api = axum::serve(
        listener,
        app(cfg).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown());
    let Some((review_addr, review)) = review_ui() else {
        api.await.unwrap_or_else(|e| fail(&format!("server: {e}")));
        return;
    };
    let listener = tokio::net::TcpListener::bind(&review_addr)
        .await
        .unwrap_or_else(|e| fail(&format!("ne mogu da slušam na {review_addr}: {e}")));
    eprintln!("klaka-api: UI recenzenta na {review_addr}");
    let ui = axum::serve(listener, review::router(review)).with_graceful_shutdown(shutdown());
    let (a, b) = tokio::join!(api, ui);
    a.unwrap_or_else(|e| fail(&format!("server: {e}")));
    b.unwrap_or_else(|e| fail(&format!("UI recenzenta: {e}")));
}

/// Token recenzenta: najmanje ovoliko znakova.
const REVIEW_TOKEN_MIN: usize = 16;

/// UI recenzenta, ako su recenzenti zadati.
fn review_ui() -> Option<(String, Review)> {
    let raw = std::env::var("KLAKA_REVIEW_TOKENS")
        .ok()
        .filter(|v| !v.trim().is_empty());
    let Some(raw) = raw else {
        eprintln!("klaka-api: UI recenzenta isključen (KLAKA_REVIEW_TOKENS nije postavljen)");
        return None;
    };
    let reviewers: Vec<(String, String)> = raw
        .split(',')
        .map(|entry| {
            let (name, token) = entry
                .trim()
                .split_once(':')
                .unwrap_or_else(|| fail("KLAKA_REVIEW_TOKENS: unos mora biti `ime:token`"));
            if name.is_empty() || token.chars().count() < REVIEW_TOKEN_MIN {
                fail(&format!(
                    "KLAKA_REVIEW_TOKENS: ime prazno ili token kraći od {REVIEW_TOKEN_MIN} znakova"
                ));
            }
            (name.to_owned(), token.to_owned())
        })
        .collect();
    let db_url = std::env::var("KLAKA_POSTGRES_URL")
        .ok()
        .filter(|u| !u.is_empty())
        .unwrap_or_else(|| fail("UI recenzenta traži KLAKA_POSTGRES_URL"));
    let valkey_url = std::env::var("KLAKA_VALKEY_URL")
        .ok()
        .filter(|u| !u.is_empty())
        .unwrap_or_else(|| fail("UI recenzenta traži KLAKA_VALKEY_URL"));
    let pool = PgPoolOptions::new()
        .connect_lazy(&db_url)
        .unwrap_or_else(|e| fail(&format!("KLAKA_POSTGRES_URL: {e}")));
    let valkey =
        redis::Client::open(valkey_url).unwrap_or_else(|e| fail(&format!("KLAKA_VALKEY_URL: {e}")));
    Some((
        env_or("KLAKA_REVIEW_ADDR", "0.0.0.0:8083"),
        Review {
            pool,
            valkey,
            reviewers,
            portals: std::env::var("KLAKA_PORTAL_LINKS")
                .unwrap_or_default()
                .split(',')
                .filter_map(|e| e.split_once('='))
                .map(|(p, u)| (p.trim().to_owned(), u.trim().to_owned()))
                .filter(|(p, u)| !p.is_empty() && u.starts_with("http"))
                .collect(),
        },
    ))
}

/// Baza nije uslov za izdavanje tokena: ako nije dostupna pri startu, prikazi se ne beleže dok
/// ne proradi (pool se povezuje lenjo), a token se izdaje i dalje.
async fn issued_log() -> Option<IssuedLog> {
    let url = std::env::var("KLAKA_POSTGRES_URL")
        .ok()
        .filter(|u| !u.is_empty())?;
    let pool = PgPoolOptions::new()
        .connect_lazy(&url)
        .unwrap_or_else(|e| fail(&format!("KLAKA_POSTGRES_URL: {e}")));
    if let Err(e) = MIGRATOR.run(&pool).await {
        eprintln!("UPOZORENJE: migracije nisu izvršene ({e}); beleženje prikaza možda ne radi");
    }
    Some(IssuedLog::spawn(PgStore(pool)))
}

fn signing_key() -> SigningKey {
    // Prazna vrednost (npr. `${KLAKA_SIGNING_SEED:-}` iz compose-a) = nije postavljena.
    match std::env::var("KLAKA_SIGNING_SEED")
        .ok()
        .filter(|s| !s.trim().is_empty())
    {
        Some(seed) => {
            let bytes = URL_SAFE_NO_PAD
                .decode(seed.trim())
                .ok()
                .and_then(|b| <[u8; 32]>::try_from(b).ok())
                .unwrap_or_else(|| fail("KLAKA_SIGNING_SEED mora biti base64url od 32 bajta"));
            SigningKey::from_bytes(&bytes)
        }
        None => {
            eprintln!(
                "UPOZORENJE: KLAKA_SIGNING_SEED nije postavljen — privremeni ključ; tokeni ne važe posle restarta"
            );
            let mut seed = [0u8; 32];
            getrandom::fill(&mut seed).expect("OS izvor slučajnosti nije dostupan");
            SigningKey::from_bytes(&seed)
        }
    }
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

fn env_or(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.to_owned())
}

fn fail(msg: &str) -> ! {
    eprintln!("klaka-api: {msg}");
    std::process::exit(1)
}
