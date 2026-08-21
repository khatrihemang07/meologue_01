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
        self.embed(format!(
            "Instruct: {QUERY_INSTRUCTION}\nQuery: {}",
            end_with_sentence_punctuation(text)
        ))
        .await
    }
}

/// Ensures a Question ends in sentence-final punctuation before it is
/// embedded.
///
/// Harrier pools the **last token** (ADR 0022), so the final character of
/// the input has outsized influence on the whole vector. Every Entry is
/// ordinary prose ending in `.`, `?` or `!`, so a Question that stops
/// mid-phrase is out of distribution against the very things it is being
/// compared to — and the damage is not subtle. Measured on this corpus:
/// "What did I write about the wedding" retrieved unrelated running Entries
/// at 0.357, while the identical text with a "?" retrieved all three real
/// wedding Entries at 0.677. "Tell me about the wedding" moved 0.346 ->
/// 0.638 the same way.
///
/// A Question mark is the right default rather than a full stop: CONTEXT.md
/// defines a Question as what the user asks during Reflection, so appending
/// "?" states what the text already is instead of changing it.
fn end_with_sentence_punctuation(text: &str) -> String {
    let trimmed = text.trim_end();
    if trimmed.ends_with(['?', '.', '!']) {
        trimmed.to_string()
    } else {
        format!("{trimmed}?")
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

    /// Builds the two clients ticket 4's `/v1/reflect` route needs — a chat
    /// client to turn Grounding plus a Question into an Answer, and an embed
    /// client to turn the Question itself into a vector for retrieval — or
    /// `None` if the route must not exist at all.
    ///
    /// This is deliberately stricter than "chat is configured": Reflection
    /// cannot retrieve anything without an embed client either (there is no
    /// way to call `embed_query` without one), so requiring both is what
    /// makes "the route exists" and "the route can actually answer" the same
    /// fact, rather than a route that exists but 500s on every call in a
    /// chat-only-configured deployment. In the documented setup (this
    /// project's README) both are always configured together, so this is a
    /// belt-and-suspenders guard for a split configuration than the primary
    /// on/off switch, which — per ADR 0021 — is `MEOLOGUE_CHAT_BASE_URL`/
    /// `MEOLOGUE_CHAT_MODEL`.
    pub fn reflect_config(&self) -> Option<(Arc<dyn LlmClient + Send + Sync>, Arc<dyn LlmClient + Send + Sync>)> {
        let chat_base_url = self.chat_base_url.clone()?;
        let chat_model = self.chat_model.clone()?;
        let chat_client: Arc<dyn LlmClient + Send + Sync> = Arc::new(OpenAiCompatibleClient::new(
            chat_base_url,
            chat_model,
            self.chat_api_key.clone(),
        ));

        let (embed_client, _model_name) = self.embed_worker_config()?;

        Some((chat_client, embed_client))
    }

    /// Builds the chat client the Digest worker (`digest::run`, ADR 0027)
    /// needs, or `None` if the worker must not start. Gated on
    /// `MEOLOGUE_CHAT_BASE_URL`/`MEOLOGUE_CHAT_MODEL` alone — per ADR 0021,
    /// unset chat config means the feature is off, mirroring
    /// `embed_worker_config` and `reflect_config` above.
    ///
    /// Deliberately looser than `reflect_config`, which also requires an
    /// embed client: Reflection retrieves Grounding by vector similarity,
    /// so it cannot function without something to turn a Question into a
    /// vector. A Digest retrieves its Entries by date range
    /// (`period::period_bounds`) instead, so it has no embedding
    /// dependency at all — requiring one here would gate the worker on a
    /// config knob it never reads.
    pub fn digest_worker_config(&self) -> Option<Arc<dyn LlmClient + Send + Sync>> {
        let chat_base_url = self.chat_base_url.clone()?;
        let chat_model = self.chat_model.clone()?;
        let client: Arc<dyn LlmClient + Send + Sync> = Arc::new(OpenAiCompatibleClient::new(
            chat_base_url,
            chat_model,
            self.chat_api_key.clone(),
        ));
        Some(client)
    }
}

#[cfg(test)]
mod tests {
    use super::end_with_sentence_punctuation;

    #[test]
    fn a_question_without_punctuation_gains_a_question_mark() {
        assert_eq!(
            end_with_sentence_punctuation("What did I write about the wedding"),
            "What did I write about the wedding?"
        );
    }

    #[test]
    fn existing_sentence_punctuation_is_left_alone() {
        for already in ["Did it stop me running?", "Tell me about the move.", "Wow!"] {
            assert_eq!(end_with_sentence_punctuation(already), already);
        }
    }

    #[test]
    fn trailing_whitespace_does_not_hide_existing_punctuation() {
        // Without trimming first, "How did it go?  " would be seen as
        // ending in a space and pick up a second, spurious "?".
        assert_eq!(end_with_sentence_punctuation("How did it go?  "), "How did it go?");
        assert_eq!(end_with_sentence_punctuation("How did it go  "), "How did it go?");
    }
}
