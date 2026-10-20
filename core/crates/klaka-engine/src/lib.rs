//! Detektori kohorti i presude (`spec/verdicts.md`).
//!
//! Svaki detektor traži presek tri dimenzije (koncept §2a) u vremenskom prozoru — mrežnu (isti
//! prefiks /24, /48), ciljnu (isti cilj) i bihevioralnu, koja se razlikuje po detektoru:
//!
//! - **prikazi-duhovi** (`ghost-views`): glas sa prikaza koje je `klaka-api` izdao, a za koje
//!   browser nikad nije poslao `view` ni `engage` — token je uzet, stranica nije prikazana;
//! - **nečitani glasovi** (`unread-votes`): stranica jeste prikazana, ali glas nije došao iz
//!   čitanja — komentar nije bio na ekranu (`seen`) ili u prikazu nije bilo nijednog unosa
//!   (klik na dugme uvek daje `pointerdown`).
//!
//! Sama mreža nije dovoljna (verdicts.md §4: CGNAT deli /24 sa hiljadama ljudi); legitimni
//! čitaoci iza istog prefiksa čitaju i klikću, pa ne ulaze u kohortu.

use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

use redis::aio::MultiplexedConnection;
use serde_json::{Value, json};
use sqlx::PgPool;

pub const GHOST_VIEWS: &str = "ghost-views";
pub const UNREAD_VOTES: &str = "unread-votes";

#[derive(Debug, Clone)]
pub struct Config {
    /// Prozor posmatranja.
    pub window: Duration,
    /// Najmanje glasova iz prefiksa na isti cilj.
    pub min_votes: i64,
    /// Najmanje različitih prikaza (`vid`) među tim glasovima.
    pub min_vids: i64,
    /// Najmanji udeo sumnjivih prikaza među njima (duhova, odnosno nečitanih).
    pub min_flagged_share: f64,
    /// Koliko dugo presuda važi.
    pub ttl: Duration,
}

/// Kohorta: glasovi iz jednog prefiksa na jedan cilj, u prozoru; `flagged` = prikazi koje je
/// detektor označio.
#[derive(Debug, Clone, PartialEq, sqlx::FromRow)]
pub struct Cohort {
    pub detector: String,
    pub portal: String,
    pub net: String,
    pub target: String,
    pub votes: i64,
    pub vids: i64,
    pub flagged: i64,
}

/// Prikaz je „duh" ako za njega u prozoru (+ najduže trajanje tokena) nema nijednog browser
/// `view` ili `engage` događaja.
pub async fn ghost_cohorts(pool: &PgPool, cfg: &Config) -> Result<Vec<Cohort>, sqlx::Error> {
    cohorts(
        pool,
        cfg,
        GHOST_VIEWS,
        "NOT EXISTS (
             SELECT 1 FROM events b
             WHERE b.vid = v.vid AND b.source = 'browser' AND b.type IN ('view', 'engage')
               AND b.recv_at > now() - make_interval(secs => $1) - interval '2 hours'
         )",
    )
    .await
}

/// Glas je „nečitan" ako prikaz ima `engage` (stranica je prikazana), a u poslednjem sažetku
/// cilj glasa nije u `seen` ili nema nijednog unosa. Prikazi bez `engage`-a nisu ovde — njih
/// pokriva [`ghost_cohorts`].
pub async fn unread_cohorts(pool: &PgPool, cfg: &Config) -> Result<Vec<Cohort>, sqlx::Error> {
    cohorts(
        pool,
        cfg,
        UNREAD_VOTES,
        "EXISTS (
             SELECT 1 FROM (
                 SELECT b.data FROM events b
                 WHERE b.vid = v.vid AND b.source = 'browser' AND b.type = 'engage'
                   AND b.recv_at > now() - make_interval(secs => $1) - interval '2 hours'
                 ORDER BY (b.data->>'seq')::int DESC, b.recv_at DESC
                 LIMIT 1
             ) e
             WHERE NOT (e.data->'seen' ? v.target)
                OR (e.data->'inputs'->>'key')::int + (e.data->'inputs'->>'ptr')::int
                   + (e.data->'inputs'->>'touch')::int = 0
         )",
    )
    .await
}

/// Zajednički okvir: glasovi sa `vid`-om u prozoru, grupisani po (portal, prefiks, cilj);
/// `flagged` broji prikaze za koje važi `condition` (SQL nad `v.vid`, `v.target`).
async fn cohorts(
    pool: &PgPool,
    cfg: &Config,
    detector: &str,
    condition: &str,
) -> Result<Vec<Cohort>, sqlx::Error> {
    let sql = format!(
        "WITH v AS (
             SELECT portal, net, data->>'target' AS target, vid
             FROM events
             WHERE type = 'vote' AND source = 'server' AND vid IS NOT NULL
               AND recv_at > now() - make_interval(secs => $1)
         ),
         c AS (
             SELECT portal, net, target, count(*) AS votes, count(DISTINCT vid) AS vids,
                    count(DISTINCT vid) FILTER (WHERE {condition}) AS flagged
             FROM v
             GROUP BY portal, net, target
         )
         SELECT $5::text AS detector, portal, net, target, votes, vids, flagged
         FROM c
         WHERE votes >= $2 AND vids >= $3 AND flagged::float8 >= $4 * vids
         ORDER BY portal, net, target"
    );
    sqlx::query_as(&sql)
        .bind(cfg.window.as_secs_f64())
        .bind(cfg.min_votes)
        .bind(cfg.min_vids)
        .bind(cfg.min_flagged_share)
        .bind(detector)
        .fetch_all(pool)
        .await
}

/// Imena detektora čije su kohorte u presudi, npr. `ghost-views+unread-votes`.
pub fn detectors(cohorts: &[Cohort]) -> String {
    let names: BTreeSet<&str> = cohorts.iter().map(|c| c.detector.as_str()).collect();
    names.into_iter().collect::<Vec<_>>().join("+")
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

/// Presuda `shadow` za jedan prefiks, sa dokazima za audit.
#[derive(Debug, Clone)]
pub struct NetVerdict<'a> {
    pub portal: &'a str,
    pub net: &'a str,
    /// Detektori čije su kohorte u presudi ([`detectors`]).
    pub detector: &'a str,
    pub evidence: Value,
}

/// Upisuje presudu `shadow` za prefiks: audit u PostgreSQL i ključ u Valkey, zajedno — ako
/// Valkey ne uspe, audit se poništava (verdicts.md §4: nema presude bez zapisa, ni obrnuto).
/// Ako važeća presuda postoji i važi još bar pola roka, ne radi ništa (`Ok(None)`).
pub async fn issue_net_shadow(
    pool: &PgPool,
    valkey: &mut MultiplexedConnection,
    verdict: NetVerdict<'_>,
    cfg: &Config,
    now_ms: i64,
) -> Result<Option<i32>, IssueError> {
    let NetVerdict {
        portal,
        net,
        detector,
        evidence,
    } = verdict;
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
    .bind(detector)
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
