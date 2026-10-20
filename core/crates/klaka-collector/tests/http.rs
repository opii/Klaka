//! `POST /v1/events` i `POST /v1/ingest` kroz ceo router, bez mreže i bez baze.

use std::collections::HashSet;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Body;
use axum::extract::connect_info::MockConnectInfo;
use axum::http::{HeaderName, Request, StatusCode, header};
use klaka_collector::{Batch, Config, Source, Stats, Store, app};
use serde_json::{Value, json};
use tower::ServiceExt;

const VID: &str = "AAECAwQFBgcICQoLDA0ODw";
const KEY: &str = "test-api-key";

#[derive(Clone, Default)]
struct MemStore {
    batches: Arc<Mutex<Vec<Batch>>>,
    fail: bool,
}

impl Store for MemStore {
    async fn insert(&self, batch: Batch) -> Result<(), sqlx::Error> {
        if self.fail {
            return Err(sqlx::Error::PoolTimedOut);
        }
        self.batches.lock().unwrap().push(batch);
        Ok(())
    }
}

fn test_app(store: MemStore, ip_header: Option<&str>) -> Router {
    let cfg = Config {
        portals: HashSet::from(["demo.local".to_owned()]),
        api_keys: vec![(KEY.to_owned(), "demo.local".to_owned())],
        client_ip_header: ip_header.map(|h| HeaderName::from_bytes(h.as_bytes()).unwrap()),
    };
    let peer: SocketAddr = "93.87.12.200:51000".parse().unwrap();
    app(cfg, store, Arc::new(Stats::default())).layer(MockConnectInfo(peer))
}

async fn send(app: Router, req: Request<Body>) -> StatusCode {
    app.oneshot(req).await.unwrap().status()
}

fn envelope(portal: &str, events: Vec<Value>) -> String {
    json!({"v": 1, "portal": portal, "sent_ms": 1, "events": events}).to_string()
}

fn post(path: &str, body: String) -> Request<Body> {
    Request::post(path)
        .header(header::CONTENT_TYPE, "text/plain;charset=UTF-8")
        .body(Body::from(body))
        .unwrap()
}

fn ingest(key: Option<&str>, body: String) -> Request<Body> {
    let mut req = Request::post("/v1/ingest").header(header::CONTENT_TYPE, "application/json");
    if let Some(k) = key {
        req = req.header(header::AUTHORIZATION, format!("Bearer {k}"));
    }
    req.body(Body::from(body)).unwrap()
}

fn honeypot() -> Value {
    json!({"type": "honeypot", "vid": VID, "t": 1, "hp": "hp-1", "kind": "click"})
}

fn vote(net: &str) -> Value {
    json!({
        "type": "vote", "t": 1, "post": "p-1", "vid": VID, "token": "valid", "uses": 1,
        "decision": "count", "net": net, "ua": "UA", "target": "c-1",
        "target_author": null, "dir": 1
    })
}

#[tokio::test]
async fn browser_bad_events_dropped_individually() {
    let store = MemStore::default();
    let body = envelope(
        "demo.local",
        vec![
            honeypot(),
            json!({"type": "nope", "vid": VID, "t": 1}),
            vote("93.87.12.0/24"),
        ],
    );
    let status = send(test_app(store.clone(), None), post("/v1/events", body)).await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let batches = store.batches.lock().unwrap();
    assert_eq!(batches.len(), 1);
    let b = &batches[0];
    assert_eq!(
        (b.portal.as_str(), b.source),
        ("demo.local", Source::Browser)
    );
    assert_eq!(b.rows.len(), 1);
    let row = &b.rows[0];
    assert_eq!(row.kind, "honeypot");
    assert_eq!(row.vid.as_deref(), Some(VID));
    assert_eq!(row.net.as_deref(), Some("93.87.12.0/24"));
}

#[tokio::test]
async fn browser_ip_from_trusted_header_last_value() {
    let store = MemStore::default();
    let req = Request::post("/v1/events")
        .header("x-forwarded-for", "1.2.3.4, 2a02:8109:1234:5678::1")
        .body(Body::from(envelope("demo.local", vec![honeypot()])))
        .unwrap();
    let status = send(test_app(store.clone(), Some("x-forwarded-for")), req).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let net = store.batches.lock().unwrap()[0].rows[0].net.clone();
    assert_eq!(net.as_deref(), Some("2a02:8109:1234::/48"));
}

#[tokio::test]
async fn browser_learns_nothing() {
    // Nepoznat portal, sve odbačeno, baza pala: uvek 204.
    for (store, body) in [
        (
            MemStore::default(),
            envelope("other.example", vec![honeypot()]),
        ),
        (
            MemStore::default(),
            envelope("demo.local", vec![json!({"type": "view"})]),
        ),
        (
            MemStore {
                fail: true,
                ..Default::default()
            },
            envelope("demo.local", vec![honeypot()]),
        ),
    ] {
        let status = send(test_app(store.clone(), None), post("/v1/events", body)).await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        assert!(store.batches.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn browser_bad_envelope_is_400() {
    let too_many = envelope("demo.local", vec![honeypot(); 101]);
    let empty = envelope("demo.local", vec![]);
    let v2 =
        json!({"v": 2, "portal": "demo.local", "sent_ms": 1, "events": [honeypot()]}).to_string();
    for body in ["not json".to_owned(), too_many, empty, v2] {
        let status = send(
            test_app(MemStore::default(), None),
            post("/v1/events", body),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }
}

#[tokio::test]
async fn body_over_64kb_is_rejected() {
    let body = format!("{{\"pad\":\"{}\"}}", "x".repeat(64 * 1024));
    let status = send(
        test_app(MemStore::default(), None),
        post("/v1/events", body),
    )
    .await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
}

#[tokio::test]
async fn ingest_stores_server_events_with_sdk_prefix() {
    let store = MemStore::default();
    let body = envelope(
        "demo.local",
        vec![
            vote("2a02:8109:1234::/48"),
            vote("93.87.12.200"),
            honeypot(),
        ],
    );
    let status = send(test_app(store.clone(), None), ingest(Some(KEY), body)).await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let batches = store.batches.lock().unwrap();
    let b = &batches[0];
    assert_eq!(b.source, Source::Server);
    assert_eq!(b.rows.len(), 1, "pun IP i browser događaj se odbacuju");
    assert_eq!(b.rows[0].kind, "vote");
    assert_eq!(b.rows[0].post.as_deref(), Some("p-1"));
    assert_eq!(b.rows[0].net.as_deref(), Some("2a02:8109:1234::/48"));
}

#[tokio::test]
async fn ingest_auth() {
    let body = || envelope("demo.local", vec![vote("93.87.12.0/24")]);
    let app = || test_app(MemStore::default(), None);
    assert_eq!(
        send(app(), ingest(None, body())).await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        send(app(), ingest(Some("wrong"), body())).await,
        StatusCode::UNAUTHORIZED
    );
    let other = envelope("other.example", vec![vote("93.87.12.0/24")]);
    assert_eq!(
        send(app(), ingest(Some(KEY), other)).await,
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn ingest_store_failure_is_503() {
    let store = MemStore {
        fail: true,
        ..Default::default()
    };
    let body = envelope("demo.local", vec![vote("93.87.12.0/24")]);
    let status = send(test_app(store, None), ingest(Some(KEY), body)).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
}
