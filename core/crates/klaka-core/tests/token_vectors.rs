//! Zajednički test vektori iz `core/spec/test-vectors/token.json` (spec `token.md` §4, §7).

use std::collections::HashMap;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::SigningKey;
use klaka_core::token::{Payload, Policy, Verifier, issue, verifying_key_from_b64u};
use serde_json::Value;

const VECTORS: &str = include_str!("../../../spec/test-vectors/token.json");

fn vectors() -> Value {
    serde_json::from_str(VECTORS).expect("token.json je validan JSON")
}

fn verifier(doc: &Value) -> Verifier {
    let cfg = &doc["config"];
    let keys: HashMap<_, _> = cfg["keys"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(kid, k)| {
            (
                kid.clone(),
                verifying_key_from_b64u(k.as_str().unwrap()).unwrap(),
            )
        })
        .collect();
    let policy = Policy {
        min_age_ms: cfg["min_age_ms"].as_i64().unwrap(),
        max_age_ms: cfg["max_age_ms"].as_i64().unwrap(),
        max_uses: cfg["max_uses"].as_u64().unwrap(),
    };
    Verifier::new(cfg["portal"].as_str().unwrap(), keys, policy)
}

#[test]
fn all_vectors_pass() {
    let doc = vectors();
    let v = verifier(&doc);
    let def = &doc["defaults"];
    let mut failures = Vec::new();

    for case in doc["cases"].as_array().unwrap() {
        let input = &case["input"];
        let get = |k: &str| input.get(k).unwrap_or(&def[k]);
        let token = input["token"].as_str();
        let post = get("post").as_str().unwrap();
        let now = get("now_ms").as_i64().unwrap();
        let uses = get("uses").as_u64().unwrap();

        let got = v.check_uses(v.verify(token, post, now), uses).result;
        let expect = case["expect"].as_str().unwrap();
        if got.as_str() != expect {
            failures.push(format!(
                "{}: očekivano {expect}, dobijeno {got}",
                case["name"]
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} neuspešnih:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

/// Ed25519 je deterministički: iz objavljenog test seed-a `issue` mora da da bajt-identične
/// tokene. Time je `klaka-core` kanonski generator, a fajl vektora zaštićen od tihe izmene.
#[test]
fn issue_reproduces_vectors() {
    let doc = vectors();
    let seed: [u8; 32] = hex(doc["test_key"]["seed_hex"].as_str().unwrap())
        .try_into()
        .unwrap();
    let key = SigningKey::from_bytes(&seed);
    assert_eq!(
        URL_SAFE_NO_PAD.encode(key.verifying_key().to_bytes()),
        doc["test_key"]["public_key_b64u"].as_str().unwrap()
    );

    let reproducible = [
        "valid",
        "wrong_portal",
        "wrong_post",
        "too_young",
        "too_young_future_iat",
        "boundary_min_age",
        "boundary_max_age",
        "expired",
        "order_wrong_portal_before_expired",
    ];
    for case in doc["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        if !reproducible.contains(&name) {
            continue;
        }
        let token = case["input"]["token"].as_str().unwrap();
        let payload_b64 = token.split('.').nth(2).unwrap();
        let payload: Payload =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload_b64).unwrap()).unwrap();
        assert_eq!(issue(&key, "test-1", &payload), token, "{name}");
    }
}

fn hex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}
