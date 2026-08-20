use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Result;
use async_trait::async_trait;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use meologue_server::llm::{ChatMessage, LlmClient};
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
    async fn chat(&self, _messages: &[ChatMessage]) -> Result<String> {
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
        embed_client: Arc::new(UnusedLlmClient),
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

async fn list_sessions(pool: &PgPool, reflect: Option<ReflectState>) -> (StatusCode, Value) {
    let app =
        meologue_server::router_with_reflection(pool.clone(), empty_static_dir(), None, reflect);
    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/v1/sessions")
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

/// `session_turns.session_id references sessions(id) on delete cascade` —
/// exercised directly against Postgres rather than through any endpoint,
/// since no delete endpoint exists yet (a later ticket's job); this only
/// proves the foreign key itself is wired the way the migration claims.
#[sqlx::test]
async fn deleting_a_session_cascades_its_turns(pool: PgPool) {
    let session_id = Uuid::new_v4();
    insert_session(&pool, session_id, "Anything?").await;
    insert_turn(&pool, session_id, "Anything?", "Not much.").await;

    let turn_count_before: i64 =
        sqlx::query_scalar("select count(*) from session_turns where session_id = $1")
            .bind(session_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(turn_count_before, 1);

    sqlx::query("delete from sessions where id = $1")
        .bind(session_id)
        .execute(&pool)
        .await
        .unwrap();

    let turn_count_after: i64 =
        sqlx::query_scalar("select count(*) from session_turns where session_id = $1")
            .bind(session_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(turn_count_after, 0);
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

    let (status, body) = list_sessions(&pool, Some(reflect_state())).await;

    assert_eq!(status, StatusCode::OK);
    let sessions = body.as_array().unwrap();
    assert_eq!(sessions.len(), 2);
    assert_eq!(sessions[0]["id"], older_id.to_string());
    assert_eq!(sessions[1]["id"], newer_id.to_string());
}

/// No Sessions exist yet is an ordinary, empty list — `200 []` — not a 404.
#[sqlx::test]
async fn an_empty_session_table_is_200_empty_list(pool: PgPool) {
    let (status, body) = list_sessions(&pool, Some(reflect_state())).await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body.as_array().unwrap().len(), 0);
}

/// `/v1/sessions` is gated on Reflection being configured, exactly like
/// `/v1/sessions/{id}` (`lib.rs`'s `reflect.is_some()` block) — a Server
/// with no chat model configured never created a Session in the first
/// place, so it should 404 exactly like an older Server that never had the
/// route, not fall through to the SPA app shell.
#[sqlx::test]
async fn the_list_route_is_absent_when_chat_is_unconfigured(pool: PgPool) {
    let (status, _) = list_sessions(&pool, None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}
