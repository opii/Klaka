//! Ključ i vrednost presude u Valkey-ju (`spec/verdicts.md` §1–2): pišu ih engine (presuda) i
//! `klaka-api` (recenzent je odbaci), čita ih SDK.

/// Ključ presude po prefiksu.
pub fn net_key(portal: &str, net: &str) -> String {
    format!("klaka:v1:{portal}:net:{net}")
}

/// Vrednost ključa presude — bez razloga i dokaza.
pub fn value(action: &str, until_ms: i64, rev: i32) -> String {
    serde_json::json!({"action": action, "until_ms": until_ms, "rev": rev}).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_and_value_follow_spec() {
        assert_eq!(
            net_key("demo.local", "93.87.12.0/24"),
            "klaka:v1:demo.local:net:93.87.12.0/24"
        );
        let v: serde_json::Value =
            serde_json::from_str(&value("shadow", 1_792_003_600_000, 7)).unwrap();
        assert_eq!(
            v,
            serde_json::json!({"action": "shadow", "until_ms": 1_792_003_600_000_i64, "rev": 7})
        );
    }
}
