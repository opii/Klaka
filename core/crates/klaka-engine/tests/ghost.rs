//! Detektor prikaza-duhova na pravoj bazi (i Valkey-ju, ako je dat). Radi samo uz
//! `KLAKA_TEST_POSTGRES_URL` (+ opciono `KLAKA_TEST_VALKEY_URL`); svaki test ima svoju šemu.

use std::time::Duration;

use klaka_db::{Batch, MIGRATOR, PgStore, Row, Source, Store, maintain_partitions};
use klaka_engine::{
    Config, GHOST_VIEWS, NetVerdict, ghost_cohorts, issue_net_shadow, net_key, unread_cohorts,
};
use serde_json::json;
use sqlx::PgPool;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};

fn cfg() -> Config {
    Config {
        window: Duration::from_secs(600),
        min_votes: 5,
        min_vids: 3,
        min_flagged_share: 0.8,
        ttl: Duration::from_secs(3600),
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
        .connect_with(opts.options([("search_path", schema.as_str())]))
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
        assert_eq!(rev, Some(1));
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
