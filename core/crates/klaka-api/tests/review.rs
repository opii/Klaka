//! UI recenzenta kroz ceo router. Prijava i CSRF bez mreže; red, dokazi i odluka na pravoj
//! bazi samo uz `KLAKA_TEST_POSTGRES_URL` i `KLAKA_TEST_VALKEY_URL` (svaki test svoja šema).

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use http_body_util::BodyExt;
use klaka_api::review::{Review, router};
use klaka_db::{Batch, MIGRATOR, PgStore, Row, Source, Store, maintain_partitions};
use serde_json::json;
use sqlx::PgPool;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use tower::ServiceExt;

const TOKEN: &str = "ana-token-0123456789";
const HOST: &str = "localhost:18083";

fn app(pool: PgPool, valkey: redis::Client) -> Router {
    router(Review {
        pool,
        valkey,
        reviewers: vec![("ana".into(), TOKEN.into())],
    })
}

/// Bez baze i Valkey-ja: veza se ne otvara dok prijava ne prođe.
fn offline() -> Router {
    app(
        PgPoolOptions::new()
            .connect_lazy("postgres://x@127.0.0.1:1/x")
            .unwrap(),
        redis::Client::open("redis://127.0.0.1:1").unwrap(),
    )
}

fn basic(name: &str, token: &str) -> String {
    format!("Basic {}", STANDARD.encode(format!("{name}:{token}")))
}

async fn call(app: Router, req: Request<Body>) -> (StatusCode, axum::http::HeaderMap, String) {
    let res = app.oneshot(req).await.unwrap();
    let (parts, body) = res.into_parts();
    let body = body.collect().await.unwrap().to_bytes();
    (
        parts.status,
        parts.headers,
        String::from_utf8_lossy(&body).into(),
    )
}

fn get(path: &str) -> Request<Body> {
    Request::get(path)
        .header(header::HOST, HOST)
        .header(header::AUTHORIZATION, basic("ana", TOKEN))
        .body(Body::empty())
        .unwrap()
}

fn decide(id: i64, decision: &str, origin: Option<&str>) -> Request<Body> {
    let mut req = Request::post(format!("/presude/{id}/odluka"))
        .header(header::HOST, HOST)
        .header(header::AUTHORIZATION, basic("ana", TOKEN))
        .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded");
    if let Some(o) = origin {
        req = req.header(header::ORIGIN, o);
    }
    req.body(Body::from(format!(
        "decision={decision}&note=ponovljen+obrazac"
    )))
    .unwrap()
}

#[tokio::test]
async fn review_needs_login_and_same_origin() {
    let anonymous = Request::get("/").body(Body::empty()).unwrap();
    let (status, headers, _) = call(offline(), anonymous).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert!(headers.contains_key(header::WWW_AUTHENTICATE));
    assert!(
        headers[header::CONTENT_SECURITY_POLICY]
            .to_str()
            .unwrap()
            .contains("default-src 'none'")
    );

    let wrong = Request::get("/")
        .header(header::AUTHORIZATION, basic("ana", "pogresan-token-0123"))
        .body(Body::empty())
        .unwrap();
    assert_eq!(call(offline(), wrong).await.0, StatusCode::UNAUTHORIZED);
    let other_name = Request::get("/")
        .header(header::AUTHORIZATION, basic("marko", TOKEN))
        .body(Body::empty())
        .unwrap();
    assert_eq!(
        call(offline(), other_name).await.0,
        StatusCode::UNAUTHORIZED
    );

    // Forma sa tuđe stranice (ili bez Origin-a): browser bi Basic podatke poslao i tada.
    for origin in [None, Some("http://napadac.example")] {
        let (status, _, _) = call(offline(), decide(1, "reject", origin)).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{origin:?}");
    }
}

async fn schema(name: &str) -> Option<(PgPool, PgPool, String)> {
    let url = std::env::var("KLAKA_TEST_POSTGRES_URL").ok()?;
    let admin = PgPool::connect(&url).await.unwrap();
    let schema = format!("test_{name}_{}", std::process::id());
    sqlx::raw_sql(&format!(
        "DROP SCHEMA IF EXISTS {schema} CASCADE; CREATE SCHEMA {schema}"
    ))
    .execute(&admin)
    .await
    .unwrap();
    let opts: PgConnectOptions = url.parse().unwrap();
    let pool = PgPoolOptions::new()
        .connect_with(opts.options([("search_path", format!("{schema},public").as_str())]))
        .await
        .unwrap();
    MIGRATOR.run(&pool).await.unwrap();
    maintain_partitions(&pool, 30).await.unwrap();
    Some((admin, pool, schema))
}

#[tokio::test]
async fn reviewer_sees_evidence_and_rejection_stops_the_verdict() {
    let Some((admin, pool, schema)) = schema("review").await else {
        eprintln!("KLAKA_TEST_POSTGRES_URL nije postavljen — preskačem");
        return;
    };
    let Ok(valkey_url) = std::env::var("KLAKA_TEST_VALKEY_URL") else {
        eprintln!("KLAKA_TEST_VALKEY_URL nije postavljen — preskačem");
        return;
    };
    let valkey = redis::Client::open(valkey_url).unwrap();
    let portal = format!("{schema}.local");
    let net = "198.18.51.0/24";
    let row = |vid: &str, data| Row {
        kind: if vid.starts_with('c') {
            "comment"
        } else {
            "vote"
        },
        t: 1,
        vid: Some(vid.to_owned()),
        post: Some("p-1".to_owned()),
        net: Some(net.to_owned()),
        data,
    };
    PgStore(pool.clone())
        .insert(Batch {
            portal: portal.clone(),
            source: Source::Server,
            rows: vec![
                row(
                    "c-1",
                    json!({"type": "comment", "comment": "k1", "author": "Goran",
                           "text": "<script>alert(1)</script> Odlično rečeno.", "decision": "count"}),
                ),
                row(
                    "v-1",
                    json!({"type": "vote", "target": "c7", "dir": -1, "decision": "count"}),
                ),
            ],
        })
        .await
        .unwrap();
    let (id,): (i64,) = sqlx::query_as(
        "INSERT INTO verdicts (portal, key_kind, key, action, until_ms, rev, detector, evidence)
         VALUES ($1, 'net', $2, 'shadow',
                 (extract(epoch FROM now()) * 1000)::bigint + 3600000, 1,
                 'shared-templates+coordinated-templates', $3)
         RETURNING id",
    )
    .bind(&portal)
    .bind(net)
    .bind(json!({"window_s": 600, "cohorts": [
        {"detector": "shared-templates", "comments": 6, "templated": 6, "baseline": 0.0123,
         "lift": 19.5, "p_value": 1.8e-8},
        {"detector": "coordinated-templates", "elements": 3, "partners": 4, "cohort_nets": 16, "posts": 3}
    ]}))
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO verdict_retro (verdict_id, kind, post, comment) VALUES ($1, 'comment', 'p-1', 'k1')",
    )
    .bind(id)
    .execute(&pool)
    .await
    .unwrap();
    // Opis modela je izveden iz neproverenog teksta: i on se escape-uje.
    sqlx::query(
        "INSERT INTO cohort_summary (verdict_id, status, output, model, prompt_version, latency_ms)
         VALUES ($1, 'done', $2, 'gemma3:4b@a2af6cc3eb7f', 'g2-2', 41200)",
    )
    .bind(id)
    .bind(
        json!({"poruka": "Hvale <b>iste</b> komentare.", "stav": "podrška", "kohezija": "visoka",
                 "toksicnost": "nema", "hvale": 6, "napadaju": 0, "skrecu": 0,
                 "sazetak": "Šest šablonskih komentara na tri članka."}),
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("UPDATE cohort_summary SET role = $2 WHERE verdict_id = $1")
        .bind(id)
        .bind(json!({"uloge": ["pojačivač", "ćaci"],
                     "razlozi": ["pojačivač: stav komentara: mešovito", "ćaci: toksičnost komentara: blaga"]}))
        .execute(&pool)
        .await
        .unwrap();
    let ui = || app(pool.clone(), valkey.clone());

    let (status, _, body) = call(ui(), get("/")).await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        body.contains(net) && body.contains("deljeni šabloni"),
        "{body}"
    );
    assert!(body.contains("1 kom. · 0 gl."), "{body}");
    assert!(body.contains("<td>pojačivač, ćaci</td>"), "{body}");

    let (status, _, body) = call(ui(), get(&format!("/presude/{id}"))).await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        body.contains("&#60;script&#62;alert(1)&#60;/script&#62;"),
        "{body}"
    );
    assert!(
        !body.contains("<script>"),
        "tekst komentara nije escape-ovan"
    );
    assert!(
        body.contains("naknadno skinut") && body.contains("protiv"),
        "{body}"
    );
    assert!(
        body.contains("1.8e-8") && body.contains("19.5<") && body.contains("prefiksa u kohorti"),
        "{body}"
    );
    assert!(body.contains("važi: shadow"), "{body}");
    assert!(
        body.contains("nikad za presudu") && body.contains("ćaci: toksičnost komentara: blaga"),
        "{body}"
    );
    assert!(
        body.contains("Hvale &#60;b&#62;iste&#60;/b&#62; komentare.")
            && body.contains("toksičnost")
            && body.contains("<dt>komentara hvali</dt><dd>6</dd>")
            && body.contains("prompt g2-2, 41.2 s"),
        "{body}"
    );

    let origin = format!("http://{HOST}");
    let (status, headers, _) = call(ui(), decide(id, "reject", Some(&origin))).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    assert_eq!(headers[header::LOCATION], format!("/presude/{id}").as_str());

    // Audit: odluka i nova revizija `none`; Valkey: `none` za prefiks.
    let (decision, reviewer, note): (String, String, Option<String>) =
        sqlx::query_as("SELECT decision, reviewer, note FROM verdict_review WHERE verdict_id = $1")
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        (decision.as_str(), reviewer.as_str(), note.as_deref()),
        ("reject", "ana", Some("ponovljen obrazac"))
    );
    let (action, rev): (String, i32) = sqlx::query_as(
        "SELECT action, rev FROM verdicts WHERE portal = $1 AND key = $2 ORDER BY created_at DESC LIMIT 1",
    )
    .bind(&portal)
    .bind(net)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!((action.as_str(), rev), ("none", 2));
    let mut c = valkey.get_multiplexed_async_connection().await.unwrap();
    let key = klaka_core::verdict::net_key(&portal, net);
    let stored: String = redis::cmd("GET")
        .arg(&key)
        .query_async(&mut c)
        .await
        .unwrap();
    assert!(
        stored.contains("\"none\"") && stored.contains("\"rev\":2"),
        "{stored}"
    );

    let (_, _, body) = call(ui(), get(&format!("/presude/{id}"))).await;
    assert!(
        body.contains("odbačena") && body.contains("ana odbacio"),
        "{body}"
    );
    let (_, _, body) = call(ui(), get("/")).await;
    assert!(!body.contains(net), "pregledana nije u redu: {body}");
    assert!(body.contains("<strong>0%</strong>"), "{body}");
    let (_, _, body) = call(ui(), get("/?sve=1")).await;
    assert!(body.contains("odbačena (ana)"), "{body}");

    redis::cmd("DEL")
        .arg(&key)
        .query_async::<()>(&mut c)
        .await
        .unwrap();
    pool.close().await;
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&admin)
        .await
        .unwrap();
}
