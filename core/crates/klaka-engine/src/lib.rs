//! Detektori kohorti i presude (`spec/verdicts.md`).
//!
//! Prvi detektor — **prikazi-duhovi**: presek tri dimenzije (koncept §2a) u vremenskom prozoru:
//! - mrežna: glasovi iz istog prefiksa (/24, /48);
//! - ciljna: na isti cilj;
//! - bihevioralna: sa prikaza koje je `klaka-api` izdao, a za koje browser nikad nije poslao
//!   `view` ni `engage` — token je uzet, stranica nije prikazana.
//!
//! Sama mreža nije dovoljna (verdicts.md §4: CGNAT deli /24 sa hiljadama ljudi); legitimni
//! čitaoci iza istog prefiksa imaju browser događaje i ne ulaze u kohortu.

use std::collections::BTreeMap;
use std::time::Duration;

use redis::aio::MultiplexedConnection;
use serde_json::{Value, json};
use sqlx::PgPool;

pub const DETECTOR: &str = "ghost-views";

#[derive(Debug, Clone)]
pub struct Config {
    /// Prozor posmatranja.
    pub window: Duration,
    /// Najmanje glasova iz prefiksa na isti cilj.
    pub min_votes: i64,
    /// Najmanje različitih prikaza (`vid`) među tim glasovima.
    pub min_vids: i64,
    /// Najmanji udeo prikaza-duhova među njima.
    pub min_ghost_share: f64,
    /// Koliko dugo presuda važi.
    pub ttl: Duration,
}

/// Kohorta: glasovi iz jednog prefiksa na jedan cilj, u prozoru.
#[derive(Debug, Clone, PartialEq, sqlx::FromRow)]
pub struct Cohort {
    pub portal: String,
    pub net: String,
    pub target: String,
    pub votes: i64,
    pub vids: i64,
    pub ghosts: i64,
}

/// Kohorte iznad pragova. Prikaz je „duh" ako za njega u prozoru (+ najduže trajanje tokena)
/// nema nijednog browser `view` ili `engage` događaja.
pub async fn ghost_cohorts(pool: &PgPool, cfg: &Config) -> Result<Vec<Cohort>, sqlx::Error> {
    sqlx::query_as(
        "WITH v AS (
             SELECT portal, net, data->>'target' AS target, vid
             FROM events
             WHERE type = 'vote' AND source = 'server' AND vid IS NOT NULL
               AND recv_at > now() - make_interval(secs => $1)
         ),
         c AS (
             SELECT portal, net, target, count(*) AS votes, count(DISTINCT vid) AS vids,
                    count(DISTINCT vid) FILTER (WHERE NOT EXISTS (
                        SELECT 1 FROM events b
                        WHERE b.vid = v.vid AND b.source = 'browser' AND b.type IN ('view', 'engage')
                          AND b.recv_at > now() - make_interval(secs => $1) - interval '2 hours'
                    )) AS ghosts
             FROM v
             GROUP BY portal, net, target
         )
         SELECT portal, net, target, votes, vids, ghosts
         FROM c
         WHERE votes >= $2 AND vids >= $3 AND ghosts::float8 >= $4 * vids
         ORDER BY portal, net, target",
    )
    .bind(cfg.window.as_secs_f64())
    .bind(cfg.min_votes)
    .bind(cfg.min_vids)
    .bind(cfg.min_ghost_share)
    .fetch_all(pool)
    .await
}

/// Vrednost ključa presude u Valkey-ju (verdicts.md §2) — bez razloga i dokaza.
pub fn verdict_value(action: &str, until_ms: i64, rev: i32) -> String {
    json!({"action": action, "until_ms": until_ms, "rev": rev}).to_string()
}

pub fn net_key(portal: &str, net: &str) -> String {
    format!("klaka:v1:{portal}:net:{net}")
}

/// Jedna presuda po prefiksu, sa dokazima svih njegovih kohorti.
pub fn group_by_net(cohorts: Vec<Cohort>) -> BTreeMap<(String, String), Vec<Cohort>> {
    let mut out: BTreeMap<(String, String), Vec<Cohort>> = BTreeMap::new();
    for c in cohorts {
        out.entry((c.portal.clone(), c.net.clone()))
            .or_default()
            .push(c);
    }
    out
}

#[derive(Debug)]
pub enum IssueError {
    Db(sqlx::Error),
    Valkey(redis::RedisError),
}

impl std::fmt::Display for IssueError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Db(e) => write!(f, "baza: {e}"),
            Self::Valkey(e) => write!(f, "valkey: {e}"),
        }
    }
}

/// Upisuje presudu `shadow` za prefiks: audit u PostgreSQL i ključ u Valkey, zajedno — ako
/// Valkey ne uspe, audit se poništava (verdicts.md §4: nema presude bez zapisa, ni obrnuto).
/// Ako važeća presuda postoji i važi još bar pola roka, ne radi ništa (`Ok(None)`).
pub async fn issue_net_shadow(
    pool: &PgPool,
    valkey: &mut MultiplexedConnection,
    portal: &str,
    net: &str,
    evidence: Value,
    cfg: &Config,
    now_ms: i64,
) -> Result<Option<i32>, IssueError> {
    let ttl_ms = i64::try_from(cfg.ttl.as_millis()).unwrap_or(i64::MAX);
    let mut tx = pool.begin().await.map_err(IssueError::Db)?;
    let last: Option<(i64, i32)> = sqlx::query_as(
        "SELECT until_ms, rev FROM verdicts
         WHERE portal = $1 AND key_kind = 'net' AND key = $2
         ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
    )
    .bind(portal)
    .bind(net)
    .fetch_optional(&mut *tx)
    .await
    .map_err(IssueError::Db)?;
    if let Some((until, _)) = last {
        if until - now_ms > ttl_ms / 2 {
            return Ok(None);
        }
    }
    let rev = last.map_or(1, |(_, r)| r + 1);
    let until_ms = now_ms + ttl_ms;
    sqlx::query(
        "INSERT INTO verdicts (portal, key_kind, key, action, until_ms, rev, detector, evidence)
         VALUES ($1, 'net', $2, 'shadow', $3, $4, $5, $6)",
    )
    .bind(portal)
    .bind(net)
    .bind(until_ms)
    .bind(rev)
    .bind(DETECTOR)
    .bind(evidence)
    .execute(&mut *tx)
    .await
    .map_err(IssueError::Db)?;
    redis::cmd("SET")
        .arg(net_key(portal, net))
        .arg(verdict_value("shadow", until_ms, rev))
        .arg("PX")
        .arg(ttl_ms)
        .query_async::<()>(valkey)
        .await
        .map_err(IssueError::Valkey)?;
    tx.commit().await.map_err(IssueError::Db)?;
    Ok(Some(rev))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verdict_value_matches_spec() {
        let v: Value =
            serde_json::from_str(&verdict_value("shadow", 1_792_003_600_000, 7)).unwrap();
        assert_eq!(
            v,
            json!({"action": "shadow", "until_ms": 1_792_003_600_000_i64, "rev": 7})
        );
        assert_eq!(
            net_key("demo.local", "93.87.12.0/24"),
            "klaka:v1:demo.local:net:93.87.12.0/24"
        );
    }
}
