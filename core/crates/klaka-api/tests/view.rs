//! `POST /v1/view` i `GET /v1/keys` kroz ceo router, bez mreže.

use std::collections::{HashMap, HashSet};

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use ed25519_dalek::SigningKey;
use http_body_util::BodyExt;
use klaka_api::{Config, app};
use klaka_core::token::{Policy, TokenResult, Verifier, verifying_key_from_b64u};
use serde_json::Value;
use tower::ServiceExt;

fn test_app() -> Router {
    app(Config {
        kid: "dev-1".into(),
        signing_key: SigningKey::from_bytes(&[7u8; 32]),
        portals: HashSet::from(["demo.local".to_owned()]),
    })
}

async fn call(app: Router, req: Request<Body>) -> (StatusCode, Value) {
    let res = app.oneshot(req).await.unwrap();
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

fn view_req(content_type: &str, body: &str) -> Request<Body> {
    Request::post("/v1/view")
        .header(header::CONTENT_TYPE, content_type)
        .body(Body::from(body.to_owned()))
        .unwrap()
}

#[tokio::test]
async fn issued_token_verifies_with_published_key() {
    let (status, view) = call(
        test_app(),
        view_req(
            "application/json",
            r#"{"portal":"demo.local","post":"p-1001"}"#,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let token = view["token"].as_str().unwrap();

    let (_, keys) = call(
        test_app(),
        Request::get("/v1/keys").body(Body::empty()).unwrap(),
    )
    .await;
    let keys: HashMap<_, _> = keys["keys"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(k, v)| {
            (
                k.clone(),
                verifying_key_from_b64u(v.as_str().unwrap()).unwrap(),
            )
        })
        .collect();

    let policy = Policy {
        min_age_ms: 0,
        max_age_ms: 60_000,
        max_uses: 50,
    };
    let v = Verifier::new("demo.local", keys, policy);
    let res = v.verify(Some(token), "p-1001", i64::MAX / 2);
    let payload = res.payload.expect("payload posle koraka 1–5");
    let res = v.verify(Some(token), "p-1001", payload.iat);
    assert_eq!(res.result, TokenResult::Valid);
    assert_eq!(payload.vid, view["vid"].as_str().unwrap());
    assert_eq!(payload.vid.len(), 22);
}

#[tokio::test]
async fn accepts_text_plain_without_preflight() {
    let (status, _) = call(
        test_app(),
        view_req("text/plain", r#"{"portal":"demo.local","post":"p-1"}"#),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn vid_is_unique_per_view() {
    let body = r#"{"portal":"demo.local","post":"p-1"}"#;
    let (_, a) = call(test_app(), view_req("application/json", body)).await;
    let (_, b) = call(test_app(), view_req("application/json", body)).await;
    assert_ne!(a["vid"], b["vid"]);
}

#[tokio::test]
async fn rejects_bad_requests() {
    let cases = [
        (
            r#"{"portal":"other.local","post":"p-1"}"#,
            StatusCode::FORBIDDEN,
        ),
        (
            r#"{"portal":"demo.local","post":""}"#,
            StatusCode::BAD_REQUEST,
        ),
        (r#"{"portal":"demo.local"}"#, StatusCode::BAD_REQUEST),
        ("nije json", StatusCode::BAD_REQUEST),
    ];
    for (body, expect) in cases {
        let (status, _) = call(test_app(), view_req("application/json", body)).await;
        assert_eq!(status, expect, "{body}");
    }
    let long_post = format!(r#"{{"portal":"demo.local","post":"{}"}}"#, "x".repeat(257));
    let (status, _) = call(test_app(), view_req("application/json", &long_post)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let huge = "x".repeat(5000);
    let (status, _) = call(test_app(), view_req("application/json", &huge)).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
}

#[tokio::test]
async fn cors_allows_portal_origin() {
    let res = test_app()
        .oneshot(
            Request::post("/v1/view")
                .header(header::ORIGIN, "https://demo.local")
                .header(header::CONTENT_TYPE, "text/plain")
                .body(Body::from(r#"{"portal":"demo.local","post":"p-1"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
}
