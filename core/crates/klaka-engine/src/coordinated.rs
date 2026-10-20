//! Usklađeni glasovi (`coordinated-votes`): klaka raspoređena po mnogo prefiksa (mobilne mreže,
//! proksiji), svaki sa par glasova — ispod pragova detektora po prefiksu. Ono što ne može da
//! sakrije je da isti prefiksi glasaju isto (isti cilj, isti smer) u kratkom razmaku posle
//! naređenja, kroz više postova. Graf zajedničkog pojavljivanja nad pseudo-identitetima
//! (koncept §12, tačka 4): čvor je prefiks, ivica je usklađenost dva prefiksa.
//!
//! Dimenzije su vremenska (razmak ≤ `covote`) i ciljna (isti cilj i smer), na više postova;
//! prefiks je samo identitet čvora. Legitimni blizanac vremenske dimenzije — nalet posle
//! push-a ili naslovne (koncept §8) — isključen je preko `promotion` događaja: glas u prozoru
//! promocije svog posta ne ulazi u graf. Prozor je kratak (podrazumevano 10 min), koliko traje
//! nalet: post sa naslovne je „promovisan" satima, a dug prozor bi detektor oslepeo baš za
//! najvažnije postove. Cena: klaka koja udari odmah posle push-a portala, na tom postu se ne vidi.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde_json::json;
use sqlx::PgPool;

use crate::{Config, Finding};

pub const COORDINATED_VOTES: &str = "coordinated-votes";

/// Element sa više glasača od ovoga se preskače (kvadratan broj parova). Takav cilj je ionako
/// slab dokaz: popularan komentar zajedno glasaju i ljudi koji se ne poznaju.
const MAX_ELEMENT_VOTERS: usize = 2_000;

/// Element glasa: (portal, post, cilj, smer).
type Element<'a> = (&'a str, &'a str, &'a str, i32);

#[derive(Debug, Clone, PartialEq, sqlx::FromRow)]
pub struct VoteAt {
    pub portal: String,
    pub net: String,
    pub post: String,
    pub target: String,
    pub dir: i32,
    /// ms, sat servera portala
    pub t: i64,
}

#[derive(Debug, Clone, PartialEq, sqlx::FromRow)]
pub struct PromotionAt {
    pub portal: String,
    pub post: String,
    pub t: i64,
}

/// Prefiks u usklađenoj kohorti.
#[derive(Debug, Clone, PartialEq)]
pub struct Member {
    pub portal: String,
    pub net: String,
    /// Različitih (post, cilj, smer) koje je prefiks glasao u prozoru.
    pub elements: i64,
    /// Prefiksa sa kojima je usklađen (ivica u grafu).
    pub partners: i64,
    /// Veličina komponente (kohorte) kojoj pripada.
    pub cohort: i64,
    /// Različitih postova u njegovim ivicama.
    pub posts: i64,
}

pub async fn coordinated_cohorts(pool: &PgPool, cfg: &Config) -> Result<Vec<Member>, sqlx::Error> {
    let votes: Vec<VoteAt> = sqlx::query_as(
        "SELECT portal, net, post, data->>'target' AS target, (data->>'dir')::int AS dir, t
         FROM events
         WHERE type = 'vote' AND source = 'server' AND net IS NOT NULL AND post IS NOT NULL
           AND recv_at > now() - make_interval(secs => $1)",
    )
    .bind(cfg.window.as_secs_f64())
    .fetch_all(pool)
    .await?;
    let promotions: Vec<PromotionAt> = sqlx::query_as(
        "SELECT portal, post, t FROM events
         WHERE type = 'promotion' AND source = 'server' AND post IS NOT NULL
           AND recv_at > now() - make_interval(secs => $1)",
    )
    .bind((cfg.window + cfg.promotion).as_secs_f64())
    .fetch_all(pool)
    .await?;
    Ok(coordinated(&votes, &promotions, cfg))
}

/// Usklađene kohorte iz glasova u prozoru.
///
/// 1. Glas u prozoru promocije svog posta (`promotion` do `cfg.promotion` posle) se izostavlja.
/// 2. Svaki prefiks ima skup elemenata (post, cilj, smer), svaki sa prvim vremenom glasa.
/// 3. Dva prefiksa su usklađena kad dele bar dva elementa, svaki glasan u razmaku ≤
///    `cfg.covote`, na ≥ `cfg.min_posts` postova, i kad im je Jaccard-ova sličnost skupova ≥
///    `cfg.min_jaccard`. Jaccard je zaštita od velikih prefiksa: CGNAT glasa mnogo i raznoliko,
///    pa deli elemente sa mnogima, ali ni sa kim nema sličan skup.
/// 4. Prefiks sa manje od `cfg.min_partners` usklađenih se izbacuje, dok takvih ima (k-jezgro):
///    slučajan dodir jednog čitaoca sa kohortom ga ne uvlači u nju.
/// 5. Komponenta sa ≥ `cfg.min_cohort_nets` prefiksa je kohorta.
pub fn coordinated(votes: &[VoteAt], promotions: &[PromotionAt], cfg: &Config) -> Vec<Member> {
    let covote_ms = i64::try_from(cfg.covote.as_millis()).unwrap_or(i64::MAX);
    let promo_ms = i64::try_from(cfg.promotion.as_millis()).unwrap_or(i64::MAX);
    let mut promoted: HashMap<(&str, &str), Vec<i64>> = HashMap::new();
    for p in promotions {
        promoted.entry((&p.portal, &p.post)).or_default().push(p.t);
    }
    let in_promotion = |v: &VoteAt| {
        promoted
            .get(&(v.portal.as_str(), v.post.as_str()))
            .is_some_and(|ts| {
                ts.iter()
                    .any(|&t| v.t >= t && v.t <= t.saturating_add(promo_ms))
            })
    };

    // Čvorovi i njihovi elementi (prvi glas po elementu).
    let mut node_of: BTreeMap<(&str, &str), usize> = BTreeMap::new();
    let mut sets: Vec<BTreeMap<(&str, &str, i32), i64>> = Vec::new();
    for v in votes.iter().filter(|v| !in_promotion(v)) {
        let next = node_of.len();
        let n = *node_of.entry((&v.portal, &v.net)).or_insert(next);
        if n == sets.len() {
            sets.push(BTreeMap::new());
        }
        let t = sets[n].entry((&v.post, &v.target, v.dir)).or_insert(v.t);
        *t = (*t).min(v.t);
    }
    let portal_of: Vec<&str> = {
        let mut p = vec![""; node_of.len()];
        for (&(portal, _), &n) in &node_of {
            p[n] = portal;
        }
        p
    };

    // Elementi → glasači; parovi u razmaku ≤ covote.
    let mut voters: HashMap<Element, Vec<(i64, usize)>> = HashMap::new();
    for (n, set) in sets.iter().enumerate() {
        for (&(post, target, dir), &t) in set {
            voters
                .entry((portal_of[n], post, target, dir))
                .or_default()
                .push((t, n));
        }
    }
    let mut pairs: HashMap<(usize, usize), (i64, BTreeSet<&str>)> = HashMap::new();
    for ((_, post, _, _), list) in voters.iter_mut() {
        if list.len() > MAX_ELEMENT_VOTERS {
            continue;
        }
        list.sort_unstable();
        for i in 0..list.len() {
            for j in i + 1..list.len() {
                if list[j].0 - list[i].0 > covote_ms {
                    break;
                }
                let key = (list[i].1.min(list[j].1), list[i].1.max(list[j].1));
                let e = pairs.entry(key).or_default();
                e.0 += 1;
                e.1.insert(post);
            }
        }
    }

    // Ivice, pa k-jezgro.
    let mut adj: Vec<BTreeMap<usize, usize>> = vec![BTreeMap::new(); sets.len()];
    for (&(a, b), (co, posts)) in &pairs {
        let union = sets[a].len() + sets[b].len() - *co as usize;
        let jaccard = *co as f64 / union as f64;
        if *co >= 2 && posts.len() as i64 >= cfg.min_posts && jaccard >= cfg.min_jaccard {
            adj[a].insert(b, posts.len());
            adj[b].insert(a, posts.len());
        }
    }
    let k = usize::try_from(cfg.min_partners).unwrap_or(usize::MAX);
    let mut alive: Vec<bool> = adj.iter().map(|e| !e.is_empty()).collect();
    loop {
        let weak: Vec<usize> = (0..adj.len())
            .filter(|&n| alive[n] && adj[n].keys().filter(|&&m| alive[m]).count() < k)
            .collect();
        if weak.is_empty() {
            break;
        }
        for n in weak {
            alive[n] = false;
        }
    }

    // Komponente preživelih.
    let mut component = vec![usize::MAX; adj.len()];
    let mut sizes = Vec::new();
    for start in (0..adj.len()).filter(|&n| alive[n]) {
        if component[start] != usize::MAX {
            continue;
        }
        let id = sizes.len();
        let (mut stack, mut size) = (vec![start], 0);
        component[start] = id;
        while let Some(n) = stack.pop() {
            size += 1;
            for &m in adj[n].keys() {
                if alive[m] && component[m] == usize::MAX {
                    component[m] = id;
                    stack.push(m);
                }
            }
        }
        sizes.push(size);
    }

    let mut out = Vec::new();
    for (&(portal, net), &n) in &node_of {
        if !alive[n] || (sizes[component[n]] as i64) < cfg.min_cohort_nets {
            continue;
        }
        let partners: Vec<usize> = adj[n].keys().copied().filter(|&m| alive[m]).collect();
        let posts: BTreeSet<&str> = partners
            .iter()
            .flat_map(|&m| pairs[&(n.min(m), n.max(m))].1.iter().copied())
            .collect();
        out.push(Member {
            portal: portal.to_owned(),
            net: net.to_owned(),
            elements: sets[n].len() as i64,
            partners: partners.len() as i64,
            cohort: sizes[component[n]] as i64,
            posts: posts.len() as i64,
        });
    }
    out
}

impl From<Member> for Finding {
    fn from(m: Member) -> Self {
        let evidence = json!({
            "detector": COORDINATED_VOTES, "elements": m.elements, "partners": m.partners,
            "cohort_nets": m.cohort, "posts": m.posts,
        });
        Self {
            detector: COORDINATED_VOTES.to_owned(),
            portal: m.portal,
            net: m.net,
            votes: m.elements,
            evidence,
        }
    }
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
            min_minhash: 0.5,
            covote: Duration::from_secs(120),
            min_jaccard: 0.5,
            min_partners: 2,
            min_cohort_nets: 5,
            promotion: Duration::from_secs(600),
            ttl: Duration::from_secs(3600),
            retro: Duration::from_secs(600),
        }
    }

    fn v(net: &str, post: &str, target: &str, dir: i32, t_s: i64) -> VoteAt {
        VoteAt {
            portal: "demo.local".into(),
            net: net.into(),
            post: post.into(),
            target: target.into(),
            dir,
            t: t_s * 1000,
        }
    }

    /// Jednostavan pseudo-slučajan niz (ponovljiv test).
    fn lcg(seed: &mut u64) -> u64 {
        *seed = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
        *seed >> 33
    }

    /// Publika: `n` prefiksa, svaki 1–3 glasa na nasumične komentare 4 posta, kroz 600 s.
    fn audience(n: usize, seed: u64) -> Vec<VoteAt> {
        let mut s = seed;
        let mut out = Vec::new();
        for i in 0..n {
            for _ in 0..1 + lcg(&mut s) % 3 {
                let post = lcg(&mut s) % 4;
                let target = format!("c{}", post * 4 + lcg(&mut s) % 4);
                let dir = if lcg(&mut s) % 10 < 7 { 1 } else { -1 };
                let t = (lcg(&mut s) % 600) as i64;
                out.push(v(
                    &format!("10.0.{i}.0/24"),
                    &format!("p-{post}"),
                    &target,
                    dir,
                    t,
                ));
            }
        }
        out
    }

    const TARGETS: [(&str, &str); 3] = [("p-0", "c1"), ("p-1", "c6"), ("p-2", "c11")];

    /// Klaka: `n` prefiksa, svaki po jedan glas za iste ciljeve na 3 posta, talas od 60 s.
    fn klaka(n: usize, first: usize, base_s: i64) -> Vec<VoteAt> {
        klaka_on(n, first, base_s, &TARGETS)
    }

    fn klaka_on(n: usize, first: usize, base_s: i64, targets: &[(&str, &str)]) -> Vec<VoteAt> {
        (0..n)
            .flat_map(|i| {
                let net = format!("198.18.{}.0/24", first + i);
                let t = base_s + (i as i64 * 7) % 60;
                targets
                    .iter()
                    .map(move |&(post, target)| v(&net, post, target, 1, t + 10))
            })
            .collect()
    }

    #[test]
    fn scattered_klaka_found_audience_and_cgnat_not() {
        let mut votes = audience(80, 7);
        votes.extend(klaka(12, 1, 100));
        // CGNAT: 40 glasova raspršeno, iza jednog prefiksa.
        for (k, mut x) in audience(40, 11).into_iter().enumerate() {
            x.net = "198.19.0.0/24".into();
            x.t += k as i64; // isti prefiks, različita vremena
            votes.push(x);
        }
        // Mala grupa: 4 prefiksa, ispod praga kohorte (svoji ciljevi, van publike).
        votes.extend(klaka_on(
            4,
            100,
            300,
            &[("p-5", "c40"), ("p-6", "c41"), ("p-7", "c42")],
        ));

        let found = coordinated(&votes, &[], &cfg());
        let nets: BTreeSet<_> = found.iter().map(|m| m.net.as_str()).collect();
        let expected: BTreeSet<String> = (1..=12).map(|i| format!("198.18.{i}.0/24")).collect();
        assert_eq!(
            nets,
            expected.iter().map(String::as_str).collect(),
            "{found:?}"
        );
        assert!(
            found
                .iter()
                .all(|m| m.cohort == 12 && m.posts == 3 && m.partners >= 2)
        );
    }

    #[test]
    fn same_targets_far_apart_in_time_are_not_coordinated() {
        // Isti ciljevi, ali po jedan prefiks na svakih 5 minuta — razmak veći od covote.
        let votes: Vec<_> = (0..10)
            .flat_map(|i| {
                let net = format!("198.18.{i}.0/24");
                let t = i as i64 * 300;
                [("p-0", "c1"), ("p-1", "c6")].map(|(post, target)| v(&net, post, target, 1, t))
            })
            .collect();
        assert!(coordinated(&votes, &[], &cfg()).is_empty());
    }

    #[test]
    fn push_twin_excluded_only_with_promotion_events() {
        // Verni čitaoci: posle push-a za p-0 pa za p-1 glasaju za najbolji komentar.
        let mut votes = audience(40, 3);
        for i in 0..12 {
            let net = format!("198.18.{}.0/24", 50 + i);
            votes.push(v(&net, "p-0", "c1", 1, 100 + i as i64));
            votes.push(v(&net, "p-1", "c5", 1, 400 + i as i64));
        }
        let promo = |post: &str, t_s: i64| PromotionAt {
            portal: "demo.local".into(),
            post: post.into(),
            t: t_s * 1000,
        };
        assert_eq!(
            coordinated(&votes, &[], &cfg()).len(),
            12,
            "bez događaja promocije blizanac liči na kohortu"
        );
        let promotions = [promo("p-0", 95), promo("p-1", 395)];
        assert!(coordinated(&votes, &promotions, &cfg()).is_empty());
    }

    #[test]
    fn single_contact_does_not_pull_a_reader_in() {
        // Čitalac je usklađen samo sa jednim poslušnikom (tri zajednička cilja, van kampanje):
        // jedna ivica, pa ga k-jezgro (≥ 2 partnera) ne uvlači u kohortu.
        let mut votes = klaka(8, 1, 100);
        for (post, target) in [("p-5", "c30"), ("p-6", "c31"), ("p-7", "c32")] {
            votes.push(v("198.18.1.0/24", post, target, 1, 200));
            votes.push(v("10.9.9.0/24", post, target, 1, 205));
        }
        let found = coordinated(&votes, &[], &cfg());
        assert_eq!(found.len(), 8, "{found:?}");
        assert!(found.iter().all(|m| m.net != "10.9.9.0/24"));
    }
}
