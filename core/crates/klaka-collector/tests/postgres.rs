//! Upis i particije na pravoj bazi. Radi samo uz `KLAKA_TEST_POSTGRES_URL`; svaki test dobija
//! svoju šemu, koja se briše na kraju.
//!
//! docker compose up -d --wait postgres
//! docker compose run --rm -e KLAKA_TEST_POSTGRES_URL=postgres://klaka:klaka-dev@postgres:5432/klaka rust cargo test -p klaka-collector

use klaka_collector::{Batch, MIGRATOR, PgStore, Row, Source, Store, maintain_partitions};
use serde_json::json;
use sqlx::PgPool;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};

struct TestDb {
    admin: PgPool,
    pool: PgPool,
    schema: String,
}

impl TestDb {
    async fn new(name: &str) -> Option<Self> {
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
            .connect_with(opts.options([("search_path", schema.as_str())]))
            .await
            .unwrap();
        MIGRATOR.run(&pool).await.unwrap();
        Some(Self {
            admin,
            pool,
            schema,
        })
    }

    async fn drop(self) {
        self.pool.close().await;
        sqlx::query(&format!("DROP SCHEMA {} CASCADE", self.schema))
            .execute(&self.admin)
            .await
            .unwrap();
    }
}

#[tokio::test]
async fn insert_lands_in_todays_partition() {
    let Some(db) = TestDb::new("insert").await else {
        eprintln!("KLAKA_TEST_POSTGRES_URL nije postavljen — preskačem");
        return;
    };
    let created = maintain_partitions(&db.pool, 30).await.unwrap();
    assert_eq!(created.len(), 3, "danas + 2 dana unapred: {created:?}");
    assert!(
        maintain_partitions(&db.pool, 30).await.unwrap().is_empty(),
        "idempotentno"
    );

    let rows = vec![
        Row {
            kind: "honeypot",
            t: 7,
            vid: Some("v-1".into()),
            post: None,
            net: Some("93.87.12.0/24".into()),
            data: json!({"type": "honeypot", "hp": "hp-1"}),
        },
        Row {
            kind: "promotion",
            t: 8,
            vid: None,
            post: Some("p-1".into()),
            net: None,
            data: json!({"type": "promotion"}),
        },
    ];
    let batch = Batch {
        portal: "demo.local".into(),
        source: Source::Browser,
        rows,
    };
    PgStore(db.pool.clone()).insert(batch).await.unwrap();

    #[derive(sqlx::FromRow)]
    struct Stored {
        portal: String,
        source: String,
        r#type: String,
        vid: Option<String>,
        post: Option<String>,
        net: Option<String>,
        data_type: String,
    }
    let got: Vec<Stored> = sqlx::query_as(
        "SELECT portal, source, type, vid, post, net, data->>'type' AS data_type
         FROM events
         WHERE tableoid = format('events_%s', to_char(now() AT TIME ZONE 'UTC', 'YYYYMMDD'))::regclass
         ORDER BY t",
    )
    .fetch_all(&db.pool)
    .await
    .unwrap();
    assert_eq!(got.len(), 2);
    assert_eq!(
        (got[0].portal.as_str(), got[0].source.as_str()),
        ("demo.local", "browser")
    );
    assert_eq!(got[0].r#type, "honeypot");
    assert_eq!(got[0].vid.as_deref(), Some("v-1"));
    assert_eq!(got[0].net.as_deref(), Some("93.87.12.0/24"));
    assert_eq!(got[1].post.as_deref(), Some("p-1"));
    assert_eq!(got[1].data_type, "promotion");
    db.drop().await;
}

#[tokio::test]
async fn old_partitions_dropped_after_retention() {
    let Some(db) = TestDb::new("retention").await else {
        return;
    };
    sqlx::query(
        "CREATE TABLE events_20000101 PARTITION OF events
         FOR VALUES FROM ('2000-01-01 00:00+00') TO ('2000-01-02 00:00+00')",
    )
    .execute(&db.pool)
    .await
    .unwrap();
    let changes = maintain_partitions(&db.pool, 30).await.unwrap();
    assert!(
        changes.contains(&"dropped events_20000101".to_owned()),
        "{changes:?}"
    );
    db.drop().await;
}
