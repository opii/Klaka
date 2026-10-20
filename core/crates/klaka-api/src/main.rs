//! Izdavanje tokena pregleda, upravljanje presudama, UI recenzenta (htmx + askama).
//!
//! Konfiguracija iz okruženja:
//! - `KLAKA_API_ADDR`      adresa (podrazumevano `0.0.0.0:8081`)
//! - `KLAKA_PORTALS`       portali, odvojeni zarezom (podrazumevano `demo.local`)
//! - `KLAKA_SIGNING_KID`   ID ključa (podrazumevano `dev-1`)
//! - `KLAKA_SIGNING_SEED`  Ed25519 seed, base64url 32 bajta; bez njega privremeni ključ

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::SigningKey;
use klaka_api::{Config, app};
use klaka_core::token::valid_kid;

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
    };
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .unwrap_or_else(|e| fail(&format!("ne mogu da slušam na {addr}: {e}")));
    eprintln!("klaka-api sluša na {addr}");
    axum::serve(listener, app(cfg))
        .with_graceful_shutdown(shutdown())
        .await
        .unwrap_or_else(|e| fail(&format!("server: {e}")));
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
