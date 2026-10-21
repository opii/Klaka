//! Detektori komentara. Isti presek kao za glasove (koncept §2a), druge dimenzije:
//!
//! - **nenapisani komentari** (`unwritten-comments`), bihevioralna: komentar nije napisan u
//!   formi stranice — za prikaz nema `compose`, ili je tekst stigao bez ijednog tastera
//!   (nalepljen ili upisan skriptom); potpis operatera iz `events.md` §2;
//! - **deljeni šabloni** (`shared-templates`), tekstualna: komentari prefiksa imaju blizanca
//!   iste formulacije na drugom postu — kopiju (MinHash) ili parafrazu (embeddings,
//!   `docs/llm.md` §5a) — mnogo češće nego organska publika, kroz više postova;
//! - **usklađeni šabloni** (`coordinated-templates`), tekstualna, za klaku rasutu po prefiksima
//!   (svaki ispod `min_comments`): graf prefiksa koji dele iste šablone kroz postove, kao
//!   usklađeni glasovi (`coordinated.rs`).
//!
//! Sadržaj se ne ocenjuje: ni stav, ni tema, ni ton — samo da li se ista formulacija ponavlja.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use klaka_llm::{Embedder, LlmError};
use serde_json::json;
use sqlx::PgPool;

use crate::coordinated::{Member, members};
use crate::{Config, Finding, Nets, binomial_tail};

pub const UNWRITTEN_COMMENTS: &str = "unwritten-comments";
pub const SHARED_TEMPLATES: &str = "shared-templates";
pub const COORDINATED_TEMPLATES: &str = "coordinated-templates";

/// Kohorta komentara jednog prefiksa u prozoru; `flagged` = komentari koje je detektor označio.
#[derive(Debug, Clone, PartialEq, sqlx::FromRow)]
pub struct CommentCohort {
    pub detector: String,
    pub portal: String,
    pub net: String,
    pub comments: i64,
    pub vids: i64,
    pub posts: i64,
    pub flagged: i64,
}

/// Komentar je „nenapisan" ako za njegov prikaz nema `compose` (forma nije korišćena), ako je
/// tekst stigao bez tastera (`keys = "0"`: nalepljen desnim klikom ili upisan skriptom), ili je
/// nalepljen uz par tastera (`Ctrl+V`). Od više `compose` događaja prikaza važi najbliži po
/// vremenu (`events.md` §2).
pub async fn unwritten_cohorts(
    pool: &PgPool,
    cfg: &Config,
) -> Result<Vec<CommentCohort>, sqlx::Error> {
    sqlx::query_as(
        "WITH c AS (
             SELECT portal, net, post, vid, t
             FROM events
             WHERE type = 'comment' AND source = 'server' AND vid IS NOT NULL AND net IS NOT NULL
               AND recv_at > now() - make_interval(secs => $1)
         ),
         f AS (
             SELECT c.*, (
                 k.data IS NULL OR k.data->>'keys' = '0'
                 OR ((k.data->>'pasted')::boolean AND k.data->>'keys' = '1-10')
             ) AS flagged
             FROM c LEFT JOIN LATERAL (
                 SELECT b.data FROM events b
                 WHERE b.vid = c.vid AND b.source = 'browser' AND b.type = 'compose'
                   AND b.recv_at > now() - make_interval(secs => $1) - interval '2 hours'
                 ORDER BY abs(b.t - c.t)
                 LIMIT 1
             ) k ON true
         )
         SELECT $5::text AS detector, portal, net, count(*) AS comments, count(DISTINCT vid) AS vids,
                count(DISTINCT post) AS posts, count(*) FILTER (WHERE flagged) AS flagged
         FROM f
         GROUP BY portal, net
         HAVING count(*) >= $2 AND count(DISTINCT vid) >= $3
            AND count(*) FILTER (WHERE flagged)::float8 >= $4 * count(*)
         ORDER BY portal, net",
    )
    .bind(cfg.window.as_secs_f64())
    .bind(cfg.min_comments)
    .bind(cfg.min_vids)
    .bind(cfg.min_flagged_share)
    .bind(UNWRITTEN_COMMENTS)
    .fetch_all(pool)
    .await
}

impl From<CommentCohort> for Finding {
    fn from(c: CommentCohort) -> Self {
        let evidence = json!({
            "detector": c.detector, "comments": c.comments, "vids": c.vids,
            "posts": c.posts, "flagged": c.flagged,
        });
        Self {
            detector: c.detector,
            portal: c.portal,
            net: c.net,
            votes: c.comments,
            evidence,
        }
    }
}

// --- MinHash -------------------------------------------------------------------------------

pub const MINHASH_K: usize = 64;
const SHINGLE: usize = 4;

/// MinHash potpis teksta: `MINHASH_K` najmanjih heševa znakovnih 4-grama, posle svođenja na
/// mala slova, bez interpunkcije i viška razmaka. Isti tekst sa drugom interpunkcijom ima isti
/// potpis; udeo jednakih pozicija procenjuje Jaccard-ovu sličnost skupova 4-grama.
pub fn minhash(text: &str) -> [u64; MINHASH_K] {
    let norm: Vec<char> = normalize(text).chars().collect();
    let mut sig = [u64::MAX; MINHASH_K];
    let n = norm.len().saturating_sub(SHINGLE - 1).max(1);
    for i in 0..n {
        let end = (i + SHINGLE).min(norm.len());
        let base = fnv1a(norm[i..end].iter());
        for (k, slot) in sig.iter_mut().enumerate() {
            let h = splitmix64(base ^ (k as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15));
            *slot = (*slot).min(h);
        }
    }
    sig
}

pub fn minhash_similarity(a: &[u64; MINHASH_K], b: &[u64; MINHASH_K]) -> f64 {
    a.iter().zip(b).filter(|(x, y)| x == y).count() as f64 / MINHASH_K as f64
}

fn normalize(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars().flat_map(char::to_lowercase) {
        if c.is_alphanumeric() {
            out.push(c);
        } else if !out.ends_with(' ') && !out.is_empty() {
            out.push(' ');
        }
    }
    out.trim_end().to_owned()
}

fn fnv1a<'a>(chars: impl Iterator<Item = &'a char>) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for c in chars {
        let mut buf = [0u8; 4];
        for b in c.encode_utf8(&mut buf).bytes() {
            h ^= u64::from(b);
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    h
}

fn splitmix64(mut x: u64) -> u64 {
    x = x.wrapping_add(0x9E37_79B9_7F4A_7C15);
    x = (x ^ (x >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    x = (x ^ (x >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    x ^ (x >> 31)
}

// --- deljeni šabloni ------------------------------------------------------------------------

/// Komentar iz prozora, sa onim po čemu se grupiše.
#[derive(Debug, Clone, PartialEq, sqlx::FromRow)]
pub struct CommentText {
    pub portal: String,
    pub net: String,
    pub post: String,
    pub vid: Option<String>,
    pub comment: String,
    pub text: String,
}

/// Prefiks čiji su komentari šablonski mnogo češće nego kod organske publike.
#[derive(Debug, Clone, PartialEq)]
pub struct TemplateCohort {
    pub portal: String,
    pub net: String,
    pub comments: i64,
    pub vids: i64,
    pub posts: i64,
    /// Komentari prefiksa koji imaju blizanca iste formulacije.
    pub templated: i64,
    /// Od toga preko MinHash-a (kopija), ostalo samo preko embeddings-a (parafraza).
    pub copies: i64,
    /// Organski udeo šablonskih: prosek po pojedincima (prefiksima ispod `min_comments`).
    pub baseline: f64,
    pub lift: f64,
    pub p_value: f64,
}

pub async fn comment_texts(pool: &PgPool, cfg: &Config) -> Result<Vec<CommentText>, sqlx::Error> {
    sqlx::query_as(
        "SELECT portal, net, post, vid, data->>'comment' AS comment, data->>'text' AS text
         FROM events
         WHERE type = 'comment' AND source = 'server' AND net IS NOT NULL AND post IS NOT NULL
           AND recv_at > now() - make_interval(secs => $1)
         ORDER BY portal, recv_at",
    )
    .bind(cfg.window.as_secs_f64())
    .fetch_all(pool)
    .await
}

/// Koliko najbližih suseda (kNN) se traži za svaki komentar: za „ima blizanca" je dovoljan
/// jedan, a HNSW ionako obiđe `ef_search` (40) kandidata, pa par više ne košta.
const NEIGHBORS: i64 = 5;

/// Par parafraza (portal, a, b, kosinusna udaljenost embeddings-a).
pub type Paraphrase = (String, String, String, f64);

/// Parovi komentara (portal, a, b, d) čiji su embeddings bliži od većeg od `max_text_distance` i
/// `max_graph_distance` (kosinus; `templates` ih deli po pragu):
/// za svaki komentar `a` iz prozora `NEIGHBORS` najbližih `b` sa drugih postova iz poslednjih
/// `template_lookback` (docs/llm.md §5a: klaka iste šablone koristi danima, kroz više članaka)
/// preko HNSW indeksa (kNN), ne svaki par.
/// Indeks je približan — retko promaši najbližeg suseda. Kad bi sused bio samo iz prozora,
/// planer bi s pravom izabrao indeks po vremenu i sortiranje — opet kvadratno u prozoru.
///
/// Uz to, za graf usklađenih šablona, `NEIGHBORS` najbližih među komentarima iz `linked`
/// (prefiksi koji mogu imati ivicu): stari blizanci često potroše svih `NEIGHBORS` mesta, pa se
/// dva poslušnika iz prozora ne bi videla direktno. To je poređenje svakog para, ali samo u
/// `linked` — pojedinci sa jednim komentarom (skoro cela publika) u njemu nisu.
pub async fn paraphrase_pairs(
    pool: &PgPool,
    cfg: &Config,
    model: &str,
    linked: &[(String, String)],
) -> Result<Vec<Paraphrase>, sqlx::Error> {
    let mut tx = pool.begin().await?;
    // pgvector ≥ 0.8: HNSW nastavlja pretragu kad filter (portal, model, prozor) odbaci
    // kandidate iz indeksa — inače bi kNN nad celom retencijom vratio skoro samo stare komentare.
    let max_distance = cfg.max_text_distance.max(cfg.max_graph_distance);
    sqlx::query("SET LOCAL hnsw.iterative_scan = relaxed_order")
        .execute(&mut *tx)
        .await?;
    let mut pairs: Vec<Paraphrase> = sqlx::query_as(
        "WITH e AS (
             SELECT portal, comment, post, emb FROM comment_embedding
             WHERE model = $2 AND t > now() - make_interval(secs => $1)
         )
         SELECT a.portal, a.comment, n.comment, n.d
         FROM e a
         CROSS JOIN LATERAL (
             SELECT b.comment, b.emb <=> a.emb AS d
             FROM comment_embedding b
             WHERE b.portal = a.portal AND b.model = $2 AND b.post <> a.post
               AND b.t > now() - make_interval(secs => $5)
             ORDER BY b.emb <=> a.emb
             LIMIT $4
         ) n
         WHERE n.d <= $3",
    )
    .bind(cfg.window.as_secs_f64())
    .bind(model)
    .bind(max_distance)
    .bind(NEIGHBORS)
    .bind(cfg.template_lookback.max(cfg.window).as_secs_f64())
    .fetch_all(&mut *tx)
    .await?;
    if !linked.is_empty() {
        let (portals, ids): (Vec<_>, Vec<_>) = linked.iter().cloned().unzip();
        let near: Vec<Paraphrase> = sqlx::query_as(
            "WITH e AS MATERIALIZED (
                 SELECT c.portal, c.comment, c.post, c.emb
                 FROM comment_embedding c
                 JOIN UNNEST($3::text[], $4::text[]) AS l(portal, comment)
                   ON c.portal = l.portal AND c.comment = l.comment
                 WHERE c.model = $1
             )
             SELECT a.portal, a.comment, n.comment, n.d
             FROM e a
             CROSS JOIN LATERAL (
                 SELECT b.comment, b.emb <=> a.emb AS d
                 FROM e b
                 WHERE b.portal = a.portal AND b.post <> a.post
                 ORDER BY b.emb <=> a.emb
                 LIMIT $5
             ) n
             WHERE n.d <= $2",
        )
        .bind(model)
        .bind(max_distance)
        .bind(portals)
        .bind(ids)
        .bind(NEIGHBORS)
        .fetch_all(&mut *tx)
        .await?;
        pairs.extend(near);
    }
    tx.commit().await?;
    Ok(pairs)
}

/// Nalazi detektora šablona iz istog prozora.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Templates {
    /// `shared-templates`: prefiksi čiji su komentari mnogo češće šablonski nego kod publike.
    pub cohorts: Vec<TemplateCohort>,
    /// `coordinated-templates`: rasuti prefiksi povezani istim šablonima kroz postove.
    pub members: Vec<Member>,
}

/// Šabloni iz prozora; `exclude` su prefiksi kohorti drugih grafova (usklađeni glasovi), koji ne
/// ulaze u organski udeo.
pub async fn template_cohorts(
    pool: &PgPool,
    cfg: &Config,
    model: Option<&str>,
    exclude: &Nets,
) -> Result<Templates, sqlx::Error> {
    let texts = comment_texts(pool, cfg).await?;
    let pairs = match model {
        Some(m) => paraphrase_pairs(pool, cfg, m, &linkable(&texts, cfg)).await?,
        None => Vec::new(),
    };
    Ok(templates(&texts, &pairs, exclude, cfg))
}

/// Komentari (portal, ID) prefiksa koji mogu imati ivicu u grafu usklađenih šablona: bar dva
/// komentara na bar `min_posts` postova.
fn linkable(texts: &[CommentText], cfg: &Config) -> Vec<(String, String)> {
    let mut nets: HashMap<(&str, &str), (usize, BTreeSet<&str>)> = HashMap::new();
    for c in texts {
        let n = nets.entry((&c.portal, &c.net)).or_default();
        n.0 += 1;
        n.1.insert(&c.post);
    }
    texts
        .iter()
        .filter(|c| {
            let (count, posts) = &nets[&(c.portal.as_str(), c.net.as_str())];
            *count >= 2 && posts.len() as i64 >= cfg.min_posts
        })
        .map(|c| (c.portal.clone(), c.comment.clone()))
        .collect()
}

/// MinHash LSH: 16 traka po 4 reda potpisa. Par sa Jaccard-ovom sličnošću s deli bar jednu
/// traku (postaje kandidat) sa verovatnoćom 1 − (1 − s⁴)¹⁶: 0,64 za 0,5, 0,99 za 0,7, 0,002 za
/// 0,1 — kopije uvek, nepovezani tekstovi skoro nikad. Kandidat se proverava celim potpisom.
const BANDS: usize = 16;
const ROWS: usize = MINHASH_K / BANDS;
/// U kofi se komentar proverava sa najviše ovoliko drugih: dovoljan je jedan blizanac, a kofa
/// sa hiljadu istih kopija tako ne pravi milion poređenja.
const MAX_CHECKS: usize = 8;

/// Grupe kopija (MinHash ≥ `min`) sa više postova — preko LSH kofa, ne poređenjem svakog para:
/// posao raste linearno sa brojem komentara. Grupa su komentari jedne kofe koji imaju kopiju
/// među predstavnicima drugih postova; u grafu dobija svoje čvorište, pa su svake dve kopije
/// grupe na dva koraka (`template_graph`). Ista grupa iz više traka se broji jednom.
fn copies(comments: &[CommentText], sigs: &[[u64; MINHASH_K]], min: f64) -> Vec<Vec<usize>> {
    let mut buckets: HashMap<(&str, usize, u64), Vec<usize>> = HashMap::new();
    for (i, sig) in sigs.iter().enumerate() {
        for band in 0..BANDS {
            let rows = &sig[band * ROWS..(band + 1) * ROWS];
            let key = rows.iter().fold(band as u64, |h, &r| splitmix64(h ^ r));
            buckets
                .entry((&comments[i].portal, band, key))
                .or_default()
                .push(i);
        }
    }
    let mut groups: HashSet<Vec<usize>> = HashSet::new();
    for list in buckets.values().filter(|l| l.len() > 1) {
        // Kofa po postovima, do `MAX_CHECKS` predstavnika po postu. Kandidati za i su
        // predstavnici drugih postova, pa se preskače najviše jedna grupa (i-ov post): i kofa sa
        // hiljadama kopija na jednom postu i jednom na drugom ostaje linearna.
        let mut posts: Vec<(&str, Vec<usize>)> = Vec::new();
        let mut at: HashMap<&str, usize> = HashMap::new();
        for &i in list {
            let post = comments[i].post.as_str();
            let k = *at.entry(post).or_insert_with(|| {
                posts.push((post, Vec::new()));
                posts.len() - 1
            });
            if posts[k].1.len() < MAX_CHECKS {
                posts[k].1.push(i);
            }
        }
        if posts.len() < 2 {
            continue;
        }
        let group: Vec<usize> = list
            .iter()
            .copied()
            .filter(|&i| {
                posts
                    .iter()
                    .filter(|&&(post, _)| post != comments[i].post)
                    .flat_map(|(_, reps)| reps.iter().copied())
                    .take(MAX_CHECKS)
                    .any(|j| minhash_similarity(&sigs[i], &sigs[j]) >= min)
            })
            .collect();
        if group.len() >= 2 {
            groups.insert(group);
        }
    }
    groups.into_iter().collect()
}

/// Grupa „istog šablona" sa više prefiksa od ovoga se ne uparuje (kvadratan broj parova). Tako
/// velika grupa je opšta fraza („Bravo!") koju piše cela publika — slab dokaz.
const MAX_GROUP_NETS: usize = 500;

/// Usklađeni šabloni (`coordinated-templates`): klaka rasuta po mnogo prefiksa, svaki sa par
/// komentara — ispod `min_comments`, pa je deljeni šabloni po prefiksu ne vide. Graf kao kod
/// usklađenih glasova (`coordinated.rs`): čvor je prefiks.
///
/// `near[x]` su susedi komentara x (blizanci sa drugog posta: komentari iz prozora, stari
/// blizanci i čvorišta grupa kopija). Dva komentara su isti šablon ako su susedi ili imaju
/// zajedničkog suseda — najviše dva koraka, ne cela komponenta: mali model parafrazu ponekad
/// pomeri ka drugom šablonu iste uloge, a lanac bi ta dva šablona spojio u jedan, pa bi par
/// poslušnika koji deli oba delio samo jedan (izmereno, rasuti-sabloni-4).
///
/// Dva prefiksa A i B su usklađena kad je bar dva komentara A isti šablon kao neki komentar B, i
/// obrnuto (manji od ta dva broja: jedan komentar A uparen sa dva komentara B nije dva šablona),
/// na ≥ `cfg.min_posts` postova, uz Jaccard nad komentarima ≥ `cfg.min_jaccard` (CGNAT sa mnogo
/// komentara ni sa kim nema sličan skup); pa k-jezgro i komponenta ≥ `cfg.min_cohort_nets`. Dva
/// para drže publiku van grafa: jedna opšta fraza ne povezuje dva čitaoca.
fn template_graph(comments: &[CommentText], near: &[Vec<usize>], cfg: &Config) -> Vec<Member> {
    let n = comments.len();
    let mut node_of: BTreeMap<(&str, &str), usize> = BTreeMap::new();
    let mut net_of = Vec::with_capacity(n);
    let mut size: Vec<usize> = Vec::new();
    let mut linked: Vec<BTreeSet<&str>> = Vec::new();
    for (i, c) in comments.iter().enumerate() {
        let next = node_of.len();
        let k = *node_of.entry((&c.portal, &c.net)).or_insert(next);
        if k == size.len() {
            size.push(0);
            linked.push(BTreeSet::new());
        }
        size[k] += 1;
        net_of.push(k);
        if !near[i].is_empty() {
            linked[k].insert(&c.comment);
        }
    }
    // Prefiks bez bar dva komentara sa blizancem na bar `min_posts` postova ne može imati ivicu —
    // ne uparuje se (pojedinci sa jednim komentarom).
    let mut eligible = vec![false; size.len()];
    for k in 0..size.len() {
        eligible[k] = linked[k].len() >= 2;
    }
    let mut posts_of: Vec<BTreeSet<&str>> = vec![BTreeSet::new(); size.len()];
    for (i, c) in comments.iter().enumerate() {
        if !near[i].is_empty() {
            posts_of[net_of[i]].insert(&c.post);
        }
    }
    for k in 0..size.len() {
        eligible[k] &= posts_of[k].len() as i64 >= cfg.min_posts;
    }

    // Grupa čvora v: v (ako je komentar iz prozora) i njegovi susedi iz prozora — svaka dva su
    // susedi ili imaju zajedničkog suseda (v). Za par prefiksa: koji su njihovi komentari upareni.
    let mut matched: HashMap<(usize, usize), (BTreeSet<usize>, BTreeSet<usize>)> = HashMap::new();
    for (v, around) in near.iter().enumerate() {
        let mut group: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
        for x in (v < n)
            .then_some(v)
            .into_iter()
            .chain(around.iter().copied())
        {
            if x < n && eligible[net_of[x]] {
                group.entry(net_of[x]).or_default().push(x);
            }
        }
        if group.len() < 2 || group.len() > MAX_GROUP_NETS {
            continue;
        }
        let list: Vec<_> = group.into_iter().collect();
        for (x, (a, ca)) in list.iter().enumerate() {
            for (b, cb) in &list[x + 1..] {
                let e = matched.entry((*a, *b)).or_default();
                e.0.extend(ca);
                e.1.extend(cb);
            }
        }
    }

    let mut adj: Vec<BTreeMap<usize, BTreeSet<&str>>> = vec![BTreeMap::new(); size.len()];
    for (&(a, b), (ca, cb)) in &matched {
        let count = ca.len().min(cb.len());
        if count < 2 {
            continue;
        }
        let jaccard = count as f64 / (size[a] + size[b] - count) as f64;
        let posts: BTreeSet<&str> = ca
            .iter()
            .chain(cb)
            .map(|&i| comments[i].post.as_str())
            .collect();
        if posts.len() as i64 >= cfg.min_posts && jaccard >= cfg.min_jaccard {
            adj[a].insert(b, posts.clone());
            adj[b].insert(a, posts);
        }
    }
    let elements: Vec<usize> = linked.iter().map(BTreeSet::len).collect();
    members(&node_of, &adj, &elements, cfg)
}

/// Težina prethodne pretpostavke u organskom udelu šablonskih komentara, u „prefiksima": dok
/// ostalih prefiksa ima malo, mera ne pada na nulu (kao `PRIOR_NETS` za usmerene glasove).
const PRIOR_NETS: f64 = 1.0;
/// Pretpostavljeni organski udeo, na gornjoj granici izmerenog (0,01–0,10 u emulatoru). Bez
/// pojedinaca u prozoru (noću, mali portal) organski udeo je ceo prior: sa 0,5 lift ne bi mogao
/// preći 2, ispod `min_lift`; sa 0,1 prolazi prefiks sa 5 od 5 šablonskih (p = 1e-5), a sa 4 od
/// 5 ne.
const PRIOR_SHARE: f64 = 0.1;

/// Šablonski komentari po prefiksu, upoređeni sa organskom publikom.
///
/// Komentar je šablonski ako ima blizanca na drugom postu: MinHash sličnost ≥ `min_minhash`
/// u prozoru (kopija i sitne izmene) ili par iz `paraphrases` (embeddings bliži od praga, sused
/// iz poslednjih `template_lookback`). Blizanac na istom postu se ne broji (koncept §8):
/// čitaoci istog članka pišu o istoj temi, a citat iz teksta je kopija. Drugi post je ujedno i
/// drugi prikaz (prikaz je jedno učitavanje jednog posta). Organski udeo
/// je prosek udela šablonskih po pojedincima — prefiksima sa manje od `min_comments` komentara,
/// svaki jedan glas, kao kod usmerenih glasova; i ovde presuda traži veličinu efekta i
/// značajnost, na više postova.
///
/// Pojedinac koji je u kohorti iz grafa — usklađeni šabloni (`template_graph`, isti prozor) ili
/// `exclude` (usklađeni glasovi) — nije organska publika: rasuta klaka bi inače organski udeo
/// podigla svojim šablonima i zaštitila i velike prefikse.
pub fn templates(
    comments: &[CommentText],
    paraphrases: &[Paraphrase],
    exclude: &Nets,
    cfg: &Config,
) -> Templates {
    let sigs: Vec<_> = comments.iter().map(|c| minhash(&c.text)).collect();
    let index: HashMap<(&str, &str), usize> = comments
        .iter()
        .enumerate()
        .map(|(i, c)| ((c.portal.as_str(), c.comment.as_str()), i))
        .collect();
    // Susedi: komentari iz prozora (0..n), pa stari blizanci i čvorišta grupa kopija.
    let mut near: Vec<Vec<usize>> = vec![Vec::new(); comments.len()];
    let mut copy = vec![false; comments.len()];
    for group in copies(comments, &sigs, cfg.min_minhash) {
        let hub = near.len();
        near.push(group.clone());
        for i in group {
            copy[i] = true;
            near[i].push(hub);
        }
    }
    // Parafraza do `max_text_distance` je blizanac za deljene šablone, do `max_graph_distance`
    // za ivice grafa.
    let mut templated = vec![false; comments.len()];
    let mut old: HashMap<(&str, &str), usize> = HashMap::new();
    for (portal, a, b, d) in paraphrases {
        let Some(&i) = index.get(&(portal.as_str(), a.as_str())) else {
            continue;
        };
        let twin = *d <= cfg.max_text_distance;
        let j = match index.get(&(portal.as_str(), b.as_str())) {
            Some(&j) if comments[i].post != comments[j].post => {
                templated[j] |= twin;
                j
            }
            Some(_) => continue,
            // Blizanac stariji od prozora (`paraphrase_pairs` traži samo druge postove). I on je
            // sused: dva komentara iz prozora su isti šablon i preko istog starog blizanca.
            None if *d <= cfg.max_graph_distance => {
                *old.entry((portal.as_str(), b.as_str())).or_insert_with(|| {
                    near.push(Vec::new());
                    near.len() - 1
                })
            }
            None => usize::MAX,
        };
        templated[i] |= twin;
        if *d <= cfg.max_graph_distance && !near[i].contains(&j) {
            near[i].push(j);
            near[j].push(i);
        }
    }
    let members = template_graph(comments, &near, cfg);
    let cohort: BTreeSet<(&str, &str)> = exclude
        .iter()
        .map(|(p, n)| (p.as_str(), n.as_str()))
        .chain(members.iter().map(|m| (m.portal.as_str(), m.net.as_str())))
        .collect();

    #[derive(Default)]
    struct Net<'a> {
        comments: i64,
        templated: i64,
        copies: i64,
        vids: BTreeSet<&'a str>,
        posts: BTreeSet<&'a str>,
    }
    let mut nets: BTreeMap<(&str, &str), Net> = BTreeMap::new();
    for (i, c) in comments.iter().enumerate() {
        let n = nets.entry((&c.portal, &c.net)).or_default();
        n.comments += 1;
        n.templated += i64::from(copy[i] || templated[i]);
        n.copies += i64::from(copy[i]);
        if let Some(v) = &c.vid {
            n.vids.insert(v);
        }
        n.posts.insert(&c.post);
    }
    // Organski udeo samo iz pojedinaca: prefiksa koji ni sami ne mogu ući u kohortu, a nisu ni u
    // kohorti iz grafa.
    let mut portals: BTreeMap<&str, (f64, f64)> = BTreeMap::new();
    let individual =
        |key: &(&str, &str), n: &Net| n.comments < cfg.min_comments && !cohort.contains(key);
    for ((portal, _), n) in nets.iter().filter(|(key, n)| individual(key, n)) {
        let e = portals.entry(portal).or_default();
        e.0 += n.templated as f64 / n.comments as f64;
        e.1 += 1.0;
    }

    let mut out = Vec::new();
    for ((portal, net), n) in &nets {
        let (vids, posts) = (n.vids.len() as i64, n.posts.len() as i64);
        if n.comments < cfg.min_comments || vids < cfg.min_vids || posts < cfg.min_posts {
            continue;
        }
        let share = n.templated as f64 / n.comments as f64;
        let (sum, count) = portals.get(portal).copied().unwrap_or_default();
        let baseline = (sum + PRIOR_NETS * PRIOR_SHARE) / (count + PRIOR_NETS);
        let lift = share / baseline;
        let p_value = binomial_tail(n.comments, n.templated, baseline);
        if lift >= cfg.min_lift && p_value <= cfg.max_p_value {
            out.push(TemplateCohort {
                portal: (*portal).to_owned(),
                net: (*net).to_owned(),
                comments: n.comments,
                vids,
                posts,
                templated: n.templated,
                copies: n.copies,
                baseline,
                lift,
                p_value,
            });
        }
    }
    Templates {
        cohorts: out,
        members,
    }
}

impl From<TemplateCohort> for Finding {
    fn from(c: TemplateCohort) -> Self {
        let evidence = json!({
            "detector": SHARED_TEMPLATES, "comments": c.comments, "vids": c.vids, "posts": c.posts,
            "templated": c.templated, "copies": c.copies, "baseline": c.baseline,
            "lift": c.lift, "p_value": c.p_value,
        });
        Self {
            detector: SHARED_TEMPLATES.to_owned(),
            portal: c.portal,
            net: c.net,
            votes: c.comments,
            evidence,
        }
    }
}

// --- embeddings (posao u engine-u) ----------------------------------------------------------

/// Dimenzija `halfvec` kolone (bge-m3).
pub const EMBEDDING_DIM: usize = 1024;

#[derive(Debug)]
pub enum EmbedError {
    Db(sqlx::Error),
    Llm(LlmError),
    Dim(usize),
}

impl std::fmt::Display for EmbedError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Db(e) => write!(f, "baza: {e}"),
            Self::Llm(e) => write!(f, "embeddings: {e}"),
            Self::Dim(d) => write!(f, "vektor dimenzije {d}, očekivano {EMBEDDING_DIM}"),
        }
    }
}

/// Embeddings za komentare iz prozora koji ih još nemaju (najviše `limit`); vraća koliko je
/// upisano. Red poslova je sama tabela događaja: komentar bez reda u `comment_embedding` čeka.
pub async fn embed_pending<E: Embedder>(
    pool: &PgPool,
    embedder: &E,
    cfg: &Config,
    limit: i64,
) -> Result<usize, EmbedError> {
    let pending: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT e.portal, e.data->>'comment', e.data->>'text'
         FROM events e
         WHERE e.type = 'comment' AND e.source = 'server' AND e.post IS NOT NULL
           AND e.recv_at > now() - make_interval(secs => $1)
           AND NOT EXISTS (
               SELECT 1 FROM comment_embedding c
               WHERE c.portal = e.portal AND c.comment = e.data->>'comment' AND c.model = $2
           )
         ORDER BY e.recv_at
         LIMIT $3",
    )
    .bind(cfg.window.as_secs_f64())
    .bind(embedder.model())
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(EmbedError::Db)?;
    if pending.is_empty() {
        return Ok(0);
    }
    let texts: Vec<&str> = pending.iter().map(|(_, _, t)| t.as_str()).collect();
    let vectors = embedder.embed(&texts).await.map_err(EmbedError::Llm)?;
    if let Some(v) = vectors.iter().find(|v| v.len() != EMBEDDING_DIM) {
        return Err(EmbedError::Dim(v.len()));
    }
    let (portals, ids): (Vec<_>, Vec<_>) = pending.into_iter().map(|(p, c, _)| (p, c)).unzip();
    let literals: Vec<String> = vectors.iter().map(|v| vector_literal(v)).collect();
    let done = sqlx::query(
        "INSERT INTO comment_embedding (portal, comment, post, t, model, emb)
         SELECT e.portal, u.comment, e.post, e.recv_at, $3, u.emb::halfvec
         FROM UNNEST($1::text[], $2::text[], $4::text[]) AS u(portal, comment, emb)
         JOIN events e ON e.portal = u.portal AND e.type = 'comment' AND e.source = 'server'
                      AND e.data->>'comment' = u.comment
                      AND e.recv_at > now() - make_interval(secs => $5)
         ON CONFLICT DO NOTHING",
    )
    .bind(portals)
    .bind(ids)
    .bind(embedder.model())
    .bind(literals)
    .bind(cfg.window.as_secs_f64())
    .execute(pool)
    .await
    .map_err(EmbedError::Db)?;
    Ok(usize::try_from(done.rows_affected()).unwrap_or(usize::MAX))
}

/// Embeddings stariji od retencije događaja (izvedeni su iz ličnih podataka, `docs/llm.md` §5a).
pub async fn purge_embeddings(pool: &PgPool, retention_days: i32) -> Result<u64, sqlx::Error> {
    Ok(
        sqlx::query("DELETE FROM comment_embedding WHERE t < now() - make_interval(days => $1)")
            .bind(retention_days)
            .execute(pool)
            .await?
            .rows_affected(),
    )
}

/// Tekstualni oblik vektora za pgvector: `[0.1,-0.2,…]`.
pub(crate) fn vector_literal(v: &[f32]) -> String {
    let parts: Vec<String> = v.iter().map(f32::to_string).collect();
    format!("[{}]", parts.join(","))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

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
            max_graph_distance: 0.25,
            min_minhash: 0.5,
            covote: Duration::from_secs(120),
            min_jaccard: 0.5,
            min_partners: 2,
            min_cohort_nets: 5,
            promotion: Duration::from_secs(600),
            template_lookback: Duration::from_secs(7 * 24 * 3600),
            ttl: Duration::from_secs(3600),
            retro: Duration::from_secs(600),
        }
    }

    fn text(net: &str, post: &str, vid: &str, comment: &str, text: &str) -> CommentText {
        CommentText {
            portal: "demo.local".into(),
            net: net.into(),
            post: post.into(),
            vid: Some(vid.into()),
            comment: comment.into(),
            text: text.into(),
        }
    }

    #[test]
    fn minhash_sees_copies_not_other_texts() {
        let a = minhash("Lep dan danas, pozdrav svima.");
        assert_eq!(
            minhash_similarity(&a, &minhash("lep dan danas pozdrav svima!!")),
            1.0
        );
        let small = minhash_similarity(&a, &minhash("Lep dan danas, pozdrav svima iz Niša."));
        assert!(small > 0.5 && small < 1.0, "{small}");
        let other = minhash_similarity(&a, &minhash("Rok je previše optimističan."));
        assert!(other < 0.1, "{other}");
        assert_eq!(normalize("  Ćao,   SVIMA!  "), "ćao svima");
        assert_eq!(minhash("ab"), minhash("AB"));
    }

    const WORDS: [&str; 40] = [
        "staza",
        "rasveta",
        "klupe",
        "drveće",
        "česma",
        "igralište",
        "ograda",
        "parking",
        "biblioteka",
        "čitaonica",
        "članarina",
        "knjige",
        "periodika",
        "subota",
        "upis",
        "ispiti",
        "autobus",
        "stajalište",
        "polasci",
        "karta",
        "vozači",
        "trotoar",
        "špic",
        "nadstrešnica",
        "pijaca",
        "tezge",
        "prodavci",
        "zakup",
        "mleko",
        "sir",
        "povrće",
        "seljaci",
        "budžet",
        "tender",
        "izvođač",
        "rokovi",
        "sednica",
        "stanari",
        "udruženje",
        "zima",
    ];

    /// Publika: `n` prefiksa sa po jednim komentarom, bez zajedničkih reči sa susedima.
    fn audience(n: usize) -> Vec<CommentText> {
        (0..n)
            .map(|i| {
                let t = format!(
                    "{} {} {}",
                    WORDS[i % 40],
                    WORDS[(i + 13) % 40],
                    WORDS[(i + 27) % 40]
                );
                text(
                    &format!("10.0.{i}.0/24"),
                    &format!("p-{}", i % 4),
                    &format!("r{i}"),
                    &format!("k{i}"),
                    &t,
                )
            })
            .collect()
    }

    #[test]
    fn templates_found_for_copies_and_paraphrases_not_for_audience() {
        let mut c = audience(40);
        // Kopije: isti šablon sa 3 prikaza, na 2 posta.
        for i in 0..6 {
            c.push(text(
                "198.18.1.0/24",
                &format!("p-{}", i % 2),
                &format!("a{i}"),
                &format!("a{i}"),
                "Odlično rečeno, bravo.",
            ));
        }
        // Parafraze: tekstovi različiti, embeddings bliski (parovi spolja).
        let para = [
            "Sjajno izrečeno.",
            "Baš si to lepo rekao.",
            "Tačno tako, svaka čast.",
            "Bolje se nije moglo reći.",
            "Izvrsno sročeno.",
        ];
        for (i, t) in para.iter().enumerate() {
            c.push(text(
                "198.18.2.0/24",
                &format!("p-{}", i % 3),
                &format!("b{i}"),
                &format!("b{i}"),
                t,
            ));
        }
        let pairs: Vec<_> = (0..5)
            .flat_map(|i| {
                (i + 1..5).map(move |j| {
                    (
                        "demo.local".to_owned(),
                        format!("b{i}"),
                        format!("b{j}"),
                        0.1,
                    )
                })
            })
            .collect();
        // CGNAT: 8 organskih komentara iza jednog prefiksa, jedan slučajno sličan drugom.
        for i in 0..8 {
            let t = if i < 2 {
                "Konačno nešto dobro za kraj.".to_owned()
            } else {
                format!(
                    "{} {} {}",
                    WORDS[(i * 3 + 1) % 40],
                    WORDS[(i * 7 + 2) % 40],
                    WORDS[(i * 11 + 5) % 40]
                )
            };
            c.push(text(
                "198.18.3.0/24",
                &format!("p-{}", i % 4),
                &format!("g{i}"),
                &format!("g{i}"),
                &t,
            ));
        }
        // Isti tekst dva puta sa istog prikaza (istog posta) nije šablon: jedan čovek, dva slanja.
        for i in 0..6 {
            let t = [
                "Prvi tekst o stazi.",
                "Drugi, o biblioteci.",
                "Treći, o autobusu.",
            ][i / 2];
            c.push(text(
                "198.18.4.0/24",
                &format!("p-{}", i / 2),
                &format!("d{}", i / 2),
                &format!("d{i}"),
                t,
            ));
        }

        let found = templates(&c, &pairs, &Nets::new(), &cfg()).cohorts;
        let nets: Vec<_> = found.iter().map(|f| f.net.as_str()).collect();
        assert_eq!(nets, ["198.18.1.0/24", "198.18.2.0/24"], "{found:?}");
        assert_eq!((found[0].templated, found[0].copies), (6, 6));
        assert_eq!((found[1].templated, found[1].copies), (5, 0));
    }

    #[test]
    fn twin_older_than_window_counts() {
        // Klaka ponavlja jučerašnje šablone: blizanci (b…) nisu u prozoru, ali kNN ih nađe.
        let mut c = audience(40);
        for i in 0..6 {
            c.push(text(
                "198.18.1.0/24",
                &format!("p-{}", i % 2),
                &format!("a{i}"),
                &format!("a{i}"),
                &format!("Tekst {i}"),
            ));
        }
        let old: Vec<_> = (0..6)
            .map(|i| {
                (
                    "demo.local".to_owned(),
                    format!("a{i}"),
                    format!("juce{i}"),
                    0.1,
                )
            })
            .collect();
        let found = templates(&c, &old, &Nets::new(), &cfg()).cohorts;
        assert_eq!(
            found
                .iter()
                .map(|f| (f.net.as_str(), f.templated))
                .collect::<Vec<_>>(),
            [("198.18.1.0/24", 6)]
        );
    }

    #[test]
    fn twins_on_the_same_post_do_not_count() {
        // Čitaoci istog članka: isti citat iz teksta i bliske parafraze, ali svaki blizanac je na
        // istom postu — iz prozora i iz ranijih dana. Prefiks ima komentare na 2 posta.
        let mut c = audience(40);
        for i in 0..8 {
            let (post, t) = if i < 4 {
                (
                    "p-1",
                    "„Staza će biti gotova do zime”, kaže opština.".to_owned(),
                )
            } else {
                ("p-2", format!("Biblioteka nedeljom, napokon {i}."))
            };
            c.push(text(
                "198.18.1.0/24",
                post,
                &format!("a{i}"),
                &format!("a{i}"),
                &t,
            ));
        }
        let pairs: Vec<_> = (4..8)
            .flat_map(|i| (4..8).filter(move |&j| j != i).map(move |j| (i, j)))
            .map(|(i, j)| {
                (
                    "demo.local".to_owned(),
                    format!("a{i}"),
                    format!("a{j}"),
                    0.1,
                )
            })
            .collect();
        assert!(
            templates(&c, &pairs, &Nets::new(), &cfg())
                .cohorts
                .is_empty()
        );
    }

    #[test]
    fn templates_found_without_audience() {
        // Noću nema pojedinaca u prozoru: organski udeo je ceo prior. Sa priorom 0,5 lift ne bi
        // mogao preći 2, pa ni kohorta sa samim kopijama ne bi bila nađena.
        let c: Vec<_> = (0..6)
            .map(|i| {
                text(
                    "198.18.1.0/24",
                    &format!("p-{}", i % 2),
                    &format!("a{i}"),
                    &format!("a{i}"),
                    "Odlično rečeno, bravo.",
                )
            })
            .collect();
        let found = templates(&c, &[], &Nets::new(), &cfg()).cohorts;
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!((found[0].templated, found[0].baseline), (6, PRIOR_SHARE));
    }

    const KLAKA: [&str; 5] = [
        "Odlično rečeno.",
        "Potpuno se slažem, bravo.",
        "Ovo je jedini razuman komentar ovde.",
        "Tačno tako, nema šta da se doda.",
        "Konačno neko da kaže kako jeste.",
    ];

    /// Rasuta klaka: `n` prefiksa sa po 3 komentara (jedan po članku), šabloni redom kao u caci-ju.
    fn scattered(n: usize) -> Vec<CommentText> {
        (0..n)
            .flat_map(|k| {
                (0..3).map(move |i| {
                    text(
                        &format!("198.18.{k}.0/24"),
                        &format!("p-{}", (2 * k + i) % 3),
                        &format!("s{k}-{i}"),
                        &format!("s{k}-{i}"),
                        KLAKA[(k + i) % 5],
                    )
                })
            })
            .collect()
    }

    #[test]
    fn scattered_klaka_found_by_template_graph_and_kept_out_of_baseline() {
        // 24 prefiksa po 3 šablonska komentara: nijedan ne prelazi min_comments, a kao
        // „pojedinci" bi organski udeo podigli na 0,40 — lift ne bi mogao preći 2,5, pa ni
        // koncentrisan prefiks sa samim šablonima ne bi bio nađen.
        let mut c = audience(40);
        c.extend(scattered(24));
        for i in 0..6 {
            c.push(text(
                "198.19.1.0/24",
                &format!("p-{}", i % 3),
                &format!("k{i}"),
                &format!("k{i}"),
                KLAKA[i % 5],
            ));
        }
        let found = templates(&c, &[], &Nets::new(), &cfg());
        let members: BTreeSet<_> = found.members.iter().map(|m| m.net.as_str()).collect();
        for k in 0..24 {
            assert!(
                members.contains(format!("198.18.{k}.0/24").as_str()),
                "{members:?}"
            );
        }
        assert!(
            members.iter().all(|n| !n.starts_with("10.")),
            "publika: {members:?}"
        );
        let nets: Vec<_> = found.cohorts.iter().map(|f| f.net.as_str()).collect();
        assert_eq!(nets, ["198.19.1.0/24"], "{:?}", found.cohorts);
        // Publika ima par slučajnih kopija (dve od tri iste reči), pa organski udeo nije nula.
        assert!(found.cohorts[0].baseline < 0.1, "{:?}", found.cohorts);
    }

    /// Prsten od 6 prefiksa, svaki sa parafrazom šablona A i B (na dva posta); parafraze istog
    /// šablona su blizanci sa susedima u prstenu (parovi spolja, kao iz kNN-a).
    fn ring() -> (Vec<CommentText>, Vec<Paraphrase>) {
        let mut c = audience(40);
        let mut pairs = Vec::new();
        for k in 0..6 {
            for (t, shift) in [("a", 0), ("b", 1)] {
                let id = format!("{t}{k}");
                c.push(text(
                    &format!("198.18.{k}.0/24"),
                    &format!("p-{}", (k + shift) % 3),
                    &id,
                    &id,
                    &format!("Parafraza {id}"),
                ));
                pairs.push((
                    "demo.local".to_owned(),
                    id,
                    format!("{t}{}", (k + 1) % 6),
                    0.1,
                ));
            }
        }
        (c, pairs)
    }

    #[test]
    fn drifting_paraphrase_does_not_chain_two_templates() {
        // Parafraza a0 koju je mali model pomerio ka šablonu B: kao komponenta bi spojila A i B u
        // jedan klaster, pa bi svaki par prefiksa delio jedan klaster — nijedna ivica.
        let (c, mut pairs) = ring();
        pairs.push((
            "demo.local".to_owned(),
            "a0".to_owned(),
            "b3".to_owned(),
            0.1,
        ));
        let found = templates(&c, &pairs, &Nets::new(), &cfg());
        let members: BTreeSet<_> = found.members.iter().map(|m| m.net.as_str()).collect();
        assert_eq!(members.len(), 6, "{:?}", found.members);
    }

    #[test]
    fn graph_distance_is_looser_than_twin_distance() {
        // Par na 0,23: iznad praga blizanca (0,2), ispod praga ivice (0,25).
        let (c, pairs) = ring();
        let loose: Vec<_> = pairs
            .into_iter()
            .map(|(p, a, b, _)| (p, a, b, 0.23))
            .collect();
        assert_eq!(templates(&c, &loose, &Nets::new(), &cfg()).members.len(), 6);
        let mut c = audience(40);
        for i in 0..6 {
            c.push(text(
                "198.18.1.0/24",
                &format!("p-{}", i % 2),
                &format!("a{i}"),
                &format!("a{i}"),
                &format!("{} {} {}", WORDS[3 * i], WORDS[3 * i + 1], WORDS[3 * i + 2]),
            ));
        }
        let old = |d: f64| -> Vec<Paraphrase> {
            (0..6)
                .map(|i| ("demo.local".into(), format!("a{i}"), format!("juce{i}"), d))
                .collect()
        };
        let cohorts = |d| templates(&c, &old(d), &Nets::new(), &cfg()).cohorts;
        assert!(cohorts(0.23).is_empty(), "deljeni šabloni: nije blizanac");
        assert_eq!(cohorts(0.15).len(), 1);
    }

    #[test]
    fn one_comment_paired_twice_is_not_two_templates() {
        // Komentar x prefiksa k je blizanac i y i z prefiksa k+1: to je jedan šablon, ne dva.
        let mut c = audience(40);
        let mut pairs = Vec::new();
        for k in 0..6 {
            for (t, post) in [("x", 0), ("y", 1), ("z", 2)] {
                let id = format!("{t}{k}");
                c.push(text(
                    &format!("198.18.{k}.0/24"),
                    &format!("p-{post}"),
                    &id,
                    &id,
                    &format!("Tekst {id}"),
                ));
            }
            for t in ["y", "z"] {
                pairs.push((
                    "demo.local".to_owned(),
                    format!("x{k}"),
                    format!("{t}{}", (k + 1) % 6),
                    0.1,
                ));
            }
        }
        let found = templates(&c, &pairs, &Nets::new(), &cfg());
        assert!(found.members.is_empty(), "{:?}", found.members);
    }

    #[test]
    fn popular_phrase_and_cgnat_make_no_template_graph() {
        // Publika: 30 čitalaca, svaki sa istom popularnom frazom i jednim svojim komentarom, na
        // dva članka — dele jedan klaster, a ivica traži dva.
        let mut c = audience(40);
        for k in 0..30 {
            c.push(text(
                &format!("10.1.{k}.0/24"),
                &format!("p-{}", k % 3),
                &format!("b{k}"),
                &format!("b{k}"),
                "Bravo, svaka čast!",
            ));
        }
        // CGNAT: 20 komentara, od toga dve popularne fraze; deli ih sa četiri čitaoca koji su
        // napisali iste dve fraze, ali ni sa kim nema sličan skup (Jaccard). Ta četiri čitaoca
        // jesu usklađena među sobom — granica detektora za popularne fraze — ali ih je manje od
        // `min_cohort_nets`.
        for i in 0..20 {
            let t = match i {
                0 => "Bravo, svaka čast!".to_owned(),
                1 => "Tačno tako, nema šta da se doda.".to_owned(),
                _ => format!("{} {} {i}", WORDS[i % 40], WORDS[(i * 7) % 40]),
            };
            c.push(text(
                "198.18.200.0/24",
                &format!("p-{}", i % 3),
                &format!("g{i}"),
                &format!("g{i}"),
                &t,
            ));
        }
        for k in 0..4 {
            c.push(text(
                &format!("10.1.{k}.0/24"),
                &format!("p-{}", (k + 1) % 3),
                &format!("t{k}"),
                &format!("t{k}"),
                "Tačno tako, nema šta da se doda.",
            ));
        }
        let found = templates(&c, &[], &Nets::new(), &cfg());
        assert!(found.members.is_empty(), "{:?}", found.members);
    }

    #[test]
    fn templates_need_several_posts() {
        let mut c = audience(40);
        for i in 0..8 {
            c.push(text(
                "198.18.1.0/24",
                "p-1",
                &format!("a{i}"),
                &format!("a{i}"),
                "Ima li neko recept za pitu?",
            ));
        }
        assert!(templates(&c, &[], &Nets::new(), &cfg()).cohorts.is_empty());
    }

    #[test]
    fn copies_found_through_lsh_in_linear_time() {
        // 3000 istih kopija na jednom postu, 3000 različitih tekstova na 100 postova i jedna sitna
        // izmena na trećem postu, na kraju kofe: kopije imaju blizanca samo preko nje. Poređenje
        // svakog para bi bilo 18 miliona poređenja; a i filter po postu nad celom kofom bi za
        // svaku kopiju prešao ostalih 3000 pre izmene — 9 miliona koraka po traci.
        let mut c = Vec::new();
        for i in 0..3_000 {
            c.push(text(
                "198.18.1.0/24",
                "p-1",
                &format!("a{i}"),
                &format!("a{i}"),
                "Lep dan danas, pozdrav svima.",
            ));
        }
        // Različiti tekstovi: nasumična slova (LCG), bez zajedničkih reči.
        let mut seed = 17u64;
        let mut letters = |n: usize| -> String {
            (0..n)
                .map(|k| {
                    seed = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
                    if k % 7 == 6 {
                        ' '
                    } else {
                        (b'a' + (seed >> 59) as u8 % 26) as char
                    }
                })
                .collect()
        };
        for i in 0..3_000 {
            let t = letters(42);
            c.push(text(
                "10.0.0.0/24",
                &format!("p-r{}", i % 100),
                &format!("r{i}"),
                &format!("r{i}"),
                &t,
            ));
        }
        c.push(text(
            "198.18.2.0/24",
            "p-3",
            "b",
            "b",
            "Lep dan danas, pozdrav svima iz Niša.",
        ));
        // Kopije samo na jednom postu (citat iz teksta): nemaju blizanca.
        for i in 0..50 {
            c.push(text(
                "198.18.3.0/24",
                "p-4",
                &format!("q{i}"),
                &format!("q{i}"),
                "„Radovi počinju u martu”, piše u tekstu.",
            ));
        }
        let sigs: Vec<_> = c.iter().map(|x| minhash(&x.text)).collect();
        let mut copy = vec![false; c.len()];
        let groups = copies(&c, &sigs, 0.5);
        for &i in groups.iter().flatten() {
            copy[i] = true;
        }
        assert!(copy[..3_000].iter().all(|&x| x), "kopije");
        assert!(copy[6_000], "sitna izmena");
        let organic = copy[3_000..6_000].iter().filter(|&&x| x).count();
        assert!(organic < 30, "različiti tekstovi: {organic} sa blizancem");
        assert!(!copy[6_001..].iter().any(|&x| x), "kopije na istom postu");
        // Kopije i izmena su u istoj grupi — na dva koraka preko njenog čvorišta, ne u lancu.
        assert!(
            groups
                .iter()
                .any(|g| g.contains(&6_000) && (0..3_000).all(|i| g.contains(&i))),
            "jedna grupa"
        );
    }

    #[test]
    fn vector_literal_is_pgvector_text() {
        assert_eq!(vector_literal(&[0.5, -1.0, 0.000_1]), "[0.5,-1,0.0001]");
    }
}
