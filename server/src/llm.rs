//! The seam between the server and whatever OpenAI-compatible endpoint is
//! configured for chat and embeddings. Nothing outside this module knows
//! whether it's talking to a real HTTP client or a test fake — see
//! `LlmClient` below, and ADR 0021 for why the server calls out to an LLM
//! at all.

use std::env;
use std::sync::Arc;

use anyhow::{Context, Result, bail};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use utoipa::ToSchema;

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

/// One increment of `LlmClient::chat_stream` — the `llm.rs`-level
/// counterpart of `harness::chat::StreamEvent`, one layer further from the
/// harness: this module has no dependency on `harness` for its types (see
/// `Usage`'s own doc comment for the same boundary drawn around token
/// accounting), so it names its own terminal/partial split rather than
/// reusing the harness's. `harness::prompted::PromptedToolClient` is the
/// one place that translates between the two.
#[derive(Debug)]
pub enum ChatStreamEvent {
    /// One chunk of reply text, in order, exactly as the endpoint sent it
    /// — never re-chunked or buffered beyond whatever one SSE frame
    /// carried.
    Delta(String),
    /// The stream has ended, successfully or not — the same `Result`
    /// shape `chat` itself returns, carrying the whole accumulated reply
    /// on success.
    Done(Result<ChatReply>),
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

    /// Issue #98: the same reply `chat` would return, delivered as it's
    /// generated rather than all at once. Defaults to calling `chat` once
    /// and reporting the whole reply as a single `Done` with no `Delta` in
    /// front of it — correct for every `LlmClient` written before this
    /// ticket (none of them has anything to stream), and for
    /// `OpenAiCompatibleClient` itself whenever the model behind it turns
    /// out not to support `stream: true` (see that impl's own override).
    /// `harness::prompted::PromptedToolClient` only ever calls this once
    /// it already knows, from `list_models` below, that the model it
    /// resolved for this Turn streams — this method is never used to
    /// *discover* that fact itself.
    async fn chat_stream(
        &self,
        messages: &[ChatMessage],
    ) -> mpsc::UnboundedReceiver<ChatStreamEvent> {
        let (tx, rx) = mpsc::unbounded_channel();
        let result = self.chat(messages).await;
        let _ = tx.send(ChatStreamEvent::Done(result));
        rx
    }

    /// Issue #98: the models this endpoint can currently reach — the same
    /// list `GET /v1/models` (`models::models_handler`) reports, reached
    /// through this trait rather than calling `llm::list_models` directly
    /// so `reflect.rs`'s own per-Turn model resolution can be exercised
    /// against a scripted `FakeChatClient` in tests, the same way every
    /// other model-facing behaviour in that test file already is, rather
    /// than needing a live (or mocked) wrapper to ask. Defaults to an
    /// empty list — correct for `embed_client` (never asked) and for any
    /// existing `LlmClient` test double that has no reason to script one.
    async fn list_models(&self) -> Vec<ModelInfo> {
        Vec::new()
    }

    /// Issue #98: a client scoped to `model` — the same endpoint this one
    /// already talks to, just bound to a different model id.
    /// `OpenAiCompatibleClient::for_model` rebuilds itself with the same
    /// `base_url`/`api_key`; `reflect.rs::resolve_model` is the only
    /// caller, reached through this trait (rather than reflect.rs
    /// constructing an `OpenAiCompatibleClient` directly) for the same
    /// reason `list_models` is: a test can override it to hand back a
    /// second scripted `LlmClient`, proving a chosen model's replies
    /// actually come from a client bound to that model, without a live (or
    /// mocked) wrapper. The default `unimplemented!`s — every `LlmClient`
    /// written before this ticket has no second model to be scoped to, and
    /// nothing but `resolve_model`'s own non-default branch ever calls
    /// this, so no existing implementation needs to override it.
    fn for_model(&self, model: &str) -> Arc<dyn LlmClient + Send + Sync> {
        unimplemented!("no per-model LlmClient available for {model}")
    }

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

    // Issue #98: the same three fields as `chat`'s own request, plus
    // `"stream": true` — this is what actually asks the wrapper to dribble
    // its reply rather than deliver it whole. Spawned rather than run
    // inline: `LlmClient::chat_stream`'s contract is to hand back a
    // receiver a caller can read progressively, not one that only starts
    // filling once this method itself has already finished, which is
    // exactly what awaiting the whole request here (as `chat` does) would
    // produce. `stream_chat_completion` does the actual reading and
    // forwarding; this method's only job is building the request and
    // spawning the task that drives it.
    async fn chat_stream(
        &self,
        messages: &[ChatMessage],
    ) -> mpsc::UnboundedReceiver<ChatStreamEvent> {
        let (tx, rx) = mpsc::unbounded_channel();
        let payload_messages: Vec<_> = messages
            .iter()
            .map(|m| json!({ "role": m.role, "content": m.content }))
            .collect();
        let request = self.authed(
            self.http
                .post(format!("{}/chat/completions", self.base_url))
                .json(&json!({
                    "model": self.model,
                    "messages": payload_messages,
                    "stream": true,
                })),
        );

        tokio::spawn(async move {
            let result = stream_chat_completion(request, &tx).await;
            let _ = tx.send(ChatStreamEvent::Done(result));
        });

        rx
    }

    // Issue #98: `reflect.rs`'s per-Turn model resolution reaches this
    // through the trait (see `LlmClient::list_models`'s own doc comment
    // for why) rather than calling the free function directly; this is
    // just that free function, reached through `self.base_url`/
    // `self.api_key` — `self.model` plays no part, since the wrapper's
    // model list isn't scoped to whichever one model this instance is
    // bound to.
    async fn list_models(&self) -> Vec<ModelInfo> {
        list_models(&self.base_url, self.api_key.as_deref()).await
    }

    fn for_model(&self, model: &str) -> Arc<dyn LlmClient + Send + Sync> {
        Arc::new(Self::new(
            self.base_url.clone(),
            model.to_string(),
            self.api_key.clone(),
        ))
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

/// The network half of `OpenAiCompatibleClient::chat_stream`: sends the
/// already-built streaming request, then reads the response body chunk by
/// chunk (`reqwest::Response::chunk`, which needs no extra Cargo feature —
/// unlike `bytes_stream`, this crate has no dependency on `futures` for
/// it), forwarding each `choices[0].delta.content` the moment its SSE
/// frame (`data: {...}\n\n`) is fully buffered.
///
/// `buffer` accumulates raw bytes across `chunk()` calls and only acts once
/// it finds the blank-line frame terminator — a chunk boundary from the
/// network has no reason to land on an SSE frame boundary, the same
/// tolerance `harness::prompted::ToolCallScanner` builds in for a
/// tool-call tag split across chunks, for the same reason. `[DONE]` (the
/// OpenAI-compatible sentinel, sent as its own frame) and any frame that
/// fails to parse as JSON are both skipped rather than treated as errors —
/// a stray non-JSON keep-alive frame must not fail a reply that is
/// otherwise streaming fine.
///
/// Returns the whole accumulated reply as an ordinary `ChatReply`, exactly
/// what `chat` itself would have returned for the same Conversation — the
/// only difference this function's caller sees is that the content also
/// arrived, piece by piece, on `tx` along the way.
async fn stream_chat_completion(
    request: reqwest::RequestBuilder,
    tx: &mpsc::UnboundedSender<ChatStreamEvent>,
) -> Result<ChatReply> {
    let response = request
        .send()
        .await
        .context("chat request failed to send")?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        bail!("chat request returned {status}: {body}");
    }

    let mut response = response;
    let mut buffer = String::new();
    let mut content = String::new();
    let mut usage = None;

    while let Some(chunk) = response
        .chunk()
        .await
        .context("reading a chat stream chunk failed")?
    {
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(pos) = buffer.find("\n\n") {
            let frame: String = buffer.drain(..pos + 2).collect();
            for line in frame.lines() {
                let Some(data) = line.strip_prefix("data:") else {
                    continue;
                };
                let data = data.trim();
                if data.is_empty() || data == "[DONE]" {
                    continue;
                }
                let Ok(parsed) = serde_json::from_str::<Value>(data) else {
                    continue;
                };
                if let Some(reported) = parse_usage(parsed.get("usage")) {
                    usage = Some(reported);
                }
                let delta = parsed
                    .get("choices")
                    .and_then(|choices| choices.get(0))
                    .and_then(|choice| choice.get("delta"))
                    .and_then(|delta| delta.get("content"))
                    .and_then(Value::as_str);
                if let Some(delta) = delta {
                    if !delta.is_empty() {
                        content.push_str(delta);
                        let _ = tx.send(ChatStreamEvent::Delta(delta.to_string()));
                    }
                }
            }
        }
    }

    Ok(ChatReply { content, usage })
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

/// The one HTTP GET both `fetch_context_window` (`GET /v1/models/{id}`,
/// ADR 0004 in `localAIWrapper`'s "retrieve" half) and `fetch_models`
/// (issue #96, the "list" half of that same ADR) need against the
/// configured wrapper: an optional bearer token, a non-2xx or a transport
/// failure both degrading to `None` rather than propagating an error either
/// caller would just have to unwrap the same way. Factored out so issue
/// #96 reuses this fetch rather than hand-rolling a second `reqwest::Client`
/// call side by side with the one `resolve_context_window` already made —
/// the two now differ only in which URL they ask and how they read the
/// body back out.
async fn get_json(url: &str, api_key: Option<&str>) -> Option<Value> {
    let client = reqwest::Client::new();
    let mut request = client.get(url);
    if let Some(key) = api_key {
        request = request.bearer_auth(key);
    }
    let response = request.send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    response.json().await.ok()
}

/// The network half of `LlmConfig::resolve_context_window` — split out so
/// the parsing half (`parse_context_window`) can be unit-tested against
/// canned JSON without a live `localAIWrapper` to ask, matching this
/// ticket's own constraint against starting either configured service.
/// `GET /v1/models/{id}` — ADR 0004 in `localAIWrapper`, the "retrieve"
/// half of the two model endpoints that ADR completed — over
/// `GET /v1/models` (list): this caller already knows exactly which one
/// Model it wants, so there is no reason to fetch and filter the whole
/// list. (`fetch_models`, below, is the caller that actually wants the
/// whole list — issue #96.)
async fn fetch_context_window(base_url: &str, model: &str, api_key: Option<&str>) -> Option<u32> {
    let body = get_json(&format!("{base_url}/models/{model}"), api_key).await?;
    parse_context_window(&body)
}

/// One Model the configured wrapper can serve — the subset of
/// `localAIWrapper`'s own `OpenAIModel.local_ai_wrapper`
/// (`discovery.ts::toOpenAIModel`) issue #96's `GET /v1/models` actually
/// needs to hand a client choosing a per-Session model (issue #98's own
/// feature; this ticket only wires the endpoint): which model to ask for,
/// whether it can stream — `streaming` is how a client tells "answer-token
/// deltas ride the same stream" apart from "on codex-terra they simply
/// don't arrive" (this module's own `ChatReply`, and
/// `harness::prompted::PromptedToolClient`'s doc comment, are the server
/// side of that same split) — and how much context it holds, the same
/// field `resolve_context_window` already reads for the *configured* model
/// alone (`parse_context_window`, reused here for every Model the wrapper
/// lists, not just that one).
#[derive(Debug, Clone, PartialEq, Serialize, ToSchema)]
pub struct ModelInfo {
    pub id: String,
    pub streaming: bool,
    pub context_window: Option<u32>,
}

/// The network half of `list_models`, split out the same way
/// `fetch_context_window` is — see that function's own doc comment, and
/// `parse_models_list`'s for the parsing half this hands canned JSON to in
/// tests.
async fn fetch_models(base_url: &str, api_key: Option<&str>) -> Option<Vec<ModelInfo>> {
    let body = get_json(&format!("{base_url}/models"), api_key).await?;
    Some(parse_models_list(&body))
}

/// Reads `localAIWrapper`'s `{"object": "list", "data": [OpenAIModel, ...]}`
/// (`discovery.ts::listOpenAIModels`) into `ModelInfo`s. Reuses
/// `parse_context_window` per-element — each entry of `data` is shaped
/// exactly like the single-Model body that function already reads off
/// `GET /v1/models/{id}`, so there is no second `contextWindow`/`maxTokens`
/// reader to keep in sync with the first. A `data` entry missing `id`
/// entirely, or not even a JSON object, is skipped rather than failing the
/// whole list — the same "one bad element must not cost every good one"
/// posture `parse_usage`'s own malformed-field handling already takes,
/// applied here to a list instead of a single object's fields.
fn parse_models_list(body: &Value) -> Vec<ModelInfo> {
    body.get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|model| {
            let id = model.get("id")?.as_str()?.to_string();
            let streaming = model
                .get("local_ai_wrapper")
                .and_then(|extras| extras.get("streaming"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let context_window = parse_context_window(model);
            Some(ModelInfo {
                id,
                streaming,
                context_window,
            })
        })
        .collect()
}

/// Issue #96: `GET /v1/models` (`models::models_handler`) proxies this.
/// Degrades to an empty `Vec` on any failure to reach the wrapper — a
/// non-2xx, a connection refused (the documented state of the wrapper as of
/// this ticket), an unparseable body — the same "unknown becomes the
/// conservative default" posture `resolve_context_window` already takes for
/// the single-Model case, applied here to the whole list: a client sees "no
/// models offered" rather than a hung or panicking request.
pub async fn list_models(base_url: &str, api_key: Option<&str>) -> Vec<ModelInfo> {
    match fetch_models(base_url, api_key).await {
        Some(models) => models,
        None => {
            tracing::warn!(
                base_url,
                "could not reach the configured chat wrapper to list its models"
            );
            Vec::new()
        }
    }
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
    use super::{
        ModelInfo, Usage, end_with_sentence_punctuation, parse_context_window,
        parse_models_list, parse_usage,
    };
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

    // -- parse_models_list (issue #96) ---------------------------------------
    //
    // Matches this ticket's own constraint against starting either
    // configured service (`fetch_context_window`'s own doc comment already
    // established the precedent for this module): tested against a canned
    // body shaped exactly like `localAIWrapper`'s real
    // `GET /v1/models` — `discovery.ts::listOpenAIModels` — never a live
    // wrapper.

    #[test]
    fn parse_models_list_reads_id_streaming_and_context_window() {
        let body = json!({
            "object": "list",
            "data": [
                {
                    "id": "codex-terra",
                    "object": "model",
                    "created": 1_700_000_000,
                    "owned_by": "codex",
                    "local_ai_wrapper": {
                        "backend": "codex",
                        "llm": "gpt-5-codex",
                        "transport": "cli",
                        "streaming": false,
                        "tools": false,
                        "options": ["model", "messages", "stream", "reasoning_effort"],
                        "contextWindow": 128_000,
                    },
                },
                {
                    "id": "claude-sonnet",
                    "object": "model",
                    "created": 1_700_000_000,
                    "owned_by": "claude",
                    "local_ai_wrapper": {
                        "backend": "claude",
                        "llm": "claude-sonnet-5",
                        "transport": "sdk",
                        "streaming": true,
                        "tools": false,
                        "options": ["model", "messages", "stream", "reasoning_effort"],
                    },
                },
            ],
        });

        assert_eq!(
            parse_models_list(&body),
            vec![
                ModelInfo {
                    id: "codex-terra".to_string(),
                    streaming: false,
                    context_window: Some(128_000),
                },
                ModelInfo {
                    id: "claude-sonnet".to_string(),
                    streaming: true,
                    // No `contextWindow`/`maxTokens` in this entry's own
                    // `local_ai_wrapper` — `None`, not a guessed default;
                    // that fallback belongs to `resolve_context_window`'s
                    // caller, not to this parse.
                    context_window: None,
                },
            ]
        );
    }

    #[test]
    fn parse_models_list_is_empty_for_a_missing_or_malformed_data_field() {
        assert_eq!(parse_models_list(&json!({"object": "list"})), Vec::new());
        assert_eq!(parse_models_list(&json!({"data": "not an array"})), Vec::new());
        assert_eq!(parse_models_list(&json!(null)), Vec::new());
    }

    #[test]
    fn parse_models_list_skips_an_entry_missing_an_id_without_failing_the_rest() {
        let body = json!({
            "data": [
                {"object": "model"},
                {"id": "codex-terra", "local_ai_wrapper": {"streaming": false}},
            ],
        });
        assert_eq!(
            parse_models_list(&body),
            vec![ModelInfo {
                id: "codex-terra".to_string(),
                streaming: false,
                context_window: None,
            }]
        );
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
