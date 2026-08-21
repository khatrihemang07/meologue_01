use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use anyhow::{Result, bail};
use async_trait::async_trait;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use chrono::{DateTime, Duration, Utc};
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

/// A fake chat client serving all three of `/v1/reflect`'s possible chat
/// calls: the extraction call (chat call 1), the answering call (chat call
/// 2, which now also carries the "GROUNDED: yes"/"GROUNDED: no" verdict —
/// ticket 6, `docs/adr/0024`), and the disclosed-fallback answering call
/// (chat call 3, only made after a "GROUNDED: no" verdict when recent
/// Entries exist). It tells them apart by content rather than by call
/// order — `extraction_system_prompt` always states "Today's date", which
/// nothing else does, and `FALLBACK_SYSTEM_INSTRUCTION` always states
/// "nothing matching the Question was found", which nothing else does
/// either — and every call is still recorded, so a test can assert on
/// exactly what each call sent.
///
/// Defaults (`FakeChatClient::new`) answer the extraction call with `"{}"`
/// — a clean, parseable "found nothing" response — so every test written
/// before ticket 5 that never mentions extraction keeps behaving exactly
/// as it did under ticket 4's single-retrieval flow. The default
/// `final_answer` carries no "GROUNDED:" marker, which (ticket 6) defaults
/// to `grounded: true` — so every pre-ticket-6 test that never mentions a
/// verdict also keeps behaving exactly as it did before.
struct FakeChatClient {
    extraction_response: Mutex<Result<String, String>>,
    final_answer: String,
    fallback_answer: String,
    calls: Mutex<Vec<Vec<ChatMessage>>>,
}

impl FakeChatClient {
    fn new(final_answer: impl Into<String>) -> Self {
        Self {
            extraction_response: Mutex::new(Ok("{}".to_string())),
            final_answer: final_answer.into(),
            fallback_answer: "Nothing matching the Question was found; here's what you've \
                              written lately."
                .to_string(),
            calls: Mutex::new(Vec::new()),
        }
    }

    fn with_extraction(
        final_answer: impl Into<String>,
        extraction_response: impl Into<String>,
    ) -> Self {
        Self {
            extraction_response: Mutex::new(Ok(extraction_response.into())),
            final_answer: final_answer.into(),
            fallback_answer: "Nothing matching the Question was found; here's what you've \
                              written lately."
                .to_string(),
            calls: Mutex::new(Vec::new()),
        }
    }

    fn with_extraction_error(final_answer: impl Into<String>) -> Self {
        Self {
            extraction_response: Mutex::new(
                Err("simulated 500 from the chat endpoint".to_string()),
            ),
            final_answer: final_answer.into(),
            fallback_answer: "Nothing matching the Question was found; here's what you've \
                              written lately."
                .to_string(),
            calls: Mutex::new(Vec::new()),
        }
    }

    /// Overrides the response the disclosed-fallback call (chat call 3)
    /// gets, for tests that want to assert on its exact wording. Chainable
    /// so it composes with any of the constructors above, e.g.
    /// `FakeChatClient::new(first_answer).with_fallback_answer(third_answer)`.
    fn with_fallback_answer(mut self, fallback_answer: impl Into<String>) -> Self {
        self.fallback_answer = fallback_answer.into();
        self
    }

    fn last_call(&self) -> Vec<ChatMessage> {
        self.calls
            .lock()
            .unwrap()
            .last()
            .cloned()
            .expect("chat() was never called")
    }

    fn extraction_call(&self) -> Vec<ChatMessage> {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .find(|call| is_extraction_call(call))
            .cloned()
            .expect("the extraction call was never made")
    }

    /// The disclosed-fallback call (chat call 3) — only made after a
    /// "GROUNDED: no" verdict with recent Entries to show.
    fn fallback_call(&self) -> Vec<ChatMessage> {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .find(|call| is_fallback_call(call))
            .cloned()
            .expect("the fallback call was never made")
    }

    fn call_count(&self) -> usize {
        self.calls.lock().unwrap().len()
    }
}

fn is_extraction_call(call: &[ChatMessage]) -> bool {
    call.first()
        .is_some_and(|m| m.content.contains("Today's date"))
}

/// The disclosed-fallback answering call is told apart from the ordinary
/// answering call by content, the same way `is_extraction_call` tells the
/// extraction call apart from everything else —
/// `FALLBACK_SYSTEM_INSTRUCTION` (`server/src/reflect.rs`) always states
/// "nothing matching the Question was found", which nothing else does.
fn is_fallback_call(call: &[ChatMessage]) -> bool {
    call.first().is_some_and(|m| {
        m.content
            .contains("nothing matching the Question was found")
    })
}

#[async_trait]
impl LlmClient for FakeChatClient {
    async fn chat(&self, messages: &[ChatMessage]) -> Result<String> {
        self.calls.lock().unwrap().push(messages.to_vec());
        if is_extraction_call(messages) {
            match &*self.extraction_response.lock().unwrap() {
                Ok(response) => Ok(response.clone()),
                Err(message) => bail!("{message}"),
            }
        } else if is_fallback_call(messages) {
            Ok(self.fallback_answer.clone())
        } else {
            Ok(self.final_answer.clone())
        }
    }

    async fn embed_document(&self, _text: &str) -> Result<Vec<f32>> {
        unimplemented!("this fake only ever plays the chat role in reflect.rs's tests")
    }

    async fn embed_query(&self, _text: &str) -> Result<Vec<f32>> {
        unimplemented!("this fake only ever plays the chat role in reflect.rs's tests")
    }
}

/// A fake embed client good for turning a query string into a deterministic
/// vector, so `<=>` has something to sort by. Every input gets
/// `default_vector` unless it exactly matches a registered override — that
/// default-everything-alike behaviour is what earlier tests (written before
/// keyword search existed) rely on: every seeded Entry sits at the same
/// vector as every Question, so retrieval order is arbitrary but retrieval
/// *count* is exactly what those tests assert on. Tests that need to tell
/// question-search and keyword-search apart register an override for the
/// exact keyword string the extraction response names.
struct FakeEmbedClient {
    default_vector: Vec<f32>,
    overrides: HashMap<String, Vec<f32>>,
    // Text that must fail `embed_query` outright, simulating a transient
    // embedding-endpoint error against a specific query string — used to
    // exercise the keyword/question retrieval failure paths in
    // `run_reflect` without touching every call the fake serves.
    failures: std::collections::HashSet<String>,
    // Every text `embed_query` was asked to embed, in call order — lets a
    // test assert on the *exact string* that reached the embed client, not
    // just on what vector came back. Needed for asserting the keyword
    // search embeds the keyword wrapped as a question (`keyword_query` in
    // `reflect.rs`) rather than the bare extracted word.
    calls: Mutex<Vec<String>>,
}

impl FakeEmbedClient {
    fn new() -> Self {
        Self {
            default_vector: vec![0.1_f32; 640],
            overrides: HashMap::new(),
            failures: std::collections::HashSet::new(),
            calls: Mutex::new(Vec::new()),
        }
    }

    fn with_override(mut self, text: impl Into<String>, vector: Vec<f32>) -> Self {
        self.overrides.insert(text.into(), vector);
        self
    }

    /// Makes `embed_query` return an `Err` when asked to embed exactly
    /// `text`, rather than a vector — for exercising a retrieval source's
    /// own failure path.
    fn with_failure(mut self, text: impl Into<String>) -> Self {
        self.failures.insert(text.into());
        self
    }

    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }
}

#[async_trait]
impl LlmClient for FakeEmbedClient {
    async fn chat(&self, _messages: &[ChatMessage]) -> Result<String> {
        unimplemented!("this fake only ever plays the embed role in reflect.rs's tests")
    }

    async fn embed_document(&self, _text: &str) -> Result<Vec<f32>> {
        unimplemented!("this fake only ever plays the embed role in reflect.rs's tests")
    }

    async fn embed_query(&self, text: &str) -> Result<Vec<f32>> {
        self.calls.lock().unwrap().push(text.to_string());
        if self.failures.contains(text) {
            bail!("simulated embed_query failure for {text:?}");
        }
        Ok(self
            .overrides
            .get(text)
            .cloned()
            .unwrap_or_else(|| self.default_vector.clone()))
    }
}

/// The same pgvector text-literal format `embedding.rs::vector_literal`
/// writes in production — duplicated here (rather than exposed as a public
/// production API just for tests) because a test seeding Entries directly
/// into Postgres is standing in for what the embedding worker would
/// normally have already done.
fn test_vector_literal(vector: &[f32]) -> String {
    let joined = vector
        .iter()
        .map(|v| v.to_string())
        .collect::<Vec<_>>()
        .join(",");
    format!("[{joined}]")
}

async fn insert_embedded_entry(
    pool: &PgPool,
    id: Uuid,
    device_id: Uuid,
    body: &str,
    created_at: &str,
) {
    // The same vector `FakeEmbedClient`'s default returns, so these Entries
    // sit at cosine similarity 1.0 to a Question embedded with the default
    // and clear `MIN_SIMILARITY` comfortably — these tests are about
    // retrieval count and prompt shape, not about the relevance floor.
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

/// A vector orthogonal to `FakeEmbedClient`'s default query vector: half
/// the dimensions positive, half negative, so the dot product is exactly
/// zero and cosine similarity is 0.0 — far below `MIN_SIMILARITY`. Used for
/// Entries that must be invisible to question-search and reachable only
/// through `retrieve_range` or a keyword override.
fn orthogonal_vector() -> Vec<f32> {
    (0..640).map(|i| if i < 320 { 0.1 } else { -0.1 }).collect()
}

async fn post_reflect(
    pool: &PgPool,
    reflect: Option<ReflectState>,
    body: Value,
) -> (StatusCode, Value) {
    let app =
        meologue_server::router_with_reflection(pool.clone(), empty_static_dir(), None, reflect);
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
        embed_client: Arc::new(FakeEmbedClient::new()),
    }
}

fn reflect_state_with_embed(
    chat: Arc<FakeChatClient>,
    embed: Arc<FakeEmbedClient>,
) -> ReflectState {
    ReflectState {
        chat_client: chat,
        embed_client: embed,
    }
}

fn grounding_ids(body: &Value) -> Vec<Uuid> {
    serde_json::from_value(body["grounding_entry_ids"].clone()).unwrap()
}

fn session_id(body: &Value) -> Uuid {
    serde_json::from_value(body["session_id"].clone()).unwrap()
}

async fn insert_session(pool: &PgPool, session_id: Uuid, title: &str) {
    sqlx::query("insert into sessions (id, title) values ($1, $2)")
        .bind(session_id)
        .bind(title)
        .execute(pool)
        .await
        .unwrap();
}

/// Appends one already-answered Turn to a Session that already exists
/// (`insert_session`), directly via SQL — standing in for what
/// `sessions::record_turn` would already have done on an earlier ask, the
/// same way `insert_embedded_entry` stands in for the embedding worker.
/// `seq` is `bigserial` (`migrations/0003_create_sessions.sql`), so calls
/// made in order get increasing `seq` values, which is all `load_turns`'s
/// `order by seq asc` needs.
async fn insert_turn(pool: &PgPool, session_id: Uuid, question: &str, answer: &str) {
    sqlx::query(
        "insert into session_turns
            (id, session_id, question, answer, grounding_entry_ids, grounded, fallback_used)
         values ($1, $2, $3, $4, '{}', true, false)",
    )
    .bind(Uuid::new_v4())
    .bind(session_id)
    .bind(question)
    .bind(answer)
    .execute(pool)
    .await
    .unwrap();
}

/// Seeds a Session with exactly one already-answered Turn.
async fn insert_session_with_turn(pool: &PgPool, session_id: Uuid, question: &str, answer: &str) {
    insert_session(pool, session_id, question).await;
    insert_turn(pool, session_id, question, answer).await;
}

/// Seeds a Session with `count` already-answered Turns, each distinctly
/// worded ("turn 0 question"/"turn 0 answer", "turn 1 question"/... in
/// insertion — and so `seq` — order) so a test can assert on exactly which
/// ones reached a chat call after `CONVERSATION_WINDOW` truncation, the
/// same way `insert_session_with_turn` stands in for a single earlier ask.
async fn insert_session_with_turns(pool: &PgPool, session_id: Uuid, count: usize) {
    insert_session(pool, session_id, "many turns").await;
    for n in 0..count {
        insert_turn(
            pool,
            session_id,
            &format!("turn {n} question"),
            &format!("turn {n} answer"),
        )
        .await;
    }
}

async fn session_count(pool: &PgPool) -> i64 {
    sqlx::query_scalar("select count(*) from sessions")
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn turn_count(pool: &PgPool) -> i64 {
    sqlx::query_scalar("select count(*) from session_turns")
        .fetch_one(pool)
        .await
        .unwrap()
}

#[sqlx::test]
async fn an_answer_comes_back_with_the_grounding_ids_retrieval_found(pool: PgPool) {
    let device = Uuid::new_v4();
    let entry_a = Uuid::new_v4();
    let entry_b = Uuid::new_v4();
    insert_embedded_entry(
        &pool,
        entry_a,
        device,
        "my knee has been hurting since February",
        "2026-02-10T00:00:00Z",
    )
    .await;
    insert_embedded_entry(
        &pool,
        entry_b,
        device,
        "the knee is finally feeling better",
        "2026-08-01T00:00:00Z",
    )
    .await;

    let chat = Arc::new(FakeChatClient::new(
        "Your knee has improved since February.",
    ));
    let reflect = reflect_state(chat.clone());

    let (status, body) = post_reflect(
        &pool,
        Some(reflect),
        json!({
            "protocol_version": 2,
            "question": "How has my knee been this year?",
        }),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["answer"], "Your knee has improved since February.");
    assert_eq!(body["grounded"], true);

    let grounding_ids = grounding_ids(&body);
    assert_eq!(grounding_ids.len(), 2);
    assert!(grounding_ids.contains(&entry_a));
    assert!(grounding_ids.contains(&entry_b));
}

#[sqlx::test]
async fn a_question_with_no_embedded_entries_is_reported_as_ungrounded(pool: PgPool) {
    // No Entries seeded at all — retrieval finds nothing to ground on, and
    // (ticket 6) the chat call's own verdict says as much.
    let chat = Arc::new(FakeChatClient::new(
        "GROUNDED: no\nI don't have anything about that in your journal.",
    ));
    let reflect = reflect_state(chat.clone());

    let (status, body) = post_reflect(
        &pool,
        Some(reflect),
        json!({
            "protocol_version": 2,
            "question": "How has my knee been?",
        }),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["grounded"], false);
    assert_eq!(body["grounding_entry_ids"], json!([]));
    // No Entries anywhere in the History — including nothing in the last 3
    // days — so the disclosed fallback finds nothing either.
    assert_eq!(body["fallback_used"], false);
}

/// The Conversation this Question follows lives entirely in `session_turns`
/// now: the client sends only a `session_id`, and the Server loads what was
/// already asked. Seeding a Session with a Turn directly, the way
/// `insert_embedded_entry` seeds an Entry, stands in for an earlier
/// successful ask on that same Session.
#[sqlx::test]
async fn a_sessions_conversation_reaches_the_chat_call(pool: PgPool) {
    let device = Uuid::new_v4();
    insert_embedded_entry(
        &pool,
        Uuid::new_v4(),
        device,
        "started physical therapy today",
        "2026-03-01T00:00:00Z",
    )
    .await;

    let session_id = Uuid::new_v4();
    insert_session_with_turn(
        &pool,
        session_id,
        "How has my knee been this year?",
        "It's been a recurring issue since February.",
    )
    .await;

    let chat = Arc::new(FakeChatClient::new("Yes, it started in March."));
    let reflect = reflect_state(chat.clone());

    let (status, _) = post_reflect(
        &pool,
        Some(reflect),
        json!({
            "protocol_version": 2,
            "question": "Did it start with physical therapy?",
            "session_id": session_id,
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

/// `CONVERSATION_WINDOW` (`server/src/reflect.rs`) caps what's replayed
/// into the answering chat call at the 10 most recent Turns — a Session
/// that has grown past that must not hand the whole Conversation to the
/// call, only the tail of it.
#[sqlx::test]
async fn a_session_with_more_than_ten_turns_replays_only_the_ten_most_recent(pool: PgPool) {
    let session_id = Uuid::new_v4();
    insert_session_with_turns(&pool, session_id, 15).await;

    let chat = Arc::new(FakeChatClient::new("Here's what I found."));

    let (status, _) = post_reflect(
        &pool,
        Some(reflect_state(chat.clone())),
        json!({
            "protocol_version": 2,
            "question": "Anything new to add?",
            "session_id": session_id,
        }),
    )
    .await;

    assert_eq!(status, StatusCode::OK);

    let sent = chat.last_call();
    let contents: Vec<&str> = sent.iter().map(|m| m.content.as_str()).collect();

    // Turns 5 through 14 are the 10 most recent of the 15 seeded (0..14) —
    // these must all have reached the call.
    for n in 5..15 {
        assert!(
            contents.contains(&format!("turn {n} question").as_str()),
            "turn {n} question should have reached the chat call: {contents:?}"
        );
        assert!(
            contents.contains(&format!("turn {n} answer").as_str()),
            "turn {n} answer should have reached the chat call: {contents:?}"
        );
    }

    // Turns 0 through 4 are older than the 10-Turn window — they must have
    // been dropped, not just crowded out of `last_call`.
    for n in 0..5 {
        assert!(
            !contents.contains(&format!("turn {n} question").as_str()),
            "turn {n} question is outside CONVERSATION_WINDOW and should not have reached the \
             chat call: {contents:?}"
        );
        assert!(
            !contents.contains(&format!("turn {n} answer").as_str()),
            "turn {n} answer is outside CONVERSATION_WINDOW and should not have reached the \
             chat call: {contents:?}"
        );
    }
}

/// The 10 Turns that survive the `CONVERSATION_WINDOW` cap must still reach
/// the chat call oldest-first — the cap drops the oldest Turns, it does not
/// reorder the ones that remain.
#[sqlx::test]
async fn replayed_turns_stay_oldest_first_after_the_window_is_applied(pool: PgPool) {
    let session_id = Uuid::new_v4();
    insert_session_with_turns(&pool, session_id, 15).await;

    let chat = Arc::new(FakeChatClient::new("Here's what I found."));

    let (status, _) = post_reflect(
        &pool,
        Some(reflect_state(chat.clone())),
        json!({
            "protocol_version": 2,
            "question": "Anything new to add?",
            "session_id": session_id,
        }),
    )
    .await;

    assert_eq!(status, StatusCode::OK);

    let sent = chat.last_call();
    let contents: Vec<&str> = sent.iter().map(|m| m.content.as_str()).collect();

    let earlier_index = contents
        .iter()
        .position(|c| *c == "turn 5 question")
        .expect("turn 5 question should be inside the window");
    let later_index = contents
        .iter()
        .position(|c| *c == "turn 14 question")
        .expect("turn 14 question should be inside the window");
    assert!(
        earlier_index < later_index,
        "turn 5 was asked before turn 14 and must still precede it after windowing: {contents:?}"
    );
}

/// A Session at or under the cap must replay every Turn it has, exactly as
/// it did before `CONVERSATION_WINDOW` existed.
#[sqlx::test]
async fn a_session_with_ten_or_fewer_turns_replays_all_of_them(pool: PgPool) {
    let session_id = Uuid::new_v4();
    insert_session_with_turns(&pool, session_id, 4).await;

    let chat = Arc::new(FakeChatClient::new("Here's what I found."));

    let (status, _) = post_reflect(
        &pool,
        Some(reflect_state(chat.clone())),
        json!({
            "protocol_version": 2,
            "question": "Anything new to add?",
            "session_id": session_id,
        }),
    )
    .await;

    assert_eq!(status, StatusCode::OK);

    let sent = chat.last_call();
    let contents: Vec<&str> = sent.iter().map(|m| m.content.as_str()).collect();
    for n in 0..4 {
        assert!(
            contents.contains(&format!("turn {n} question").as_str()),
            "turn {n} question should have reached the chat call: {contents:?}"
        );
        assert!(
            contents.contains(&format!("turn {n} answer").as_str()),
            "turn {n} answer should have reached the chat call: {contents:?}"
        );
    }
}

/// The disclosed-fallback call (`docs/adr/0024`) is a *different* chat call
/// from the main answering call, built by the same `build_messages` off the
/// same `prior_turns` — it must be capped by the same `CONVERSATION_WINDOW`,
/// not the whole Conversation.
#[sqlx::test]
async fn the_disclosed_fallback_call_gets_the_same_conversation_window(pool: PgPool) {
    let device = Uuid::new_v4();
    let now = Utc::now();
    insert_embedded_entry_with_vector(
        &pool,
        Uuid::new_v4(),
        device,
        "went for a run today",
        &(now - Duration::hours(2)).to_rfc3339(),
        &orthogonal_vector(),
    )
    .await;

    let session_id = Uuid::new_v4();
    insert_session_with_turns(&pool, session_id, 15).await;

    let chat = Arc::new(
        FakeChatClient::new("GROUNDED: no\nI couldn't find anything about scuba diving.")
            .with_fallback_answer("Nothing matching the Question was found; you went for a run."),
    );

    let (status, body) = post_reflect(
        &pool,
        Some(reflect_state(chat.clone())),
        json!({
            "protocol_version": 2,
            "question": "Have I written anything about scuba diving in Portugal?",
            "session_id": session_id,
        }),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["fallback_used"], true);

    let fallback_call = chat.fallback_call();
    let contents: Vec<&str> = fallback_call.iter().map(|m| m.content.as_str()).collect();

    for n in 5..15 {
        assert!(
            contents.contains(&format!("turn {n} question").as_str()),
            "turn {n} question should have reached the fallback call: {contents:?}"
        );
    }
    for n in 0..5 {
        assert!(
            !contents.contains(&format!("turn {n} question").as_str()),
            "turn {n} question is outside CONVERSATION_WINDOW and should not have reached the \
             fallback call: {contents:?}"
        );
    }
}

/// `sessions::load_turns` is shared between `run_reflect`'s replay (capped
/// at `CONVERSATION_WINDOW`) and `GET /v1/sessions/{id}` (which must render
/// a whole Conversation regardless of length) — the regression guard for
/// the shared-function hazard `CONVERSATION_WINDOW`'s own doc comment
/// names. A user reopening an over-cap Session must still see every Turn.
#[sqlx::test]
async fn get_session_still_returns_every_turn_of_an_over_cap_session(pool: PgPool) {
    let session_id = Uuid::new_v4();
    insert_session_with_turns(&pool, session_id, 15).await;

    let chat = Arc::new(FakeChatClient::new("unused"));
    let app = meologue_server::router_with_reflection(
        pool.clone(),
        empty_static_dir(),
        None,
        Some(reflect_state(chat)),
    );
    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/v1/sessions/{session_id}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let body: Value = serde_json::from_slice(&bytes).unwrap();
    let turns = body["turns"]
        .as_array()
        .expect("SessionResponse::turns should be a JSON array");
    assert_eq!(
        turns.len(),
        15,
        "GET /v1/sessions/{{id}} must return every Turn, not just the CONVERSATION_WINDOW replay \
         cap: {turns:?}"
    );
}

#[sqlx::test]
async fn the_route_is_absent_when_chat_is_unconfigured(pool: PgPool) {
    // No ReflectState at all — mirrors what main.rs builds when
    // MEOLOGUE_CHAT_BASE_URL/MEOLOGUE_CHAT_MODEL aren't set.
    let (status, _) = post_reflect(
        &pool,
        None,
        json!({
            "protocol_version": 2,
            "question": "Anything?",
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

    let chat = Arc::new(FakeChatClient::new(
        "GROUNDED: no\nI couldn't find anything about that.",
    ));

    let (status, body) = post_reflect(
        &pool,
        Some(reflect_state(chat)),
        json!({ "protocol_version": 2, "question": "anything" }),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body["grounding_entry_ids"].as_array().unwrap().len(),
        0,
        "an Entry at cosine 0.0 must not be handed to the model as Grounding"
    );
    assert_eq!(body["grounded"], json!(false));
    // The seeded Entry is dated 2026-03-01 — well outside the 3-day
    // fallback window from "now" — so the disclosed fallback finds nothing
    // either.
    assert_eq!(body["fallback_used"], json!(false));
}

// ---------------------------------------------------------------------
// Ticket 5 — the three-source fan-out (docs/adr/0023)
// ---------------------------------------------------------------------

/// Extraction finding a date range widens Grounding to Entries the
/// Question's own vector search would never have found — the whole point
/// of `retrieve_range`. The seeded Entry's vector is orthogonal to the
/// Question's, so it can only have arrived via the date-range retriever.
#[sqlx::test]
async fn a_date_range_extraction_grounds_entries_orthogonal_to_the_question(pool: PgPool) {
    let device = Uuid::new_v4();
    let in_range = Uuid::new_v4();
    insert_embedded_entry_with_vector(
        &pool,
        in_range,
        device,
        "packed the last box for the move",
        "2026-08-05T12:00:00Z",
        &orthogonal_vector(),
    )
    .await;

    let chat = Arc::new(FakeChatClient::with_extraction(
        "You packed the last box on August 5th.",
        r#"{"date_range": {"from": "2026-08-01", "to": "2026-08-10"}, "keyword": null}"#,
    ));

    let (status, body) = post_reflect(
        &pool,
        Some(reflect_state(chat)),
        json!({
            "protocol_version": 2,
            "question": "What happened with the move?",
            "utc_offset_minutes": 0,
        }),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["grounded"], true);
    assert!(grounding_ids(&body).contains(&in_range));
}

/// Extraction finding a keyword runs a *second* vector search — an Entry
/// only that keyword's embedding is close to (and not the Question's own)
/// must still show up in Grounding.
#[sqlx::test]
async fn a_keyword_extraction_grounds_an_entry_only_the_keyword_search_finds(pool: PgPool) {
    let device = Uuid::new_v4();
    let keyword_only = Uuid::new_v4();
    insert_embedded_entry_with_vector(
        &pool,
        keyword_only,
        device,
        "the flat move is finally done",
        "2026-05-01T00:00:00Z",
        &orthogonal_vector(),
    )
    .await;

    let chat = Arc::new(FakeChatClient::with_extraction(
        "The move went well.",
        r#"{"date_range": null, "keyword": "moving flat"}"#,
    ));
    // The override key is the *wrapped* form — `keyword_query`'s doc
    // comment on the production side — not the bare extracted keyword, so
    // this test also exercises that the keyword search actually embeds the
    // wrapped question rather than "moving flat" on its own.
    let embed = Arc::new(
        FakeEmbedClient::new()
            .with_override("What did I write about moving flat?", orthogonal_vector()),
    );
    let reflect = reflect_state_with_embed(chat, embed.clone());

    let (status, body) = post_reflect(
        &pool,
        Some(reflect),
        json!({
            "protocol_version": 2,
            "question": "how did the move go",
        }),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["grounded"], true);
    assert!(grounding_ids(&body).contains(&keyword_only));

    let calls = embed.calls();
    assert!(
        calls.contains(&"What did I write about moving flat?".to_string()),
        "keyword search should embed the keyword wrapped as a question: {calls:?}"
    );
    assert!(
        !calls.contains(&"moving flat".to_string()),
        "keyword search must not embed the bare keyword: {calls:?}"
    );
}

/// Junk, non-JSON, or an outright error from the extraction call must never
/// fail the Question — it degrades to question-only retrieval, exactly
/// ticket 4's behaviour.
#[sqlx::test]
async fn junk_extraction_output_still_answers_with_question_only_retrieval(pool: PgPool) {
    let device = Uuid::new_v4();
    let entry = Uuid::new_v4();
    insert_embedded_entry(
        &pool,
        entry,
        device,
        "the knee is better now",
        "2026-06-01T00:00:00Z",
    )
    .await;

    let chat = Arc::new(FakeChatClient::with_extraction(
        "Your knee has improved.",
        "Sorry, I don't understand the request.",
    ));

    let (status, body) = post_reflect(
        &pool,
        Some(reflect_state(chat)),
        json!({ "protocol_version": 2, "question": "How's my knee?" }),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["answer"], "Your knee has improved.");
    assert!(grounding_ids(&body).contains(&entry));
}

/// Same, but the extraction call itself errors outright (the endpoint the
/// chat client talks to returned, say, a 500) — the Question still gets an
/// Answer, from question-only retrieval.
#[sqlx::test]
async fn an_extraction_call_error_still_answers_with_question_only_retrieval(pool: PgPool) {
    let device = Uuid::new_v4();
    let entry = Uuid::new_v4();
    insert_embedded_entry(
        &pool,
        entry,
        device,
        "the knee is better now",
        "2026-06-01T00:00:00Z",
    )
    .await;

    let chat = Arc::new(FakeChatClient::with_extraction_error(
        "Your knee has improved.",
    ));

    let (status, body) = post_reflect(
        &pool,
        Some(reflect_state(chat)),
        json!({ "protocol_version": 2, "question": "How's my knee?" }),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["answer"], "Your knee has improved.");
    assert!(grounding_ids(&body).contains(&entry));
}

// ---------------------------------------------------------------------
// Issue #66 — the extraction call sees the recent Conversation too
// ---------------------------------------------------------------------

/// The whole point of this ticket: a follow-up like "and the week before
/// that?" has no antecedent for "that" unless the extraction call reads
/// the Conversation it follows, not just its own bare text. The earlier
/// Question and Answer must both reach the extraction call's prompt.
#[sqlx::test]
async fn the_extraction_call_receives_the_prior_conversation(pool: PgPool) {
    let session_id = Uuid::new_v4();
    insert_session_with_turn(
        &pool,
        session_id,
        "How has my knee been in June?",
        "Your knee improved steadily through June.",
    )
    .await;

    let chat = Arc::new(FakeChatClient::new("Here's the week before that."));

    let (status, _) = post_reflect(
        &pool,
        Some(reflect_state(chat.clone())),
        json!({
            "protocol_version": 2,
            "question": "and the week before that?",
            "session_id": session_id,
        }),
    )
    .await;

    assert_eq!(status, StatusCode::OK);

    let extraction_call = chat.extraction_call();
    let system_content = &extraction_call[0].content;
    assert!(
        system_content.contains("How has my knee been in June?"),
        "extraction prompt should carry the earlier Question: {system_content}"
    );
    assert!(
        system_content.contains("Your knee improved steadily through June."),
        "extraction prompt should carry the earlier Answer: {system_content}"
    );
}

/// A first Question in a fresh Session (no `session_id` at all, so no prior
/// Turns exist) must produce an extraction call with no Conversation folded
/// into it, and extraction must still work exactly as it did before this
/// ticket — reaching all the way through to the keyword search.
#[sqlx::test]
async fn a_first_question_in_a_fresh_session_has_no_conversation_in_extraction(pool: PgPool) {
    let chat = Arc::new(FakeChatClient::with_extraction(
        "Found it.",
        r#"{"date_range": null, "keyword": "wedding"}"#,
    ));
    let embed = Arc::new(FakeEmbedClient::new());
    let reflect = reflect_state_with_embed(chat.clone(), embed.clone());

    let (status, _) = post_reflect(
        &pool,
        Some(reflect),
        json!({
            "protocol_version": 2,
            "question": "Tell me about the wedding",
        }),
    )
    .await;

    assert_eq!(status, StatusCode::OK);

    let extraction_call = chat.extraction_call();
    let system_content = &extraction_call[0].content;
    assert!(
        !system_content.contains("For context only, here is the recent Conversation"),
        "a fresh Session's extraction call should carry no Conversation section at all: \
         {system_content}"
    );
    assert!(
        !system_content.contains("End of recent Conversation."),
        "a fresh Session's extraction call should carry no Conversation section at all: \
         {system_content}"
    );

    let calls = embed.calls();
    assert!(
        calls.contains(&"What did I write about wedding?".to_string()),
        "extraction should still reach the keyword search normally: {calls:?}"
    );
}

/// The extraction call's Conversation is capped at `CONVERSATION_WINDOW`
/// too — the same cap `run_reflect` already applies to `prior_turns` before
/// the answering call ever sees them, reused here rather than left
/// unbounded.
#[sqlx::test]
async fn the_extraction_call_conversation_is_capped_at_the_window_too(pool: PgPool) {
    let session_id = Uuid::new_v4();
    insert_session_with_turns(&pool, session_id, 15).await;

    let chat = Arc::new(FakeChatClient::new("Here's what I found."));

    let (status, _) = post_reflect(
        &pool,
        Some(reflect_state(chat.clone())),
        json!({
            "protocol_version": 2,
            "question": "Anything new to add?",
            "session_id": session_id,
        }),
    )
    .await;

    assert_eq!(status, StatusCode::OK);

    let extraction_call = chat.extraction_call();
    let system_content = &extraction_call[0].content;

    for n in 5..15 {
        assert!(
            system_content.contains(&format!("turn {n} question")),
            "turn {n} question should be inside the extraction call's Conversation window: \
             {system_content}"
        );
    }
    for n in 0..5 {
        assert!(
            !system_content.contains(&format!("turn {n} question")),
            "turn {n} question is outside CONVERSATION_WINDOW and should not have reached the \
             extraction call: {system_content}"
        );
    }
}

/// Extraction failure must still degrade to question-only retrieval even
/// when a Conversation is folded into the very prompt that failed —
/// `docs/adr/0023`'s floor ("never a failed Question") does not get weaker
/// just because this call now carries more content than the bare Question.
#[sqlx::test]
async fn an_extraction_error_with_a_prior_conversation_still_degrades_to_question_only(
    pool: PgPool,
) {
    let device = Uuid::new_v4();
    let entry = Uuid::new_v4();
    insert_embedded_entry(
        &pool,
        entry,
        device,
        "the knee is better now",
        "2026-06-01T00:00:00Z",
    )
    .await;

    let session_id = Uuid::new_v4();
    insert_session_with_turn(
        &pool,
        session_id,
        "How has my knee been in June?",
        "Your knee improved steadily through June.",
    )
    .await;

    let chat = Arc::new(FakeChatClient::with_extraction_error(
        "Your knee has improved.",
    ));

    let (status, body) = post_reflect(
        &pool,
        Some(reflect_state(chat)),
        json!({
            "protocol_version": 2,
            "question": "and the week before that?",
            "session_id": session_id,
        }),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["answer"], "Your knee has improved.");
    assert!(grounding_ids(&body).contains(&entry));
}

/// An Entry findable by more than one source (here: the Question's own
/// search *and* the extracted date range) must appear exactly once in
/// Grounding — the dedupe-by-id rule.
#[sqlx::test]
async fn an_entry_found_by_two_sources_appears_exactly_once(pool: PgPool) {
    let device = Uuid::new_v4();
    let entry = Uuid::new_v4();
    // Matches the Question's own vector (default) *and* sits inside the
    // extracted date range — reachable via both `retrieve_nearest` and
    // `retrieve_range`.
    insert_embedded_entry(
        &pool,
        entry,
        device,
        "the knee is better now",
        "2026-08-05T00:00:00Z",
    )
    .await;

    let chat = Arc::new(FakeChatClient::with_extraction(
        "Your knee has improved.",
        r#"{"date_range": {"from": "2026-08-01", "to": "2026-08-10"}, "keyword": null}"#,
    ));

    let (status, body) = post_reflect(
        &pool,
        Some(reflect_state(chat)),
        json!({ "protocol_version": 2, "question": "How's my knee?", "utc_offset_minutes": 0 }),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    let ids = grounding_ids(&body);
    assert_eq!(
        ids.iter().filter(|id| **id == entry).count(),
        1,
        "duplicate Grounding id: {ids:?}"
    );
}

/// More than `RETRIEVAL_LIMIT` (40) total candidates must be capped to
/// exactly 40 — and priority order (question-search first) decides which
/// 40 survive: the question-search results, not the range-only ones.
#[sqlx::test]
async fn more_than_the_cap_is_truncated_with_question_search_surviving(pool: PgPool) {
    let device = Uuid::new_v4();

    // 45 Entries the Question's own search finds (default vector), dated
    // well outside the extracted range so they can't also arrive via
    // `retrieve_range`.
    let mut question_ids = Vec::new();
    for i in 0..45 {
        let id = Uuid::new_v4();
        question_ids.push(id);
        insert_embedded_entry(
            &pool,
            id,
            device,
            &format!("entry {i}"),
            "2020-01-01T00:00:00Z",
        )
        .await;
    }

    // 10 more Entries findable *only* through the extracted date range —
    // orthogonal to the Question's vector, dated inside the range.
    let mut range_only_ids = Vec::new();
    for i in 0..10 {
        let id = Uuid::new_v4();
        range_only_ids.push(id);
        insert_embedded_entry_with_vector(
            &pool,
            id,
            device,
            &format!("range-only entry {i}"),
            "2026-08-05T00:00:00Z",
            &orthogonal_vector(),
        )
        .await;
    }

    let chat = Arc::new(FakeChatClient::with_extraction(
        "Here's what I found.",
        r#"{"date_range": {"from": "2026-08-01", "to": "2026-08-10"}, "keyword": null}"#,
    ));

    let (status, body) = post_reflect(
        &pool,
        Some(reflect_state(chat)),
        json!({ "protocol_version": 2, "question": "anything", "utc_offset_minutes": 0 }),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    let ids = grounding_ids(&body);
    assert_eq!(
        ids.len(),
        40,
        "the merged set must be capped at RETRIEVAL_LIMIT"
    );
    for id in &range_only_ids {
        assert!(
            !ids.contains(id),
            "a range-only Entry survived the cap ahead of question-search results: {id}"
        );
    }
    let surviving_question_entries = ids.iter().filter(|id| question_ids.contains(id)).count();
    assert_eq!(
        surviving_question_entries, 40,
        "all 40 surviving Entries should be question-search results"
    );
}

/// `grounding_entry_ids` is chronological, regardless of which source
/// found each Entry or the order sources are merged in.
#[sqlx::test]
async fn grounding_entry_ids_are_chronological(pool: PgPool) {
    let device = Uuid::new_v4();
    let earliest = Uuid::new_v4();
    let middle = Uuid::new_v4();
    let latest = Uuid::new_v4();

    // Inserted out of chronological order, and found via different sources
    // (question-search vs. date-range), so ordering can't be an accident of
    // insertion or retrieval order.
    insert_embedded_entry(&pool, latest, device, "third", "2026-08-09T00:00:00Z").await;
    insert_embedded_entry_with_vector(
        &pool,
        earliest,
        device,
        "first",
        "2026-08-01T00:00:00Z",
        &orthogonal_vector(),
    )
    .await;
    insert_embedded_entry(&pool, middle, device, "second", "2026-08-05T00:00:00Z").await;

    let chat = Arc::new(FakeChatClient::with_extraction(
        "Ordered.",
        r#"{"date_range": {"from": "2026-08-01", "to": "2026-08-10"}, "keyword": null}"#,
    ));

    let (status, body) = post_reflect(
        &pool,
        Some(reflect_state(chat)),
        json!({ "protocol_version": 2, "question": "anything", "utc_offset_minutes": 0 }),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(grounding_ids(&body), vec![earliest, middle, latest]);
}

/// `utc_offset_minutes` shifts the local-day boundary the extracted range
/// resolves against. An Entry whose UTC timestamp is late on the previous
/// UTC day falls inside the extracted local day at a large positive
/// (IST-like) offset, and does not at offset 0.
#[sqlx::test]
async fn utc_offset_minutes_shifts_the_extracted_day_boundary(pool: PgPool) {
    let device = Uuid::new_v4();
    let entry = Uuid::new_v4();
    // 2026-08-14T20:00:00Z is 2026-08-15 01:30 IST (+330) — inside the
    // local day 2026-08-15 at that offset, but outside it at offset 0.
    insert_embedded_entry_with_vector(
        &pool,
        entry,
        device,
        "wrote this just after midnight, IST",
        "2026-08-14T20:00:00Z",
        &orthogonal_vector(),
    )
    .await;

    let extraction_json =
        r#"{"date_range": {"from": "2026-08-15", "to": "2026-08-15"}, "keyword": null}"#;

    let ist_chat = Arc::new(FakeChatClient::with_extraction(
        "Found it.",
        extraction_json,
    ));
    let (status, body) = post_reflect(
        &pool,
        Some(reflect_state(ist_chat)),
        json!({
            "protocol_version": 2,
            "question": "what did I write that day",
            "utc_offset_minutes": 330,
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        grounding_ids(&body).contains(&entry),
        "at offset 330 the Entry should fall inside the extracted local day"
    );

    let utc_chat = Arc::new(FakeChatClient::with_extraction(
        "Found nothing.",
        extraction_json,
    ));
    let (status, body) = post_reflect(
        &pool,
        Some(reflect_state(utc_chat)),
        json!({
            "protocol_version": 2,
            "question": "what did I write that day",
            "utc_offset_minutes": 0,
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        !grounding_ids(&body).contains(&entry),
        "at offset 0 the Entry should fall outside the extracted local day"
    );
}

/// A Device that predates this ticket posts with no `utc_offset_minutes`
/// field at all — `#[serde(default)]` must still answer the Question
/// (defaulting the offset to 0), not reject the request.
#[sqlx::test]
async fn an_absent_utc_offset_defaults_to_zero_and_still_answers(pool: PgPool) {
    let device = Uuid::new_v4();
    let entry = Uuid::new_v4();
    insert_embedded_entry(
        &pool,
        entry,
        device,
        "the knee is better now",
        "2026-06-01T00:00:00Z",
    )
    .await;

    let chat = Arc::new(FakeChatClient::new("Your knee has improved."));

    let (status, body) = post_reflect(
        &pool,
        Some(reflect_state(chat)),
        // No "utc_offset_minutes" key at all.
        json!({ "protocol_version": 2, "question": "How's my knee?" }),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["answer"], "Your knee has improved.");
    assert!(grounding_ids(&body).contains(&entry));
}

/// The extraction prompt must state the correct local date for the given
/// offset — the server must never guess the timezone from its own clock.
#[sqlx::test]
async fn the_extraction_prompt_states_the_correct_local_date_for_the_offset(pool: PgPool) {
    let offset_minutes = 330; // IST
    let expected_local_date = (Utc::now() + Duration::minutes(offset_minutes))
        .date_naive()
        .format("%Y-%m-%d")
        .to_string();

    let chat = Arc::new(FakeChatClient::new("unused"));
    let reflect = reflect_state(chat.clone());

    let (status, _) = post_reflect(
        &pool,
        Some(reflect),
        json!({
            "protocol_version": 2,
            "question": "what did I write yesterday",
            "utc_offset_minutes": offset_minutes,
        }),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    let extraction_call = chat.extraction_call();
    let system_content = &extraction_call[0].content;
    assert!(
        system_content.contains(&expected_local_date),
        "extraction prompt should contain today's local date {expected_local_date}: {system_content}"
    );
}

/// Sanity check on the fake itself: exactly two chat calls happen per
/// request — extraction, then the final Answer — so tests relying on
/// `last_call()`/`extraction_call()` aren't accidentally passing on a
/// single merged call.
#[sqlx::test]
async fn exactly_two_chat_calls_happen_per_request(pool: PgPool) {
    let chat = Arc::new(FakeChatClient::new("An answer."));
    let reflect = reflect_state(chat.clone());

    let (status, _) = post_reflect(
        &pool,
        Some(reflect),
        json!({ "protocol_version": 2, "question": "anything" }),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(chat.call_count(), 2);
}

// ---------------------------------------------------------------------
// Ticket 6 — Reflection admits when it found nothing (docs/adr/0024)
// ---------------------------------------------------------------------

/// A "GROUNDED: yes" verdict reports `grounded: true`, never triggers the
/// fallback, and the marker itself never reaches the client.
#[sqlx::test]
async fn a_grounded_yes_verdict_reports_grounded_true_with_the_marker_stripped(pool: PgPool) {
    let device = Uuid::new_v4();
    let entry = Uuid::new_v4();
    insert_embedded_entry(
        &pool,
        entry,
        device,
        "the knee is better now",
        "2026-06-01T00:00:00Z",
    )
    .await;

    let chat = Arc::new(FakeChatClient::new(
        "GROUNDED: yes\nYour knee has improved since February.",
    ));

    let (status, body) = post_reflect(
        &pool,
        Some(reflect_state(chat.clone())),
        json!({ "protocol_version": 2, "question": "How's my knee?" }),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["grounded"], true);
    assert_eq!(body["fallback_used"], false);
    assert_eq!(body["answer"], "Your knee has improved since February.");
    assert!(!body["answer"].as_str().unwrap().contains("GROUNDED:"));
    assert_eq!(
        chat.call_count(),
        2,
        "a grounded verdict must not spend the fallback's extra chat call"
    );
}

/// A "GROUNDED: no" verdict with Entries in the last 3 days triggers the
/// disclosed fallback: a third chat call, `fallback_used: true`,
/// `grounded: false`, and `grounding_entry_ids` exactly the recent Entries
/// — not the (empty, in this case) merged Grounding set.
#[sqlx::test]
async fn a_grounded_no_verdict_with_recent_entries_triggers_the_disclosed_fallback(pool: PgPool) {
    let device = Uuid::new_v4();
    let now = Utc::now();
    let recent_a = Uuid::new_v4();
    let recent_b = Uuid::new_v4();
    insert_embedded_entry_with_vector(
        &pool,
        recent_a,
        device,
        "went for a run today",
        &(now - Duration::hours(2)).to_rfc3339(),
        &orthogonal_vector(),
    )
    .await;
    insert_embedded_entry_with_vector(
        &pool,
        recent_b,
        device,
        "cooked dinner for friends",
        &(now - Duration::days(1)).to_rfc3339(),
        &orthogonal_vector(),
    )
    .await;
    // Outside the 3-day window — must never appear in the fallback.
    let stale = Uuid::new_v4();
    insert_embedded_entry_with_vector(
        &pool,
        stale,
        device,
        "an old entry",
        &(now - Duration::days(10)).to_rfc3339(),
        &orthogonal_vector(),
    )
    .await;

    let chat = Arc::new(
        FakeChatClient::new("GROUNDED: no\nI couldn't find anything about scuba diving.")
            .with_fallback_answer(
                "Nothing matching the Question was found. In the last few days you wrote about \
                 a run and cooking dinner for friends.",
            ),
    );

    let (status, body) = post_reflect(
        &pool,
        Some(reflect_state(chat.clone())),
        json!({
            "protocol_version": 2,
            "question": "Have I written anything about scuba diving in Portugal?",
        }),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["grounded"], false);
    assert_eq!(body["fallback_used"], true);
    assert_eq!(
        body["answer"],
        "Nothing matching the Question was found. In the last few days you wrote about a run \
         and cooking dinner for friends."
    );

    let ids = grounding_ids(&body);
    assert_eq!(ids.len(), 2);
    assert!(ids.contains(&recent_a));
    assert!(ids.contains(&recent_b));
    assert!(
        !ids.contains(&stale),
        "an Entry outside the 3-day window leaked into the fallback"
    );

    assert_eq!(chat.call_count(), 3);
    let fallback_call = chat.fallback_call();
    let grounding_message = fallback_call
        .iter()
        .find(|m| m.content.starts_with("Grounding:"))
        .expect("the fallback call should carry a Grounding block");
    assert!(grounding_message.content.contains("went for a run today"));
    assert!(
        grounding_message
            .content
            .contains("cooked dinner for friends")
    );
}

/// A "GROUNDED: no" verdict with nothing in the last 3 days makes no third
/// chat call at all, and keeps the first call's own "I found nothing"
/// Answer rather than spending a call on an empty fallback.
#[sqlx::test]
async fn a_grounded_no_verdict_with_nothing_recent_skips_the_fallback_call(pool: PgPool) {
    let device = Uuid::new_v4();
    let now = Utc::now();
    let stale = Uuid::new_v4();
    insert_embedded_entry_with_vector(
        &pool,
        stale,
        device,
        "an old entry",
        &(now - Duration::days(30)).to_rfc3339(),
        &orthogonal_vector(),
    )
    .await;

    let chat = Arc::new(FakeChatClient::new(
        "GROUNDED: no\nI couldn't find anything about scuba diving.",
    ));

    let (status, body) = post_reflect(
        &pool,
        Some(reflect_state(chat.clone())),
        json!({
            "protocol_version": 2,
            "question": "Have I written anything about scuba diving in Portugal?",
        }),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["grounded"], false);
    assert_eq!(body["fallback_used"], false);
    assert_eq!(body["grounding_entry_ids"], json!([]));
    assert_eq!(
        body["answer"],
        "I couldn't find anything about scuba diving."
    );
    assert_eq!(
        chat.call_count(),
        2,
        "no recent Entries means no third chat call"
    );
}

/// No marker at all, with real Grounding behind it (the seeded Entry
/// clears the merged fan-out) — the "fail open" default `run_reflect`
/// itself applies when the verdict can't be read (see its own doc comment
/// on that `match`, not `parse_and_strip_verdict`'s, which only reports
/// `None` and leaves the choice to its caller): `grounded: true`, no
/// fallback, and the (unmarked) Answer returned exactly as the chat call
/// gave it.
/// `no_marker_with_an_empty_merged_set_defaults_to_ungrounded_and_runs_the_fallback`
/// below covers the opposite case, where the same missing marker defaults
/// the other way because there was no Grounding to fail open onto.
#[sqlx::test]
async fn no_verdict_marker_defaults_to_grounded_and_leaves_the_answer_unchanged(pool: PgPool) {
    let device = Uuid::new_v4();
    let entry = Uuid::new_v4();
    insert_embedded_entry(
        &pool,
        entry,
        device,
        "the knee is better now",
        "2026-06-01T00:00:00Z",
    )
    .await;

    let chat = Arc::new(FakeChatClient::new(
        "Your knee has improved since February.",
    ));

    let (status, body) = post_reflect(
        &pool,
        Some(reflect_state(chat.clone())),
        json!({ "protocol_version": 2, "question": "How's my knee?" }),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["answer"], "Your knee has improved since February.");
    assert_eq!(body["grounded"], true);
    assert_eq!(body["fallback_used"], false);
    assert_eq!(
        chat.call_count(),
        2,
        "a missing marker must not trigger the fallback's extra chat call"
    );
}

/// The verdict marker is recognised end to end even wrapped in markdown,
/// mixed case, and stray whitespace — not just at the unit level
/// (`parse_and_strip_verdict`'s own tests in `reflect.rs`).
#[sqlx::test]
async fn a_noisy_marker_is_still_recognised_end_to_end(pool: PgPool) {
    let device = Uuid::new_v4();
    let now = Utc::now();
    let recent = Uuid::new_v4();
    insert_embedded_entry_with_vector(
        &pool,
        recent,
        device,
        "went for a run today",
        &(now - Duration::hours(1)).to_rfc3339(),
        &orthogonal_vector(),
    )
    .await;

    let chat = Arc::new(
        FakeChatClient::new("  **grounded: NO**  \n\nI couldn't find anything about that.")
            .with_fallback_answer(
                "Nothing matching the Question was found; lately you wrote about a run.",
            ),
    );

    let (status, body) = post_reflect(
        &pool,
        Some(reflect_state(chat.clone())),
        json!({ "protocol_version": 2, "question": "Anything about scuba diving?" }),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["grounded"], false);
    assert_eq!(body["fallback_used"], true);
    assert_eq!(grounding_ids(&body), vec![recent]);
}

// ---------------------------------------------------------------------
// Code review fixes on f97d697..HEAD — a widening retrieval must not be
// able to narrow the Answer to zero (docs/adr/0023), and `grounded: true`
// must not be reachable with no Grounding behind it (docs/adr/0024).
// ---------------------------------------------------------------------

/// A transient failure embedding the *keyword* — a source that exists only
/// to widen recall beyond question-only retrieval (docs/adr/0023) — must
/// not fail the Question: it degrades to an empty keyword-search result and
/// the Question is still answered from question-only retrieval, exactly
/// ticket 4's floor.
#[sqlx::test]
async fn a_keyword_embedding_failure_still_answers_from_question_only_retrieval(pool: PgPool) {
    let device = Uuid::new_v4();
    let entry = Uuid::new_v4();
    insert_embedded_entry(
        &pool,
        entry,
        device,
        "the knee is better now",
        "2026-06-01T00:00:00Z",
    )
    .await;

    let chat = Arc::new(FakeChatClient::with_extraction(
        "Your knee has improved.",
        r#"{"date_range": null, "keyword": "wedding"}"#,
    ));
    // The wrapped form `keyword_query` embeds, not the bare "wedding" —
    // matching how `a_keyword_extraction_grounds_an_entry_only_the_keyword_search_finds`
    // above already keys its override.
    let embed = Arc::new(FakeEmbedClient::new().with_failure("What did I write about wedding?"));
    let reflect = reflect_state_with_embed(chat.clone(), embed);

    let (status, body) = post_reflect(
        &pool,
        Some(reflect),
        json!({ "protocol_version": 2, "question": "How's my knee?" }),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["answer"], "Your knee has improved.");
    assert!(grounding_ids(&body).contains(&entry));
    assert_eq!(
        chat.call_count(),
        2,
        "a degraded keyword search must not spend the fallback's extra chat call"
    );
}

/// Embedding the Question itself has no floor left to fall back to —
/// ticket 4 already returned an error in exactly this case, so propagating
/// it *is* "at least what ticket 4 already gave" (docs/adr/0023). Unlike
/// the keyword/range widening sources, this must remain fatal.
#[sqlx::test]
async fn a_question_embedding_failure_still_fails_the_request(pool: PgPool) {
    let chat = Arc::new(FakeChatClient::new("unused"));
    let embed = Arc::new(FakeEmbedClient::new().with_failure("How's my knee?"));
    let reflect = reflect_state_with_embed(chat, embed);

    let (status, _) = post_reflect(
        &pool,
        Some(reflect),
        json!({ "protocol_version": 2, "question": "How's my knee?" }),
    )
    .await;

    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
}

/// A missing verdict marker must not be able to make `grounded: true`
/// reachable with nothing behind it (docs/adr/0024): with an empty merged
/// set, "no marker" now defaults to `grounded: false`, and the disclosed
/// fallback runs exactly as it would for an explicit "GROUNDED: no" when
/// recent Entries exist to show.
#[sqlx::test]
async fn no_marker_with_an_empty_merged_set_defaults_to_ungrounded_and_runs_the_fallback(
    pool: PgPool,
) {
    let device = Uuid::new_v4();
    let now = Utc::now();
    let recent = Uuid::new_v4();
    insert_embedded_entry_with_vector(
        &pool,
        recent,
        device,
        "went for a run today",
        &(now - Duration::hours(2)).to_rfc3339(),
        &orthogonal_vector(),
    )
    .await;

    // No "GROUNDED:" marker at all in the first answering call's response,
    // and nothing in the History matches the Question's own search (the
    // only seeded Entry is orthogonal to it), so the merged Grounding set
    // is empty.
    let chat = Arc::new(
        FakeChatClient::new("I couldn't find anything about scuba diving.").with_fallback_answer(
            "Nothing matching the Question was found; lately you wrote about a run.",
        ),
    );

    let (status, body) = post_reflect(
        &pool,
        Some(reflect_state(chat.clone())),
        json!({
            "protocol_version": 2,
            "question": "Have I written anything about scuba diving in Portugal?",
        }),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["grounded"], false);
    assert_eq!(body["fallback_used"], true);
    assert_eq!(
        body["answer"],
        "Nothing matching the Question was found; lately you wrote about a run."
    );
    assert_eq!(grounding_ids(&body), vec![recent]);
    assert_eq!(
        chat.call_count(),
        3,
        "an empty merged set with no marker should still run the disclosed fallback's third call"
    );
}

// ---------------------------------------------------------------------
// Ticket 8 — Sessions are held by the Server (docs/adr/0025)
// ---------------------------------------------------------------------

/// A `session_id` of `null` mints a new Session and reports both its id and
/// a title derived from the first Question — the only way a client learns
/// either, since there is no separate create endpoint.
#[sqlx::test]
async fn a_null_session_id_mints_a_new_session(pool: PgPool) {
    let chat = Arc::new(FakeChatClient::new("An answer."));
    let reflect = reflect_state(chat);

    let (status, body) = post_reflect(
        &pool,
        Some(reflect),
        json!({
            "protocol_version": 2,
            "question": "How has my knee been this year?",
            "session_id": null,
        }),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    let id = session_id(&body);
    assert_ne!(id, Uuid::nil());
    assert_eq!(body["title"], "How has my knee been this year?");
}

/// Once an Answer succeeds, its Turn — and, for a new Session, the Session
/// row itself — actually lands in Postgres, not just in the response.
#[sqlx::test]
async fn a_successful_answer_persists_its_turn(pool: PgPool) {
    let device = Uuid::new_v4();
    insert_embedded_entry(
        &pool,
        Uuid::new_v4(),
        device,
        "the knee is better now",
        "2026-06-01T00:00:00Z",
    )
    .await;

    let chat = Arc::new(FakeChatClient::new(
        "Your knee has improved since February.",
    ));
    let reflect = reflect_state(chat);

    let (status, body) = post_reflect(
        &pool,
        Some(reflect),
        json!({ "protocol_version": 2, "question": "How's my knee?" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let id = session_id(&body);
    assert_eq!(session_count(&pool).await, 1);

    let (question, answer, grounded, fallback_used): (String, String, bool, bool) = sqlx::query_as(
        "select question, answer, grounded, fallback_used from session_turns \
             where session_id = $1",
    )
    .bind(id)
    .fetch_one(&pool)
    .await
    .unwrap();

    assert_eq!(question, "How's my knee?");
    assert_eq!(answer, "Your knee has improved since February.");
    assert!(grounded);
    assert!(!fallback_used);
}

/// The Question's own embedding call has no floor left to fall back to
/// (see `a_question_embedding_failure_still_fails_the_request` above), so
/// its failure must fail the whole ask — and CONTEXT.md's "a Session can
/// never exist holding an empty Conversation" means that failure must leave
/// no trace: no Session, no Turn.
#[sqlx::test]
async fn a_failed_ask_persists_no_session_and_no_turn(pool: PgPool) {
    let chat = Arc::new(FakeChatClient::new("unused"));
    let embed = Arc::new(FakeEmbedClient::new().with_failure("How's my knee?"));
    let reflect = reflect_state_with_embed(chat, embed);

    let (status, _) = post_reflect(
        &pool,
        Some(reflect),
        json!({ "protocol_version": 2, "question": "How's my knee?" }),
    )
    .await;

    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(session_count(&pool).await, 0);
    assert_eq!(turn_count(&pool).await, 0);
}

/// A `session_id` naming no Session is a clean 404, not a 500 — and no
/// extraction, retrieval or chat call should have happened trying to answer
/// a Question that can never be persisted.
#[sqlx::test]
async fn an_unknown_session_id_is_a_404(pool: PgPool) {
    let chat = Arc::new(FakeChatClient::new("unused"));
    let reflect = reflect_state(chat.clone());

    let (status, _) = post_reflect(
        &pool,
        Some(reflect),
        json!({
            "protocol_version": 2,
            "question": "Anything?",
            "session_id": Uuid::new_v4(),
        }),
    )
    .await;

    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(
        chat.call_count(),
        0,
        "a 404 must short-circuit before any chat call"
    );
}

/// A second ask on the same Session appends a second Turn rather than
/// replacing the first, and bumps the Session's `updated_at` — the signal
/// a later listing ticket will sort on.
#[sqlx::test]
async fn a_second_ask_on_the_same_session_appends_and_bumps_updated_at(pool: PgPool) {
    let chat = Arc::new(FakeChatClient::new("First answer."));
    let reflect = reflect_state(chat);

    let (status, body) = post_reflect(
        &pool,
        Some(reflect),
        json!({ "protocol_version": 2, "question": "First question?" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let id = session_id(&body);

    let updated_at_before: DateTime<Utc> =
        sqlx::query_scalar("select updated_at from sessions where id = $1")
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap();

    // Real Postgres timestamps have microsecond resolution, but two writes
    // in the same test can otherwise land in the same tick — sleeping a
    // little is what actually exercises "updated_at moved" rather than
    // "updated_at happened to already be later."
    tokio::time::sleep(std::time::Duration::from_millis(10)).await;

    let chat2 = Arc::new(FakeChatClient::new("Second answer."));
    let reflect2 = reflect_state(chat2);
    let (status2, body2) = post_reflect(
        &pool,
        Some(reflect2),
        json!({
            "protocol_version": 2,
            "question": "Second question?",
            "session_id": id,
        }),
    )
    .await;
    assert_eq!(status2, StatusCode::OK);
    assert_eq!(session_id(&body2), id, "the same Session, not a new one");

    assert_eq!(turn_count(&pool).await, 2);

    let updated_at_after: DateTime<Utc> =
        sqlx::query_scalar("select updated_at from sessions where id = $1")
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(
        updated_at_after > updated_at_before,
        "updated_at should move on a second Turn: before={updated_at_before}, after={updated_at_after}"
    );
}
