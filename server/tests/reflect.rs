use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use anyhow::Result;
use async_trait::async_trait;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use meologue_server::llm::{ChatMessage, LlmClient};
use meologue_server::reflect::ReflectState;
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

// These tests only ever hit /v1/reflect, never a static asset — any
// directory that exists is fine as the (otherwise unused) static_dir,
// matching tests/embedding.rs's own convention.
fn empty_static_dir() -> PathBuf {
    std::env::current_dir().unwrap()
}

/// A fake chat client that hands back a fixed Answer and records every
/// `chat()` call's messages, so a test can assert on what the route sent —
/// in particular, that prior turns actually reached the call (this ticket's
/// central requirement for follow-up Questions).
struct FakeChatClient {
    answer: String,
    calls: Mutex<Vec<Vec<ChatMessage>>>,
}

impl FakeChatClient {
    fn new(answer: impl Into<String>) -> Self {
        Self {
            answer: answer.into(),
            calls: Mutex::new(Vec::new()),
        }
    }

    fn last_call(&self) -> Vec<ChatMessage> {
        self.calls.lock().unwrap().last().cloned().expect("chat() was never called")
    }
}

#[async_trait]
impl LlmClient for FakeChatClient {
    async fn chat(&self, messages: &[ChatMessage]) -> Result<String> {
        self.calls.lock().unwrap().push(messages.to_vec());
        Ok(self.answer.clone())
    }

    async fn embed_document(&self, _text: &str) -> Result<Vec<f32>> {
        unimplemented!("this fake only ever plays the chat role in reflect.rs's tests")
    }

    async fn embed_query(&self, _text: &str) -> Result<Vec<f32>> {
        unimplemented!("this fake only ever plays the chat role in reflect.rs's tests")
    }
}

/// A fake embed client good for exactly one thing — turning a Question into
/// *some* deterministic vector, so `<=>` has something to sort by. The
/// vector's actual content doesn't matter to these tests: every seeded
/// Entry below gets the same embedding, so retrieval order is arbitrary but
/// retrieval *count* (up to the limit) is exactly what's asserted.
struct FakeEmbedClient;

#[async_trait]
impl LlmClient for FakeEmbedClient {
    async fn chat(&self, _messages: &[ChatMessage]) -> Result<String> {
        unimplemented!("this fake only ever plays the embed role in reflect.rs's tests")
    }

    async fn embed_document(&self, _text: &str) -> Result<Vec<f32>> {
        unimplemented!("this fake only ever plays the embed role in reflect.rs's tests")
    }

    async fn embed_query(&self, _text: &str) -> Result<Vec<f32>> {
        Ok(vec![0.1_f32; 640])
    }
}

/// The same pgvector text-literal format `embedding.rs::vector_literal`
/// writes in production — duplicated here (rather than exposed as a public
/// production API just for tests) because a test seeding Entries directly
/// into Postgres is standing in for what the embedding worker would
/// normally have already done.
fn test_vector_literal(vector: &[f32]) -> String {
    let joined = vector.iter().map(|v| v.to_string()).collect::<Vec<_>>().join(",");
    format!("[{joined}]")
}

async fn insert_embedded_entry(pool: &PgPool, id: Uuid, device_id: Uuid, body: &str, created_at: &str) {
    // The same vector `FakeEmbedClient::embed_query` returns, so these
    // Entries sit at cosine similarity 1.0 to every Question and clear
    // `MIN_SIMILARITY` comfortably — these tests are about retrieval count
    // and prompt shape, not about the relevance floor.
    insert_embedded_entry_with_vector(pool, id, device_id, body, created_at, &[0.1_f32; 640]).await;
}

async fn insert_embedded_entry_with_vector(
    pool: &PgPool,
    id: Uuid,
    device_id: Uuid,
    body: &str,
    created_at: &str,
    vector: &[f32],
) {
    sqlx::query(
        "insert into entries (id, device_id, body, created_at, embedding, embedding_model)
         values ($1, $2, $3, $4::timestamptz, $5::vector, 'fake-embed-model')",
    )
    .bind(id)
    .bind(device_id)
    .bind(body)
    .bind(created_at)
    .bind(test_vector_literal(vector))
    .execute(pool)
    .await
    .unwrap();
}

/// A vector orthogonal to `FakeEmbedClient`'s query vector: half the
/// dimensions positive, half negative, so the dot product is exactly zero
/// and cosine similarity is 0.0 — far below `MIN_SIMILARITY`.
fn orthogonal_vector() -> Vec<f32> {
    (0..640).map(|i| if i < 320 { 0.1 } else { -0.1 }).collect()
}

async fn post_reflect(pool: &PgPool, reflect: Option<ReflectState>, body: Value) -> (StatusCode, Value) {
    let app = meologue_server::router_with_reflection(pool.clone(), empty_static_dir(), None, reflect);
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/reflect")
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
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

fn reflect_state(chat: Arc<FakeChatClient>) -> ReflectState {
    ReflectState {
        chat_client: chat,
        embed_client: Arc::new(FakeEmbedClient),
    }
}

#[sqlx::test]
async fn an_answer_comes_back_with_the_grounding_ids_retrieval_found(pool: PgPool) {
    let device = Uuid::new_v4();
    let entry_a = Uuid::new_v4();
    let entry_b = Uuid::new_v4();
    insert_embedded_entry(&pool, entry_a, device, "my knee has been hurting since February", "2026-02-10T00:00:00Z")
        .await;
    insert_embedded_entry(&pool, entry_b, device, "the knee is finally feeling better", "2026-08-01T00:00:00Z")
        .await;

    let chat = Arc::new(FakeChatClient::new("Your knee has improved since February."));
    let reflect = reflect_state(chat.clone());

    let (status, body) = post_reflect(
        &pool,
        Some(reflect),
        json!({
            "protocol_version": 1,
            "question": "How has my knee been this year?",
            "prior_turns": [],
        }),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["answer"], "Your knee has improved since February.");
    assert_eq!(body["grounded"], true);

    let grounding_ids: Vec<Uuid> =
        serde_json::from_value(body["grounding_entry_ids"].clone()).unwrap();
    assert_eq!(grounding_ids.len(), 2);
    assert!(grounding_ids.contains(&entry_a));
    assert!(grounding_ids.contains(&entry_b));
}

#[sqlx::test]
async fn a_question_with_no_embedded_entries_is_reported_as_ungrounded(pool: PgPool) {
    // No Entries seeded at all — retrieval finds nothing to ground on.
    let chat = Arc::new(FakeChatClient::new("I don't have anything about that in your journal."));
    let reflect = reflect_state(chat.clone());

    let (status, body) = post_reflect(
        &pool,
        Some(reflect),
        json!({
            "protocol_version": 1,
            "question": "How has my knee been?",
            "prior_turns": [],
        }),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["grounded"], false);
    assert_eq!(body["grounding_entry_ids"], json!([]));
}

#[sqlx::test]
async fn prior_turns_reach_the_chat_call(pool: PgPool) {
    let device = Uuid::new_v4();
    insert_embedded_entry(
        &pool,
        Uuid::new_v4(),
        device,
        "started physical therapy today",
        "2026-03-01T00:00:00Z",
    )
    .await;

    let chat = Arc::new(FakeChatClient::new("Yes, it started in March."));
    let reflect = reflect_state(chat.clone());

    let (status, _) = post_reflect(
        &pool,
        Some(reflect),
        json!({
            "protocol_version": 1,
            "question": "Did it start with physical therapy?",
            "prior_turns": [
                { "question": "How has my knee been this year?", "answer": "It's been a recurring issue since February." },
            ],
        }),
    )
    .await;

    assert_eq!(status, StatusCode::OK);

    let sent = chat.last_call();
    let contents: Vec<&str> = sent.iter().map(|m| m.content.as_str()).collect();
    assert!(
        contents.contains(&"How has my knee been this year?"),
        "the prior Question should have reached the chat call: {contents:?}"
    );
    assert!(
        contents.contains(&"It's been a recurring issue since February."),
        "the prior Answer should have reached the chat call: {contents:?}"
    );
    assert!(
        contents.contains(&"Did it start with physical therapy?"),
        "the new Question should have reached the chat call: {contents:?}"
    );

    // The prior turn precedes the new Question, in order, matching "a
    // follow-up is read in the light of the Conversation before it."
    let prior_question_index = contents
        .iter()
        .position(|c| *c == "How has my knee been this year?")
        .unwrap();
    let new_question_index = contents
        .iter()
        .position(|c| *c == "Did it start with physical therapy?")
        .unwrap();
    assert!(prior_question_index < new_question_index);
}

#[sqlx::test]
async fn the_route_is_absent_when_chat_is_unconfigured(pool: PgPool) {
    // No ReflectState at all — mirrors what main.rs builds when
    // MEOLOGUE_CHAT_BASE_URL/MEOLOGUE_CHAT_MODEL aren't set.
    let (status, _) = post_reflect(
        &pool,
        None,
        json!({
            "protocol_version": 1,
            "question": "Anything?",
            "prior_turns": [],
        }),
    )
    .await;

    // A genuine 404 — not a 200 SPA-shell fallback, and not a synthetic
    // "not configured" body — so a client can tell "this Server predates
    // Reflection" apart from every other failure (ticket 4).
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[sqlx::test]
async fn an_unrecognised_protocol_version_is_rejected(pool: PgPool) {
    let chat = Arc::new(FakeChatClient::new("unused"));
    let reflect = reflect_state(chat);

    let (status, _) = post_reflect(
        &pool,
        Some(reflect),
        json!({
            "protocol_version": 99,
            "question": "Anything?",
            "prior_turns": [],
        }),
    )
    .await;

    assert_eq!(status, StatusCode::UPGRADE_REQUIRED);
}

/// The relevance floor is what makes "no Grounding" a state that can
/// actually happen. A nearest-neighbour search with only a `limit` returns
/// its full quota however unrelated the rows are, which would make
/// `grounded` true for every Question a non-empty History ever sees — and
/// CONTEXT.md requires an Answer with no Grounding behind it to say so
/// plainly, which it cannot do if there is never no Grounding.
#[sqlx::test]
async fn an_entry_below_the_similarity_floor_is_not_used_as_grounding(pool: PgPool) {
    let device_id = Uuid::new_v4();
    insert_embedded_entry_with_vector(
        &pool,
        Uuid::new_v4(),
        device_id,
        "Something the Question is not about at all.",
        "2026-03-01T09:00:00Z",
        &orthogonal_vector(),
    )
    .await;

    let chat = Arc::new(FakeChatClient::new("I couldn't find anything about that."));

    let (status, body) = post_reflect(
        &pool,
        Some(reflect_state(chat)),
        json!({ "protocol_version": 1, "question": "anything", "prior_turns": [] }),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body["grounding_entry_ids"].as_array().unwrap().len(),
        0,
        "an Entry at cosine 0.0 must not be handed to the model as Grounding"
    );
    assert_eq!(body["grounded"], json!(false));
}
