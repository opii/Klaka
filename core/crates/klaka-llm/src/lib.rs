//! `Embedder` (E1, docs/llm.md §1) preko Ollama-e — lokalno, jer je tekst komentara lični
//! podatak. Generativni zadaci (`LlmProvider`, G1–G3) slede. Izlaz je savetodavan: embeddings
//! su ulaz detektoru, nikad presuda.

use std::future::Future;
use std::time::Duration;

use serde::Deserialize;
use serde_json::json;

#[derive(Debug)]
pub enum LlmError {
    Http(reqwest::Error),
    /// Ollama radi, ali nema traženi model (npr. preuzimanje još traje).
    Missing(String),
    /// Odgovor nije oblika koji API obećava.
    Shape(String),
}

impl std::fmt::Display for LlmError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Http(e) => write!(f, "http: {e}"),
            Self::Missing(m) => write!(f, "nema modela {m}"),
            Self::Shape(s) => write!(f, "neočekivan odgovor: {s}"),
        }
    }
}

impl std::error::Error for LlmError {}

impl From<reqwest::Error> for LlmError {
    fn from(e: reqwest::Error) -> Self {
        Self::Http(e)
    }
}

pub trait Embedder {
    /// Model sa digestom (`bge-m3@5e2b1c0d9a81`): vektori različitih modela se ne porede.
    fn model(&self) -> &str;
    /// Po jedan vektor za svaki tekst, istim redom.
    fn embed(&self, texts: &[&str])
    -> impl Future<Output = Result<Vec<Vec<f32>>, LlmError>> + Send;
}

/// Ollama (`/api/tags`, `/api/embed`).
pub struct Ollama {
    base: String,
    name: String,
    model: String,
    client: reqwest::Client,
}

#[derive(Deserialize)]
struct Tags {
    models: Vec<Tag>,
}

#[derive(Deserialize)]
struct Tag {
    name: String,
    digest: String,
}

#[derive(Deserialize)]
struct Embeddings {
    embeddings: Vec<Vec<f32>>,
}

impl Ollama {
    /// Proverava da Ollama ima model `name` i pamti njegov digest.
    pub async fn connect(base_url: &str, name: &str, timeout: Duration) -> Result<Self, LlmError> {
        let client = reqwest::Client::builder().timeout(timeout).build()?;
        let base = base_url.trim_end_matches('/').to_owned();
        let tags: Tags = client
            .get(format!("{base}/api/tags"))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        let latest = format!("{name}:latest");
        let tag = tags
            .models
            .into_iter()
            .find(|m| m.name == name || m.name == latest)
            .ok_or_else(|| LlmError::Missing(name.to_owned()))?;
        let digest: String = tag.digest.chars().take(12).collect();
        Ok(Self {
            base,
            name: name.to_owned(),
            model: format!("{name}@{digest}"),
            client,
        })
    }
}

impl Embedder for Ollama {
    fn model(&self) -> &str {
        &self.model
    }

    async fn embed(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>, LlmError> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        let out: Embeddings = self
            .client
            .post(format!("{}/api/embed", self.base))
            .json(&json!({"model": self.name, "input": texts}))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        if out.embeddings.len() != texts.len() {
            return Err(LlmError::Shape(format!(
                "{} vektora za {} tekstova",
                out.embeddings.len(),
                texts.len()
            )));
        }
        Ok(out.embeddings)
    }
}
