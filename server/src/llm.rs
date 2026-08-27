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
use serde_json::{Value, json};

/// One turn in a Conversation, in the shape a chat-completions endpoint
/// expects. Defined now so `LlmClient`'s full shape is settled before
/// anything needs it — Reflection (ticket 4) is the first caller of `chat`.
#[derive(Debug, Clone)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

/// Coarse token accounting off one `chat` call's own response — issue #97:
/// "the wrapper returns `{prompt_tokens, completion_tokens, total_tokens}`,
/// trust the last good assistant usage." Named for the wire vocabulary the
/// endpoint actually reports (`prompt_tokens`/`completion_tokens`), not
/// `harness::types::Usage`'s `input_tokens`/`output_tokens` — this module
/// has no dependency on `harness` for its *types* (only `LlmConfig::resolve_context_window`
/// reaches into `harness::compaction` for one constant), and re-using the
/// harness name here would suggest a coupling that doesn't exist.
/// `harness::prompted::PromptedToolClient` — the one caller that needs
/// `harness::types::Usage` at all — converts between the two at the one
/// seam that actually has to know both vocabularies.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Usage {
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
}

/// What `LlmClient::chat` actually returns: the model's reply text, plus
/// whatever token usage the endpoint reported for that call, when it did.
/// Before issue #97 this was a bare `String` — every caller that only ever
/// wanted the text (`digest.rs`, three of `reflect.rs`'s four call sites)
/// still does, via `.content`; `ChatReply::text` exists so those callers'
/// own test doubles don't have to spell out `usage: None` at every fixture.
/// `harness::prompted::PromptedToolClient::stream` is the one call site
/// `usage` is actually *for* — see that module for where it lands.
#[derive(Debug, Clone, PartialEq)]
pub struct ChatReply {
    pub content: String,
    pub usage: Option<Usage>,
}

impl ChatReply {
    /// A reply with no usage reported — what every test double that
    /// doesn't care about token accounting should build, and what a real
    /// endpoint's response degrades to when its own `usage` is absent,
    /// zero, or malformed (`parse_usage`'s own doc comment).
    pub fn text(content: impl Into<String>) -> Self {
        Self {
            content: content.into(),
            usage: None,
        }
    }
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
    async fn chat(&self, messages: &[ChatMessage]) -> Result<ChatReply>;

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
    async fn chat(&self, messages: &[ChatMessage]) -> Result<ChatReply> {
        #[derive(Deserialize)]
        struct ChatResponse {
            choices: Vec<ChatChoice>,
            // Untyped, and `#[serde(default)]` rather than a typed, required
            // `Usage` sub-struct: `localAIWrapper`'s non-streaming response
            // (ADR 0003 there — "always emit ... usage") does carry a real
            // `usage: {prompt_tokens, completion_tokens, total_tokens}`
            // object, but nothing about this endpoint's own OpenAI-compatible
            // contract *requires* one, and a stray non-numeric field inside
            // it must degrade this call to "usage unknown," never fail the
            // whole chat call outright over a field this caller doesn't
            // strictly need. `parse_usage` is what actually reads it.
            #[serde(default)]
            usage: Option<Value>,
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
        Ok(ChatReply {
            content: parsed.choices.remove(0).message.content,
            usage: parse_usage(parsed.usage.as_ref()),
        })
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

    /// Issue #97: how much context the configured chat model actually has,
    /// read once from `GET {chat_base_url}/models/{chat_model}` — the
    /// `local_ai_wrapper`-namespaced `contextWindow` (or `maxTokens`) field
    /// ADR 0004 in `localAIWrapper` created that key for
    /// (`discovery.ts::OpenAIModel`). Called once, here, rather than per
    /// request: this is exactly the "model list ... already given" issue
    /// #97 names, not something a live `/v1/reflect` call should be paying
    /// an extra round trip for on every Question.
    ///
    /// Falls back to `harness::compaction::DEFAULT_CONTEXT_WINDOW` — the
    /// "conservative configured value" issue #97 asks for — on *any*
    /// failure to learn a real number: no chat config at all, the request
    /// itself failing, a non-2xx, an unparseable body, or a `local_ai_wrapper`
    /// object present but missing both fields. Every one of those is
    /// "unknown," and issue #97 is explicit about which way to round an
    /// unknown: summarise earlier than strictly necessary rather than risk
    /// a Question failing because the guessed window was too generous.
    pub async fn resolve_context_window(&self) -> u32 {
        let (Some(base_url), Some(model)) =
            (self.chat_base_url.as_deref(), self.chat_model.as_deref())
        else {
            return crate::harness::compaction::DEFAULT_CONTEXT_WINDOW;
        };

        match fetch_context_window(base_url, model, self.chat_api_key.as_deref()).await {
            Some(window) => window,
            None => {
                tracing::warn!(
                    base_url,
                    model,
                    "could not learn a context window for the configured chat model; \
                     falling back to the conservative default"
                );
                crate::harness::compaction::DEFAULT_CONTEXT_WINDOW
            }
        }
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

/// The network half of `LlmConfig::resolve_context_window` — split out so
/// the parsing half (`parse_context_window`) can be unit-tested against
/// canned JSON without a live `localAIWrapper` to ask, matching this
/// ticket's own constraint against starting either configured service.
/// `GET /v1/models/{id}` — ADR 0004 in `localAIWrapper`, the "retrieve"
/// half of the two model endpoints that ADR completed — over
/// `GET /v1/models` (list): this caller already knows exactly which one
/// Model it wants, so there is no reason to fetch and filter the whole
/// list.
async fn fetch_context_window(base_url: &str, model: &str, api_key: Option<&str>) -> Option<u32> {
    let client = reqwest::Client::new();
    let mut request = client.get(format!("{base_url}/models/{model}"));
    if let Some(key) = api_key {
        request = request.bearer_auth(key);
    }
    let response = request.send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    let body: Value = response.json().await.ok()?;
    parse_context_window(&body)
}

/// Reads `local_ai_wrapper.contextWindow` (or, if absent, `.maxTokens` —
/// issue #97's own "a `contextWindow` (and/or `maxTokens`) field") off one
/// `GET /v1/models/{id}` response body. `contextWindow` wins when a model
/// object somehow carries both, on the theory that a field named for
/// exactly this purpose is more trustworthy than one that merely happens to
/// also describe it. `None` for anything else — no `local_ai_wrapper` key
/// at all (every Model in `localAIWrapper`'s `models.json` before this
/// ticket), a key present but neither field set to a positive integer, or a
/// body that isn't even the expected shape — `resolve_context_window` reads
/// every one of those the same way: fall back to the conservative default.
fn parse_context_window(body: &Value) -> Option<u32> {
    let extras = body.get("local_ai_wrapper")?;
    for field in ["contextWindow", "maxTokens"] {
        if let Some(window) = extras.get(field).and_then(Value::as_u64) {
            if window > 0 {
                return u32::try_from(window).ok();
            }
        }
    }
    None
}

/// Reads `prompt_tokens`/`completion_tokens` off one chat response's own
/// `usage` object (issue #97: "the wrapper returns `{prompt_tokens,
/// completion_tokens, total_tokens}`") — `total_tokens` is never read
/// separately; every caller of `Usage` treats it as `prompt_tokens +
/// completion_tokens`, and a wrapper that reports one honestly reports the
/// other two consistent with it, so there is nothing a third field would
/// let this function catch that the two it does read wouldn't already show.
///
/// `usage` being absent entirely returns `None` — the ordinary case for any
/// endpoint that doesn't report it, which must read as "unknown," never as
/// "zero were used." **A `usage` object present but reporting `0` for both
/// fields is treated exactly the same way, `None`, not `Some(Usage{0, 0})`**:
/// a real chat call that produced a real reply cannot have genuinely cost
/// zero tokens, so `0`/`0` here means the field was there but not honestly
/// populated (or, at minimum, that this caller cannot tell the difference
/// between "must not use, no cost" and "value not filled in") — either way,
/// the honest answer is "unknown," and `compaction::estimate_tokens`'s own
/// contract already says what to do with an unknown anchor: fall back to
/// the chars/4 estimate, never trust a stated 0.
///
/// A non-numeric or missing sub-field degrades to `0` for that one field
/// (`Value::as_u64`'s own `None` case, read as `.unwrap_or(0)`) rather than
/// failing this whole call — `usage` is a courtesy this caller cannot
/// require of every endpoint, and a malformed one field should not cost the
/// content this call otherwise successfully got back. If *both* fields
/// degrade this way, the result folds into the same "treated as absent"
/// case above.
fn parse_usage(usage: Option<&Value>) -> Option<Usage> {
    let usage = usage?;
    let prompt_tokens = usage
        .get("prompt_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0) as u32;
    let completion_tokens = usage
        .get("completion_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0) as u32;
    if prompt_tokens == 0 && completion_tokens == 0 {
        return None;
    }
    Some(Usage {
        prompt_tokens,
        completion_tokens,
    })
}

#[cfg(test)]
mod tests {
    use super::{Usage, end_with_sentence_punctuation, parse_context_window, parse_usage};
    use serde_json::json;

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

    // -- parse_context_window (issue #97) -----------------------------------

    #[test]
    fn parse_context_window_reads_the_local_ai_wrapper_field() {
        let body = json!({
            "id": "codex-terra",
            "object": "model",
            "local_ai_wrapper": {"backend": "codex", "contextWindow": 128_000},
        });
        assert_eq!(parse_context_window(&body), Some(128_000));
    }

    #[test]
    fn parse_context_window_falls_back_to_max_tokens_when_context_window_is_absent() {
        let body = json!({"local_ai_wrapper": {"maxTokens": 32_000}});
        assert_eq!(parse_context_window(&body), Some(32_000));
    }

    #[test]
    fn parse_context_window_prefers_context_window_over_max_tokens() {
        let body = json!({"local_ai_wrapper": {"contextWindow": 200_000, "maxTokens": 8_000}});
        assert_eq!(parse_context_window(&body), Some(200_000));
    }

    #[test]
    fn parse_context_window_is_none_without_a_local_ai_wrapper_key() {
        // Every Model in `localAIWrapper`'s `models.json` before issue #97's
        // own config change — this is `resolve_context_window`'s real
        // fallback trigger today for any Model that hasn't been given a
        // `contextWindow` yet.
        let body = json!({"id": "codex-terra", "object": "model"});
        assert_eq!(parse_context_window(&body), None);
    }

    #[test]
    fn parse_context_window_is_none_for_a_zero_or_malformed_value() {
        assert_eq!(
            parse_context_window(&json!({"local_ai_wrapper": {"contextWindow": 0}})),
            None
        );
        assert_eq!(
            parse_context_window(&json!({"local_ai_wrapper": {"contextWindow": "a lot"}})),
            None
        );
        assert_eq!(parse_context_window(&json!({"local_ai_wrapper": {}})), None);
    }

    // -- parse_usage (issue #97) ---------------------------------------------

    #[test]
    fn parse_usage_reads_prompt_and_completion_tokens() {
        let usage =
            json!({"prompt_tokens": 17_432, "completion_tokens": 214, "total_tokens": 17_646});
        assert_eq!(
            parse_usage(Some(&usage)),
            Some(Usage {
                prompt_tokens: 17_432,
                completion_tokens: 214
            })
        );
    }

    #[test]
    fn parse_usage_is_none_when_the_response_carries_no_usage_at_all() {
        // Absent must not read as zero — `should_compact`'s own callers
        // treat `None` as "estimate it," not as "this call was free."
        assert_eq!(parse_usage(None), None);
    }

    #[test]
    fn parse_usage_zero_on_both_fields_is_treated_as_absent_not_as_a_real_zero() {
        // A response that carries a `usage` object but reports 0/0 cannot be
        // an honest measurement of a real chat call that returned content —
        // this is "the field wasn't actually filled in," not "nothing was
        // spent," and must degrade the same way an absent `usage` does.
        let zero = json!({"prompt_tokens": 0, "completion_tokens": 0});
        assert_eq!(parse_usage(Some(&zero)), None);
    }

    #[test]
    fn parse_usage_one_nonzero_field_is_still_a_real_measurement() {
        // Only one side reporting non-zero (an endpoint that only fills in
        // `completion_tokens`, say) is still meaningfully different from
        // "nothing was reported at all" and must not be discarded the same
        // way a genuine 0/0 is.
        let one_sided = json!({"prompt_tokens": 0, "completion_tokens": 42});
        assert_eq!(
            parse_usage(Some(&one_sided)),
            Some(Usage {
                prompt_tokens: 0,
                completion_tokens: 42
            })
        );
    }

    #[test]
    fn parse_usage_malformed_fields_degrade_rather_than_panic() {
        let malformed = json!({"prompt_tokens": "a lot", "completion_tokens": null});
        assert_eq!(parse_usage(Some(&malformed)), None);

        let missing_completion = json!({"prompt_tokens": 500});
        assert_eq!(
            parse_usage(Some(&missing_completion)),
            Some(Usage {
                prompt_tokens: 500,
                completion_tokens: 0
            })
        );
    }
}
