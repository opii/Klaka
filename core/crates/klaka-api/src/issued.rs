//! Beleženje izdatih prikaza (`type = 'issued'`, `source = 'api'`) u tabelu `events`.
//!
//! Izdavanje tokena nikad ne čeka bazu: prikaz ide u ograničen red, a pozadinski zadatak ga
//! upisuje u serijama. Ako je red pun ili baza ne radi, prikaz se ne beleži — token je izdat.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use klaka_db::{Batch, Row, Source, Store};
use serde_json::json;
use tokio::sync::mpsc;

const QUEUE: usize = 10_000;
const BATCH: usize = 500;
const LINGER: Duration = Duration::from_millis(500);

#[derive(Clone)]
pub struct IssuedLog {
    tx: mpsc::Sender<(String, Row)>,
    pub dropped: Arc<AtomicU64>,
}

impl IssuedLog {
    /// Pokreće pozadinski zadatak koji upisuje u `store`.
    pub fn spawn<S: Store>(store: S) -> Self {
        let (tx, rx) = mpsc::channel(QUEUE);
        let dropped = Arc::new(AtomicU64::new(0));
        tokio::spawn(writer(rx, store, dropped.clone()));
        Self { tx, dropped }
    }

    pub fn record(&self, portal: &str, vid: &str, post: &str, iat: i64, net: Option<String>) {
        let row = Row {
            kind: "issued",
            t: iat,
            vid: Some(vid.to_owned()),
            post: Some(post.to_owned()),
            net,
            data: json!({"type": "issued", "t": iat, "vid": vid, "post": post}),
        };
        if self.tx.try_send((portal.to_owned(), row)).is_err() {
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }
}

async fn writer<S: Store>(
    mut rx: mpsc::Receiver<(String, Row)>,
    store: S,
    dropped: Arc<AtomicU64>,
) {
    while let Some(first) = rx.recv().await {
        let mut rows = vec![first];
        let deadline = tokio::time::sleep(LINGER);
        tokio::pin!(deadline);
        while rows.len() < BATCH {
            tokio::select! {
                next = rx.recv() => match next {
                    Some(r) => rows.push(r),
                    None => break,
                },
                _ = &mut deadline => break,
            }
        }
        let mut by_portal: HashMap<String, Vec<Row>> = HashMap::new();
        for (portal, row) in rows {
            by_portal.entry(portal).or_default().push(row);
        }
        for (portal, rows) in by_portal {
            let n = rows.len() as u64;
            let batch = Batch {
                portal,
                source: Source::Api,
                rows,
            };
            if let Err(e) = store.insert(batch).await {
                dropped.fetch_add(n, Ordering::Relaxed);
                eprintln!("klaka-api: upis {n} prikaza nije uspeo: {e}");
            }
        }
    }
}
