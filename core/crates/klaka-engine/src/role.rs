//! Uloga kohorte (docs/caci.md §1): pojačivači guraju, ćaci ruše, razvodnjivači gase — po efektu,
//! na nivou kohorte, za recenzenta i izveštaj. **Nikad za presudu**: presuda je već doneta po
//! koordinaciji, isto za sve uloge (koncept §0). Uloge dele prefiks (ista kancelarija), pa je
//! ishod skup uloga, svaka sa razlogom.
//!
//! Signali: smer glasova prefiksa i autori na koje „protiv" cilja; stav i toksičnost iz opisa
//! kohorte (`describe.rs`); relevantnost komentara prema tekstu članka, uz publiku na istim
//! člancima kao meru. Relevantnost sama ne razlikuje uloge — opšte pohvale, uvrede i skretanje se
//! podjednako slabo tiču članka (izmereno: 0,26–0,34, publika 0,44–0,51) — pa je za razvodnjivača
//! odlučujući stav „skretanje", a relevantnost je razlog uz njega.

use std::time::Duration;

use klaka_llm::Embedder;
use serde_json::{Value, json};
use sqlx::PgPool;

use crate::Config;
use crate::comments::{EMBEDDING_DIM, EmbedError, vector_literal};

/// Najviše znakova članka u embedding-u (naslov i početak teksta nose temu).
const POST_TEXT_MAX: usize = 4000;

/// Embeddings članaka na kojima ima komentara u prozoru (nova revizija → nov vektor). Članak se
/// traži preko indeksa (portal, post), ne skeniranjem svih događaja.
pub async fn embed_posts<E: Embedder>(
    pool: &PgPool,
    embedder: &E,
    cfg: &Config,
) -> Result<usize, EmbedError> {
    let pending: Vec<(String, String, i32, String)> = sqlx::query_as(
        "WITH posts AS (
             SELECT DISTINCT portal, post FROM events
             WHERE type = 'comment' AND source = 'server' AND post IS NOT NULL
               AND recv_at > now() - make_interval(secs => $1)
         ),
         latest AS (
             SELECT DISTINCT ON (p.portal, p.post) p.portal, p.post,
                    coalesce((e.data->>'rev')::int, 0) AS rev,
                    coalesce(e.data->>'title', '') || E'\\n\\n' || coalesce(e.data->>'body', '') AS text
             FROM posts p
             JOIN events e ON e.portal = p.portal AND e.post = p.post
                          AND e.type = 'post' AND e.source = 'server'
             ORDER BY p.portal, p.post, e.recv_at DESC
         )
         SELECT l.portal, l.post, l.rev, l.text FROM latest l
         WHERE NOT EXISTS (
             SELECT 1 FROM post_embedding pe
             WHERE pe.portal = l.portal AND pe.post = l.post AND pe.model = $2 AND pe.rev >= l.rev
         )",
    )
    .bind(cfg.window.as_secs_f64())
    .bind(embedder.model())
    .fetch_all(pool)
    .await
    .map_err(EmbedError::Db)?;
    if pending.is_empty() {
        return Ok(0);
    }
    let texts: Vec<String> = pending
        .iter()
        .map(|(_, _, _, t)| t.chars().take(POST_TEXT_MAX).collect())
        .collect();
    let refs: Vec<&str> = texts.iter().map(String::as_str).collect();
    let vectors = embedder.embed(&refs).await.map_err(EmbedError::Llm)?;
    if let Some(v) = vectors.iter().find(|v| v.len() != EMBEDDING_DIM) {
        return Err(EmbedError::Dim(v.len()));
    }
    for ((portal, post, rev, _), v) in pending.iter().zip(&vectors) {
        sqlx::query(
            "INSERT INTO post_embedding (portal, post, model, rev, emb)
             VALUES ($1, $2, $3, $4, $5::halfvec)
             ON CONFLICT (portal, post, model) DO UPDATE SET rev = EXCLUDED.rev, emb = EXCLUDED.emb",
        )
        .bind(portal)
        .bind(post)
        .bind(embedder.model())
        .bind(rev)
        .bind(vector_literal(v))
        .execute(pool)
        .await
        .map_err(EmbedError::Db)?;
    }
    Ok(pending.len())
}

/// Signali uloge za prefiks presude: prozor dokaza i `after` posle presude (kohorta tada još
/// radi, već u shadow-u — isto ponašanje).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Signals {
    /// Glasovi „za" na tuđe komentare, i na komentare kohorte (sopstveni prefiks ili prefiks sa
    /// presudom iz istog vremena) — razvodnjivači glasaju jedni za druge, pojačivači za tuđe.
    pub votes_for: i64,
    pub votes_for_cohort: i64,
    pub votes_against: i64,
    /// Različitih autora na čije komentare glasa „protiv", i udeo najčešćeg od njih.
    pub against_authors: i64,
    pub against_top_share: f64,
    pub comments: i64,
    /// Udeo komentara prefiksa na članku na kome ih je najviše.
    pub top_post_share: f64,
    /// Prosečna sličnost komentara prefiksa sa tekstom članka, i publike na istim člancima.
    pub relevance: Option<f64>,
    pub audience_relevance: Option<f64>,
    /// Iz opisa kohorte (G2), ako ga ima: komentara koji hvale, napadaju, skreću; toksičnost.
    pub praise: Option<u64>,
    pub attack: Option<u64>,
    pub offtopic: Option<u64>,
    pub toxicity: Option<String>,
    pub stance: Option<String>,
    /// Komentara u uzorku opisa (do 20; za kohortu iz grafa iz svih njenih prefiksa): brojevi po
    /// vrsti su nad njim.
    pub sample: Option<u64>,
}

/// Verzija pravila: uloga starije verzije se preračunava iz sačuvanog opisa (`refresh`), bez
/// ponovnog poziva modela.
pub const ROLE_VERSION: &str = "u5";

/// Najmanje glasova jednog smera da bi smer bio signal uloge, i najmanji udeo među glasovima
/// prefiksa: pojedinačan glas suprotnog smera ne pravi ulogu.
const MIN_SIDE_VOTES: i64 = 3;
const MIN_SIDE_SHARE: f64 = 0.25;
/// Komentari po vrsti (iz opisa): najmanje ovoliko, i ovoliki udeo, da bi vrsta bila uloga.
const MIN_KIND: u64 = 2;
const MIN_KIND_SHARE: f64 = 0.25;
/// Razvodnjivač zatrpava jedan članak: ovoliki udeo komentara prefiksa na jednom članku.
const CONCENTRATED: f64 = 0.8;
const MIN_OFFTOPIC: u64 = 3;

/// Uloge sa razlozima: `{"uloge": [...], "razlozi": [...]}`, redom pojačivač, ćaci, razvodnjivač.
///
/// Brojevi iz opisa su bučni (mali model, izmereno), pa nijedan sam ne pravi ćacija ni
/// razvodnjivača: napad traži i toksičnost, skretanje traži većinu komentara ili članak koji je
/// prefiks zatrpao. Kod malih kohorti (3 komentara) model broji loše („1 hvali, 1 napada" uz
/// „komentari se slažu i hvale"), a stav pogađa, pa i stav „podrška" daje pojačivača —
/// „mešovito" ne, jer ga model kaže i za razvodnjivače.
pub fn roles(s: &Signals) -> Value {
    let votes = s.votes_for + s.votes_for_cohort + s.votes_against;
    let side = |n: i64| n >= MIN_SIDE_VOTES && n as f64 >= MIN_SIDE_SHARE * votes as f64;
    let n = s.comments.max(0) as u64;
    // Imenilac brojeva iz opisa: uzorak opisa, ne komentari prefiksa (kod kohorte iz grafa opis
    // vidi 20 komentara, a prefiks ima 3).
    let sample = s.sample.unwrap_or(n);
    let kind =
        |k: Option<u64>| k.filter(|&k| k >= MIN_KIND && k as f64 >= MIN_KIND_SHARE * sample as f64);
    let toxicity = s.toxicity.as_deref().unwrap_or("nema");
    let stance = s.stance.as_deref();
    let concentrated = n >= 5 && s.top_post_share >= CONCENTRATED;
    let mut out: Vec<(&str, Vec<String>)> = Vec::new();

    let mut amplifier = Vec::new();
    if side(s.votes_for) {
        amplifier.push(format!(
            "{} od {votes} glasova „za\" tuđe komentare",
            s.votes_for
        ));
    }
    if let Some(k) = kind(s.praise) {
        amplifier.push(format!("{k} od {sample} komentara hvali"));
    } else if stance == Some("podrška") {
        amplifier.push("stav komentara: podrška".to_owned());
    }
    if !amplifier.is_empty() {
        out.push(("pojačivač", amplifier));
    }

    let mut caci = Vec::new();
    if side(s.votes_against) {
        let mut r = format!("{} od {votes} glasova „protiv\"", s.votes_against);
        if s.against_authors > 0 {
            r.push_str(&format!(
                " ({} autora, najčešći {:.0}%)",
                s.against_authors,
                100.0 * s.against_top_share
            ));
        }
        caci.push(r);
    }
    match kind(s.attack) {
        Some(k) if toxicity != "nema" => caci.push(format!(
            "{k} od {sample} komentara napada, toksičnost {toxicity}"
        )),
        _ if toxicity == "izrazita" => caci.push("toksičnost komentara: izrazita".to_owned()),
        _ if stance == Some("napad") && toxicity != "nema" => {
            caci.push(format!("stav komentara: napad, toksičnost {toxicity}"))
        }
        _ => {}
    }
    if !caci.is_empty() {
        out.push(("ćaci", caci));
    }

    let mut diluter = Vec::new();
    if let Some(k) = s
        .offtopic
        .filter(|&k| k >= MIN_OFFTOPIC && (2 * k >= sample || concentrated))
    {
        diluter.push(format!("{k} od {sample} komentara skreće sa teme"));
    }
    // Glasovi za sopstvene komentare, više nego za tuđe: kohorta gura svoj sadržaj, ne tuđe
    // ciljeve — bihevioralni potpis, i kad zatrpava više članaka i kad opisa modela nema.
    if side(s.votes_for_cohort) && s.votes_for_cohort > s.votes_for {
        let mut r = format!(
            "{} od {votes} glasova „za\" komentare sopstvene kohorte",
            s.votes_for_cohort
        );
        if concentrated {
            r.push_str(&format!(
                ", {:.0}% komentara na jednom članku",
                100.0 * s.top_post_share
            ));
        }
        diluter.push(r);
    }
    if !diluter.is_empty() {
        out.push(("razvodnjivač", diluter));
    }

    let mut reasons: Vec<String> = out
        .iter()
        .map(|(role, rs)| format!("{role}: {}", rs.join("; ")))
        .collect();
    if let (Some(k), Some(o)) = (s.relevance, s.audience_relevance) {
        reasons.push(format!(
            "sličnost komentara sa člankom {k:.2}, publika na istim člancima {o:.2}"
        ));
    }
    json!({
        "uloge": out.iter().map(|(r, _)| *r).collect::<Vec<_>>(),
        "razlozi": reasons,
        "verzija": ROLE_VERSION,
    })
}

/// Signali za prefiks presude `verdict_id`, sa brojevima i toksičnošću iz opisa.
pub async fn signals(
    pool: &PgPool,
    verdict_id: i64,
    description: Option<&Value>,
    after: Duration,
) -> Result<Signals, sqlx::Error> {
    const WINDOW: &str = "v AS (
             SELECT portal, key, created_at,
                    created_at - make_interval(secs => coalesce((evidence->>'window_s')::float8, 600))
                        AS lo,
                    created_at + make_interval(secs => $2) AS hi
             FROM verdicts WHERE id = $1
         )";
    // Glasovi prefiksa po smeru i po tome čiji je komentar cilj.
    let votes: Vec<(i32, bool, String, i64)> = sqlx::query_as(&format!(
        "WITH {WINDOW},
         votes AS (
             SELECT e.portal, e.post, e.data->>'target' AS target, (e.data->>'dir')::int AS dir,
                    v.key, v.lo, v.hi
             FROM events e, v
             WHERE e.portal = v.portal AND e.net = v.key AND e.type = 'vote' AND e.source = 'server'
               AND e.recv_at > v.lo AND e.recv_at <= v.hi
         )
         SELECT sign(x.dir)::int, coalesce(
                    t.net = x.key OR EXISTS (
                        SELECT 1 FROM verdicts c
                        WHERE c.portal = x.portal AND c.key_kind = 'net' AND c.key = t.net
                          AND c.action = 'shadow' AND c.created_at BETWEEN x.lo AND x.hi
                    ), false),
                coalesce(t.author, '?'), count(*)
         FROM votes x
         LEFT JOIN LATERAL (
             SELECT net, data->>'author' AS author FROM events
             WHERE portal = x.portal AND post = x.post AND type = 'comment'
               AND data->>'comment' = x.target
             LIMIT 1
         ) t ON true
         GROUP BY 1, 2, 3"
    ))
    .bind(verdict_id)
    .bind(after.as_secs_f64())
    .fetch_all(pool)
    .await?;
    let mut s = Signals::default();
    let mut against: Vec<i64> = Vec::new();
    for (dir, cohort, _, n) in &votes {
        match (dir.signum(), cohort) {
            (1, true) => s.votes_for_cohort += n,
            (1, false) => s.votes_for += n,
            (-1, _) => {
                s.votes_against += n;
                against.push(*n);
            }
            _ => {}
        }
    }
    s.against_authors = against.len() as i64;
    s.against_top_share = against
        .iter()
        .max()
        .map_or(0.0, |&m| m as f64 / s.votes_against.max(1) as f64);

    // Komentari prefiksa: koliko, koncentracija, i relevantnost prema tekstu članka uz publiku
    // (ostali prefiksi) na istim člancima, istim modelom.
    let (comments, top_post_share, relevance, audience_relevance): (
        i64,
        Option<f64>,
        Option<f64>,
        Option<f64>,
    ) = sqlx::query_as(&format!(
        "WITH {WINDOW},
         c AS (
             SELECT e.net = v.key AS own, e.post, ce.emb, pe.emb AS post_emb
             FROM events e
             JOIN v ON e.portal = v.portal
             LEFT JOIN comment_embedding ce
                    ON ce.portal = e.portal AND ce.comment = e.data->>'comment'
             LEFT JOIN post_embedding pe
                    ON pe.portal = e.portal AND pe.post = e.post AND pe.model = ce.model
             WHERE e.type = 'comment' AND e.source = 'server'
               AND e.recv_at > v.lo AND e.recv_at <= v.hi
               AND e.post IN (
                   SELECT post FROM events
                   WHERE portal = v.portal AND net = v.key AND type = 'comment'
                     AND recv_at > v.lo AND recv_at <= v.hi
               )
         )
         SELECT (SELECT count(*) FROM c WHERE own),
                (SELECT max(n)::float8 / nullif(sum(n), 0)
                 FROM (SELECT count(*) AS n FROM c WHERE own GROUP BY post) p),
                avg(1 - (emb <=> post_emb)) FILTER (WHERE own AND post_emb IS NOT NULL),
                avg(1 - (emb <=> post_emb)) FILTER (WHERE NOT own AND post_emb IS NOT NULL)
         FROM c"
    ))
    .bind(verdict_id)
    .bind(after.as_secs_f64())
    .fetch_one(pool)
    .await?;
    s.comments = comments;
    s.top_post_share = top_post_share.unwrap_or(0.0);
    s.relevance = relevance;
    s.audience_relevance = audience_relevance;
    let count = |k: &str| description.and_then(|d| d.get(k)).and_then(Value::as_u64);
    s.praise = count("hvale");
    s.sample = count("uzorak");
    s.attack = count("napadaju");
    s.offtopic = count("skrecu");
    let text = |k: &str| {
        description
            .and_then(|d| d.get(k))
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    s.toxicity = text("toksicnost");
    s.stance = text("stav");
    Ok(s)
}

/// Računa i upisuje ulogu uz opis kohorte.
pub async fn assign(
    pool: &PgPool,
    verdict_id: i64,
    description: Option<&Value>,
    after: Duration,
) -> Result<Value, sqlx::Error> {
    let mut role = roles(&signals(pool, verdict_id, description, after).await?);
    // Bez opisa modela: uloga iz glasova (i strukture komentara), privremena dok opis ne stigne.
    role["uz_opis"] = description.is_some().into();
    sqlx::query("UPDATE cohort_summary SET role = $2 WHERE verdict_id = $1")
        .bind(verdict_id)
        .bind(&role)
        .execute(pool)
        .await?;
    Ok(role)
}

/// Uloge starije verzije pravila, iz sačuvanog opisa (bez modela): najviše `limit` po pozivu.
pub async fn refresh(pool: &PgPool, after: Duration, limit: i64) -> Result<usize, sqlx::Error> {
    let stale: Vec<(i64, Option<Value>)> = sqlx::query_as(
        "SELECT verdict_id, output FROM cohort_summary
         WHERE status IN ('done', 'skipped', 'failed')
           AND (role IS NULL OR role->>'verzija' IS DISTINCT FROM $1)
         ORDER BY created_at LIMIT $2",
    )
    .bind(ROLE_VERSION)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    for (id, output) in &stale {
        assign(pool, *id, output.as_ref(), after).await?;
    }
    Ok(stale.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(v: &Value) -> Vec<&str> {
        v["uloge"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_str().unwrap())
            .collect()
    }

    #[test]
    fn votes_give_amplifier_and_caci_by_side() {
        // pazljiv-3-postovi: isti prefiksi guraju jedne i potiskuju druge autore.
        let both = Signals {
            votes_for: 30,
            votes_against: 20,
            against_authors: 3,
            against_top_share: 0.4,
            ..Signals::default()
        };
        let v = roles(&both);
        assert_eq!(names(&v), ["pojačivač", "ćaci"]);
        assert!(
            v["razlozi"][1]
                .as_str()
                .unwrap()
                .contains("3 autora, najčešći 40%")
        );
        // Jedan glas suprotnog smera nije uloga.
        let one = Signals {
            votes_for: 30,
            votes_against: 1,
            ..Signals::default()
        };
        assert_eq!(names(&roles(&one)), ["pojačivač"]);
        assert!(names(&roles(&Signals::default())).is_empty());
    }

    #[test]
    fn comment_counts_give_roles_with_toxicity_for_attacks() {
        // sabloni-4: 8 pohvala i 4 napada u istoj kohorti (model: 7 i 3), blaga toksičnost.
        let mixed = Signals {
            comments: 12,
            top_post_share: 0.4,
            praise: Some(7),
            attack: Some(3),
            offtopic: Some(2),
            toxicity: Some("blaga".into()),
            ..Signals::default()
        };
        assert_eq!(names(&roles(&mixed)), ["pojačivač", "ćaci"]);
        // Isti broj „napada" bez toksičnosti nije ćaci (šum modela kod razvodnjivača).
        let noisy = Signals {
            toxicity: Some("nema".into()),
            ..mixed.clone()
        };
        assert_eq!(names(&roles(&noisy)), ["pojačivač"]);
        // Skretanje u manjini, na tri članka: nije razvodnjivač.
        assert!(!names(&roles(&mixed)).contains(&"razvodnjivač"));
    }

    #[test]
    fn shared_description_counts_are_shares_of_its_sample() {
        // Kohorta od 16 prefiksa po 3 komentara, opis nad uzorkom od 20: 14 hvali, 2 „napada"
        // (šum). Sa imeniocem prefiksa (3) bi 2 napada bila dve trećine — lažan ćaci.
        let member = Signals {
            comments: 3,
            sample: Some(20),
            praise: Some(14),
            attack: Some(2),
            offtopic: Some(0),
            toxicity: Some("blaga".into()),
            stance: Some("podrška".into()),
            ..Signals::default()
        };
        let v = roles(&member);
        assert_eq!(names(&v), ["pojačivač"], "{v}");
        assert!(
            v["razlozi"][0].as_str().unwrap().contains("14 od 20"),
            "{v}"
        );
    }

    #[test]
    fn own_cohort_votes_make_a_diluter_on_two_posts_without_description() {
        // uloge-3/4: razvodnjivači na dva članka glasaju jedni za druge; opisa modela nema.
        let two_posts = Signals {
            comments: 8,
            top_post_share: 0.5,
            votes_for_cohort: 4,
            ..Signals::default()
        };
        let v = roles(&two_posts);
        assert_eq!(names(&v), ["razvodnjivač"], "{v}");
        // Pojačivač koji usput glasa i za svoje: više glasova za tuđe — nije razvodnjivač.
        let amplifier = Signals {
            votes_for: 12,
            votes_for_cohort: 4,
            ..Signals::default()
        };
        assert_eq!(names(&roles(&amplifier)), ["pojačivač"]);
    }

    #[test]
    fn small_praise_cohort_from_stance_when_counts_are_off() {
        // rasuti-sabloni: 3 pohvale, model kaže „1 hvali, 1 napada", stav podrška.
        let small = Signals {
            comments: 3,
            praise: Some(1),
            attack: Some(1),
            offtopic: Some(0),
            toxicity: Some("nema".into()),
            stance: Some("podrška".into()),
            ..Signals::default()
        };
        assert_eq!(names(&roles(&small)), ["pojačivač"]);
        // „mešovito" nije pojačivač (model ga kaže i za razvodnjivače).
        let mixed = Signals {
            stance: Some("mešovito".into()),
            ..small
        };
        assert!(names(&roles(&mixed)).is_empty());
    }

    #[test]
    fn diluters_from_offtopic_and_own_votes_on_one_post() {
        // razvodnjivaci-2: 9 komentara na jednom članku, glasaju jedni za druge; model: 6
        // skreće, 2 „napada", toksičnost nema.
        let diluter = Signals {
            comments: 9,
            top_post_share: 1.0,
            votes_for_cohort: 6,
            praise: Some(0),
            attack: Some(2),
            offtopic: Some(6),
            toxicity: Some("nema".into()),
            relevance: Some(0.34),
            audience_relevance: Some(0.47),
            ..Signals::default()
        };
        let v = roles(&diluter);
        assert_eq!(names(&v), ["razvodnjivač"], "{v}");
        let reasons = v["razlozi"].to_string();
        assert!(
            reasons.contains("sopstvene kohorte") && reasons.contains("0.34"),
            "{v}"
        );
    }
}
