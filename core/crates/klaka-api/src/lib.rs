//! Izdavanje tokena pregleda (`spec/token.md` §5) i objava javnih ključeva.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::{DefaultBodyLimit, State};
use axum::http::{Method, StatusCode, header};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::SigningKey;
use klaka_core::token::{Payload, issue};
use serde::{Deserialize, Serialize};
use tower_http::cors::{Any, CorsLayer};

const MAX_BODY: usize = 4 * 1024;
const POST_MAX_LEN: usize = 256;

pub struct Config {
    pub kid: String,
    pub signing_key: SigningKey,
    /// Portali za koje se izdaju tokeni. *(PoC: post se prihvata bilo koji.)*
    pub portals: HashSet<String>,
}

pub fn app(cfg: Config) -> Router {
    // Bilo koji origin: izdavanje tokena je javno, a ograničenje origin-a ne bi zaustavilo
    // nikoga ko zove sa servera. Zaštita je u potpisu i u proverama kod SDK-a.
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::POST])
        .allow_headers([header::CONTENT_TYPE]);

    Router::new()
        .route("/v1/view", post(view))
        .route("/v1/keys", get(keys))
        .route("/healthz", get(|| async { "ok" }))
        .layer(DefaultBodyLimit::max(MAX_BODY))
        .layer(cors)
        .with_state(Arc::new(cfg))
}

#[derive(Deserialize)]
struct ViewRequest {
    portal: String,
    post: String,
}

#[derive(Serialize)]
struct ViewResponse {
    token: String,
    vid: String,
}

/// Telo se čita kao tekst: browser sme da pošalje `text/plain`, što ne pokreće CORS
/// preflight (isto kao za `/v1/events`, `spec/events.md` §1).
async fn view(
    State(cfg): State<Arc<Config>>,
    body: String,
) -> Result<Json<ViewResponse>, StatusCode> {
    let req: ViewRequest = serde_json::from_str(&body).map_err(|_| StatusCode::BAD_REQUEST)?;
    if req.post.is_empty() || req.post.len() > POST_MAX_LEN {
        return Err(StatusCode::BAD_REQUEST);
    }
    if !cfg.portals.contains(&req.portal) {
        return Err(StatusCode::FORBIDDEN);
    }
    let vid = new_vid();
    let payload = Payload {
        v: 1,
        portal: req.portal,
        post: req.post,
        vid: vid.clone(),
        iat: now_ms(),
    };
    let token = issue(&cfg.signing_key, &cfg.kid, &payload);
    Ok(Json(ViewResponse { token, vid }))
}

#[derive(Serialize)]
struct KeysResponse {
    keys: HashMap<String, String>,
}

/// Javni ključevi za konfiguraciju SDK-a (`spec/sdk.md` §3). Javni ključ nije tajna.
async fn keys(State(cfg): State<Arc<Config>>) -> Json<KeysResponse> {
    let public = URL_SAFE_NO_PAD.encode(cfg.signing_key.verifying_key().to_bytes());
    Json(KeysResponse {
        keys: HashMap::from([(cfg.kid.clone(), public)]),
    })
}

/// `vid` = 16 bajtova iz CSPRNG-a, base64url (22 znaka). Generiše ga server, nikad browser.
fn new_vid() -> String {
    let mut buf = [0u8; 16];
    getrandom::fill(&mut buf).expect("OS izvor slučajnosti nije dostupan");
    URL_SAFE_NO_PAD.encode(buf)
}

fn now_ms() -> i64 {
    let d = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("sat pre 1970");
    i64::try_from(d.as_millis()).expect("vreme van opsega i64")
}
