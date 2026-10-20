//! Token pregleda — `core/spec/token.md`.
//!
//! Format `klaka1.<kid>.<payload>.<sig>`, Ed25519. Provera ide normativnim redosledom iz
//! spec-a §4 i vraća prvi neuspeh, tako da svi SDK-ovi daju isti rezultat za isti ulaz.

use std::collections::HashMap;
use std::fmt;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};

/// Najveća dozvoljena dužina tokena u bajtovima; duži je `malformed` bez dekodiranja.
pub const MAX_TOKEN_LEN: usize = 1024;

const PREFIX: &str = "klaka1.";
const KID_MAX_LEN: usize = 32;
const SIG_B64_LEN: usize = 86;
const VID_B64_LEN: usize = 22;

/// Rezultat provere (spec §4). Imena u JSON-u i u događajima su `snake_case`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TokenResult {
    Valid,
    Missing,
    Malformed,
    UnknownKey,
    BadSignature,
    WrongPortal,
    WrongPost,
    TooYoung,
    Expired,
    Overused,
}

impl TokenResult {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Valid => "valid",
            Self::Missing => "missing",
            Self::Malformed => "malformed",
            Self::UnknownKey => "unknown_key",
            Self::BadSignature => "bad_signature",
            Self::WrongPortal => "wrong_portal",
            Self::WrongPost => "wrong_post",
            Self::TooYoung => "too_young",
            Self::Expired => "expired",
            Self::Overused => "overused",
        }
    }
}

impl fmt::Display for TokenResult {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Payload tokena (spec §3). Redosled polja je redosled u JSON-u koji izdavač piše.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Payload {
    pub v: u32,
    pub portal: String,
    pub post: String,
    pub vid: String,
    pub iat: i64,
}

/// Pragovi provere. Nikad ne idu u token ni do browsera (spec README, princip 2).
#[derive(Debug, Clone, Copy)]
pub struct Policy {
    pub min_age_ms: i64,
    pub max_age_ms: i64,
    pub max_uses: u64,
}

/// Ishod koraka 1–10. `payload` postoji ako su koraci 1–5 prošli, čak i kad kasniji ne prođu —
/// SDK tada zna `vid` za brojač upotreba i za događaj.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Verification {
    pub result: TokenResult,
    pub payload: Option<Payload>,
}

impl Verification {
    fn fail(result: TokenResult) -> Self {
        Self {
            result,
            payload: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyError {
    Encoding,
    Length,
    Invalid,
}

impl fmt::Display for KeyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Encoding => "ključ nije kanonski base64url",
            Self::Length => "ključ nema 32 bajta",
            Self::Invalid => "nevažeći Ed25519 javni ključ",
        })
    }
}

impl std::error::Error for KeyError {}

/// Javni ključ iz konfiguracije (base64url, 32 bajta).
pub fn verifying_key_from_b64u(s: &str) -> Result<VerifyingKey, KeyError> {
    let bytes = decode_canonical(s).ok_or(KeyError::Encoding)?;
    let bytes: [u8; 32] = bytes.try_into().map_err(|_| KeyError::Length)?;
    VerifyingKey::from_bytes(&bytes).map_err(|_| KeyError::Invalid)
}

/// Proverava tokene za jedan portal.
pub struct Verifier {
    portal: String,
    keys: HashMap<String, VerifyingKey>,
    policy: Policy,
}

impl Verifier {
    pub fn new(
        portal: impl Into<String>,
        keys: HashMap<String, VerifyingKey>,
        policy: Policy,
    ) -> Self {
        Self {
            portal: portal.into(),
            keys,
            policy,
        }
    }

    pub fn policy(&self) -> Policy {
        self.policy
    }

    /// Koraci 1–9: sve što ne zavisi od stanja.
    pub fn verify(&self, token: Option<&str>, post: &str, now_ms: i64) -> Verification {
        // 1
        let token = match token {
            Some(t) if !t.is_empty() => t,
            _ => return Verification::fail(TokenResult::Missing),
        };
        // 2
        let Some(parts) = split_strict(token) else {
            return Verification::fail(TokenResult::Malformed);
        };
        // 3
        let Some(key) = self.keys.get(parts.kid) else {
            return Verification::fail(TokenResult::UnknownKey);
        };
        // 4 — potpis pre JSON-a
        let sig = decode_canonical(parts.sig).and_then(|b| <[u8; 64]>::try_from(b).ok());
        let Some(sig) = sig else {
            return Verification::fail(TokenResult::BadSignature);
        };
        if key
            .verify_strict(parts.signed.as_bytes(), &Signature::from_bytes(&sig))
            .is_err()
        {
            return Verification::fail(TokenResult::BadSignature);
        }
        // 5
        let Some(payload) = parse_payload(parts.payload) else {
            return Verification::fail(TokenResult::Malformed);
        };
        // 6–9
        let result = if payload.portal != self.portal {
            TokenResult::WrongPortal
        } else if payload.post != post {
            TokenResult::WrongPost
        } else if now_ms.saturating_sub(payload.iat) < self.policy.min_age_ms {
            TokenResult::TooYoung
        } else if now_ms.saturating_sub(payload.iat) > self.policy.max_age_ms {
            TokenResult::Expired
        } else {
            TokenResult::Valid
        };
        Verification {
            result,
            payload: Some(payload),
        }
    }

    /// Korak 10: `uses` = stanje brojača za `vid` posle ove akcije. Menja samo `valid`.
    pub fn check_uses(&self, mut v: Verification, uses: u64) -> Verification {
        if v.result == TokenResult::Valid && uses > self.policy.max_uses {
            v.result = TokenResult::Overused;
        }
        v
    }
}

/// Izdaje token (spec §5). `kid` mora odgovarati `[a-z0-9-]{1,32}`.
pub fn issue(key: &SigningKey, kid: &str, payload: &Payload) -> String {
    debug_assert!(valid_kid(kid), "kid van [a-z0-9-]{{1,32}}");
    let json = serde_json::to_vec(payload).expect("Payload se uvek serijalizuje");
    let signed = format!("{PREFIX}{kid}.{}", URL_SAFE_NO_PAD.encode(json));
    let sig = key.sign(signed.as_bytes());
    format!("{signed}.{}", URL_SAFE_NO_PAD.encode(sig.to_bytes()))
}

struct Parts<'a> {
    kid: &'a str,
    payload: &'a str,
    sig: &'a str,
    /// `klaka1.<kid>.<payload>` — tačno ono što je potpisano.
    signed: &'a str,
}

/// Korak 2: ekvivalent regex-a
/// `^klaka1\.[a-z0-9-]{1,32}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{86}$` uz dužinu ≤ 1024.
fn split_strict(token: &str) -> Option<Parts<'_>> {
    if token.len() > MAX_TOKEN_LEN {
        return None;
    }
    let rest = token.strip_prefix(PREFIX)?;
    let (kid, rest) = rest.split_once('.')?;
    let (payload, sig) = rest.split_once('.')?;
    let ok = valid_kid(kid)
        && !payload.is_empty()
        && payload.bytes().all(is_b64url)
        && sig.len() == SIG_B64_LEN
        && sig.bytes().all(is_b64url);
    ok.then(|| Parts {
        kid,
        payload,
        sig,
        signed: &token[..token.len() - SIG_B64_LEN - 1],
    })
}

/// Korak 5: kanonski base64url → UTF-8 → JSON objekat → polja ispravnog tipa.
fn parse_payload(b64: &str) -> Option<Payload> {
    let bytes = decode_canonical(b64)?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    // Struktura bi se iz JSON niza deserijalizovala pozicijski; spec traži objekat.
    if !value.is_object() {
        return None;
    }
    let p: Payload = serde_json::from_value(value).ok()?;
    let vid_ok = p.vid.len() == VID_B64_LEN && p.vid.bytes().all(is_b64url);
    (p.v == 1 && vid_ok).then_some(p)
}

/// Strogo i kanonski: bez paddinga, samo base64url alfabet, bez „viška" bitova u poslednjem
/// znaku (spec §4, napomena o kanonskom zapisu). `base64` to podrazumevano odbija.
fn decode_canonical(s: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(s).ok()
}

/// `kid` po spec-u: `[a-z0-9-]{1,32}`.
pub fn valid_kid(kid: &str) -> bool {
    (1..=KID_MAX_LEN).contains(&kid.len())
        && kid
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn is_b64url(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'-' || b == b'_'
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_rejects_noncanonical_trailing_bits() {
        assert_eq!(decode_canonical("AQ"), Some(vec![1]));
        assert_eq!(decode_canonical("AR"), None);
    }

    #[test]
    fn split_rejects_extra_dot() {
        let sig = "A".repeat(SIG_B64_LEN);
        assert!(split_strict(&format!("klaka1.k.p.{sig}")).is_some());
        assert!(split_strict(&format!("klaka1.k.p.x.{sig}")).is_none());
    }
}
