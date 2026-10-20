//! Šema događaja (`spec/events.md`). Koverta se parsira u celini, a događaji pojedinačno:
//! neispravan događaj se odbacuje, ostali iz iste koverte prolaze (§4, tačka 4).
//!
//! Tipovi služe i kao filter: u bazu ide ponovo serijalizovan događaj, pa polja koja spec
//! ne poznaje (i koja bi browser mogao da podmetne) ne stižu nigde.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::net;
use crate::token::TokenResult;

pub const MAX_BODY: usize = 64 * 1024;
pub const MAX_EVENTS: usize = 100;

const ID_MAX: usize = 256;
const VID_MAX: usize = 64;
const URL_MAX: usize = 1024;
const SHORT_MAX: usize = 64;
const TITLE_MAX: usize = 1024;
const UA_MAX: usize = 512;
const TEXT_MAX: usize = 8 * 1024;
const BODY_MAX: usize = 32 * 1024;
const SEEN_MAX: usize = 200;

#[derive(Debug, Deserialize)]
pub struct Envelope {
    pub v: u8,
    pub portal: String,
    pub sent_ms: i64,
    pub events: Vec<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EnvelopeError {
    Json,
    Version,
    Portal,
    Count,
}

impl Envelope {
    /// Kriterijumi za odbacivanje cele koverte (§1). Veličinu tela proverava server.
    pub fn parse(body: &[u8]) -> Result<Self, EnvelopeError> {
        let env: Self = serde_json::from_slice(body).map_err(|_| EnvelopeError::Json)?;
        if env.v != 1 {
            return Err(EnvelopeError::Version);
        }
        if !id(&env.portal) {
            return Err(EnvelopeError::Portal);
        }
        if env.events.is_empty() || env.events.len() > MAX_EVENTS {
            return Err(EnvelopeError::Count);
        }
        Ok(env)
    }
}

/// Događaji iz browsera (`/v1/events`, §2).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum BrowserEvent {
    View(View),
    Engage(Engage),
    Compose(Compose),
    Honeypot(Honeypot),
}

/// Događaji sa backenda portala (`/v1/ingest`, §3).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerEvent {
    Vote(Vote),
    Comment(Comment),
    Moderation(Moderation),
    Post(Post),
    Promotion(Promotion),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct View {
    pub vid: String,
    pub t: i64,
    pub post: String,
    #[serde(rename = "ref")]
    pub referrer: Option<String>,
    pub variant: Option<String>,
    pub lang: String,
    pub tz_min: i16,
    pub vp: [u32; 2],
    pub auto: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Engage {
    pub vid: String,
    pub t: i64,
    pub dwell_ms: u64,
    pub visible_ms: u64,
    pub depth_max: u16,
    pub depth_hist: [u64; 10],
    pub jumps: u32,
    pub first_input_ms: Option<u64>,
    pub inputs: Inputs,
    pub comments_ms: Option<u64>,
    pub seq: u32,
    pub seen: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Inputs {
    pub key: u32,
    pub ptr: u32,
    pub touch: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Compose {
    pub vid: String,
    pub t: i64,
    pub post: String,
    pub focus_ms: u64,
    pub keys: Keys,
    pub pasted: bool,
    pub pasted_chars: Pasted,
    pub length: Length,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Keys {
    #[serde(rename = "0")]
    Zero,
    #[serde(rename = "1-10")]
    To10,
    #[serde(rename = "11-50")]
    To50,
    #[serde(rename = "51-200")]
    To200,
    #[serde(rename = "200+")]
    Over200,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Pasted {
    #[serde(rename = "0")]
    Zero,
    #[serde(rename = "1-50")]
    To50,
    #[serde(rename = "51-200")]
    To200,
    #[serde(rename = "200+")]
    Over200,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Length {
    #[serde(rename = "0")]
    Zero,
    #[serde(rename = "1-50")]
    To50,
    #[serde(rename = "51-200")]
    To200,
    #[serde(rename = "201-1000")]
    To1000,
    #[serde(rename = "1000+")]
    Over1000,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Honeypot {
    pub vid: String,
    pub t: i64,
    pub hp: String,
    pub kind: HoneypotKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HoneypotKind {
    Click,
    Focus,
    Fill,
}

/// Zajednička polja za `vote` i `comment` (§3).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Action {
    pub t: i64,
    pub post: String,
    pub vid: Option<String>,
    pub token: TokenResult,
    pub uses: Option<u32>,
    pub decision: Decision,
    pub net: String,
    pub ua: String,
    pub cid: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Decision {
    Count,
    Shadow,
    Challenge,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Vote {
    #[serde(flatten)]
    pub action: Action,
    pub target: String,
    pub target_author: Option<String>,
    pub dir: Dir,
    /// `sdk.md` §2a; `None` ako prikaz nije poznat ili Valkey nije bio dostupan.
    pub repeat: Option<bool>,
}

/// `1` ili `-1`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "i8", into = "i8")]
pub enum Dir {
    Up,
    Down,
}

impl TryFrom<i8> for Dir {
    type Error = &'static str;
    fn try_from(d: i8) -> Result<Self, Self::Error> {
        match d {
            1 => Ok(Self::Up),
            -1 => Ok(Self::Down),
            _ => Err("dir mora biti 1 ili -1"),
        }
    }
}

impl From<Dir> for i8 {
    fn from(d: Dir) -> Self {
        match d {
            Dir::Up => 1,
            Dir::Down => -1,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Comment {
    #[serde(flatten)]
    pub action: Action,
    pub comment: String,
    pub author: String,
    pub text: String,
    pub reply_to: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Moderation {
    pub t: i64,
    pub comment: String,
    pub result: ModerationResult,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModerationResult {
    Approved,
    Rejected,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Post {
    pub t: i64,
    pub post: String,
    pub rev: u32,
    pub url: String,
    pub title: String,
    pub section: Option<String>,
    pub body: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Promotion {
    pub t: i64,
    pub post: String,
    pub channel: Channel,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Channel {
    Push,
    Homepage,
    Newsletter,
    Social,
    Other,
}

/// Zašto je događaj odbačen. Ide samo u brojače i logove collector-a, nikad pošiljaocu.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Rejected {
    /// Nepoznat tip ili polje pogrešnog tipa.
    Schema,
    /// Tipovi su ispravni, ali vrednost nije (dužina, opseg, format).
    Field(&'static str),
}

/// Polja koja collector izvlači u kolone; ostatak događaja ide u `data` (jsonb).
pub trait Event: Serialize + Sized {
    fn kind(&self) -> &'static str;
    fn t(&self) -> i64;
    fn vid(&self) -> Option<&str>;
    fn post(&self) -> Option<&str>;
    /// Provera vrednosti i normalizacija (skraćivanje onoga što ne sme da se čuva u celini).
    fn check(&mut self) -> Result<(), Rejected>;

    fn parse(v: Value) -> Result<Self, Rejected>
    where
        Self: for<'de> Deserialize<'de>,
    {
        let mut e: Self = serde_json::from_value(v).map_err(|_| Rejected::Schema)?;
        e.check()?;
        Ok(e)
    }
}

impl Event for BrowserEvent {
    fn kind(&self) -> &'static str {
        match self {
            Self::View(_) => "view",
            Self::Engage(_) => "engage",
            Self::Compose(_) => "compose",
            Self::Honeypot(_) => "honeypot",
        }
    }

    fn t(&self) -> i64 {
        match self {
            Self::View(e) => e.t,
            Self::Engage(e) => e.t,
            Self::Compose(e) => e.t,
            Self::Honeypot(e) => e.t,
        }
    }

    fn vid(&self) -> Option<&str> {
        Some(match self {
            Self::View(e) => &e.vid,
            Self::Engage(e) => &e.vid,
            Self::Compose(e) => &e.vid,
            Self::Honeypot(e) => &e.vid,
        })
    }

    fn post(&self) -> Option<&str> {
        match self {
            Self::View(e) => Some(&e.post),
            Self::Compose(e) => Some(&e.post),
            Self::Engage(_) | Self::Honeypot(_) => None,
        }
    }

    fn check(&mut self) -> Result<(), Rejected> {
        let vid = match self {
            Self::View(e) => &e.vid,
            Self::Engage(e) => &e.vid,
            Self::Compose(e) => &e.vid,
            Self::Honeypot(e) => &e.vid,
        };
        need(non_empty_max(vid, VID_MAX), "vid")?;
        match self {
            Self::View(e) => {
                need(id(&e.post), "post")?;
                if let Some(r) = &mut e.referrer {
                    // Samo origin + putanja: query i fragment mogu da nose lične podatke.
                    if let Some(i) = r.find(['?', '#']) {
                        r.truncate(i);
                    }
                    need(r.len() <= URL_MAX, "ref")?;
                }
                need(opt_max(&e.variant, SHORT_MAX), "variant")?;
                need(e.lang.len() <= SHORT_MAX, "lang")?;
                need((-16 * 60..=16 * 60).contains(&e.tz_min), "tz_min")?;
                // Browser treba da zaokruži sam; ovde se zaokružuje ponovo, za svaki slučaj.
                e.vp = e.vp.map(|x| x.saturating_add(50) / 100 * 100);
            }
            Self::Engage(e) => {
                need(e.depth_max <= 1000, "depth_max")?;
                need(e.seen.len() <= SEEN_MAX, "seen")?;
                need(e.seen.iter().all(|s| id(s)), "seen")?;
            }
            Self::Compose(e) => {
                need(id(&e.post), "post")?;
            }
            Self::Honeypot(e) => {
                need(id(&e.hp), "hp")?;
            }
        }
        Ok(())
    }
}

impl Event for ServerEvent {
    fn kind(&self) -> &'static str {
        match self {
            Self::Vote(_) => "vote",
            Self::Comment(_) => "comment",
            Self::Moderation(_) => "moderation",
            Self::Post(_) => "post",
            Self::Promotion(_) => "promotion",
        }
    }

    fn t(&self) -> i64 {
        match self {
            Self::Vote(e) => e.action.t,
            Self::Comment(e) => e.action.t,
            Self::Moderation(e) => e.t,
            Self::Post(e) => e.t,
            Self::Promotion(e) => e.t,
        }
    }

    fn vid(&self) -> Option<&str> {
        match self {
            Self::Vote(e) => e.action.vid.as_deref(),
            Self::Comment(e) => e.action.vid.as_deref(),
            _ => None,
        }
    }

    fn post(&self) -> Option<&str> {
        match self {
            Self::Vote(e) => Some(&e.action.post),
            Self::Comment(e) => Some(&e.action.post),
            Self::Moderation(_) => None,
            Self::Post(e) => Some(&e.post),
            Self::Promotion(e) => Some(&e.post),
        }
    }

    fn check(&mut self) -> Result<(), Rejected> {
        match self {
            Self::Vote(e) => {
                e.action.check()?;
                need(id(&e.target), "target")?;
                need(opt_id(&e.target_author), "target_author")?;
            }
            Self::Comment(e) => {
                e.action.check()?;
                need(id(&e.comment), "comment")?;
                need(id(&e.author), "author")?;
                need(e.text.len() <= TEXT_MAX, "text")?;
                need(opt_id(&e.reply_to), "reply_to")?;
            }
            Self::Moderation(e) => {
                need(id(&e.comment), "comment")?;
                need(opt_max(&e.reason, TITLE_MAX), "reason")?;
            }
            Self::Post(e) => {
                need(id(&e.post), "post")?;
                need(non_empty_max(&e.url, URL_MAX), "url")?;
                need(e.title.len() <= TITLE_MAX, "title")?;
                need(opt_max(&e.section, SHORT_MAX), "section")?;
                need(opt_max(&e.body, BODY_MAX), "body")?;
            }
            Self::Promotion(e) => {
                need(id(&e.post), "post")?;
            }
        }
        Ok(())
    }
}

impl Action {
    fn check(&mut self) -> Result<(), Rejected> {
        need(id(&self.post), "post")?;
        need(
            self.vid
                .as_deref()
                .is_none_or(|v| non_empty_max(v, VID_MAX)),
            "vid",
        )?;
        // Samo prefiks u kanonskom obliku — pun IP ne sme da prođe ni greškom SDK-a.
        need(is_prefix(&self.net), "net")?;
        truncate_utf8(&mut self.ua, UA_MAX);
        need(opt_max(&self.cid, SHORT_MAX), "cid")?;
        Ok(())
    }
}

/// `93.87.12.0/24` ili `2a02:8109:1234::/48`, tačno onako kako ga daje [`net::prefix`].
pub fn is_prefix(s: &str) -> bool {
    s.rsplit_once('/')
        .and_then(|(ip, _)| net::prefix_str(ip))
        .is_some_and(|p| p == s)
}

fn need(ok: bool, field: &'static str) -> Result<(), Rejected> {
    if ok {
        Ok(())
    } else {
        Err(Rejected::Field(field))
    }
}

fn id(s: &str) -> bool {
    non_empty_max(s, ID_MAX)
}

fn opt_id(s: &Option<String>) -> bool {
    s.as_deref().is_none_or(id)
}

fn non_empty_max(s: &str, max: usize) -> bool {
    !s.is_empty() && s.len() <= max
}

fn opt_max(s: &Option<String>, max: usize) -> bool {
    s.as_deref().is_none_or(|s| s.len() <= max)
}

fn truncate_utf8(s: &mut String, max: usize) {
    if s.len() > max {
        let mut i = max;
        while !s.is_char_boundary(i) {
            i -= 1;
        }
        s.truncate(i);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_respects_char_boundary() {
        let mut s = "aš".repeat(300);
        truncate_utf8(&mut s, 512);
        assert!(s.len() <= 512);
        assert!(s.len() >= 510);
    }

    #[test]
    fn serialized_event_keeps_type_and_drops_unknown_fields() {
        let v = serde_json::json!({
            "type": "honeypot", "vid": "AAECAwQFBgcICQoLDA0ODw", "t": 1,
            "hp": "h-1", "kind": "fill", "extra": "x"
        });
        let e = BrowserEvent::parse(v).unwrap();
        let out = serde_json::to_value(&e).unwrap();
        assert_eq!(out["type"], "honeypot");
        assert!(out.get("extra").is_none());
    }
}
