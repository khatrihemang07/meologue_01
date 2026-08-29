use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Result;
use async_trait::async_trait;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use meologue_server::llm::{ChatMessage, ChatReply, LlmClient};
use meologue_server::reflect::ReflectState;
use meologue_server::sync::PROTOCOL_VERSION;
use serde_json::Value;
use sqlx::PgPool;
use tower::ServiceExt;

// This test never hits /v1/sync, so any directory that exists is fine as the
// (otherwise unused) static_dir.
fn empty_static_dir() -> PathBuf {
    std::env::current_dir().unwrap()
}

// A pool that only ever parses its URL and never opens a connection — proves
// the handler answers without the database, rather than merely against a
// database that happens to be reachable in test (ticket 28).
fn unreachable_pool() -> PgPool {
    sqlx::postgres::PgPoolOptions::new()
        .connect_lazy("postgres://meologue:meologue@localhost:1/nonexistent")
        .unwrap()
}

async fn get_health(pool: &PgPool) -> (StatusCode, Value) {
    let app = meologue_server::router(pool.clone(), empty_static_dir());
    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/v1/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let json = serde_json::from_slice(&bytes).unwrap();
    (status, json)
}

/// Mirrors `tests/models.rs`'s own `UnusedLlmClient`: `health_handler` never
/// calls through a `ReflectState`'s clients at all, only reads whether they
/// exist (`reflect.is_some()`, `embed_client.is_some()`), so this only has
/// to satisfy `ReflectState`'s shape.
struct UnusedLlmClient;

#[async_trait]
impl LlmClient for UnusedLlmClient {
    async fn chat(&self, _messages: &[ChatMessage]) -> Result<ChatReply> {
        unimplemented!("health_handler never calls LlmClient::chat")
    }
    async fn embed_document(&self, _text: &str) -> Result<Vec<f32>> {
        unimplemented!("health_handler never calls LlmClient::embed_document")
    }
    async fn embed_query(&self, _text: &str) -> Result<Vec<f32>> {
        unimplemented!("health_handler never calls LlmClient::embed_query")
    }
}

fn chat_only_reflect_state() -> ReflectState {
    ReflectState {
        chat_client: Arc::new(UnusedLlmClient),
        embed_client: None,
        context_window: 200_000,
        chat_base_url: "http://unused.invalid".to_string(),
        chat_api_key: None,
        chat_model: "codex-terra".to_string(),
        chat_streaming: false,
    }
}

fn chat_and_embed_reflect_state() -> ReflectState {
    ReflectState {
        embed_client: Some(Arc::new(UnusedLlmClient)),
        ..chat_only_reflect_state()
    }
}

/// Builds the Router the same way `main.rs` does — `router_with_digests`
/// gated on exactly the `reflect`/`digests_enabled` values a real
/// `LlmConfig` would have produced — and reads back `/v1/health`'s
/// `capabilities` object.
async fn get_capabilities(
    pool: &PgPool,
    reflect: Option<ReflectState>,
    digests_enabled: bool,
) -> Value {
    let app = meologue_server::router_with_digests(
        pool.clone(),
        empty_static_dir(),
        None,
        reflect,
        digests_enabled,
    );
    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/v1/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let json: Value = serde_json::from_slice(&bytes).unwrap();
    json["capabilities"].clone()
}

#[tokio::test]
async fn it_answers_with_no_database_available() {
    let pool = unreachable_pool();

    let (status, body) = get_health(&pool).await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["protocol_version"], PROTOCOL_VERSION);
    assert!(body["service"].is_string());
}

#[tokio::test]
async fn it_never_rejects_on_protocol_version() {
    let pool = unreachable_pool();
    let app = meologue_server::router(pool, empty_static_dir());

    // Health has no request body to carry a claimed protocol_version at all —
    // its whole job is to let the caller learn the version and compare it
    // themselves, so there is nothing here that could gate on one.
    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/v1/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_ne!(response.status(), StatusCode::UPGRADE_REQUIRED);
    assert_eq!(response.status(), StatusCode::OK);
}

// Issue #133: `capabilities` must read exactly the config that decides
// route registration (`router_with_digests`'s own `reflect.is_some()` and
// `digests_enabled` checks), in each of the three configurations `main.rs`
// can actually produce. A mismatch here is exactly the drift the ticket
// exists to prevent — a Destination row locking (or not) based on a stale
// or approximated read of what the Server can serve.

#[tokio::test]
async fn it_reports_every_capability_off_when_unconfigured() {
    let pool = unreachable_pool();

    let capabilities = get_capabilities(&pool, None, false).await;

    assert_eq!(capabilities["reflect"], false);
    assert_eq!(capabilities["digest"], false);
    assert_eq!(capabilities["embeddings"], false);
}

#[tokio::test]
async fn it_reports_reflect_and_digest_on_with_no_embed_client() {
    let pool = unreachable_pool();

    // Issue #130: a chat-only Server still registers `/v1/reflect` (and,
    // independently, `/v1/digests/*` when its own worker config resolves)
    // — `reflect: true` here must not depend on `embeddings` also being
    // true.
    let capabilities = get_capabilities(&pool, Some(chat_only_reflect_state()), true).await;

    assert_eq!(capabilities["reflect"], true);
    assert_eq!(capabilities["digest"], true);
    assert_eq!(capabilities["embeddings"], false);
}

#[tokio::test]
async fn it_reports_embeddings_on_only_once_an_embed_client_resolved() {
    let pool = unreachable_pool();

    let capabilities = get_capabilities(&pool, Some(chat_and_embed_reflect_state()), false).await;

    assert_eq!(capabilities["reflect"], true);
    // `digests_enabled` is Digest's own switch (`LlmConfig::digest_worker_config`),
    // independent of Reflection's — a Server can have Reflection's embed
    // client resolved and still have no Digest worker running.
    assert_eq!(capabilities["digest"], false);
    assert_eq!(capabilities["embeddings"], true);
}
