//! Zajednički test vektori iz `core/spec/test-vectors/net.json`.

use ppd_core::net::prefix_str;
use serde_json::Value;

const VECTORS: &str = include_str!("../../../spec/test-vectors/net.json");

#[test]
fn all_vectors_pass() {
    let doc: Value = serde_json::from_str(VECTORS).unwrap();
    let mut failures = Vec::new();
    for case in doc["cases"].as_array().unwrap() {
        let got = prefix_str(case["input"].as_str().unwrap());
        let expect = case["expect"].as_str().map(str::to_owned);
        if got != expect {
            failures.push(format!(
                "{}: očekivano {expect:?}, dobijeno {got:?}",
                case["name"]
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
