//! PostgreSQL: migracije (`core/migrations/`), tabela `events` (particije po danu) i upis u nju.
//! Zajedničko za `klaka-collector` i `klaka-api`.

use std::future::Future;

use klaka_core::events::Event;
use serde_json::Value;
use sqlx::PgPool;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Browser,
    Server,
    /// `klaka-api`: izdati prikazi.
    Api,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Browser => "browser",
            Self::Server => "server",
            Self::Api => "api",
        }
    }
}

/// Jedan red tabele `events`.
#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    pub kind: &'static str,
    pub t: i64,
    pub vid: Option<String>,
    pub post: Option<String>,
    pub net: Option<String>,
    pub data: Value,
}

impl Row {
    pub fn from_event<E: Event>(e: &E, net: Option<String>) -> Self {
        Self {
            kind: e.kind(),
            t: e.t(),
            vid: e.vid().map(str::to_owned),
            post: e.post().map(str::to_owned),
            net,
            data: serde_json::to_value(e).expect("događaj se uvek serijalizuje"),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Batch {
    pub portal: String,
    pub source: Source,
    pub rows: Vec<Row>,
}

pub trait Store: Send + Sync + 'static {
    fn insert(&self, batch: Batch) -> impl Future<Output = Result<(), sqlx::Error>> + Send;
}

pub struct PgStore(pub PgPool);

impl Store for PgStore {
    async fn insert(&self, b: Batch) -> Result<(), sqlx::Error> {
        let n = b.rows.len();
        let (mut kind, mut t, mut vid, mut post, mut net, mut data) = (
            Vec::with_capacity(n),
            Vec::with_capacity(n),
            Vec::with_capacity(n),
            Vec::with_capacity(n),
            Vec::with_capacity(n),
            Vec::with_capacity(n),
        );
        for r in b.rows {
            kind.push(r.kind);
            t.push(r.t);
            vid.push(r.vid);
            post.push(r.post);
            net.push(r.net);
            data.push(r.data);
        }
        sqlx::query(
            "INSERT INTO events (portal, source, type, t, vid, post, net, data)
             SELECT $1, $2, * FROM UNNEST($3::text[], $4::int8[], $5::text[], $6::text[], $7::text[], $8::jsonb[])",
        )
        .bind(b.portal)
        .bind(b.source.as_str())
        .bind(kind)
        .bind(t)
        .bind(vid)
        .bind(post)
        .bind(net)
        .bind(data)
        .execute(&self.0)
        .await?;
        Ok(())
    }
}

/// Pravi particije unapred i briše stare (`klaka_event_partitions` iz migracije).
/// Vraća promene, npr. `created events_20261021`.
pub async fn maintain_partitions(
    pool: &PgPool,
    retention_days: i32,
) -> Result<Vec<String>, sqlx::Error> {
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT action, partition FROM klaka_event_partitions($1, 2)")
            .bind(retention_days)
            .fetch_all(pool)
            .await?;
    Ok(rows.into_iter().map(|(a, p)| format!("{a} {p}")).collect())
}

pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("../../migrations");
