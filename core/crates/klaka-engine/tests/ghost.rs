//! Detektori na pravoj bazi (i presuda u Valkey-ju, ako je dat). Radi samo uz
//! `KLAKA_TEST_POSTGRES_URL` (+ opciono `KLAKA_TEST_VALKEY_URL`); svaki test ima svoju šemu.

use std::time::Duration;

use klaka_db::{Batch, MIGRATOR, PgStore, Row, Source, Store, maintain_partitions};
use klaka_engine::comments::{EMBEDDING_DIM, embed_pending, template_cohorts, unwritten_cohorts};
use klaka_engine::coordinated::coordinated_cohorts;
use klaka_engine::{
    Config, GHOST_VIEWS, Issued, NetVerdict, Nets, focused_cohorts, ghost_cohorts,
    issue_net_shadow, net_key, retro_key, unread_cohorts,
};
use klaka_llm::{Embedder, LlmError};
use serde_json::json;
use sqlx::PgPool;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};

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

fn row(kind: &'static str, vid: &str, net: &str, target: Option<&str>) -> Row {
    Row {
        kind,
        t: 1,
        vid: Some(vid.to_owned()),
        post: Some("p-1".to_owned()),
        net: Some(net.to_owned()),
        data: match target {
            Some(t) => json!({"type": kind, "target": t, "dir": 1}),
            None => json!({"type": kind}),
        },
    }
}

/// `n` glasova na `target` iz `net`, sa `vids` prikaza, od kojih `with_view` ima browser `view`.
async fn scenario(
    store: &PgStore,
    net: &str,
    target: &str,
    n: usize,
    vids: usize,
    with_view: usize,
) {
    let (mut api, mut server, mut browser) = (vec![], vec![], vec![]);
    for i in 0..vids {
        let vid = format!("{net}-{i}");
        api.push(row("issued", &vid, net, None));
        if i < with_view {
            browser.push(row("view", &vid, net, None));
        }
    }
    for i in 0..n {
        server.push(row(
            "vote",
            &format!("{net}-{}", i % vids),
            net,
            Some(target),
        ));
    }
    for (source, rows) in [
        (Source::Api, api),
        (Source::Server, server),
        (Source::Browser, browser),
    ] {
        if !rows.is_empty() {
            store
                .insert(Batch {
                    portal: "demo.local".into(),
                    source,
                    rows,
                })
                .await
                .unwrap();
        }
    }
}

#[tokio::test]
async fn ghost_cohort_found_twins_and_small_groups_not() {
    let Some((admin, pool, schema)) = schema("ghost").await else {
        eprintln!("KLAKA_TEST_POSTGRES_URL nije postavljen — preskačem");
        return;
    };
    let store = PgStore(pool.clone());
    scenario(&store, "198.18.1.0/24", "c1", 6, 6, 0).await; // napad: duhovi
    scenario(&store, "198.18.2.0/24", "c1", 6, 6, 6).await; // CGNAT blizanac: pravi prikazi
    scenario(&store, "198.18.3.0/24", "c1", 4, 4, 0).await; // premalo glasova
    scenario(&store, "198.18.4.0/24", "c1", 6, 1, 0).await; // jedan prikaz (to je posao §2a)
    scenario(&store, "198.18.5.0/24", "c1", 6, 6, 2).await; // 4/6 duhova < 80%

    let found = ghost_cohorts(&pool, &cfg()).await.unwrap();
    let nets: Vec<_> = found.iter().map(|c| c.net.as_str()).collect();
    assert_eq!(nets, ["198.18.1.0/24"], "{found:?}");
    assert_eq!((found[0].votes, found[0].vids, found[0].flagged), (6, 6, 6));

    if let Ok(url) = std::env::var("KLAKA_TEST_VALKEY_URL") {
        let mut valkey = redis::Client::open(url)
            .unwrap()
            .get_multiplexed_async_connection()
            .await
            .unwrap();
        let net = format!("{schema}.0/24"); // jedinstven ključ po izvođenju
        let ev = json!({"test": true});
        let verdict = |evidence| NetVerdict {
            portal: "demo.local",
            net: &net,
            detector: GHOST_VIEWS,
            evidence,
        };
        let rev = issue_net_shadow(&pool, &mut valkey, verdict(ev.clone()), &cfg(), 1_000)
            .await
            .unwrap();
        assert_eq!(rev.map(|i| i.rev), Some(1));
        let again = issue_net_shadow(&pool, &mut valkey, verdict(ev), &cfg(), 2_000)
            .await
            .unwrap();
        assert_eq!(again, None, "važeća presuda se ne ponavlja");
        let key = net_key("demo.local", &net);
        let stored: String = redis::cmd("GET")
            .arg(&key)
            .query_async(&mut valkey)
            .await
            .unwrap();
        assert!(stored.contains("\"shadow\""));
        redis::cmd("DEL")
            .arg(&key)
            .query_async::<()>(&mut valkey)
            .await
            .unwrap();
    }

    pool.close().await;
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&admin)
        .await
        .unwrap();
}

/// `n` glasova na `target` iz `net`, svaki sa svog prikaza koji ima browser `engage`.
async fn engaged(store: &PgStore, net: &str, target: &str, n: usize, seen: &[&str], ptr: u32) {
    let (mut api, mut server, mut browser) = (vec![], vec![], vec![]);
    for i in 0..n {
        let vid = format!("{net}-{i}");
        api.push(row("issued", &vid, net, None));
        let mut view = row("view", &vid, net, None);
        view.data = json!({"type": "view"});
        browser.push(view);
        let mut engage = row("engage", &vid, net, None);
        engage.data = json!({
            "type": "engage", "seq": 0, "seen": seen,
            "inputs": {"key": 0, "ptr": ptr, "touch": 0},
        });
        browser.push(engage);
        server.push(row("vote", &vid, net, Some(target)));
    }
    for (source, rows) in [
        (Source::Api, api),
        (Source::Server, server),
        (Source::Browser, browser),
    ] {
        store
            .insert(Batch {
                portal: "demo.local".into(),
                source,
                rows,
            })
            .await
            .unwrap();
    }
}

#[tokio::test]
async fn unread_votes_found_readers_and_ghosts_not() {
    let Some((admin, pool, schema)) = schema("unread").await else {
        return;
    };
    let store = PgStore(pool.clone());
    engaged(&store, "198.18.11.0/24", "c1", 6, &["c2", "c3"], 2).await; // glas van seen
    engaged(&store, "198.18.12.0/24", "c1", 6, &["c1", "c2"], 0).await; // bez ijednog unosa
    engaged(&store, "198.18.13.0/24", "c1", 6, &["c1", "c2"], 3).await; // čitaoci: video + klik
    scenario(&store, "198.18.14.0/24", "c1", 6, 6, 0).await; // duhovi: posao drugog detektora

    let found = unread_cohorts(&pool, &cfg()).await.unwrap();
    let nets: Vec<_> = found.iter().map(|c| c.net.as_str()).collect();
    assert_eq!(nets, ["198.18.11.0/24", "198.18.12.0/24"], "{found:?}");
    assert!(
        found
            .iter()
            .all(|c| c.detector == "unread-votes" && c.flagged == 6)
    );

    pool.close().await;
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&admin)
        .await
        .unwrap();
}

/// `n` glasova iz `net` za komentare autora u smeru `dir`, svaki sa svog prikaza, raspoređenih
/// po `posts` postova; `seq` je redni broj prvog glasa (za prikaz i post).
async fn author_votes(
    store: &PgStore,
    net: &str,
    (author, dir): (&str, i32),
    n: usize,
    posts: usize,
    seq: usize,
) {
    let rows = (seq..seq + n)
        .map(|i| Row {
            kind: "vote",
            t: 1,
            vid: Some(format!("{net}-{author}-{dir}-{i}")),
            post: Some(format!("p-{}", i % posts)),
            net: Some(net.to_owned()),
            data: json!({
                "type": "vote", "target": format!("c-{author}-{}", i % posts),
                "target_author": author, "dir": dir,
            }),
        })
        .collect();
    store
        .insert(Batch {
            portal: "demo.local".into(),
            source: Source::Server,
            rows,
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn focused_votes_found_across_posts_twins_not() {
    let Some((admin, pool, schema)) = schema("focused").await else {
        return;
    };
    let store = PgStore(pool.clone());
    // Publika: 48 čitalaca, svaki iza svog prefiksa, raspršeno po 8 autora.
    let audience = |i: usize| (format!("a{}", i % 8), if (i / 8) % 3 < 2 { 1 } else { -1 });
    for i in 0..48 {
        let (author, dir) = audience(i);
        let net = format!("10.1.{i}.0/24");
        author_votes(&store, &net, (&author, dir), 1, 1, 0).await;
    }
    // CGNAT: 48 glasova iza jednog prefiksa, raspoređenih kao publika, na 3 posta — svaka
    // ćelija ima ≥ 5 glasova, ≥ 3 prikaza i ≥ 2 posta, pa odlučuje samo odnos prema publici.
    for i in 0..48 {
        let (author, dir) = audience(i);
        author_votes(&store, "198.18.2.0/24", (&author, dir), 1, 3, i).await;
    }
    author_votes(&store, "198.18.1.0/24", ("a0", 1), 20, 3, 0).await; // kohorta kroz 3 posta
    author_votes(&store, "198.18.1.0/24", ("a1", -1), 6, 3, 0).await;
    author_votes(&store, "198.18.3.0/24", ("a0", 1), 20, 1, 0).await; // ista, na jednom postu

    let found = focused_cohorts(&pool, &cfg(), &Nets::new()).await.unwrap();
    let got: Vec<_> = found
        .iter()
        .map(|f| (f.cell.net.as_str(), f.cell.author.as_str(), f.cell.dir))
        .collect();
    assert_eq!(got, [("198.18.1.0/24", "a0", 1)], "{found:?}");
    assert_eq!(
        (
            found[0].cell.votes,
            found[0].cell.vids,
            found[0].cell.posts,
            found[0].net_votes
        ),
        (20, 20, 3, 26)
    );

    pool.close().await;
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&admin)
        .await
        .unwrap();
}

/// Komentar iz `net` sa prikaza `vid`; `compose` = (keys, pasted) ako je napisan u formi.
fn comment_rows(
    net: &str,
    vid: &str,
    post: &str,
    id: &str,
    text: &str,
    compose: Option<(&str, bool)>,
) -> (Row, Option<Row>) {
    let comment = Row {
        kind: "comment",
        t: 1_000,
        vid: Some(vid.to_owned()),
        post: Some(post.to_owned()),
        net: Some(net.to_owned()),
        data: json!({"type": "comment", "comment": id, "author": "X", "text": text}),
    };
    let compose = compose.map(|(keys, pasted)| Row {
        kind: "compose",
        t: 990,
        vid: Some(vid.to_owned()),
        post: Some(post.to_owned()),
        net: Some(net.to_owned()),
        data: json!({"type": "compose", "keys": keys, "pasted": pasted}),
    });
    (comment, compose)
}

async fn insert_comments(store: &PgStore, rows: Vec<(Row, Option<Row>)>) {
    let (server, browser): (Vec<_>, Vec<_>) = rows.into_iter().unzip();
    let browser: Vec<_> = browser.into_iter().flatten().collect();
    for (source, rows) in [(Source::Server, server), (Source::Browser, browser)] {
        if !rows.is_empty() {
            store
                .insert(Batch {
                    portal: "demo.local".into(),
                    source,
                    rows,
                })
                .await
                .unwrap();
        }
    }
}

#[tokio::test]
async fn unwritten_comments_found_typed_not() {
    let Some((admin, pool, schema)) = schema("unwritten").await else {
        return;
    };
    let store = PgStore(pool.clone());
    let mut rows = Vec::new();
    for i in 0..6 {
        let post = format!("p-{}", i % 2);
        let mut add = |net: &str, compose| {
            let vid = format!("{net}-{i}");
            rows.push(comment_rows(net, &vid, &post, &vid, "tekst", compose));
        };
        add("198.18.21.0/24", Some(("0", true))); // nalepljeno desnim klikom
        add("198.18.22.0/24", None); // bez forme (API)
        add("198.18.23.0/24", Some(("11-50", false))); // kucano
        add("198.18.24.0/24", Some(("51-200", true))); // kucano, uz nalepljen citat
        add("198.18.25.0/24", Some(("1-10", true))); // Ctrl+V
    }
    insert_comments(&store, rows).await;

    let found = unwritten_cohorts(&pool, &cfg()).await.unwrap();
    let nets: Vec<_> = found.iter().map(|c| c.net.as_str()).collect();
    assert_eq!(
        nets,
        ["198.18.21.0/24", "198.18.22.0/24", "198.18.25.0/24"],
        "{found:?}"
    );
    assert!(
        found
            .iter()
            .all(|c| c.comments == 6 && c.flagged == 6 && c.posts == 2)
    );

    pool.close().await;
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&admin)
        .await
        .unwrap();
}

/// Lažni model: tekstovi sa istom prvom reči su „parafraze" (gotovo isti vektor), ostali su
/// međusobno ortogonalni.
struct FakeEmbedder;

impl Embedder for FakeEmbedder {
    fn model(&self) -> &str {
        "fake@0"
    }

    async fn embed(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>, LlmError> {
        let slot = |s: &str| {
            s.bytes()
                .fold(7usize, |h, b| h.wrapping_mul(31).wrapping_add(b as usize))
                % EMBEDDING_DIM
        };
        Ok(texts
            .iter()
            .map(|t| {
                let mut v = vec![0.0f32; EMBEDDING_DIM];
                v[slot(t.split(' ').next().unwrap_or(""))] = 1.0;
                v[slot(t)] += 0.05;
                v
            })
            .collect())
    }
}

#[tokio::test]
async fn shared_templates_found_through_embeddings() {
    let Some((admin, pool, schema)) = schema("templates").await else {
        return;
    };
    let store = PgStore(pool.clone());
    let mut rows = Vec::new();
    // Publika: 40 prefiksa, svaki sa svojim tekstom (bez zajedničkih reči sa susedima).
    const WORDS: [&str; 20] = [
        "staza",
        "rasveta",
        "klupe",
        "česma",
        "biblioteka",
        "čitaonica",
        "upis",
        "ispiti",
        "autobus",
        "stajalište",
        "polasci",
        "trotoar",
        "pijaca",
        "tezge",
        "zakup",
        "povrće",
        "budžet",
        "tender",
        "sednica",
        "stanari",
    ];
    for i in 0..40 {
        let net = format!("10.2.{i}.0/24");
        let text = format!("{i}. {} {}", WORDS[i % 20], WORDS[(i / 2 + 7) % 20]);
        rows.push(comment_rows(
            &net,
            &format!("r{i}"),
            &format!("p-{}", i % 4),
            &format!("r{i}"),
            &text,
            Some(("11-50", false)),
        ));
    }
    // Kohorta: 6 parafraza kroz 2 posta, kucano — tekstovi različiti (MinHash ih ne spaja),
    // a lažni model ih vidi kao isti šablon (ista prva reč).
    for i in 0..6 {
        let text = format!("Sjajno {} {}", WORDS[i * 2], WORDS[i * 2 + 1]);
        rows.push(comment_rows(
            "198.18.31.0/24",
            &format!("a{i}"),
            &format!("p-{}", i % 2),
            &format!("a{i}"),
            &text,
            Some(("11-50", false)),
        ));
    }
    insert_comments(&store, rows).await;

    assert_eq!(
        embed_pending(&pool, &FakeEmbedder, &cfg(), 100)
            .await
            .unwrap(),
        46
    );
    assert_eq!(
        embed_pending(&pool, &FakeEmbedder, &cfg(), 100)
            .await
            .unwrap(),
        0,
        "svaki komentar jednom"
    );

    let without = template_cohorts(&pool, &cfg(), None, &Nets::new())
        .await
        .unwrap()
        .cohorts;
    assert!(
        without.is_empty(),
        "MinHash sam ne vidi parafraze: {without:?}"
    );
    let found = template_cohorts(&pool, &cfg(), Some("fake@0"), &Nets::new())
        .await
        .unwrap()
        .cohorts;
    let got: Vec<_> = found
        .iter()
        .map(|c| (c.net.as_str(), c.templated, c.copies))
        .collect();
    assert_eq!(got, [("198.18.31.0/24", 6, 0)], "{found:?}");

    pool.close().await;
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&admin)
        .await
        .unwrap();
}

#[tokio::test]
async fn verdict_sends_counted_actions_of_the_prefix_to_retro() {
    let Some((admin, pool, schema)) = schema("retro").await else {
        return;
    };
    let Ok(url) = std::env::var("KLAKA_TEST_VALKEY_URL") else {
        eprintln!("KLAKA_TEST_VALKEY_URL nije postavljen — preskačem");
        return;
    };
    let mut valkey = redis::Client::open(url)
        .unwrap()
        .get_multiplexed_async_connection()
        .await
        .unwrap();
    let store = PgStore(pool.clone());
    let portal = format!("{schema}.local"); // svoj stream po izvođenju
    let action = |kind: &'static str, vid: Option<&str>, net: &str, decision: &str, id: &str| Row {
        kind,
        t: 1,
        vid: vid.map(str::to_owned),
        post: Some("p-1".to_owned()),
        net: Some(net.to_owned()),
        data: match kind {
            "vote" => json!({"type": "vote", "target": id, "dir": 1, "decision": decision}),
            _ => json!({"type": "comment", "comment": id, "text": "x", "decision": decision}),
        },
    };
    let net = "198.18.41.0/24";
    store
        .insert(Batch {
            portal: portal.clone(),
            source: Source::Server,
            rows: vec![
                action("vote", Some("v1"), net, "count", "c1"),
                action("vote", Some("v2"), net, "shadow", "c2"), // već shadow
                action("comment", Some("v3"), net, "count", "k1"),
                action("comment", Some("v4"), net, "shadow", "k2"), // već shadow
                action("vote", Some("v5"), "198.18.42.0/24", "count", "c1"), // drugi prefiks
            ],
        })
        .await
        .unwrap();

    let verdict = || NetVerdict {
        portal: &portal,
        net,
        detector: "test",
        evidence: json!({}),
    };
    let issued = issue_net_shadow(&pool, &mut valkey, verdict(), &cfg(), 1_000)
        .await
        .unwrap();
    assert_eq!(
        issued,
        Some(Issued {
            rev: 1,
            top_up: false,
            retro_comments: 1,
            retro_votes: 1
        })
    );
    let ttl: i64 = redis::cmd("PTTL")
        .arg(net_key(&portal, net))
        .query_async(&mut valkey)
        .await
        .unwrap();

    // Portal ih je uračunao pre nego što je presuda stigla do Valkey-ja, a u bazu su stigle
    // posle nje (SDK šalje u paketima): sledeći krug ih dopuni pod istom presudom.
    store
        .insert(Batch {
            portal: portal.clone(),
            source: Source::Server,
            rows: vec![
                action("comment", Some("v6"), net, "count", "k3"),
                action("vote", Some("v7"), net, "count", "c3"),
                action("vote", Some("v8"), net, "shadow", "c3"), // presuda ga je već videla
            ],
        })
        .await
        .unwrap();
    let topped = issue_net_shadow(&pool, &mut valkey, verdict(), &cfg(), 2_000)
        .await
        .unwrap();
    assert_eq!(
        topped,
        Some(Issued {
            rev: 1,
            top_up: true,
            retro_comments: 1,
            retro_votes: 1
        })
    );
    let again = issue_net_shadow(&pool, &mut valkey, verdict(), &cfg(), 3_000)
        .await
        .unwrap();
    assert_eq!(again, None, "dopunjeno se ne šalje ponovo");
    let ttl_after: i64 = redis::cmd("PTTL")
        .arg(net_key(&portal, net))
        .query_async(&mut valkey)
        .await
        .unwrap();
    assert!(
        ttl_after <= ttl,
        "dopuna ne produžava presudu: {ttl} → {ttl_after}"
    );
    let verdicts: i64 = sqlx::query_scalar("SELECT count(*) FROM verdicts")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(verdicts, 1, "dopuna je pod istom presudom");

    let audit: Vec<String> = sqlx::query_scalar(
        "SELECT concat_ws(' ', kind, comment, vid, target) FROM verdict_retro ORDER BY kind",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        audit,
        ["comment k1", "comment k3", "vote v1 c1", "vote v7 c3"]
    );
    let entries: Vec<(String, Vec<String>)> = redis::cmd("XRANGE")
        .arg(retro_key(&portal))
        .arg("-")
        .arg("+")
        .query_async(&mut valkey)
        .await
        .unwrap();
    // Akcije jednog paketa su upisane istim INSERT-om (isto vreme prijema), pa redosled nije zadat.
    let mut fields: Vec<_> = entries.into_iter().map(|(_, f)| f.join(" ")).collect();
    fields.sort();
    assert_eq!(
        fields,
        [
            "kind comment post p-1 comment k1",
            "kind comment post p-1 comment k3",
            "kind vote post p-1 vid v1 target c1",
            "kind vote post p-1 vid v7 target c3"
        ]
    );

    redis::cmd("DEL")
        .arg(retro_key(&portal))
        .arg(net_key(&portal, net))
        .query_async::<()>(&mut valkey)
        .await
        .unwrap();
    pool.close().await;
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&admin)
        .await
        .unwrap();
}

#[tokio::test]
async fn coordinated_votes_from_db_with_promotion() {
    let Some((admin, pool, schema)) = schema("coordinated").await else {
        return;
    };
    let store = PgStore(pool.clone());
    let vote = |net: &str, post: &str, target: &str, t: i64| Row {
        kind: "vote",
        t,
        vid: Some(format!("{net}-{target}")),
        post: Some(post.to_owned()),
        net: Some(net.to_owned()),
        data: json!({"type": "vote", "target": target, "dir": 1, "decision": "count"}),
    };
    let mut rows = Vec::new();
    for i in 0..6 {
        // Klaka: 6 prefiksa, isti ciljevi na 2 posta, u roku od minuta.
        let net = format!("198.18.{}.0/24", 60 + i);
        rows.push(vote(&net, "p-1", "c1", 1_000_000 + i * 5_000));
        rows.push(vote(&net, "p-2", "c6", 1_010_000 + i * 5_000));
        // Verni čitaoci posle push-a za p-3 i p-4: isto usklađeni, ali u prozoru promocije.
        let fan = format!("198.18.{}.0/24", 80 + i);
        rows.push(vote(&fan, "p-3", "c9", 2_000_000 + i * 5_000));
        rows.push(vote(&fan, "p-4", "c13", 2_100_000 + i * 5_000));
    }
    let promotion = |post: &str, t: i64| Row {
        kind: "promotion",
        t,
        vid: None,
        post: Some(post.to_owned()),
        net: None,
        data: json!({"type": "promotion", "post": post, "channel": "push"}),
    };
    store
        .insert(Batch {
            portal: "demo.local".into(),
            source: Source::Server,
            rows: [
                rows,
                vec![promotion("p-3", 1_990_000), promotion("p-4", 2_090_000)],
            ]
            .concat(),
        })
        .await
        .unwrap();

    let found = coordinated_cohorts(&pool, &cfg()).await.unwrap();
    let nets: Vec<_> = found.iter().map(|m| m.net.as_str()).collect();
    let klaka: Vec<String> = (0..6).map(|i| format!("198.18.{}.0/24", 60 + i)).collect();
    assert_eq!(nets, klaka, "{found:?}");

    pool.close().await;
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&admin)
        .await
        .unwrap();
}
