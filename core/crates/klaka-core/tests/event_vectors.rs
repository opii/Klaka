//! Zajednički test vektori iz `core/spec/test-vectors/events.json`.

use klaka_core::events::{BrowserEvent, Event, ServerEvent};
use serde_json::Value;

const VECTORS: &str = include_str!("../../../spec/test-vectors/events.json");

#[test]
fn all_vectors_pass() {
    let doc: Value = serde_json::from_str(VECTORS).unwrap();
    let mut failures = Vec::new();
    for case in doc["cases"].as_array().unwrap() {
        let input = case["input"].clone();
        let got = match case["endpoint"].as_str().unwrap() {
            "events" => BrowserEvent::parse(input).map(|e| serde_json::to_value(e).unwrap()),
            "ingest" => ServerEvent::parse(input).map(|e| serde_json::to_value(e).unwrap()),
            other => panic!("nepoznat endpoint {other}"),
        };
        let got = got.ok().unwrap_or(Value::Null);
        if got != case["expect"] {
            failures.push(format!(
                "{}: očekivano {}, dobijeno {got}",
                case["name"], case["expect"]
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
