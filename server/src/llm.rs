//! The seam between the server and whatever OpenAI-compatible endpoint is
//! configured for chat and embeddings. Nothing outside this module knows
//! whether it's talking to a real HTTP client or a test fake — see
//! `LlmClient` below, and ADR 0021 for why the server calls out to an LLM
//! at all.

use std::env;
use std::sync::Arc;

use anyhow::{Context, Result, bail};
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::json;

/// One turn in a Conversation, in the shape a chat-completions endpoint
/// expects. Defined now so `LlmClient`'s full shape is settled before
/// anything needs it — Reflection (ticket 4) is the first caller of `chat`.
#[derive(Debug, Clone)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

/// The task instruction Harrier's model card documents for query
/// embeddings. Never used for `embed_document` — see that method.
const QUERY_INSTRUCTION: &str =
    "Given a question about a personal journal, retrieve journal entries that answer it";

/// The server's dependency on an LLM, expressed as a trait so production
/// code can hold `Arc<dyn LlmClient + Send + Sync>` and the test suite can
/// substitute a fake that returns deterministic vectors instead of making a
/// network call. `#[async_trait]` keeps the trait object-safe (it desugars
/// each method to return `Pin<Box<dyn Future>>>`), which is what lets it be
/// stored behind an `Arc` and shared across the sync handler and the
/// embedding worker.
#[async_trait]
pub trait LlmClient {
    /// Not called anywhere in this ticket — ticket 4 (Reflection) is the
    /// first caller. Defined now so the trait doesn't need a breaking
    /// change when that ticket lands.
    async fn chat(&self, messages: &[ChatMessage]) -> Result<String>;

    /// Embeds an Entry's body for storage, so it can later be compared
    /// against a query embedding. Harrier is instruction-tuned and expects
    /// the raw text with **no prefix whatsoever** for anything being
    /// indexed — only text used to *search* gets the `Instruct:` wrapper
    /// (see `embed_query`). Sending the body unprefixed is what makes this
    /// a document embedding rather than a query embedding; collapsing the
    /// two into one method would silently mismatch the model's expected
    /// input for one side of every future similarity comparison.
    async fn embed_document(&self, text: &str) -> Result<Vec<f32>>;

    /// Embeds a Question for retrieval. Harrier's model card documents an
    /// `Instruct: {task}\nQuery: {text}` wrapper for anything used to
    /// search rather than to be found — verified against this model to
    /// widen the relevant-vs-irrelevant cosine margin from 0.144 to 0.164,
    /// so it is not a cosmetic difference from `embed_document`. Unused in
    /// this ticket (there is no retrieval endpoint yet), but declared here
    /// so the document/query asymmetry lives at the trait boundary instead
    /// of being reintroduced ad hoc later.
    async fn embed_query(&self, text: &str) -> Result<Vec<f32>>;
}

/// Talks to any endpoint that speaks the OpenAI chat-completions and
/// embeddings shapes — Ollama and the `codex-terra` wrapper both do. One
/// instance is scoped to a single `(base_url, model, api_key)` triple, so
/// the chat client and the embedding client (which may point at entirely
/// different endpoints and models — see `LlmConfig`) are two separate
/// instances, never one shared client juggling two configurations.
pub struct OpenAiCompatibleClient {
    http: reqwest::Client,
    base_url: String,
    model: String,
    api_key: Option<String>,
}

impl OpenAiCompatibleClient {
    pub fn new(base_url: impl Into<String>, model: impl Into<String>, api_key: Option<String>) -> Self {
        Self {
            http: reqwest::Client::new(),
            base_url: base_url.into(),
            model: model.into(),
            api_key,
        }
    }

    fn authed(&self, builder: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        // Sent only when a key is configured: Ollama and the local
        // `codex-terra` wrapper don't require one, and an empty
        // `Authorization` header is worse than none.
        match &self.api_key {
            Some(key) => builder.bearer_auth(key),
            None => builder,
        }
    }

    async fn embed(&self, input: String) -> Result<Vec<f32>> {
        #[derive(Deserialize)]
        struct EmbeddingResponse {
            data: Vec<EmbeddingDatum>,
        }
        #[derive(Deserialize)]
        struct EmbeddingDatum {
            embedding: Vec<f32>,
        }

        let request = self.authed(self.http.post(format!("{}/embeddings", self.base_url)).json(&json!({
            "model": self.model,
            "input": input,
        })));
        let response = request.send().await.context("embedding request failed to send")?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            bail!("embedding request returned {status}: {body}");
        }
        let mut parsed: EmbeddingResponse = response
            .json()
            .await
            .context("embedding response was not the expected shape")?;
        if parsed.data.is_empty() {
            bail!("embedding response contained no data");
        }
        Ok(parsed.data.remove(0).embedding)
    }
}

#[async_trait]
impl LlmClient for OpenAiCompatibleClient {
    async fn chat(&self, messages: &[ChatMessage]) -> Result<String> {
        #[derive(Deserialize)]
        struct ChatResponse {
            choices: Vec<ChatChoice>,
        }
        #[derive(Deserialize)]
        struct ChatChoice {
            message: ChatChoiceMessage,
        }
        #[derive(Deserialize)]
        struct ChatChoiceMessage {
            content: String,
        }

        let payload_messages: Vec<_> = messages
            .iter()
            .map(|m| json!({ "role": m.role, "content": m.content }))
            .collect();
        // Only `model`, `messages`, `stream` — the local wrapper this points
        // at today accepts nothing else (no `response_format`, no tools).
        let request = self.authed(self.http.post(format!("{}/chat/completions", self.base_url)).json(&json!({
            "model": self.model,
            "messages": payload_messages,
            "stream": false,
        })));
        let response = request.send().await.context("chat request failed to send")?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            bail!("chat request returned {status}: {body}");
        }
        let mut parsed: ChatResponse = response
            .json()
            .await
            .context("chat response was not the expected shape")?;
        if parsed.choices.is_empty() {
            bail!("chat response contained no choices");
        }
        Ok(parsed.choices.remove(0).message.content)
    }

    async fn embed_document(&self, text: &str) -> Result<Vec<f32>> {
        self.embed(text.to_string()).await
    }

    async fn embed_query(&self, text: &str) -> Result<Vec<f32>> {
        self.embed(format!("Instruct: {QUERY_INSTRUCTION}\nQuery: {text}")).await
    }
}

/// Chat and embeddings read from environment, independently of each other —
/// see `server/README.md` and ADR 0021. An unset `MEOLOGUE_CHAT_*` pair
/// means Reflection is off; an unset `MEOLOGUE_EMBED_MODEL` (with no base
/// URL to resolve, see `embed_worker_config`) means the embedding worker
/// never starts. This mirrors ADR 0011's "unset Server URL means Sync is
/// off": a missing config value is a deliberate off-switch, not an error.
pub struct LlmConfig {
    pub chat_base_url: Option<String>,
    pub chat_model: Option<String>,
    pub chat_api_key: Option<String>,
    pub embed_base_url: Option<String>,
    pub embed_model: Option<String>,
    pub embed_api_key: Option<String>,
}

impl LlmConfig {
    pub fn from_env() -> Self {
        fn var(name: &str) -> Option<String> {
            env::var(name).ok().filter(|value| !value.is_empty())
        }

        Self {
            chat_base_url: var("MEOLOGUE_CHAT_BASE_URL"),
            chat_model: var("MEOLOGUE_CHAT_MODEL"),
            chat_api_key: var("MEOLOGUE_CHAT_API_KEY"),
            embed_base_url: var("MEOLOGUE_EMBED_BASE_URL"),
            embed_model: var("MEOLOGUE_EMBED_MODEL"),
            embed_api_key: var("MEOLOGUE_EMBED_API_KEY"),
        }
    }

    /// Builds the client and model name the embedding worker needs, or
    /// `None` if the worker must not start. `MEOLOGUE_EMBED_BASE_URL` falls
    /// back to the chat base URL when unset — a single local endpoint
    /// commonly serves both — but an explicit embed URL always wins, and a
    /// missing model name (the actual on/off switch) means "off" even if a
    /// base URL is resolvable from either variable.
    pub fn embed_worker_config(&self) -> Option<(Arc<dyn LlmClient + Send + Sync>, String)> {
        let base_url = self.embed_base_url.clone().or_else(|| self.chat_base_url.clone())?;
        let model = self.embed_model.clone()?;
        let client = OpenAiCompatibleClient::new(base_url, model.clone(), self.embed_api_key.clone());
        Some((Arc::new(client), model))
    }
}
