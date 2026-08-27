use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use anyhow::{Result, bail};
use async_trait::async_trait;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use chrono::{DateTime, NaiveDate, Utc};
use http_body_util::BodyExt;
use meologue_server::llm::{ChatMessage, ChatReply, LlmClient};
use meologue_server::reflect::ReflectState;
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

// Issue #96: `ReflectState` grew `chat_base_url`/`chat_api_key` for
// `GET /v1/models` (`models::models_handler`) — no test in this file
// exercises that route (see `tests/models.rs` for those), so every
// `ReflectState` built here points at an address nothing should ever
// actually connect to, on the theory that a real-looking but wrong value
// is more honest than a valid-looking placeholder a future test could
// accidentally start depending on.
const UNUSED_CHAT_BASE_URL: &str = "http://127.0.0.1:1";

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
    async fn chat(&self, messages: &[ChatMessage]) -> Result<ChatReply> {
        self.calls.lock().unwrap().push(messages.to_vec());
        match self.replies.lock().unwrap().pop_front() {
            // `ChatReply::text` — no usage scripted. Real usage wiring
            // (`llm::ChatReply.usage` -> `harness::types::Usage`) is
            // proven at `harness::prompted`'s own level
            // (`real_usage_reaches_the_assistant_message_with_the_harness_names`),
            // not duplicated here — this fake's whole contract is a queue
            // of plain reply text, and widening it to also script usage
            // would touch every existing call site for no test here that
            // needs it.
            Some(Ok(reply)) => Ok(ChatReply::text(reply)),
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
    async fn chat(&self, _messages: &[ChatMessage]) -> Result<ChatReply> {
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

/// One parsed SSE frame — `event: <name>`, `data: <json>` — from
/// `/v1/reflect`'s streamed response body.
#[derive(Debug, Clone)]
struct SseEvent {
    event: String,
    data: Value,
}

/// Splits a full SSE response body into its frames (blank-line separated,
/// per the SSE spec) and parses each one's `event:`/`data:` lines. Real
/// `axum::response::sse::Event` output always uses `\n` between fields and
/// `\n\n` between frames — the server under test controls both ends of this
/// wire, so this doesn't need to handle anything more exotic than that. A
/// frame with no `event:`/`data:` pair at all (axum's own keep-alive
/// comment ping, `Sse::keep_alive` — never actually seen in these tests,
/// which run far under its default interval) is silently skipped rather
/// than treated as malformed.
fn parse_sse_events(body: &str) -> Vec<SseEvent> {
    body.split("\n\n")
        .filter_map(|frame| {
            let mut event = None;
            let mut data = None;
            for line in frame.lines() {
                if let Some(rest) = line.strip_prefix("event:") {
                    event = Some(rest.trim().to_string());
                } else if let Some(rest) = line.strip_prefix("data:") {
                    data = Some(rest.trim().to_string());
                }
            }
            let (event, data) = (event?, data?);
            Some(SseEvent {
                event,
                data: serde_json::from_str(&data).unwrap_or(Value::Null),
            })
        })
        .collect()
}

/// Posts to `/v1/reflect` and drains its whole SSE response, returning
/// every frame in order — what the "full event sequence" tests assert
/// against directly. `oneshot`'s own `.await` only resolves once the
/// response body is fully read (`response.into_body().collect()`), which
/// only happens once `run_reflect_stream`'s spawned task has dropped its
/// sender — i.e. once the whole run is over — so by the time this returns,
/// every chat call the run made has already happened and every assertion
/// against a `FakeChatClient`'s own recorded calls is safe to make.
async fn post_reflect_events(
    pool: &PgPool,
    reflect: Option<ReflectState>,
    body: Value,
) -> (StatusCode, Vec<SseEvent>) {
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
    let text = String::from_utf8(bytes.to_vec()).expect("an SSE body must be valid UTF-8");
    (status, parse_sse_events(&text))
}

/// The pre-#96 convenience most existing tests in this file still use:
/// `body["answer"]`, `body["grounding_entry_ids"]`, and so on read off the
/// terminal `agent_end` event's own `data`, exactly the shape
/// `ReflectResponse` used to be the *entire* response body
/// (`run_reflect_stream`'s own doc comment covers why that shape itself
/// didn't change, only where it now lives on the wire). `Value::Null` when
/// the request never reached an SSE stream at all (404/426 — an empty body,
/// same as before issue #96) or `agent_end` is somehow missing.
async fn post_reflect(
    pool: &PgPool,
    reflect: Option<ReflectState>,
    body: Value,
) -> (StatusCode, Value) {
    let (status, events) = post_reflect_events(pool, reflect, body).await;
    let data = events
        .iter()
        .rev()
        .find(|event| event.event == "agent_end")
        .map(|event| event.data.clone())
        .unwrap_or(Value::Null);
    (status, data)
}

fn reflect_state(chat: Arc<FakeChatClient>) -> ReflectState {
    ReflectState {
        chat_client: chat,
        embed_client: Arc::new(UnusedEmbedClient),
        context_window: 200_000,
        chat_base_url: UNUSED_CHAT_BASE_URL.to_string(),
        chat_api_key: None,
    }
}

/// A deterministic `LlmClient` double for `embed_query` alone — every
/// `similar_entries` test needs *some* vector back from `embed_query`
/// before `retrieve_nearest` has anything to rank, and the actual value
/// doesn't matter (nothing here asserts on similarity ordering). `chat` is
/// never called through this fake — a test using it always supplies its
/// own `FakeChatClient` for that half.
struct FakeEmbedClient;

#[async_trait]
impl LlmClient for FakeEmbedClient {
    async fn chat(&self, _messages: &[ChatMessage]) -> Result<ChatReply> {
        unimplemented!("FakeEmbedClient only ever plays the embed role")
    }

    async fn embed_document(&self, _text: &str) -> Result<Vec<f32>> {
        unimplemented!("nothing in these tests writes an Entry through this client")
    }

    async fn embed_query(&self, _text: &str) -> Result<Vec<f32>> {
        Ok(vec![0.1_f32; 640])
    }
}

fn reflect_state_with_embedding(chat: Arc<FakeChatClient>) -> ReflectState {
    ReflectState {
        chat_client: chat,
        embed_client: Arc::new(FakeEmbedClient),
        context_window: 200_000,
        chat_base_url: UNUSED_CHAT_BASE_URL.to_string(),
        chat_api_key: None,
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
            "protocol_version": 3,
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

/// Issue #96 bumped `PROTOCOL_VERSION` from 2 to 3 for the SSE wire change
/// (`sync::PROTOCOL_VERSION`'s own doc comment covers why). This is the
/// sharper version of `an_unrecognised_protocol_version_is_rejected` above:
/// not an arbitrary invalid number, but the *real* version every Device
/// spoke before this ticket — proving the bump actually took effect, not
/// just that 426 still fires for garbage input. The mid-stream-failure
/// tests below (`a_chat_client_error_ends_the_stream_with_an_agent_end_error_event`
/// and its neighbour) prove the SSE stream itself terminates recognisably
/// on a failure *inside* a run; this proves a stale Device never even gets
/// that far — no stream opens at all.
#[sqlx::test]
async fn a_device_speaking_the_pre_bump_protocol_version_is_rejected(pool: PgPool) {
    let chat = Arc::new(FakeChatClient::new(["unused"]));
    let reflect = reflect_state(chat.clone());

    let (status, _) = post_reflect(
        &pool,
        Some(reflect),
        json!({
            "protocol_version": 2,
            "question": "Anything?",
        }),
    )
    .await;

    assert_eq!(status, StatusCode::UPGRADE_REQUIRED);
    assert_eq!(
        chat.call_count(),
        0,
        "a stale protocol_version must short-circuit before any chat call, and before any \
         stream is ever opened"
    );
}

#[sqlx::test]
async fn an_unknown_session_id_is_a_404(pool: PgPool) {
    let chat = Arc::new(FakeChatClient::new(["unused"]));
    let reflect = reflect_state(chat.clone());

    let (status, _) = post_reflect(
        &pool,
        Some(reflect),
        json!({
            "protocol_version": 3,
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
        json!({ "protocol_version": 3, "question": "Anything?" }),
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
        json!({ "protocol_version": 3, "question": "Anything about scuba diving?" }),
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
        json!({ "protocol_version": 3, "question": "Did I run in July?" }),
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

// -- issue #96: the SSE event sequence itself -------------------------------

/// The full ordered SSE event sequence a two-step Question produces, end to
/// end through real HTTP `event:`/`data:` frames — the acceptance criterion
/// issue #96 states directly: "steps appear as they happen ... in order."
/// Order matters here, not just presence: a `turn_start` must precede its
/// own turn's `message_start`/`message_end`, the tool events must fall
/// strictly between the turn that requested them and the next `turn_start`,
/// and the whole stream must end in exactly one `agent_end`.
/// `agent_loop`'s own equivalent test
/// (`run_with_events_reports_the_full_event_sequence_for_a_two_step_run`)
/// proves the same shape one layer down, at the `LoopEvent` level; this is
/// the same proof carried all the way through `loop_event_to_sse` and real
/// HTTP framing.
#[sqlx::test]
async fn the_full_event_sequence_for_a_two_step_question(pool: PgPool) {
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
    let reflect = reflect_state(chat);

    let (status, events) = post_reflect_events(
        &pool,
        Some(reflect),
        json!({ "protocol_version": 3, "question": "Did I run in July?" }),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    let names: Vec<&str> = events.iter().map(|e| e.event.as_str()).collect();
    assert_eq!(
        names,
        vec![
            "turn_start",
            "message_start",
            "message_end",
            "tool_execution_start",
            "tool_execution_end",
            "turn_start",
            "message_start",
            "message_end",
            "agent_end",
        ],
        "the full event sequence must match exactly, in order: {events:?}"
    );

    let agent_end = events.last().unwrap();
    assert_eq!(agent_end.data["status"], "ok");
    assert_eq!(agent_end.data["answer"], "You ran a 5k on July 5th.");
    assert_eq!(agent_end.data["grounded"], true);
    assert_eq!(grounding_ids(&agent_end.data), vec![entry_id]);
}

/// A tool event must carry what the interface needs to say what happened:
/// which tool ran, the query or range it ran with, and how many Entries
/// came back — issue #96's own acceptance criterion, spelled out on the
/// wire. `details` on `tool_execution_end` is `tools::ToolOutcome::details`
/// verbatim (the same sidecar issue #95 already put `"source": "digest"`
/// in), reused rather than a parallel channel — the range this tool ran
/// with (`details.from`/`details.to`) travels there, not duplicated into
/// `arguments`'s own JSON a second time in a different shape.
#[sqlx::test]
async fn a_tool_event_pair_names_what_was_searched_and_how_much_came_back(pool: PgPool) {
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
    let reflect = reflect_state(chat);

    let (_, events) = post_reflect_events(
        &pool,
        Some(reflect),
        json!({ "protocol_version": 3, "question": "Did I run in July?" }),
    )
    .await;

    let start = events
        .iter()
        .find(|e| e.event == "tool_execution_start")
        .expect("a tool_execution_start event must have been sent");
    assert_eq!(start.data["tool_name"], "entries_in_range");
    assert_eq!(start.data["arguments"]["from"], "2026-07-01");
    assert_eq!(start.data["arguments"]["to"], "2026-07-31");

    let end = events
        .iter()
        .find(|e| e.event == "tool_execution_end")
        .expect("a tool_execution_end event must have been sent");
    assert_eq!(end.data["tool_name"], "entries_in_range");
    assert_eq!(end.data["is_error"], false);
    assert_eq!(end.data["entry_count"], 1);
    assert_eq!(end.data["entry_ids"], json!([entry_id]));
    // `details` is `ToolOutcome::details` verbatim — the range it ran with
    // must be there too, not just a bare count.
    assert_eq!(end.data["details"]["from"], "2026-07-01");
    assert_eq!(end.data["details"]["to"], "2026-07-31");
}

/// `read_digest` is the one tool that reports its Grounding through
/// `details.grounding_entry_ids` rather than `ToolOutcome::entry_ids`
/// (`harness::tools::ReadDigestTool`'s own doc comment explains why: a
/// Digest's Grounding belongs to the Digest, not to this one call). This
/// proves `tool_entry_count` still reports the right number for that case
/// — "how many Entries came back" must not silently read 0 for the one
/// tool whose Grounding lives somewhere else.
#[sqlx::test]
async fn a_read_digest_tool_event_still_reports_a_correct_entry_count(pool: PgPool) {
    let grounding_id = Uuid::new_v4();
    // Matches `harness::tools::read_digest`'s own test fixture shape
    // (`insert_digest` in that module's test module) — `digests` has no
    // `period_end` column (it's derived, not stored), and
    // `grounding_entry_ids` is a real `uuid[]`, not a JSON array.
    sqlx::query(
        "insert into digests (id, period, period_start, body, grounding_entry_ids) \
         values ($1, $2, $3, $4, $5)",
    )
    .bind(Uuid::new_v4())
    .bind("day")
    .bind(NaiveDate::from_ymd_opt(2026, 3, 15).unwrap())
    .bind("A short day summary.")
    .bind([grounding_id].as_slice())
    .execute(&pool)
    .await
    .unwrap();

    let chat = Arc::new(FakeChatClient::new([
        tool_call_tag(
            "read_digest",
            json!({"period": "day", "date": "2026-03-15"}),
        ),
        "Here's the day's Digest.".to_string(),
    ]));
    let reflect = reflect_state(chat);

    let (_, events) = post_reflect_events(
        &pool,
        Some(reflect),
        json!({ "protocol_version": 3, "question": "What happened on March 15th?" }),
    )
    .await;

    let end = events
        .iter()
        .find(|e| e.event == "tool_execution_end")
        .expect("a tool_execution_end event must have been sent");
    assert_eq!(end.data["tool_name"], "read_digest");
    // `ToolOutcome::entry_ids` is deliberately empty for this tool — the
    // count must still come from `details.grounding_entry_ids`.
    assert_eq!(end.data["entry_ids"], json!([]));
    assert_eq!(end.data["entry_count"], 1);
}

/// Issue #93: the loop's model never streamed answer-token deltas because
/// `PromptedToolClient` only ever produces a single `Done` — this pins that
/// exact behaviour on the live route, so a future change to `prompted.rs`
/// that starts emitting `TextDelta` (or doesn't) is caught here rather than
/// only in `agent_loop`'s own unit test
/// (`run_with_events_forwards_text_deltas_as_message_updates_in_order`).
/// "On codex-terra ... nothing else differs" (issue #96) means exactly this:
/// zero `message_update` events, but the rest of the sequence unaffected.
#[sqlx::test]
async fn the_configured_model_never_produces_message_update_events(pool: PgPool) {
    let chat = Arc::new(FakeChatClient::new(["An answer with no deltas."]));
    let reflect = reflect_state(chat);

    let (_, events) = post_reflect_events(
        &pool,
        Some(reflect),
        json!({ "protocol_version": 3, "question": "Anything?" }),
    )
    .await;

    assert!(
        !events.iter().any(|e| e.event == "message_update"),
        "PromptedToolClient never streams deltas today; a message_update here would mean \
         something upstream started producing StreamEvent::TextDelta without this test \
         having been updated to expect it: {events:?}"
    );
}

/// Issue #94: proves `search_entries` is actually wired into the live
/// loop, not just unit-tested in isolation — the model calls it by name
/// through `/v1/reflect`, and its result grounds the Answer exactly the
/// way `entries_in_range`'s own equivalent test proves above.
#[sqlx::test]
async fn a_search_entries_call_then_prose_grounds_the_answer(pool: PgPool) {
    let entry_id = Uuid::new_v4();
    insert_entry_at(
        &pool,
        entry_id,
        "Started reading Piranesi tonight.",
        DateTime::parse_from_rfc3339("2026-07-05T08:00:00Z")
            .unwrap()
            .with_timezone(&Utc),
    )
    .await;

    let chat = Arc::new(FakeChatClient::new([
        tool_call_tag("search_entries", json!({"query": "Piranesi"})),
        "You started reading Piranesi.".to_string(),
    ]));
    let reflect = reflect_state(chat.clone());

    let (status, body) = post_reflect(
        &pool,
        Some(reflect),
        json!({ "protocol_version": 3, "question": "What have I been reading?" }),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["answer"], "You started reading Piranesi.");
    assert_eq!(grounding_ids(&body), vec![entry_id]);
    assert_eq!(body["grounded"], true);
}

/// Issue #94's counterpart for `similar_entries` — the same proof, through
/// the tool that embeds its query rather than running plain SQL. Uses
/// `reflect_state_with_embedding` since, unlike every `entries_in_range`
/// or `search_entries` test, this one actually reaches `embed_query`.
#[sqlx::test]
async fn a_similar_entries_call_then_prose_grounds_the_answer(pool: PgPool) {
    let entry_id = Uuid::new_v4();
    sqlx::query(
        "insert into entries (id, device_id, body, created_at, embedding, embedding_model)
         values ($1, $2, $3, $4, $5::vector, 'test-model')",
    )
    .bind(entry_id)
    .bind(Uuid::new_v4())
    .bind("Thinking a lot about the move to the new flat lately.")
    .bind(
        DateTime::parse_from_rfc3339("2026-07-05T08:00:00Z")
            .unwrap()
            .with_timezone(&Utc),
    )
    .bind(format!(
        "[{}]",
        std::iter::repeat_n("0.1", 640)
            .collect::<Vec<_>>()
            .join(",")
    ))
    .execute(&pool)
    .await
    .unwrap();

    let chat = Arc::new(FakeChatClient::new([
        tool_call_tag("similar_entries", json!({"query": "how did the move go"})),
        "You've been settling into the new flat.".to_string(),
    ]));
    let reflect = reflect_state_with_embedding(chat.clone());

    let (status, body) = post_reflect(
        &pool,
        Some(reflect),
        json!({ "protocol_version": 3, "question": "How did the move go?" }),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["answer"], "You've been settling into the new flat.");
    assert_eq!(grounding_ids(&body), vec![entry_id]);
    assert_eq!(body["grounded"], true);
}

/// Issue #94's own words: an embedding failure "must become an
/// `is_error` tool result the model can recover from, never a failed
/// Question" — proved end to end here, through the live loop rather than
/// the tool in isolation (`similar_entries.rs`'s own unit test already
/// covers `execute` returning `Err` directly).
#[sqlx::test]
async fn an_embedding_failure_recovers_and_still_answers(pool: PgPool) {
    struct AlwaysFailingEmbedClient;

    #[async_trait]
    impl LlmClient for AlwaysFailingEmbedClient {
        async fn chat(&self, _messages: &[ChatMessage]) -> Result<ChatReply> {
            unimplemented!("only embed_query is exercised here")
        }
        async fn embed_document(&self, _text: &str) -> Result<Vec<f32>> {
            unimplemented!("only embed_query is exercised here")
        }
        async fn embed_query(&self, _text: &str) -> Result<Vec<f32>> {
            bail!("simulated connection refused talking to Ollama")
        }
    }

    let chat = Arc::new(FakeChatClient::new([
        tool_call_tag("similar_entries", json!({"query": "how did the move go"})),
        "I couldn't search by meaning, but here's what I know.".to_string(),
    ]));
    let reflect = ReflectState {
        chat_client: chat.clone(),
        embed_client: Arc::new(AlwaysFailingEmbedClient),
        context_window: 200_000,
        chat_base_url: UNUSED_CHAT_BASE_URL.to_string(),
        chat_api_key: None,
    };

    let (status, body) = post_reflect(
        &pool,
        Some(reflect),
        json!({ "protocol_version": 3, "question": "How did the move go?" }),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body["answer"],
        "I couldn't search by meaning, but here's what I know."
    );

    let second_call = chat.nth_call(1);
    assert!(
        second_call.iter().any(|m| m.content.contains("embedding")),
        "the embedding failure should have reached the next turn as a \
         recoverable tool result: {second_call:?}"
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
        json!({ "protocol_version": 3, "question": "Did I keep my resolution?" }),
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
        json!({ "protocol_version": 3, "question": "What did I write in May?" }),
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
        json!({ "protocol_version": 3, "question": "Anything?" }),
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
        json!({ "protocol_version": 3, "question": "Anything?" }),
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

// -- issue #102: an empty final reply is not an Answer ---------------------
//
// The loop's stopping rule is "a reply with no tool call ends the loop and
// its text is the Answer" — a rule that says nothing about that text
// actually containing anything. `run_reflect_loop` gives an empty final
// reply exactly one corrective turn (`EMPTY_REPLY_CORRECTION`), the same
// "something the model can self-correct from" precedent issue #93 already
// established for an unknown tool or a malformed `<tool_call>` tag
// (`an_unknown_tool_name_recovers_and_still_answers`,
// `a_malformed_tool_call_recovers_and_still_answers`, above); unlike those,
// a *second* empty reply fails the request rather than looping forever —
// `a_final_reply_still_empty_after_a_corrective_turn_fails_the_request_and_persists_nothing`
// pins that bound.

#[sqlx::test]
async fn an_empty_final_reply_gets_one_corrective_turn_and_then_answers(pool: PgPool) {
    let chat = Arc::new(FakeChatClient::new([
        "".to_string(),
        "A real answer, the second time around.".to_string(),
    ]));
    let reflect = reflect_state(chat.clone());

    let (status, body) = post_reflect(
        &pool,
        Some(reflect),
        json!({ "protocol_version": 3, "question": "How did the flat move go?" }),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["answer"], "A real answer, the second time around.");
    assert_eq!(
        chat.call_count(),
        2,
        "the empty first reply must cost exactly one corrective turn"
    );

    // The corrective turn must actually tell the model what happened —
    // not a silent retry it has no way to learn from.
    let second_call = chat.nth_call(1);
    assert!(
        second_call
            .iter()
            .any(|m| m.content.contains("Your last reply had no text in it")),
        "the correction should have reached the retried turn: {second_call:?}"
    );
}

#[sqlx::test]
async fn a_whitespace_only_final_reply_counts_as_empty_and_is_retried(pool: PgPool) {
    let chat = Arc::new(FakeChatClient::new([
        "   \n\t  \n".to_string(),
        "A real answer.".to_string(),
    ]));
    let reflect = reflect_state(chat.clone());

    let (status, body) = post_reflect(
        &pool,
        Some(reflect),
        json!({ "protocol_version": 3, "question": "Anything?" }),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["answer"], "A real answer.");
    assert_eq!(chat.call_count(), 2);
}

#[sqlx::test]
async fn a_grounded_marker_only_final_reply_counts_as_empty_and_is_retried(pool: PgPool) {
    // The old fixed pipeline's "GROUNDED: yes/no" verdict marker
    // (docs/adr/0024) — `LOOP_SYSTEM_INSTRUCTION` never asks for it, but
    // the same configured model answers both prompts, so a bare marker
    // with nothing after it is a real shape this loop can receive.
    let chat = Arc::new(FakeChatClient::new([
        "GROUNDED: yes".to_string(),
        "A real answer.".to_string(),
    ]));
    let reflect = reflect_state(chat.clone());

    let (status, body) = post_reflect(
        &pool,
        Some(reflect),
        json!({ "protocol_version": 3, "question": "Anything?" }),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["answer"], "A real answer.");
    assert_eq!(chat.call_count(), 2);
}

/// The exact shape issue #102 was filed against: a tool call finds real
/// Entries, and *then* the reply that was meant to describe them comes back
/// empty. Proves the retry doesn't just answer — it keeps the Grounding the
/// first attempt already found, rather than silently losing it because the
/// reply that followed it didn't land.
#[sqlx::test]
async fn an_empty_reply_after_a_real_tool_call_still_carries_that_grounding_once_it_answers(
    pool: PgPool,
) {
    let entry_id = Uuid::new_v4();
    insert_entry_at(
        &pool,
        entry_id,
        "Finished moving into the new flat today.",
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
        "".to_string(),
        "The flat move went well, it sounds like.".to_string(),
    ]));
    let reflect = reflect_state(chat.clone());

    let (status, body) = post_reflect(
        &pool,
        Some(reflect),
        json!({ "protocol_version": 3, "question": "How did the flat move go?" }),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["answer"], "The flat move went well, it sounds like.");
    assert_eq!(body["grounded"], true);
    assert_eq!(grounding_ids(&body), vec![entry_id]);
    assert_eq!(chat.call_count(), 3);
}

// -- issue #96: a run that fails mid-stream terminates recognisably --------
//
// Before issue #96, either failure below was a plain HTTP 500 — the
// contract these two tests originally pinned. Once `/v1/reflect` commits to
// a 200 and starts streaming, that's no longer possible: the status line
// has already gone out by the time either failure is known (both happen
// inside the loop, only reachable once `resolve_session`'s own synchronous
// preflight has already succeeded — see `reflect_handler`'s own doc
// comment). What these two now prove is issue #96's actual replacement
// contract: the stream still ends, with exactly one `agent_end` event
// carrying `"status": "error"`, rather than hanging or the connection just
// dropping with nothing a client can distinguish from a lost network. Every
// other consequence of failure is unchanged and still asserted here: no
// Session or Turn is ever persisted for a Question that never produced an
// Answer.

#[sqlx::test]
async fn a_final_reply_still_empty_after_a_corrective_turn_ends_the_stream_with_an_agent_end_error_event(
    pool: PgPool,
) {
    let chat = Arc::new(FakeChatClient::new(["".to_string(), "   ".to_string()]));
    let reflect = reflect_state(chat.clone());

    let (status, events) = post_reflect_events(
        &pool,
        Some(reflect),
        json!({ "protocol_version": 3, "question": "How did the flat move go?" }),
    )
    .await;

    // The stream still opens as an ordinary 200 — the failure is only
    // known once the loop is already running, well after headers went out.
    assert_eq!(status, StatusCode::OK);
    let last = events.last().expect("the stream must end with some event");
    assert_eq!(
        last.event, "agent_end",
        "the stream must end with agent_end, not hang or close silently: {events:?}"
    );
    assert_eq!(last.data["status"], "error");
    assert!(
        last.data["error"].as_str().is_some(),
        "an error agent_end must explain what happened: {:?}",
        last.data
    );

    assert_eq!(session_count(&pool).await, 0);
    assert_eq!(turn_count(&pool).await, 0);
    assert_eq!(
        chat.call_count(),
        2,
        "a second empty reply must fail the request, not retry again"
    );
}

#[sqlx::test]
async fn a_chat_client_error_ends_the_stream_with_an_agent_end_error_event(pool: PgPool) {
    let chat = Arc::new(FakeChatClient::failing(
        "simulated 500 from the chat endpoint",
    ));
    let reflect = reflect_state(chat);

    let (status, events) = post_reflect_events(
        &pool,
        Some(reflect),
        json!({ "protocol_version": 3, "question": "Anything?" }),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    let last = events.last().expect("the stream must end with some event");
    assert_eq!(
        last.event, "agent_end",
        "the stream must end with agent_end, not hang or close silently: {events:?}"
    );
    assert_eq!(last.data["status"], "error");
    assert!(
        last.data["error"]
            .as_str()
            .is_some_and(|msg| msg.contains("simulated 500 from the chat endpoint")),
        "the underlying chat failure should be named in the error: {:?}",
        last.data
    );

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
        json!({ "protocol_version": 3, "question": "Anything?" }),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    let system_message = &chat.last_call()[0];
    assert_eq!(system_message.role, "system");
    // Issue #94's own acceptance criterion: "each tool contributes its own
    // description to the model's instructions" — all three of the loop's
    // tools must appear, not just the one issue #93 shipped first.
    for tool_name in ["entries_in_range", "search_entries", "similar_entries"] {
        assert!(
            system_message.content.contains(tool_name),
            "the active tool set should be described in the system prompt: {}",
            system_message.content
        );
    }
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
            "protocol_version": 3,
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
        json!({ "protocol_version": 3, "question": "How's my knee?" }),
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
            "protocol_version": 3,
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
        json!({ "protocol_version": 3, "question": "First question?" }),
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
            "protocol_version": 3,
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
        json!({ "protocol_version": 3, "question": "Did I run in April?" }),
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
            "protocol_version": 3,
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
            "protocol_version": 3,
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
            "protocol_version": 3,
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
            "protocol_version": 3,
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

async fn get_session(pool: &PgPool, reflect: ReflectState, id: Uuid) -> Value {
    let app = meologue_server::router_with_reflection(
        pool.clone(),
        empty_static_dir(),
        None,
        Some(reflect),
    );
    let response = app
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
    serde_json::from_slice(&bytes).unwrap()
}

/// Issue #97's between-Turns compaction (`reflect::maybe_compact_prior_turns`),
/// proven end to end through the real `/v1/reflect` and `GET /v1/sessions/{id}`
/// routes — `harness::compaction`'s own tests already cover the intra-run
/// half (the transform `agent_loop::run` applies turn by turn) in isolation,
/// so this is the wiring `sessions::append_compaction` needed a live proof
/// for: a real Session, built the same way `/v1/reflect` always builds one
/// (`record_turn_from_steps`, so it has a real entry tree — the one
/// precondition `append_compaction` checks), actually gets a `Compaction`
/// entry written onto it, and `GET /v1/sessions/{id}` — which shares
/// `sessions::load_turns` with `run_reflect_loop`'s own prior-Turns read —
/// stops showing every Turn that summary now stands in for.
///
/// Compacts *every* prior Turn, not a suffix of them —
/// `sessions::append_compaction`'s own doc comment covers why a partial
/// keep is impossible against an append-only tree, and
/// `reflect::maybe_compact_prior_turns` is written around that constraint.
#[sqlx::test]
async fn a_session_nearing_its_context_window_gets_compacted_between_turns(pool: PgPool) {
    let generous = ReflectState {
        chat_client: Arc::new(FakeChatClient::new(["a first answer"])),
        embed_client: Arc::new(UnusedEmbedClient),
        context_window: 200_000,
        chat_base_url: UNUSED_CHAT_BASE_URL.to_string(),
        chat_api_key: None,
    };
    let (status, body) = post_reflect(
        &pool,
        Some(generous),
        json!({ "protocol_version": 3, "question": "What did I write about running?" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let id = session_id(&body);

    let generous = ReflectState {
        chat_client: Arc::new(FakeChatClient::new(["a second answer"])),
        embed_client: Arc::new(UnusedEmbedClient),
        context_window: 200_000,
        chat_base_url: UNUSED_CHAT_BASE_URL.to_string(),
        chat_api_key: None,
    };
    let (status, _) = post_reflect(
        &pool,
        Some(generous),
        json!({ "protocol_version": 3, "session_id": id, "question": "And the wedding?" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // A small `context_window` — `harness::compaction::FIXED_OVERHEAD_TOKENS`
    // alone already exceeds it, so the two Turns above are enough to fire
    // `should_compact` with no padding needed. The chat script needs one
    // extra reply at the front for `maybe_compact_prior_turns`'s own
    // summarisation call, ahead of the harness loop's usual one.
    let tight = ReflectState {
        chat_client: Arc::new(FakeChatClient::new([
            "condensed: running and the wedding were both discussed",
            "a third answer",
        ])),
        embed_client: Arc::new(UnusedEmbedClient),
        context_window: 20_000,
        chat_base_url: UNUSED_CHAT_BASE_URL.to_string(),
        chat_api_key: None,
    };
    let (status, body) = post_reflect(
        &pool,
        Some(tight),
        json!({ "protocol_version": 3, "session_id": id, "question": "What about my knee?" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["answer"], "a third answer");

    // Read the Session back the same way a client (or the next Question)
    // would — `GET /v1/sessions/{id}` shares `sessions::load_turns` with
    // `run_reflect_loop`, so this is exactly "reading a summarised
    // Conversation starts from the summary and continues with what was
    // kept": Turns 1 and 2 (summarised away together — the only shape a
    // between-Turns compaction can take) must both be gone; Turn 3 (just
    // answered) must still be there.
    let unused = ReflectState {
        chat_client: Arc::new(FakeChatClient::new(["unused"])),
        embed_client: Arc::new(UnusedEmbedClient),
        context_window: 200_000,
        chat_base_url: UNUSED_CHAT_BASE_URL.to_string(),
        chat_api_key: None,
    };
    let session = get_session(&pool, unused, id).await;
    let turns = session["turns"]
        .as_array()
        .expect("SessionResponse::turns should be a JSON array");
    let questions: Vec<&str> = turns
        .iter()
        .map(|t| t["question"].as_str().unwrap())
        .collect();

    assert_eq!(
        questions,
        vec!["What about my knee?"],
        "Turns 1 and 2 must both be gone once compaction summarised them away: {questions:?}"
    );
}

/// A compaction summary is not a one-time flash — `sessions::latest_compaction_summary`'s
/// own doc comment names the bug this guards against: without it, only the
/// Question that happened to trigger compaction would ever see the summary;
/// every later Question would just see `prior_turns` starting abruptly
/// after it, with no idea a summary exists at all.
#[sqlx::test]
async fn a_summary_reaches_every_question_after_it_not_only_the_one_that_wrote_it(pool: PgPool) {
    let seed = ReflectState {
        chat_client: Arc::new(FakeChatClient::new(["a first answer"])),
        embed_client: Arc::new(UnusedEmbedClient),
        context_window: 200_000,
        chat_base_url: UNUSED_CHAT_BASE_URL.to_string(),
        chat_api_key: None,
    };
    let (_, body) = post_reflect(
        &pool,
        Some(seed),
        json!({ "protocol_version": 3, "question": "What did I write about running?" }),
    )
    .await;
    let id = session_id(&body);

    // This call's tight window makes it the one that actually compacts.
    let compacting = ReflectState {
        chat_client: Arc::new(FakeChatClient::new([
            "condensed: running was discussed",
            "a second answer",
        ])),
        embed_client: Arc::new(UnusedEmbedClient),
        context_window: 20_000,
        chat_base_url: UNUSED_CHAT_BASE_URL.to_string(),
        chat_api_key: None,
    };
    let (status, _) = post_reflect(
        &pool,
        Some(compacting),
        json!({ "protocol_version": 3, "session_id": id, "question": "And the wedding?" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // A *later* Question, still under the same tight window but with
    // nothing new large enough to trigger a second compaction on its own —
    // `should_compact` still fires here purely off `FIXED_OVERHEAD_TOKENS`,
    // but the summary already on the tree must still be the one folded in,
    // not silently dropped for lack of a *new* one to write.
    let later = ReflectState {
        chat_client: Arc::new(FakeChatClient::new([
            "condensed: running and the wedding, further condensed",
            "a third answer",
        ])),
        embed_client: Arc::new(UnusedEmbedClient),
        context_window: 20_000,
        chat_base_url: UNUSED_CHAT_BASE_URL.to_string(),
        chat_api_key: None,
    };
    let (status, body) = post_reflect(
        &pool,
        Some(later),
        json!({ "protocol_version": 3, "session_id": id, "question": "What about my knee?" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["answer"], "a third answer");
}
