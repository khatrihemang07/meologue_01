//! `GET /v1/models` (issue #96) — `src/models.rs`'s own doc comment covers
//! what this proxies and why it's gated on `ReflectState`. Matches
//! `llm.rs`'s own precedent (`fetch_context_window`'s doc comment) against
//! starting either configured service: `llm::parse_models_list`'s unit
//! tests already cover the parsing half against canned JSON, so what's left
//! to prove here is the wiring — the route's on/off switch, and that an
//! actually-unreachable wrapper (the documented state of the wrapper during
//! this ticket) degrades to an empty list rather than panicking or hanging
//! the request.

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Result;
use async_trait::async_trait;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use meologue_server::llm::{ChatMessage, ChatReply, LlmClient};
use meologue_server::reflect::ReflectState;
use serde_json::Value;
use sqlx::PgPool;
use tower::ServiceExt;

// Matches tests/reflect.rs's own convention: these tests never serve a
// static asset, so any existing directory works as the otherwise-unused
// static_dir.
fn empty_static_dir() -> PathBuf {
    std::env::current_dir().unwrap()
}

/// Never actually called by anything in this file — `models_handler` only
/// ever reaches `reflect.chat_base_url`/`chat_api_key` directly
/// (`llm::list_models`, not the `LlmClient` trait), so `ReflectState`'s
/// other two fields exist here only to satisfy its shape.
struct UnusedLlmClient;

#[async_trait]
impl LlmClient for UnusedLlmClient {
    async fn chat(&self, _messages: &[ChatMessage]) -> Result<ChatReply> {
        unimplemented!("models_handler never calls LlmClient::chat")
    }
    async fn embed_document(&self, _text: &str) -> Result<Vec<f32>> {
        unimplemented!("models_handler never calls LlmClient::embed_document")
    }
    async fn embed_query(&self, _text: &str) -> Result<Vec<f32>> {
        unimplemented!("models_handler never calls LlmClient::embed_query")
    }
}

fn reflect_state(chat_base_url: &str) -> ReflectState {
    ReflectState {
        chat_client: Arc::new(UnusedLlmClient),
        embed_client: Some(Arc::new(UnusedLlmClient)),
        context_window: 200_000,
        chat_base_url: chat_base_url.to_string(),
        chat_api_key: None,
        // Issue #98: `models_handler` never reads either of these — same
        // "exists only to satisfy the struct's shape" reasoning as every
        // other field on `reflect_state` here.
        chat_model: "codex-terra".to_string(),
        chat_streaming: false,
    }
}

async fn get_models(pool: &PgPool, reflect: Option<ReflectState>) -> (StatusCode, Value) {
    let app =
        meologue_server::router_with_reflection(pool.clone(), empty_static_dir(), None, reflect);
    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/v1/models")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let json = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap()
    };
    (status, json)
}

#[sqlx::test]
async fn the_route_is_absent_when_chat_is_unconfigured(pool: PgPool) {
    // No ReflectState at all — mirrors what main.rs builds when
    // MEOLOGUE_CHAT_BASE_URL/MEOLOGUE_CHAT_MODEL aren't set, exactly the
    // same gate `/v1/reflect` itself uses
    // (`the_route_is_absent_when_chat_is_unconfigured` in tests/reflect.rs).
    let (status, _) = get_models(&pool, None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

/// The wrapper is genuinely down during this ticket (per the environment
/// this was built against) — `127.0.0.1:1` stands in for exactly that: a
/// real address nothing is listening on, so the connection fails fast
/// rather than hanging on a timeout. This is the acceptance criterion
/// issue #96 states directly: "degrades sensibly when the wrapper is
/// unreachable ... must not panic or hang."
#[sqlx::test]
async fn an_unreachable_wrapper_degrades_to_an_empty_list(pool: PgPool) {
    let reflect = reflect_state("http://127.0.0.1:1");

    let (status, body) = get_models(&pool, Some(reflect)).await;

    assert_eq!(
        status,
        StatusCode::OK,
        "an unreachable wrapper must still be a clean 200 with an empty list, not a 5xx"
    );
    assert_eq!(body["models"], serde_json::json!([]));
}
