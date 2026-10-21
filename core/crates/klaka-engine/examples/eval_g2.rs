//! Ocena opisa kohorte (G2/G3) po docs/llm.md §7: isti prompt, šema i validacija kao radnik
//! (`describe.rs`), nad sintetičkim skupom sa poznatim odgovorima (`eval/g2.json`).
//!
//! ```text
//! cargo run --release -p klaka-engine --example eval_g2 -- gemma3:4b qwen3:8b
//! ```
//!
//! Ollama: `KLAKA_OLLAMA_URL` (podrazumevano `http://127.0.0.1:18434`). Mere po modelu: ispravan
//! JSON (neispravan ili odbijen = odbijanje), stav i toksičnost, greška broja komentara po vrsti,
//! simetričnost parova u ogledalu, vreme na ovom računaru. `KLAKA_EVAL_OUT`: folder u koji ide
//! izlaz po kohorti (`<model>.json`).

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use klaka_engine::describe::{COUNTS, PROMPT_VERSION, SYSTEM, TASK, input, schema, validate};
use klaka_llm::{JsonTask, Ollama, Privacy, generate};
use serde_json::{Value, json};

struct Case {
    id: String,
    grupa: String,
    par: Option<String>,
    strana: Option<String>,
    titles: Vec<(String, String)>,
    comments: Vec<(String, String)>,
    stav: Vec<String>,
    tox: Vec<String>,
    counts: [u64; 3],
}

fn pairs(v: &Value) -> Vec<(String, String)> {
    v.as_array()
        .into_iter()
        .flatten()
        .map(|p| {
            (
                p[0].as_str().unwrap_or("").to_owned(),
                p[1].as_str().unwrap_or("").to_owned(),
            )
        })
        .collect()
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .into_iter()
        .flatten()
        .filter_map(|x| x.as_str().map(str::to_owned))
        .collect()
}

fn load(path: &str) -> Vec<Case> {
    let raw = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{path}: {e}"));
    let doc: Value = serde_json::from_str(&raw).expect("skup nije JSON");
    doc["kohorte"]
        .as_array()
        .expect("nema kohorti")
        .iter()
        .map(|c| {
            let o = &c["ocekivano"];
            Case {
                id: c["id"].as_str().unwrap_or("?").to_owned(),
                grupa: c["grupa"].as_str().unwrap_or("?").to_owned(),
                par: c["par"].as_str().map(str::to_owned),
                strana: c["strana"].as_str().map(str::to_owned),
                titles: pairs(&c["naslovi"]),
                comments: pairs(&c["komentari"]),
                stav: strings(&o["stav"]),
                tox: strings(&o["toksicnost"]),
                counts: COUNTS.map(|k| o[k].as_u64().unwrap_or(0)),
            }
        })
        .collect()
}

/// Ishod jedne kohorte: validiran izlaz ili razlog odbijanja.
struct Outcome<'a> {
    case: &'a Case,
    out: Result<Value, String>,
    elapsed: Duration,
}

impl Outcome<'_> {
    fn field(&self, k: &str) -> Option<&str> {
        self.out.as_ref().ok().and_then(|o| o[k].as_str())
    }
    fn stav_ok(&self) -> bool {
        self.field("stav")
            .is_some_and(|s| self.case.stav.iter().any(|e| e == s))
    }
    fn tox_ok(&self) -> bool {
        self.field("toksicnost")
            .is_some_and(|t| self.case.tox.iter().any(|e| e == t))
    }
    fn counts(&self) -> Option<[u64; 3]> {
        let o = self.out.as_ref().ok()?;
        Some(COUNTS.map(|k| o[k].as_u64().unwrap_or(0)))
    }
}

fn pct(n: usize, of: usize) -> String {
    if of == 0 {
        "—".into()
    } else {
        format!("{n}/{of} ({:.0}%)", 100.0 * n as f64 / of as f64)
    }
}

fn report(model: &str, rows: &[Outcome]) {
    let valid: Vec<&Outcome> = rows.iter().filter(|r| r.out.is_ok()).collect();
    let group = |g: &'static str| rows.iter().filter(move |r| r.case.grupa == g);
    let refused = group("odbijanje").filter(|r| r.out.is_err()).count();
    let stav = rows.iter().filter(|r| r.stav_ok()).count();
    let tox = rows.iter().filter(|r| r.tox_ok()).count();
    let under = rows
        .iter()
        .filter(|r| r.case.tox == ["izrazita"] && r.out.is_ok() && !r.tox_ok())
        .count();
    let strong = rows.iter().filter(|r| r.case.tox == ["izrazita"]).count();
    let irony = group("ironija").filter(|r| r.stav_ok()).count();
    let mut mae = [0.0f64; 3];
    for r in &valid {
        if let Some(c) = r.counts() {
            for k in 0..3 {
                mae[k] += (c[k] as f64 - r.case.counts[k] as f64).abs() / valid.len() as f64;
            }
        }
    }
    // Parovi u ogledalu: obe strane isti stav i toksičnost (ne nužno tačni).
    let mut by_pair: BTreeMap<&str, Vec<&Outcome>> = BTreeMap::new();
    for r in rows {
        if let Some(p) = &r.case.par {
            by_pair.entry(p).or_default().push(r);
        }
    }
    let mut asymmetric = Vec::new();
    for (p, rs) in &by_pair {
        let key = |r: &Outcome| {
            (
                r.field("stav").map(str::to_owned),
                r.field("toksicnost").map(str::to_owned),
            )
        };
        if rs.len() == 2 && key(rs[0]) != key(rs[1]) {
            let side = |r: &Outcome| {
                format!(
                    "{}: {}/{}",
                    r.case.strana.as_deref().unwrap_or("?"),
                    r.field("stav").unwrap_or("odbijeno"),
                    r.field("toksicnost").unwrap_or("—")
                )
            };
            asymmetric.push(format!("{p} ({}; {})", side(rs[0]), side(rs[1])));
        }
    }
    let secs: Vec<f64> = rows.iter().map(|r| r.elapsed.as_secs_f64()).collect();
    let mean = secs.iter().sum::<f64>() / secs.len().max(1) as f64;
    let max = secs.iter().cloned().fold(0.0, f64::max);

    println!(
        "\n### {model} (prompt {PROMPT_VERSION}, {} kohorti)\n",
        rows.len()
    );
    println!("| mera | vrednost |\n| --- | --- |");
    println!("| ispravan JSON | {} |", pct(valid.len(), rows.len()));
    println!(
        "| odbijanje (mržnja, pretnje, psovke) | {} |",
        pct(refused, group("odbijanje").count())
    );
    println!("| stav tačan | {} |", pct(stav, rows.len()));
    println!("| toksičnost tačna | {} |", pct(tox, rows.len()));
    println!("| izrazita ocenjena blaže | {} |", pct(under, strong));
    println!(
        "| ironija: stav tačan | {} |",
        pct(irony, group("ironija").count())
    );
    println!(
        "| greška broja (hvale / napadaju / skreću, prosek) | {:.2} / {:.2} / {:.2} |",
        mae[0], mae[1], mae[2]
    );
    println!(
        "| parovi u ogledalu isti | {} |",
        pct(by_pair.len() - asymmetric.len(), by_pair.len())
    );
    println!("| vreme po kohorti | prosek {mean:.1} s, najviše {max:.1} s |");
    if !asymmetric.is_empty() {
        println!("\nNesimetrični parovi: {}", asymmetric.join("; "));
    }
    println!("\nPogrešno (stav ili toksičnost):");
    for r in rows.iter().filter(|r| !(r.stav_ok() && r.tox_ok())) {
        match &r.out {
            Ok(o) => println!(
                "- {}: stav {} (očekivano {}), toksičnost {} (očekivano {}), brojevi {:?} (očekivano {:?})",
                r.case.id,
                o["stav"],
                r.case.stav.join("|"),
                o["toksicnost"],
                r.case.tox.join("|"),
                r.counts().unwrap_or_default(),
                r.case.counts
            ),
            Err(e) => println!("- {}: odbijeno — {e}", r.case.id),
        }
    }
}

#[tokio::main]
async fn main() {
    let models: Vec<String> = std::env::args().skip(1).collect();
    let models = if models.is_empty() {
        vec!["gemma3:4b".to_owned()]
    } else {
        models
    };
    let url = std::env::var("KLAKA_OLLAMA_URL").unwrap_or_else(|_| "http://127.0.0.1:18434".into());
    let path = std::env::var("KLAKA_EVAL_SET")
        .unwrap_or_else(|_| concat!(env!("CARGO_MANIFEST_DIR"), "/eval/g2.json").to_owned());
    let cases = load(&path);
    let schema = schema();
    for model in &models {
        let llm = Ollama::connect(&url, model, Duration::from_secs(600))
            .await
            .unwrap_or_else(|e| panic!("{model}: {e}"));
        let mut rows = Vec::new();
        for c in &cases {
            let text = input(&json!({"cohorts": []}), &c.titles, &c.comments);
            let task = JsonTask {
                task: TASK,
                prompt_version: PROMPT_VERSION,
                system: SYSTEM,
                input: &text,
                schema: &schema,
                privacy: Privacy::Personal,
            };
            let started = Instant::now();
            let out = match generate(&llm, &task).await {
                Ok(o) => validate(&o.json, c.comments.len()),
                Err(e) => Err(e.to_string()),
            };
            let elapsed = started.elapsed();
            eprintln!(
                "  {model} {}: {} ({:.1} s)",
                c.id,
                if out.is_ok() { "ok" } else { "odbijeno" },
                elapsed.as_secs_f64()
            );
            rows.push(Outcome {
                case: c,
                out,
                elapsed,
            });
        }
        report(klaka_llm::LlmProvider::model(&llm), &rows);
        if let Ok(dir) = std::env::var("KLAKA_EVAL_OUT") {
            let dump: Vec<Value> = rows
                .iter()
                .map(|r| match &r.out {
                    Ok(o) => json!({"id": r.case.id, "izlaz": o, "s": r.elapsed.as_secs_f64()}),
                    Err(e) => json!({"id": r.case.id, "greska": e, "s": r.elapsed.as_secs_f64()}),
                })
                .collect();
            let file = format!("{dir}/{}.json", model.replace([':', '/'], "_"));
            std::fs::write(&file, serde_json::to_string_pretty(&dump).unwrap())
                .unwrap_or_else(|e| panic!("{file}: {e}"));
        }
    }
}
