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
use uuid::Uuid;

// `/v1/sessions/{id}` never hits a static asset — any directory that exists
// is fine as the (otherwise unused) static_dir, matching tests/reflect.rs's
// own convention.
fn empty_static_dir() -> PathBuf {
    std::env::current_dir().unwrap()
}

/// A `ReflectState` good for nothing but *existing* — `/v1/sessions/{id}`
/// is registered inside the same `reflect.is_some()` block as `/v1/reflect`
/// (`lib.rs`), so a test needs one in scope to get the route registered at
/// all, even though `get_session_handler` never calls either method on it.
struct UnusedLlmClient;

#[async_trait]
impl LlmClient for UnusedLlmClient {
    async fn chat(&self, _messages: &[ChatMessage]) -> Result<ChatReply> {
        unimplemented!("GET /v1/sessions/{{id}} never talks to an LlmClient")
    }

    async fn embed_document(&self, _text: &str) -> Result<Vec<f32>> {
        unimplemented!("GET /v1/sessions/{{id}} never talks to an LlmClient")
    }

    async fn embed_query(&self, _text: &str) -> Result<Vec<f32>> {
        unimplemented!("GET /v1/sessions/{{id}} never talks to an LlmClient")
    }
}

fn reflect_state() -> ReflectState {
    ReflectState {
        chat_client: Arc::new(UnusedLlmClient),
        embed_client: Some(Arc::new(UnusedLlmClient)),
        context_window: 200_000,
        // Issue #96: `GET /v1/models` needs these, but nothing in this file
        // exercises that route — an address nothing should ever connect to,
        // matching tests/reflect.rs's own `UNUSED_CHAT_BASE_URL` convention.
        chat_base_url: "http://127.0.0.1:1".to_string(),
        chat_api_key: None,
        // Issue #98: `get_session_handler` reads `chat_model` (never a
        // method on `chat_client`) to attribute a pre-#98 Turn — see
        // `SessionTurnRow::model`'s own doc comment. `chat_streaming` is
        // still never read by this route at all.
        chat_model: "codex-terra".to_string(),
        chat_streaming: false,
    }
}

async fn get_session(
    pool: &PgPool,
    reflect: Option<ReflectState>,
    id: Uuid,
) -> (StatusCode, Value) {
    let app =
        meologue_server::router_with_reflection(pool.clone(), empty_static_dir(), None, reflect);
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

    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let json = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap()
    };
    (status, json)
}

/// Percent-encodes `value` for use as a query-string parameter — just
/// enough to get a Search term with spaces, `%`, or other reserved
/// characters safely onto the wire in a test, mirroring what a real client
/// (`sessions-transport.ts`'s `URLSearchParams`) does automatically. Only
/// unreserved characters (RFC 3986) pass through unescaped.
fn percent_encode(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char);
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

/// `q: None` lists every Session unfiltered — today's behaviour. `q:
/// Some(term)` sends `?q=<term>` (percent-encoded), issue #64's Search
/// narrowing.
async fn list_sessions(
    pool: &PgPool,
    reflect: Option<ReflectState>,
    q: Option<&str>,
) -> (StatusCode, Value) {
    let app =
        meologue_server::router_with_reflection(pool.clone(), empty_static_dir(), None, reflect);
    let uri = match q {
        None => "/v1/sessions".to_string(),
        Some(term) => format!("/v1/sessions?q={}", percent_encode(term)),
    };
    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(uri)
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

async fn delete_session(pool: &PgPool, reflect: Option<ReflectState>, id: Uuid) -> StatusCode {
    let app =
        meologue_server::router_with_reflection(pool.clone(), empty_static_dir(), None, reflect);
    let response = app
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(format!("/v1/sessions/{id}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    response.status()
}

async fn insert_session(pool: &PgPool, id: Uuid, title: &str) {
    sqlx::query("insert into sessions (id, title) values ($1, $2)")
        .bind(id)
        .bind(title)
        .execute(pool)
        .await
        .unwrap();
}

/// Seeds a Session with explicit `created_at`/`updated_at`, rather than
/// letting both default to `now()` — the only way to pin `created_at` and
/// `updated_at` into two different orders, which `list_sessions_orders_by_updated_at_not_created_at`
/// below needs to actually prove the list orders by the right column.
async fn insert_session_with_times(
    pool: &PgPool,
    id: Uuid,
    title: &str,
    created_at: chrono::DateTime<chrono::Utc>,
    updated_at: chrono::DateTime<chrono::Utc>,
) {
    sqlx::query("insert into sessions (id, title, created_at, updated_at) values ($1, $2, $3, $4)")
        .bind(id)
        .bind(title)
        .bind(created_at)
        .bind(updated_at)
        .execute(pool)
        .await
        .unwrap();
}

/// Writes the pair of chained tree entries `sessions::record_turn_from_steps`
/// would append for the same simple, no-tool-call Turn. This test crate has
/// no access to that function's `pub(crate)` internals, so it replicates
/// the shape directly in SQL rather than reimplementing it —
/// `session_entries_append_and_read_back` and friends in
/// `server/src/sessions.rs`'s own `#[cfg(test)]` module are what actually
/// exercise `append_entry`. What matters here is only that `GET
/// /v1/sessions/{id}` — which reads the tree, the only representation a
/// Session has (issue #99 removed `session_turns`, the older one-row-per-Turn
/// table this helper used to write alongside the tree) — sees exactly the
/// Turns these tests seed.
async fn insert_turn(pool: &PgPool, session_id: Uuid, question: &str, answer: &str) {
    let leaf: Option<Uuid> = sqlx::query_scalar("select main_leaf_id from sessions where id = $1")
        .bind(session_id)
        .fetch_one(pool)
        .await
        .unwrap();

    let user_seq: i64 = sqlx::query_scalar(
        "update sessions set next_seq = next_seq + 1 where id = $1 returning next_seq - 1",
    )
    .bind(session_id)
    .fetch_one(pool)
    .await
    .unwrap();
    let user_entry_id = Uuid::new_v4();
    sqlx::query(
        "insert into session_entries (session_id, id, parent_id, seq, type, payload)
         values ($1, $2, $3, $4, 'message', $5)",
    )
    .bind(session_id)
    .bind(user_entry_id)
    .bind(leaf)
    .bind(user_seq)
    .bind(serde_json::json!({"role": "user", "text": question}))
    .execute(pool)
    .await
    .unwrap();

    let assistant_seq: i64 = sqlx::query_scalar(
        "update sessions set next_seq = next_seq + 1 where id = $1 returning next_seq - 1",
    )
    .bind(session_id)
    .fetch_one(pool)
    .await
    .unwrap();
    let assistant_entry_id = Uuid::new_v4();
    sqlx::query(
        "insert into session_entries (session_id, id, parent_id, seq, type, payload)
         values ($1, $2, $3, $4, 'message', $5)",
    )
    .bind(session_id)
    .bind(assistant_entry_id)
    .bind(user_entry_id)
    .bind(assistant_seq)
    .bind(serde_json::json!({
        "role": "assistant",
        "text": answer,
        "grounding_entry_ids": Vec::<Uuid>::new(),
    }))
    .execute(pool)
    .await
    .unwrap();

    sqlx::query("update sessions set main_leaf_id = $1 where id = $2")
        .bind(assistant_entry_id)
        .bind(session_id)
        .execute(pool)
        .await
        .unwrap();
}

/// Appends one tree entry onto whatever a Session's `main_leaf_id` currently
/// is, and moves the leaf onto it — the same chaining `append_entry`/
/// `record_turn_from_steps` do, reimplemented in raw SQL for the same reason
/// `insert_turn` above is: this test crate has no access to `sessions.rs`'s
/// `pub(crate)` internals. Returns the new entry's id, so a caller building
/// a multi-step run (a tool call, a tool result, a real answer) can chain
/// each one onto the last without re-deriving `main_leaf_id` itself.
async fn append_tree_entry(pool: &PgPool, session_id: Uuid, payload: Value) -> Uuid {
    let leaf: Option<Uuid> = sqlx::query_scalar("select main_leaf_id from sessions where id = $1")
        .bind(session_id)
        .fetch_one(pool)
        .await
        .unwrap();
    let seq: i64 = sqlx::query_scalar(
        "update sessions set next_seq = next_seq + 1 where id = $1 returning next_seq - 1",
    )
    .bind(session_id)
    .fetch_one(pool)
    .await
    .unwrap();
    let id = Uuid::new_v4();
    sqlx::query(
        "insert into session_entries (session_id, id, parent_id, seq, type, payload)
         values ($1, $2, $3, $4, 'message', $5)",
    )
    .bind(session_id)
    .bind(id)
    .bind(leaf)
    .bind(seq)
    .bind(payload)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query("update sessions set main_leaf_id = $1 where id = $2")
        .bind(id)
        .bind(session_id)
        .execute(pool)
        .await
        .unwrap();
    id
}

/// Carry-over from #96 pass 2, recorded on issue #99: a Turn answered from a
/// `read_digest` tool call must still say so — via `digest_source` on the
/// wire — after a page reload, not just while the browser session that
/// asked is still open. Before this ticket, `GET /v1/sessions/{id}` returned
/// `SessionTurnRow` with no per-tool detail at all, so a Turn shaped exactly
/// like this one — a tool call, a `tool_result` tagged `"source": "digest"`
/// (`harness/tools/read_digest.rs`'s own shape), then the real answer — read
/// back indistinguishable from an ordinary Entry-grounded Turn: this test
/// would have failed to compile against the pre-#99 `SessionTurnRow` (no
/// `digest_source` field existed to assert on at all), and would have
/// failed at runtime against the pre-#99 `GET /v1/sessions/{id}`, which had
/// nowhere in its response to carry this.
#[sqlx::test]
async fn a_digest_sourced_turn_reads_back_with_its_digest_source_after_reload(pool: PgPool) {
    let session_id = Uuid::new_v4();
    insert_session(&pool, session_id, "How did the flat move go?").await;

    append_tree_entry(
        &pool,
        session_id,
        serde_json::json!({"role": "user", "text": "And what about the month before?"}),
    )
    .await;
    append_tree_entry(
        &pool,
        session_id,
        serde_json::json!({
            "role": "assistant",
            "text": "[calling read_digest]",
            "grounding_entry_ids": Vec::<Uuid>::new(),
        }),
    )
    .await;
    append_tree_entry(
        &pool,
        session_id,
        serde_json::json!({
            "role": "tool_result",
            "text": "Digest for 2026-07-01 to 2026-07-31: ...",
            "tool_name": "read_digest",
            "is_error": false,
            "details": {
                "source": "digest",
                "period": "month",
                "period_start": "2026-07-01",
                "period_end": "2026-07-31",
            },
        }),
    )
    .await;
    append_tree_entry(
        &pool,
        session_id,
        serde_json::json!({
            "role": "assistant",
            "text": "The month before was quieter — mostly settling in.",
            "grounding_entry_ids": Vec::<Uuid>::new(),
        }),
    )
    .await;

    let (status, body) = get_session(&pool, Some(reflect_state()), session_id).await;

    assert_eq!(status, StatusCode::OK);
    let turns = body["turns"].as_array().unwrap();
    assert_eq!(turns.len(), 1);
    assert_eq!(
        turns[0]["digest_source"],
        serde_json::json!({
            "period": "month",
            "period_start": "2026-07-01",
            "period_end": "2026-07-31",
        }),
        "a Turn answered from a Digest must still say so after the read that survives a reload"
    );
}

/// The mirror of the case above: a Turn whose tool calls never touched
/// `read_digest` at all must read back with no `digest_source` — the field
/// is `None`, not a guess or a leftover from a different Turn in the same
/// Conversation.
#[sqlx::test]
async fn a_turn_with_no_digest_tool_call_reads_back_with_no_digest_source(pool: PgPool) {
    let session_id = Uuid::new_v4();
    insert_session(&pool, session_id, "How has my knee been?").await;
    insert_turn(
        &pool,
        session_id,
        "How has my knee been?",
        "It's been a recurring issue since February.",
    )
    .await;

    let (status, body) = get_session(&pool, Some(reflect_state()), session_id).await;

    assert_eq!(status, StatusCode::OK);
    let turns = body["turns"].as_array().unwrap();
    assert_eq!(turns.len(), 1);
    assert_eq!(turns[0]["digest_source"], serde_json::Value::Null);
}

/// The whole point of a server-held Conversation (`docs/adr/0025`): a
/// client that opens a Session must see its Turns in the order they were
/// actually asked, not insertion order or `created_at` order — `seq`
/// (server-assigned, ticket 8) is what `load_turns` orders by.
#[sqlx::test]
async fn turns_come_back_oldest_first(pool: PgPool) {
    let session_id = Uuid::new_v4();
    insert_session(&pool, session_id, "How has my knee been?").await;
    insert_turn(
        &pool,
        session_id,
        "How has my knee been?",
        "It's been a recurring issue since February.",
    )
    .await;
    insert_turn(
        &pool,
        session_id,
        "Did it start with physical therapy?",
        "Yes, it started in March.",
    )
    .await;

    let (status, body) = get_session(&pool, Some(reflect_state()), session_id).await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["id"], session_id.to_string());
    assert_eq!(body["title"], "How has my knee been?");
    let turns = body["turns"].as_array().unwrap();
    assert_eq!(turns.len(), 2);
    assert_eq!(turns[0]["question"], "How has my knee been?");
    assert_eq!(
        turns[0]["answer"],
        "It's been a recurring issue since February."
    );
    assert_eq!(turns[1]["question"], "Did it start with physical therapy?");
    assert_eq!(turns[1]["answer"], "Yes, it started in March.");
}

#[sqlx::test]
async fn an_unknown_session_id_is_a_404(pool: PgPool) {
    let (status, _) = get_session(&pool, Some(reflect_state()), Uuid::new_v4()).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

/// `/v1/sessions/{id}` is gated on Reflection being configured, the same
/// way `/v1/reflect` itself is (`lib.rs`'s `reflect.is_some()` block) — a
/// Server with no chat model configured never created a Session in the
/// first place, so it should 404 exactly like an older Server that never
/// had the route, not fall through to the SPA app shell.
#[sqlx::test]
async fn the_route_is_absent_when_chat_is_unconfigured(pool: PgPool) {
    let (status, _) = get_session(&pool, None, Uuid::new_v4()).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

/// `session_entries.session_id references sessions(id) on delete cascade`
/// (migration `0006`) — exercised directly against Postgres rather than
/// through `DELETE /v1/sessions/{id}`, so this proves the foreign key
/// itself is wired the way the migration claims, independent of the
/// handler built on top of it.
/// `the_delete_endpoint_removes_the_session_and_cascades_its_turns` below
/// exercises the same cascade through the real endpoint.
#[sqlx::test]
async fn deleting_a_session_cascades_its_turns(pool: PgPool) {
    let session_id = Uuid::new_v4();
    insert_session(&pool, session_id, "Anything?").await;
    insert_turn(&pool, session_id, "Anything?", "Not much.").await;

    let entry_count_before: i64 =
        sqlx::query_scalar("select count(*) from session_entries where session_id = $1")
            .bind(session_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(entry_count_before, 2);

    sqlx::query("delete from sessions where id = $1")
        .bind(session_id)
        .execute(&pool)
        .await
        .unwrap();

    let entry_count_after: i64 =
        sqlx::query_scalar("select count(*) from session_entries where session_id = $1")
            .bind(session_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(entry_count_after, 0);
}

/// `GET /v1/sessions` orders newest-first by `updated_at` — the column
/// `record_turn` bumps on every appended Turn — not by `created_at`. Seeded
/// so the two orders actually disagree: the Session created first is the
/// one updated most recently, so a list that (bug) ordered by `created_at`
/// would come back in the wrong order and this test would catch it.
#[sqlx::test]
async fn list_sessions_orders_by_updated_at_not_created_at(pool: PgPool) {
    use chrono::{Duration, Utc};

    let now = Utc::now();
    let older_id = Uuid::new_v4();
    let newer_id = Uuid::new_v4();

    // Created first, but touched most recently.
    insert_session_with_times(
        &pool,
        older_id,
        "Created first, used most recently",
        now - Duration::hours(2),
        now,
    )
    .await;
    // Created second, but never touched again since.
    insert_session_with_times(
        &pool,
        newer_id,
        "Created second, not used since",
        now - Duration::hours(1),
        now - Duration::hours(1),
    )
    .await;
    // Issue #108: `list_sessions`'s unfiltered branch now excludes a
    // Session with no entries at all — neither of the two above would
    // appear in the list without this, which would make this test prove
    // nothing about ordering. `insert_turn` never touches `updated_at`
    // itself, so the pinned times above are unaffected.
    insert_turn(&pool, older_id, "Q", "A").await;
    insert_turn(&pool, newer_id, "Q", "A").await;

    let (status, body) = list_sessions(&pool, Some(reflect_state()), None).await;

    assert_eq!(status, StatusCode::OK);
    let sessions = body.as_array().unwrap();
    assert_eq!(sessions.len(), 2);
    assert_eq!(sessions[0]["id"], older_id.to_string());
    assert_eq!(sessions[1]["id"], newer_id.to_string());
}

/// No Sessions exist yet is an ordinary, empty list — `200 []` — not a 404.
#[sqlx::test]
async fn an_empty_session_table_is_200_empty_list(pool: PgPool) {
    let (status, body) = list_sessions(&pool, Some(reflect_state()), None).await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body.as_array().unwrap().len(), 0);
}

/// Issue #108: `reflect.rs::resolve_session` now mints a Session's `sessions`
/// row up front, before the run it belongs to even starts — so a request
/// that resolves a Session and then fails before ever producing an Answer
/// can leave a real, committed Session with no entries at all behind
/// (`sessions.rs`'s own doc comment on `create_session`). `docs/adr/0025`'s
/// guarantee — "a Session holding an empty Conversation is unrepresentable"
/// — is kept exactly where a client would actually observe it breaking:
/// neither list shape may ever show such a Session, even though the row
/// itself is real. The unfiltered branch needs an explicit guard for this
/// (`list_sessions`'s own doc comment); the search branch already joins
/// `session_entries` to match at all, so a Session with none can never
/// produce a matching row to begin with — proven here too, rather than
/// assumed.
#[sqlx::test]
async fn a_session_with_no_entries_is_absent_from_both_list_shapes(pool: PgPool) {
    let empty_id = Uuid::new_v4();
    insert_session(&pool, empty_id, "Never answered").await;

    let real_id = Uuid::new_v4();
    insert_session(&pool, real_id, "How has my knee been?").await;
    insert_turn(
        &pool,
        real_id,
        "How has my knee been?",
        "It's been a recurring issue since February.",
    )
    .await;

    let (status, body) = list_sessions(&pool, Some(reflect_state()), None).await;
    assert_eq!(status, StatusCode::OK);
    let ids: Vec<String> = body
        .as_array()
        .unwrap()
        .iter()
        .map(|session| session["id"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(
        ids,
        vec![real_id.to_string()],
        "the entry-less Session must never appear in the unfiltered list: {body:?}"
    );

    let (status, body) = list_sessions(&pool, Some(reflect_state()), Some("Never")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body.as_array().unwrap().len(),
        0,
        "the search branch already joins session_entries, so it excludes an entry-less \
         Session even though its own title matches the term: {body:?}"
    );
}

/// `/v1/sessions` is gated on Reflection being configured, exactly like
/// `/v1/sessions/{id}` (`lib.rs`'s `reflect.is_some()` block) — a Server
/// with no chat model configured never created a Session in the first
/// place, so it should 404 exactly like an older Server that never had the
/// route, not fall through to the SPA app shell.
#[sqlx::test]
async fn the_list_route_is_absent_when_chat_is_unconfigured(pool: PgPool) {
    let (status, _) = list_sessions(&pool, None, None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

/// `DELETE /v1/sessions/{id}` (issue #63): `204`, the Session is gone from
/// `GET /v1/sessions`, and — proving the cascade through the real endpoint
/// rather than assuming it from the foreign key alone — its tree entries
/// are gone from `session_entries` too, queried directly.
#[sqlx::test]
async fn the_delete_endpoint_removes_the_session_and_cascades_its_turns(pool: PgPool) {
    let session_id = Uuid::new_v4();
    insert_session(&pool, session_id, "Anything?").await;
    insert_turn(&pool, session_id, "Anything?", "Not much.").await;

    let status = delete_session(&pool, Some(reflect_state()), session_id).await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let (list_status, list_body) = list_sessions(&pool, Some(reflect_state()), None).await;
    assert_eq!(list_status, StatusCode::OK);
    assert!(
        list_body
            .as_array()
            .unwrap()
            .iter()
            .all(|session| session["id"] != session_id.to_string()),
        "the deleted Session must not still be in the list"
    );

    let entry_count: i64 =
        sqlx::query_scalar("select count(*) from session_entries where session_id = $1")
            .bind(session_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(entry_count, 0);
}

/// Deleting an id that names no Session is a 404, not a 204 — so a client
/// can tell "I just deleted it" from "it was already gone."
#[sqlx::test]
async fn deleting_an_unknown_session_id_is_a_404(pool: PgPool) {
    let status = delete_session(&pool, Some(reflect_state()), Uuid::new_v4()).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

/// `DELETE /v1/sessions/{id}` is gated on Reflection being configured,
/// exactly like the `GET` routes above (`lib.rs`'s `reflect.is_some()`
/// block) — a Server with no chat model configured never created a Session
/// in the first place, so it should 404 exactly like an older Server that
/// never had the route.
#[sqlx::test]
async fn the_delete_route_is_absent_when_chat_is_unconfigured(pool: PgPool) {
    let status = delete_session(&pool, None, Uuid::new_v4()).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

/// Issue #64: `?q=` must match the full text of a Turn's Answer, not just
/// the Session's title — a word that appears only in what Reflection said
/// back, never in the Question that was typed.
#[sqlx::test]
async fn a_word_found_only_in_an_answer_finds_its_session(pool: PgPool) {
    let session_id = Uuid::new_v4();
    insert_session(&pool, session_id, "How has my knee been?").await;
    insert_turn(
        &pool,
        session_id,
        "How has my knee been?",
        "It's been a recurring issue since February.",
    )
    .await;

    let (status, body) = list_sessions(&pool, Some(reflect_state()), Some("recurring")).await;

    assert_eq!(status, StatusCode::OK);
    let sessions = body.as_array().unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0]["id"], session_id.to_string());
}

/// Issue #64: `?q=` must also match a Turn's Question — the title alone
/// (a truncated first Question) is not enough, and this proves the full
/// Question text is searched too, not only the Answer.
#[sqlx::test]
async fn a_word_found_only_in_a_question_finds_its_session(pool: PgPool) {
    let session_id = Uuid::new_v4();
    insert_session(&pool, session_id, "Anything about the flat move?").await;
    insert_turn(
        &pool,
        session_id,
        "Did the physical therapy for my knee help?",
        "Yes, noticeably.",
    )
    .await;

    let (status, body) =
        list_sessions(&pool, Some(reflect_state()), Some("physical therapy")).await;

    assert_eq!(status, StatusCode::OK);
    let sessions = body.as_array().unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0]["id"], session_id.to_string());
}

/// Issue #64: matching is case-insensitive.
#[sqlx::test]
async fn search_is_case_insensitive(pool: PgPool) {
    let session_id = Uuid::new_v4();
    insert_session(&pool, session_id, "How has my knee been?").await;
    insert_turn(
        &pool,
        session_id,
        "How has my knee been?",
        "It's been a RECURRING issue since February.",
    )
    .await;

    let (status, body) = list_sessions(&pool, Some(reflect_state()), Some("recurring")).await;

    assert_eq!(status, StatusCode::OK);
    let sessions = body.as_array().unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0]["id"], session_id.to_string());
}

/// Issue #64: a term matching nothing in any Session's Conversation returns
/// an empty list — not an error, and not the unfiltered list.
#[sqlx::test]
async fn a_non_matching_term_returns_an_empty_list(pool: PgPool) {
    let session_id = Uuid::new_v4();
    insert_session(&pool, session_id, "How has my knee been?").await;
    insert_turn(
        &pool,
        session_id,
        "How has my knee been?",
        "It's been a recurring issue since February.",
    )
    .await;

    let (status, body) = list_sessions(&pool, Some(reflect_state()), Some("flat move")).await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body.as_array().unwrap().len(), 0);
}

/// Issue #64: an absent or empty/whitespace-only `q` is identical to
/// today's behaviour — the full, unfiltered list.
#[sqlx::test]
async fn empty_or_whitespace_q_returns_everything(pool: PgPool) {
    let session_id = Uuid::new_v4();
    insert_session(&pool, session_id, "How has my knee been?").await;
    insert_turn(
        &pool,
        session_id,
        "How has my knee been?",
        "It's been a recurring issue since February.",
    )
    .await;

    let (status, body) = list_sessions(&pool, Some(reflect_state()), Some("")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body.as_array().unwrap().len(), 1);

    let (status, body) = list_sessions(&pool, Some(reflect_state()), Some("   ")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body.as_array().unwrap().len(), 1);

    let (status, body) = list_sessions(&pool, Some(reflect_state()), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body.as_array().unwrap().len(), 1);
}

/// Issue #64: a Session matches if ANY of its Turns matches, but must come
/// back exactly once — not once per matching Turn. Seeded with a single
/// Turn whose Question *and* Answer both contain the term, which is exactly
/// the shape that would produce a duplicate row if the join weren't
/// deduplicated.
#[sqlx::test]
async fn a_session_with_two_matching_turns_appears_once(pool: PgPool) {
    let session_id = Uuid::new_v4();
    insert_session(&pool, session_id, "How has my knee been?").await;
    insert_turn(
        &pool,
        session_id,
        "How has my knee been since the injury?",
        "The injury has mostly healed.",
    )
    .await;
    insert_turn(
        &pool,
        session_id,
        "Anything else about the injury?",
        "Not since the last injury update.",
    )
    .await;

    let (status, body) = list_sessions(&pool, Some(reflect_state()), Some("injury")).await;

    assert_eq!(status, StatusCode::OK);
    let sessions = body.as_array().unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0]["id"], session_id.to_string());
}

/// Issue #64: `%` must be treated as a literal character in the search
/// term, not as `ILIKE`'s wildcard — otherwise a search for a literal
/// percent sign would match every Session's every Turn instead of only the
/// one that actually contains one.
#[sqlx::test]
async fn percent_is_treated_literally(pool: PgPool) {
    let matching_id = Uuid::new_v4();
    insert_session(&pool, matching_id, "Any progress?").await;
    insert_turn(&pool, matching_id, "Any progress?", "About 50% done.").await;

    let other_id = Uuid::new_v4();
    insert_session(&pool, other_id, "Anything else?").await;
    insert_turn(&pool, other_id, "Anything else?", "Not much to report.").await;

    let (status, body) = list_sessions(&pool, Some(reflect_state()), Some("50%")).await;

    assert_eq!(status, StatusCode::OK);
    let sessions = body.as_array().unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0]["id"], matching_id.to_string());
}
