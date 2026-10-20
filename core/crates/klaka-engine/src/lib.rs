//! Detektori kohorti i presude (`spec/verdicts.md`).
//!
//! Svaki detektor traži presek dimenzija (koncept §2a) u vremenskom prozoru. Prva dva: mrežna
//! (isti prefiks /24, /48), ciljna (isti cilj) i bihevioralna, koja se razlikuje po detektoru:
//!
//! - **prikazi-duhovi** (`ghost-views`): glas sa prikaza koje je `klaka-api` izdao, a za koje
//!   browser nikad nije poslao `view` ni `engage` — token je uzet, stranica nije prikazana;
//! - **nečitani glasovi** (`unread-votes`): stranica jeste prikazana, ali glas nije došao iz
//!   čitanja — komentar nije bio na ekranu (`seen`) ili u prikazu nije bilo nijednog unosa
//!   (klik na dugme uvek daje `pointerdown`).
//!
//! Treći hvata i poslušnika koji se ponaša kao čitalac (nivo 3, `docs/caci.md` §3), po pravilu
//! preseka bez bihevioralnog signala — mrežna i ciljna dimenzija, **na više postova**:
//!
//! - **usmereni glasovi** (`focused-votes`): prefiks daje glasove istom autoru komentara, u istom
//!   smeru, kroz više postova — mnogo češće nego organska publika ([`focused`]).
//!
//! Komentare ocenjuju detektori iz [`comments`]: nenapisani komentari (bihevioralna) i deljeni
//! šabloni (tekstualna, kroz više postova).
//!
//! Sama mreža nije dovoljna (verdicts.md §4: CGNAT deli /24 sa hiljadama ljudi); legitimni
//! čitaoci iza istog prefiksa čitaju, klikću i glasaju raspršeno kao i svi ostali, pa ne ulaze
//! u kohortu.

pub mod comments;

use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

use redis::aio::MultiplexedConnection;
use serde_json::{Value, json};
use sqlx::PgPool;

pub const GHOST_VIEWS: &str = "ghost-views";
pub const UNREAD_VOTES: &str = "unread-votes";
pub const FOCUSED_VOTES: &str = "focused-votes";

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
    /// Usmereni glasovi i deljeni šabloni: na najmanje ovoliko različitih postova.
    pub min_posts: i64,
    /// Usmereni glasovi: udeo u glasovima prefiksa najmanje ovoliko puta veći od organskog.
    pub min_lift: f64,
    /// Usmereni glasovi i deljeni šabloni: najveća verovatnoća da bi organska publika istog
    /// obima dala bar toliko ovakvih akcija (binomni rep).
    pub max_p_value: f64,
    /// Detektori komentara: najmanje komentara iz prefiksa.
    pub min_comments: i64,
    /// Deljeni šabloni: najveća kosinusna udaljenost embeddings-a za parafrazu (`docs/llm.md` §5a).
    pub max_text_distance: f64,
    /// Deljeni šabloni: najmanja MinHash sličnost za kopiju.
    pub min_minhash: f64,
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

/// Ćelija: glasovi jednog prefiksa jednom autoru komentara u jednom smeru, u prozoru.
#[derive(Debug, Clone, PartialEq, sqlx::FromRow)]
pub struct Cell {
    pub portal: String,
    pub net: String,
    pub author: String,
    pub dir: i32,
    pub votes: i64,
    pub vids: i64,
    pub posts: i64,
}

/// Ćelija koju je [`focused`] izdvojio, sa merama za audit.
#[derive(Debug, Clone, PartialEq)]
pub struct Focus {
    pub cell: Cell,
    /// Svi glasovi prefiksa u prozoru.
    pub net_votes: i64,
    /// Udeo ćelije u glasovima prefiksa.
    pub share: f64,
    /// Organski udeo iste ćelije: prosek udela po pojedincima (prefiksima ispod `min_votes`).
    pub baseline: f64,
    pub lift: f64,
    pub p_value: f64,
}

pub async fn vote_cells(pool: &PgPool, cfg: &Config) -> Result<Vec<Cell>, sqlx::Error> {
    sqlx::query_as(
        "SELECT portal, net, data->>'target_author' AS author, (data->>'dir')::int AS dir,
                count(*) AS votes, count(DISTINCT vid) AS vids, count(DISTINCT post) AS posts
         FROM events
         WHERE type = 'vote' AND source = 'server' AND net IS NOT NULL
           AND data->>'target_author' IS NOT NULL
           AND recv_at > now() - make_interval(secs => $1)
         GROUP BY 1, 2, 3, 4
         ORDER BY 1, 2, 3, 4",
    )
    .bind(cfg.window.as_secs_f64())
    .fetch_all(pool)
    .await
}

pub async fn focused_cohorts(pool: &PgPool, cfg: &Config) -> Result<Vec<Focus>, sqlx::Error> {
    Ok(focused(&vote_cells(pool, cfg).await?, cfg))
}

/// Težina ravnomerne raspodele u organskom udelu, u „prefiksima" (Laplasovo izravnanje):
/// dok ostalih prefiksa ima malo, organski udeo ne pada na nulu.
const PRIOR_NETS: f64 = 1.0;

/// Usmereni glasovi: ćelije u kojima prefiks glasa za istog autora u istom smeru, na više
/// postova, mnogo češće nego organska publika.
///
/// Organski udeo ćelije je **prosek udela po pojedincima**: prefiksima sa manje od `min_votes`
/// glasova u prozoru, koji ni sami ne mogu ući u kohortu — svaki je jedan glas. Veliki prefiksi
/// (kohorta, CGNAT) se porede sa njima, a ne jedni sa drugima: koordinisani prefiksi tako ne
/// podižu meru jedni drugima, a CGNAT je uzorak iste publike i glasa kao ona. Presuda traži i veličinu
/// efekta (`min_lift`) i značajnost (`max_p_value`): veliki CGNAT sa blagim odstupanjem ima
/// mali p, ali ne i veliki lift; mala grupa sa velikim liftom nema mali p.
///
/// Mera ne zna za stranu ni za sadržaj: ista je za guranje i za potiskivanje, za bilo kog
/// autora (koncept §0, §11).
pub fn focused(cells: &[Cell], cfg: &Config) -> Vec<Focus> {
    let mut net_votes: BTreeMap<(&str, &str), i64> = BTreeMap::new();
    for c in cells {
        *net_votes.entry((&c.portal, &c.net)).or_default() += c.votes;
    }
    let individual = |portal: &str, net: &str| net_votes[&(portal, net)] < cfg.min_votes;
    let mut individuals: BTreeMap<&str, f64> = BTreeMap::new();
    for (portal, net) in net_votes.keys() {
        if individual(portal, net) {
            *individuals.entry(portal).or_default() += 1.0;
        }
    }
    let mut kinds: BTreeMap<&str, BTreeSet<(&str, i32)>> = BTreeMap::new();
    let mut share_sum: BTreeMap<(&str, &str, i32), f64> = BTreeMap::new();
    for c in cells {
        kinds
            .entry(&c.portal)
            .or_default()
            .insert((&c.author, c.dir));
        if individual(&c.portal, &c.net) {
            *share_sum.entry((&c.portal, &c.author, c.dir)).or_default() +=
                c.votes as f64 / net_votes[&(c.portal.as_str(), c.net.as_str())] as f64;
        }
    }

    let mut out = Vec::new();
    for c in cells {
        if c.votes < cfg.min_votes || c.vids < cfg.min_vids || c.posts < cfg.min_posts {
            continue;
        }
        let n = net_votes[&(c.portal.as_str(), c.net.as_str())];
        let share = c.votes as f64 / n as f64;
        let uniform = 1.0 / kinds[c.portal.as_str()].len() as f64;
        let others = individuals.get(c.portal.as_str()).copied().unwrap_or(0.0);
        let rest = share_sum
            .get(&(c.portal.as_str(), c.author.as_str(), c.dir))
            .copied()
            .unwrap_or(0.0);
        let baseline = (rest + PRIOR_NETS * uniform) / (others + PRIOR_NETS);
        let lift = share / baseline;
        let p_value = binomial_tail(n, c.votes, baseline);
        if lift >= cfg.min_lift && p_value <= cfg.max_p_value {
            out.push(Focus {
                cell: c.clone(),
                net_votes: n,
                share,
                baseline,
                lift,
                p_value,
            });
        }
    }
    out
}

/// P(X ≥ k) za X ~ Bin(n, p).
pub fn binomial_tail(n: i64, k: i64, p: f64) -> f64 {
    if k <= 0 || p >= 1.0 {
        return 1.0;
    }
    if k > n || p <= 0.0 {
        return 0.0;
    }
    let m = k.min(n - k);
    let ln_choose: f64 = (1..=m).map(|j| ((n - m + j) as f64 / j as f64).ln()).sum();
    // Član za i = k, pa ostali preko odnosa susednih članova; u log prostoru do prvog, da
    // (1 - p)^n ne padne na nulu za veliko n.
    let mut term = (ln_choose + k as f64 * p.ln() + (n - k) as f64 * (1.0 - p).ln()).exp();
    let ratio = p / (1.0 - p);
    let mut sum = 0.0;
    for i in k..=n {
        sum += term;
        term *= (n - i) as f64 / (i + 1) as f64 * ratio;
        if term <= sum * 1e-17 {
            break;
        }
    }
    sum.min(1.0)
}

/// Nalaz jednog detektora za jedan prefiks: ono što ide u presudu i njen dokaz.
#[derive(Debug, Clone, PartialEq)]
pub struct Finding {
    pub detector: String,
    pub portal: String,
    pub net: String,
    pub votes: i64,
    /// Dokaz za audit (PostgreSQL); u Valkey ne ide ništa od ovoga.
    pub evidence: Value,
}

impl From<Cohort> for Finding {
    fn from(c: Cohort) -> Self {
        let evidence = json!({
            "detector": c.detector, "target": c.target,
            "votes": c.votes, "vids": c.vids, "flagged": c.flagged,
        });
        Self {
            detector: c.detector,
            portal: c.portal,
            net: c.net,
            votes: c.votes,
            evidence,
        }
    }
}

impl From<Focus> for Finding {
    fn from(f: Focus) -> Self {
        let evidence = json!({
            "detector": FOCUSED_VOTES, "target_author": f.cell.author, "dir": f.cell.dir,
            "votes": f.cell.votes, "vids": f.cell.vids, "posts": f.cell.posts,
            "net_votes": f.net_votes, "share": f.share, "baseline": f.baseline,
            "lift": f.lift, "p_value": f.p_value,
        });
        Self {
            detector: FOCUSED_VOTES.to_owned(),
            portal: f.cell.portal,
            net: f.cell.net,
            votes: f.cell.votes,
            evidence,
        }
    }
}

/// Imena detektora čiji su nalazi u presudi, npr. `ghost-views+unread-votes`.
pub fn detectors(findings: &[Finding]) -> String {
    let names: BTreeSet<&str> = findings.iter().map(|c| c.detector.as_str()).collect();
    names.into_iter().collect::<Vec<_>>().join("+")
}

/// Vrednost ključa presude u Valkey-ju (verdicts.md §2) — bez razloga i dokaza.
pub fn verdict_value(action: &str, until_ms: i64, rev: i32) -> String {
    json!({"action": action, "until_ms": until_ms, "rev": rev}).to_string()
}

pub fn net_key(portal: &str, net: &str) -> String {
    format!("klaka:v1:{portal}:net:{net}")
}

/// Jedna presuda po prefiksu, sa dokazima svih njegovih nalaza.
pub fn group_by_net(findings: Vec<Finding>) -> BTreeMap<(String, String), Vec<Finding>> {
    let mut out: BTreeMap<(String, String), Vec<Finding>> = BTreeMap::new();
    for c in findings {
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
    /// Detektori čiji su nalazi u presudi ([`detectors`]).
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

    fn cfg() -> Config {
        Config {
            window: Duration::from_secs(600),
            min_votes: 5,
            min_vids: 3,
            min_flagged_share: 0.8,
            min_posts: 2,
            min_lift: 3.0,
            max_p_value: 1e-4,
            min_comments: 5,
            max_text_distance: 0.2,
            min_minhash: 0.5,
            ttl: Duration::from_secs(3600),
        }
    }

    fn cell(net: &str, author: &str, dir: i32, votes: i64, posts: i64) -> Cell {
        Cell {
            portal: "demo.local".into(),
            net: net.into(),
            author: author.into(),
            dir,
            votes,
            vids: votes,
            posts,
        }
    }

    /// Organska publika: `n` prefiksa sa po jednim glasom, raspoređenim po 8 autora, oko dve
    /// trećine „za" — isti odnos za svakog autora.
    fn readers(n: usize) -> Vec<Cell> {
        (0..n)
            .map(|i| {
                let dir = if (i / 8) % 3 < 2 { 1 } else { -1 };
                cell(&format!("10.0.{i}.0/24"), &format!("a{}", i % 8), dir, 1, 1)
            })
            .collect()
    }

    #[test]
    fn binomial_tail_matches_exact_values() {
        // Tačne vrednosti (racionalni brojevi, Python fractions).
        let close = |a: f64, b: f64| (a - b).abs() <= 1e-9 * b.max(1e-300);
        assert!(close(binomial_tail(20, 11, 0.13), 9.654_063_350_859_266e-6));
        assert!(close(binomial_tail(10, 3, 0.5), 0.945_312_5));
        assert!(close(
            binomial_tail(50, 30, 0.13),
            8.425_910_007_598_863e-15
        ));
        assert_eq!(binomial_tail(10, 0, 0.1), 1.0);
        assert_eq!(binomial_tail(10, 11, 0.1), 0.0);
        let big = binomial_tail(5_000, 1_000, 0.13);
        assert!(big > 0.0 && big < 1e-30, "{big}");
    }

    #[test]
    fn focused_cohort_found_twins_not() {
        let mut cells = readers(60);
        // Kohorta: 20 glasova za a0 na 3 posta, uz malo drugih glasova.
        cells.push(cell("198.18.1.0/24", "a0", 1, 20, 3));
        cells.push(cell("198.18.1.0/24", "a1", -1, 6, 2));
        // CGNAT: 24 glasa iza jednog prefiksa, raspoređena kao i publika.
        for (i, c) in readers(24).into_iter().enumerate() {
            let mut c = c;
            c.net = "198.18.2.0/24".into();
            c.posts = 1 + (i as i64 % 3);
            cells.push(c);
        }
        // Ista kohorta na jednom postu: nije presek kroz postove.
        cells.push(cell("198.18.3.0/24", "a0", 1, 20, 1));
        // Obožavalac: malo glasova.
        cells.push(cell("198.18.4.0/24", "a0", 1, 4, 2));

        let found = focused(&cells, &cfg());
        let got: Vec<_> = found
            .iter()
            .map(|f| (f.cell.net.as_str(), f.cell.author.as_str(), f.cell.dir))
            .collect();
        assert_eq!(got, [("198.18.1.0/24", "a0", 1)], "{found:?}");
        let f = &found[0];
        assert!(f.lift > 5.0 && f.p_value < 1e-10, "{f:?}");
    }

    #[test]
    fn focused_is_symmetric_by_side() {
        // Ogledalo: strana B gura onog koga A potiskuje i obrnuto — ista mera.
        let mut cells = readers(60);
        cells.push(cell("198.18.1.0/24", "a0", 1, 20, 3));
        cells.push(cell("198.18.1.0/24", "a1", -1, 10, 3));
        cells.push(cell("198.18.2.0/24", "a1", 1, 20, 3));
        cells.push(cell("198.18.2.0/24", "a0", -1, 10, 3));
        let found = focused(&cells, &cfg());
        let nets: BTreeSet<_> = found.iter().map(|f| f.cell.net.as_str()).collect();
        assert_eq!(nets.len(), 2, "{found:?}");
        let lift = |net: &str, dir: i32| {
            found
                .iter()
                .find(|f| f.cell.net == net && f.cell.dir == dir)
                .map(|f| f.lift)
        };
        let (a, b) = (
            lift("198.18.1.0/24", 1).unwrap(),
            lift("198.18.2.0/24", 1).unwrap(),
        );
        assert!((a - b).abs() < 1e-9 * a, "{a} vs {b}");
    }

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
