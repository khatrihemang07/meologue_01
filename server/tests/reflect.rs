use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use anyhow::{Result, bail};
use async_trait::async_trait;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use chrono::{DateTime, Utc};
use http_body_util::BodyExt;
use meologue_server::llm::{ChatMessage, LlmClient};
use meologue_server::reflect::ReflectState;
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

// These tests only ever hit /v1/reflect (or /v1/sessions), never a static
// asset — any directory that exists is fine as the (otherwise unused)
// static_dir, matching tests/embedding.rs's own convention.
fn empty_static_dir() -> PathBuf {
    std::env::current_dir().unwrap()
}

/// A **scripted** `LlmClient` double (issue #93 pass 2) — the harness's
/// `ReflectState.chat_client` is still `Arc<dyn LlmClient>` (wrapping it in
/// `harness::prompted::PromptedToolClient` is `run_reflect_loop`'s own job,
/// not this fake's), so this is where a test controls what the *model*
/// says, one loop turn at a time. `new` takes a queue of canned replies —
/// plain prose, or a literal `<tool_call>{"name": ..., "arguments":
/// {...}}</tool_call>` tag block, exactly the wire format
/// `harness::prompted::PromptedToolClient` parses — and `chat` pops one off
/// on every call the harness makes, so a test scripts a whole multi-turn
/// run by listing what each turn should say, in order.
///
/// Replaces the old `FakeChatClient`, which told apart the fixed pipeline's
/// three chat calls by sniffing each prompt for phrases specific to that
/// pipeline ("Today's date", "nothing matching the Question was found") —
/// phrases the loop-based `/v1/reflect` no longer sends at all. There is
/// only ever one *kind* of call now, so there is nothing left to sniff:
/// `calls()` records every request verbatim (system prompt — with its
/// rendered `<tools>` block and tool guidance intact — plus every prior
/// message) so a test can assert on exactly what the harness sent, in
/// call order.
struct FakeChatClient {
    replies: Mutex<VecDeque<Result<String, String>>>,
    calls: Mutex<Vec<Vec<ChatMessage>>>,
}

impl FakeChatClient {
    /// A script of all-successful replies, in the order they're consumed.
    fn new<I, S>(replies: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Self::from_results(replies.into_iter().map(|reply| Ok(reply.into())))
    }

    /// A single call that fails outright, simulating a non-2xx or a
    /// connection error from the configured chat endpoint — the one shape
    /// `harness::chat::ChatClient`'s never-`Err` contract turns into a
    /// terminal `StopReason::Error` for the loop to stop on.
    fn failing(message: impl Into<String>) -> Self {
        Self::from_results(std::iter::once(Err(message.into())))
    }

    fn from_results(results: impl IntoIterator<Item = Result<String, String>>) -> Self {
        Self {
            replies: Mutex::new(results.into_iter().collect()),
            calls: Mutex::new(Vec::new()),
        }
    }

    fn call_count(&self) -> usize {
        self.calls.lock().unwrap().len()
    }

    /// The `n`th call's messages (0-indexed) — what the harness sent on
    /// that turn.
    fn nth_call(&self, n: usize) -> Vec<ChatMessage> {
        self.calls.lock().unwrap()[n].clone()
    }

    fn last_call(&self) -> Vec<ChatMessage> {
        self.calls
            .lock()
            .unwrap()
            .last()
            .cloned()
            .expect("chat() was never called")
    }
}

#[async_trait]
impl LlmClient for FakeChatClient {
    async fn chat(&self, messages: &[ChatMessage]) -> Result<String> {
        self.calls.lock().unwrap().push(messages.to_vec());
        match self.replies.lock().unwrap().pop_front() {
            Some(Ok(reply)) => Ok(reply),
            Some(Err(message)) => bail!("{message}"),
            None => panic!("FakeChatClient's script ran out of replies"),
        }
    }

    async fn embed_document(&self, _text: &str) -> Result<Vec<f32>> {
        unimplemented!("this fake only ever plays the chat role in reflect.rs's tests")
    }

    async fn embed_query(&self, _text: &str) -> Result<Vec<f32>> {
        unimplemented!("this fake only ever plays the chat role in reflect.rs's tests")
    }
}

/// `ReflectState.embed_client` is still required by the struct's shape, but
/// the loop's one tool (`entries_in_range`) does no embedding at all — a
/// date-range lookup is plain SQL — so nothing in this test file should
/// ever actually call it. Panicking loudly rather than returning a
/// plausible-looking vector is deliberate: a test that somehow reaches this
/// fake has a real design mistake in it, not a scenario worth silently
/// tolerating.
struct UnusedEmbedClient;

#[async_trait]
impl LlmClient for UnusedEmbedClient {
    async fn chat(&self, _messages: &[ChatMessage]) -> Result<String> {
        unimplemented!("UnusedEmbedClient only ever plays the embed role, and nothing embeds")
    }

    async fn embed_document(&self, _text: &str) -> Result<Vec<f32>> {
        unimplemented!("entries_in_range does no embedding; nothing should call this")
    }

    async fn embed_query(&self, _text: &str) -> Result<Vec<f32>> {
        unimplemented!("entries_in_range does no embedding; nothing should call this")
    }
}

/// Builds one `<tool_call>{"name": ..., "arguments": ...}</tool_call>` tag
/// — the literal wire format `harness::prompted::PromptedToolClient`
/// parses (issue #93's own prototype format) — for a `FakeChatClient`
/// script to hand back as one turn's whole reply, or part of it.
fn tool_call_tag(name: &str, arguments: Value) -> String {
    let payload = json!({"name": name, "arguments": arguments});
    format!("<tool_call>{payload}</tool_call>")
}

async fn insert_entry_at(pool: &PgPool, id: Uuid, body: &str, created_at: DateTime<Utc>) {
    sqlx::query("insert into entries (id, device_id, body, created_at) values ($1, $2, $3, $4)")
        .bind(id)
        .bind(Uuid::new_v4())
        .bind(body)
        .bind(created_at)
        .execute(pool)
        .await
        .unwrap();
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
        embed_client: Arc::new(UnusedEmbedClient),
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
/// `sessions::record_turn_from_steps` would already have done on an earlier
/// ask. `load_turns` falls back to reading `session_turns` directly for a
/// Session with no tree entries yet (`sessions.rs`'s own doc comment), which
/// is exactly the state this helper leaves a Session in — so these seeded
/// Sessions exercise the loop's prior-Turn replay without needing a tree at
/// all.
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
/// ones reached a chat call after `CONVERSATION_WINDOW` truncation.
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

async fn entry_count_for(pool: &PgPool, session_id: Uuid) -> i64 {
    sqlx::query_scalar("select count(*) from session_entries where session_id = $1")
        .bind(session_id)
        .fetch_one(pool)
        .await
        .unwrap()
}

// -- wiring / rejection paths, unaffected by the loop vs. the old pipeline --

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
    // Reflection" apart from every other failure.
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[sqlx::test]
async fn an_unrecognised_protocol_version_is_rejected(pool: PgPool) {
    let chat = Arc::new(FakeChatClient::new(["unused"]));
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

#[sqlx::test]
async fn an_unknown_session_id_is_a_404(pool: PgPool) {
    let chat = Arc::new(FakeChatClient::new(["unused"]));
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

#[sqlx::test]
async fn an_absent_utc_offset_defaults_to_zero_and_still_answers(pool: PgPool) {
    let chat = Arc::new(FakeChatClient::new(["An answer, no offset given."]));
    let reflect = reflect_state(chat);

    // No `utc_offset_minutes` field at all — a Device that predates this
    // field must still get an Answer (`ReflectRequest::utc_offset_minutes`'s
    // own doc comment).
    let (status, body) = post_reflect(
        &pool,
        Some(reflect),
        json!({ "protocol_version": 2, "question": "Anything?" }),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["answer"], "An answer, no offset given.");
}

// -- the loop itself, exercised end to end through /v1/reflect -------------

#[sqlx::test]
async fn a_prose_only_reply_is_the_answer_with_no_grounding(pool: PgPool) {
    let chat = Arc::new(FakeChatClient::new(["You haven't written about that yet."]));
    let reflect = reflect_state(chat.clone());

    let (status, body) = post_reflect(
        &pool,
        Some(reflect),
        json!({ "protocol_version": 2, "question": "Anything about scuba diving?" }),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["answer"], "You haven't written about that yet.");
    assert_eq!(grounding_ids(&body), Vec::<Uuid>::new());
    assert_eq!(body["grounded"], false);
    assert_eq!(body["fallback_used"], false);
    assert_eq!(
        chat.call_count(),
        1,
        "a reply with no tool call ends the loop after a single turn"
    );
}

#[sqlx::test]
async fn a_tool_call_then_prose_grounds_the_answer_in_the_entry_it_found(pool: PgPool) {
    let entry_id = Uuid::new_v4();
    insert_entry_at(
        &pool,
        entry_id,
        "Ran a 5k this morning.",
        DateTime::parse_from_rfc3339("2026-07-05T08:00:00Z")
            .unwrap()
            .with_timezone(&Utc),
    )
    .await;

    let chat = Arc::new(FakeChatClient::new([
        tool_call_tag(
            "entries_in_range",
            json!({"from": "2026-07-01", "to": "2026-07-31"}),
        ),
        "You ran a 5k on July 5th.".to_string(),
    ]));
    let reflect = reflect_state(chat.clone());

    let (status, body) = post_reflect(
        &pool,
        Some(reflect),
        json!({ "protocol_version": 2, "question": "Did I run in July?" }),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["answer"], "You ran a 5k on July 5th.");
    assert_eq!(grounding_ids(&body), vec![entry_id]);
    assert_eq!(body["grounded"], true);
    assert_eq!(
        chat.call_count(),
        2,
        "the loop must take a second turn to read the tool result"
    );

    // The second turn's Context must carry the tool result forward as an
    // ordinary (non-error) result the model can read.
    let second_call = chat.nth_call(1);
    assert!(
        second_call
            .iter()
            .any(|m| m.role == "user" && m.content.contains("Ran a 5k this morning.")),
        "the tool result should have reached the second turn: {second_call:?}"
    );
}

#[sqlx::test]
async fn two_tool_calls_in_one_reply_both_ground_the_answer(pool: PgPool) {
    let entry_a = Uuid::new_v4();
    let entry_b = Uuid::new_v4();
    insert_entry_at(
        &pool,
        entry_a,
        "January: started the year with a resolution.",
        DateTime::parse_from_rfc3339("2026-01-10T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc),
    )
    .await;
    insert_entry_at(
        &pool,
        entry_b,
        "July: still keeping it up.",
        DateTime::parse_from_rfc3339("2026-07-10T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc),
    )
    .await;

    let both_calls_in_one_reply = format!(
        "{}{}",
        tool_call_tag(
            "entries_in_range",
            json!({"from": "2026-01-01", "to": "2026-01-31"})
        ),
        tool_call_tag(
            "entries_in_range",
            json!({"from": "2026-07-01", "to": "2026-07-31"})
        ),
    );
    let chat = Arc::new(FakeChatClient::new([
        both_calls_in_one_reply,
        "You kept your resolution from January through July.".to_string(),
    ]));
    let reflect = reflect_state(chat.clone());

    let (status, body) = post_reflect(
        &pool,
        Some(reflect),
        json!({ "protocol_version": 2, "question": "Did I keep my resolution?" }),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        chat.call_count(),
        2,
        "both tool calls resolve within one turn before the model replies again"
    );
    let ids = grounding_ids(&body);
    assert_eq!(ids.len(), 2);
    assert!(ids.contains(&entry_a));
    assert!(ids.contains(&entry_b));
}

#[sqlx::test]
async fn an_entry_found_by_two_tool_calls_appears_once_in_grounding_ids(pool: PgPool) {
    let entry_id = Uuid::new_v4();
    insert_entry_at(
        &pool,
        entry_id,
        "Overlapping entry.",
        DateTime::parse_from_rfc3339("2026-05-15T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc),
    )
    .await;

    let chat = Arc::new(FakeChatClient::new([
        tool_call_tag(
            "entries_in_range",
            json!({"from": "2026-05-01", "to": "2026-05-31"}),
        ),
        tool_call_tag(
            "entries_in_range",
            json!({"from": "2026-05-10", "to": "2026-05-20"}),
        ),
        "Found it, once.".to_string(),
    ]));
    let reflect = reflect_state(chat.clone());

    let (status, body) = post_reflect(
        &pool,
        Some(reflect),
        json!({ "protocol_version": 2, "question": "What did I write in May?" }),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(grounding_ids(&body), vec![entry_id]);
}

#[sqlx::test]
async fn an_unknown_tool_name_recovers_and_still_answers(pool: PgPool) {
    let chat = Arc::new(FakeChatClient::new([
        tool_call_tag("not_a_real_tool", json!({})),
        "I couldn't look that up, but here's what I know.".to_string(),
    ]));
    let reflect = reflect_state(chat.clone());

    let (status, body) = post_reflect(
        &pool,
        Some(reflect),
        json!({ "protocol_version": 2, "question": "Anything?" }),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body["answer"],
        "I couldn't look that up, but here's what I know."
    );

    let second_call = chat.nth_call(1);
    assert!(
        second_call
            .iter()
            .any(|m| m.content.contains("Unknown tool")),
        "the unknown-tool error result should have reached the next turn: {second_call:?}"
    );
}

#[sqlx::test]
async fn a_malformed_tool_call_recovers_and_still_answers(pool: PgPool) {
    // No closing tag at all — the empty-name sentinel
    // `harness::types::ContentBlock::ToolCall` documents.
    let chat = Arc::new(FakeChatClient::new([
        "<tool_call>{\"name\": \"entries_in_range\", \"argum".to_string(),
        "Let me try again — here's an answer anyway.".to_string(),
    ]));
    let reflect = reflect_state(chat.clone());

    let (status, body) = post_reflect(
        &pool,
        Some(reflect),
        json!({ "protocol_version": 2, "question": "Anything?" }),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body["answer"],
        "Let me try again — here's an answer anyway."
    );
    assert_eq!(
        session_count(&pool).await,
        1,
        "a malformed reply must not fail the Question"
    );
}

#[sqlx::test]
async fn a_chat_client_error_fails_the_request_and_persists_nothing(pool: PgPool) {
    let chat = Arc::new(FakeChatClient::failing(
        "simulated 500 from the chat endpoint",
    ));
    let reflect = reflect_state(chat);

    let (status, _) = post_reflect(
        &pool,
        Some(reflect),
        json!({ "protocol_version": 2, "question": "Anything?" }),
    )
    .await;

    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(session_count(&pool).await, 0);
    assert_eq!(turn_count(&pool).await, 0);
}

#[sqlx::test]
async fn the_active_tool_set_is_named_in_the_system_prompt(pool: PgPool) {
    let chat = Arc::new(FakeChatClient::new(["No tools needed for that."]));
    let reflect = reflect_state(chat.clone());

    let (status, _) = post_reflect(
        &pool,
        Some(reflect),
        json!({ "protocol_version": 2, "question": "Anything?" }),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    let system_message = &chat.last_call()[0];
    assert_eq!(system_message.role, "system");
    assert!(
        system_message.content.contains("entries_in_range"),
        "the active tool set should be described in the system prompt: {}",
        system_message.content
    );
}

// -- Session persistence: create, append, 404, entry-tree order -----------

#[sqlx::test]
async fn a_null_session_id_mints_a_new_session(pool: PgPool) {
    let chat = Arc::new(FakeChatClient::new(["An answer."]));
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

#[sqlx::test]
async fn a_successful_answer_persists_its_turn(pool: PgPool) {
    let chat = Arc::new(FakeChatClient::new([
        "Your knee has improved since February.",
    ]));
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
    assert!(
        !grounded,
        "no tool ever ran, so nothing grounds this Answer"
    );
    assert!(!fallback_used);
}

#[sqlx::test]
async fn an_unknown_session_id_persists_no_session_and_no_turn(pool: PgPool) {
    let chat = Arc::new(FakeChatClient::new(["unused"]));
    let reflect = reflect_state(chat);

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
    assert_eq!(session_count(&pool).await, 0);
    assert_eq!(turn_count(&pool).await, 0);
}

#[sqlx::test]
async fn a_second_ask_on_the_same_session_appends_and_bumps_updated_at(pool: PgPool) {
    let chat = Arc::new(FakeChatClient::new(["First answer."]));
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

    let chat2 = Arc::new(FakeChatClient::new(["Second answer."]));
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

/// Issue #93 pass 2's own persistence requirement: every step a loop run
/// took — the Question, each Assistant reply, each tool result — lands in
/// the Session entry tree in the order it happened, chained parent to
/// child, not just summarised into the one `session_turns` row.
#[sqlx::test]
async fn steps_land_in_the_session_entry_tree_in_order(pool: PgPool) {
    let entry_id = Uuid::new_v4();
    insert_entry_at(
        &pool,
        entry_id,
        "Went for a run.",
        DateTime::parse_from_rfc3339("2026-04-01T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc),
    )
    .await;

    let chat = Arc::new(FakeChatClient::new([
        tool_call_tag(
            "entries_in_range",
            json!({"from": "2026-04-01", "to": "2026-04-30"}),
        ),
        "You went for a run in April.".to_string(),
    ]));
    let reflect = reflect_state(chat);

    let (status, body) = post_reflect(
        &pool,
        Some(reflect),
        json!({ "protocol_version": 2, "question": "Did I run in April?" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let id = session_id(&body);

    // user, assistant (tool call), tool_result, assistant (final answer).
    assert_eq!(entry_count_for(&pool, id).await, 4);

    let rows: Vec<(Option<Uuid>, Uuid, String)> = sqlx::query_as(
        "select parent_id, id, type from session_entries where session_id = $1 order by seq asc",
    )
    .bind(id)
    .fetch_all(&pool)
    .await
    .unwrap();

    assert_eq!(rows.len(), 4);
    assert_eq!(rows[0].0, None, "the first entry is a root");
    for i in 1..rows.len() {
        assert_eq!(
            rows[i].0,
            Some(rows[i - 1].1),
            "every entry must chain onto the one before it, in order"
        );
    }
    assert!(
        rows.iter()
            .all(|(_, _, entry_type)| entry_type == "message")
    );

    // load_turns must read the *final* Assistant reply as the Turn's
    // answer, not the one that only made the tool call.
    let get_app = meologue_server::router_with_reflection(
        pool.clone(),
        empty_static_dir(),
        None,
        Some(reflect_state(Arc::new(FakeChatClient::new(["unused"])))),
    );
    let response = get_app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/v1/sessions/{id}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let session_body: Value = serde_json::from_slice(&bytes).unwrap();
    let turns = session_body["turns"].as_array().unwrap();
    assert_eq!(turns.len(), 1);
    assert_eq!(turns[0]["answer"], "You went for a run in April.");
}

// -- Conversation replay: prior Turns reach the loop's own Context ---------

#[sqlx::test]
async fn a_sessions_conversation_reaches_the_chat_call(pool: PgPool) {
    let session_id = Uuid::new_v4();
    insert_session_with_turn(
        &pool,
        session_id,
        "How has my knee been this year?",
        "It's been a recurring issue since February.",
    )
    .await;

    let chat = Arc::new(FakeChatClient::new(["Yes, it started in March."]));
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
/// into the loop's own `Context.messages` at the 10 most recent Turns — a
/// Session that has grown past that must not hand the whole Conversation to
/// the call, only the tail of it.
#[sqlx::test]
async fn a_session_with_more_than_ten_turns_replays_only_the_ten_most_recent(pool: PgPool) {
    let session_id = Uuid::new_v4();
    insert_session_with_turns(&pool, session_id, 15).await;

    let chat = Arc::new(FakeChatClient::new(["Here's what I found."]));

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

    let chat = Arc::new(FakeChatClient::new(["Here's what I found."]));

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

    let chat = Arc::new(FakeChatClient::new(["Here's what I found."]));

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

#[sqlx::test]
async fn get_session_still_returns_every_turn_of_an_over_cap_session(pool: PgPool) {
    let session_id = Uuid::new_v4();
    insert_session_with_turns(&pool, session_id, 15).await;

    let chat = Arc::new(FakeChatClient::new(["unused"]));
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
