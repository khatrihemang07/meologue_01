//! `GET /v1/sessions/{id}` — fetches one Session and its whole Conversation,
//! oldest Turn first. This is a fetch you make when you open a Session, not
//! a background loop with a Cursor (`docs/adr/0025`): unlike `/v1/sync`,
//! there is no incremental "what's new since" shape here.
//!
//! This module also holds the row types and SQL `reflect.rs` uses to load a
//! Session's prior Turns before asking, and to persist a new Turn (creating
//! the Session first if it doesn't exist yet) once an Answer succeeds —
//! kept here rather than duplicated in `reflect.rs` so there is exactly one
//! place that knows the shape of `sessions`/`session_turns`.
//!
//! Only the one read endpoint exists yet. Listing, searching and deleting
//! Sessions are separate, later tickets.

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::{FromRow, PgPool};
use utoipa::ToSchema;
use uuid::Uuid;

/// A Session's own row — everything about it except its Turns.
#[derive(Debug, Clone, FromRow)]
pub(crate) struct SessionRow {
    pub id: Uuid,
    pub title: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// One Question/Answer pair persisted inside a Session, as loaded from
/// `session_turns` — oldest first (`load_turns` orders by `seq asc`). This
/// is also what `reflect.rs`'s `build_messages` takes a slice of in place
/// of the wire's old `PriorTurn`, and it doubles as the wire shape for one
/// entry of `SessionResponse::turns` below — the same fields both a
/// follow-up Question's prompt and a client restoring a Conversation need.
#[derive(Debug, Clone, FromRow, Serialize, ToSchema)]
pub struct SessionTurnRow {
    pub question: String,
    pub answer: String,
    pub grounding_entry_ids: Vec<Uuid>,
    pub grounded: bool,
    pub fallback_used: bool,
    pub created_at: DateTime<Utc>,
}

/// One Question/Answer pair `reflect.rs::run_reflect` is about to persist —
/// built only after a successful Answer exists (`record_turn`'s doc
/// comment), never before.
pub(crate) struct NewTurn {
    pub question: String,
    pub answer: String,
    pub grounding_entry_ids: Vec<Uuid>,
    pub grounded: bool,
    pub fallback_used: bool,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct SessionResponse {
    pub id: Uuid,
    pub title: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    /// Oldest first — the order a Conversation was actually lived in, and
    /// the order `reflect.rs` replays Turns into a follow-up Question's
    /// prompt.
    pub turns: Vec<SessionTurnRow>,
}

#[utoipa::path(
    get,
    path = "/v1/sessions/{id}",
    params(("id" = Uuid, Path, description = "The Session's id")),
    responses(
        (status = 200, description = "The Session and its whole Conversation, oldest Turn first", body = SessionResponse),
        (status = 404, description = "No Session with this id exists"),
    )
)]
pub async fn get_session_handler(
    State(pool): State<PgPool>,
    Path(id): Path<Uuid>,
) -> Result<Json<SessionResponse>, StatusCode> {
    match run_get_session(&pool, id).await {
        Ok(Some(response)) => Ok(Json(response)),
        Ok(None) => Err(StatusCode::NOT_FOUND),
        Err(err) => {
            tracing::error!(error = ?err, session_id = %id, "loading session failed");
            Err(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

async fn run_get_session(pool: &PgPool, id: Uuid) -> anyhow::Result<Option<SessionResponse>> {
    let Some(session) = find_session(pool, id).await? else {
        return Ok(None);
    };
    let turns = load_turns(pool, id).await?;
    Ok(Some(SessionResponse {
        id: session.id,
        title: session.title,
        created_at: session.created_at,
        updated_at: session.updated_at,
        turns,
    }))
}

/// `None` means exactly "no Session with this id" — never an error on its
/// own. `reflect.rs` uses this to turn an unknown `session_id` on
/// `/v1/reflect` into a clean 404 rather than a 500, the same way this
/// module's own `get_session_handler` does.
pub(crate) async fn find_session(pool: &PgPool, id: Uuid) -> anyhow::Result<Option<SessionRow>> {
    let row = sqlx::query_as::<_, SessionRow>(
        "select id, title, created_at, updated_at from sessions where id = $1",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

/// Every Turn for one Session, oldest first — empty for a Session with no
/// Turns, which should never happen for a real Session id (`record_turn`
/// never creates a Session without one) but is not this function's job to
/// enforce.
pub(crate) async fn load_turns(
    pool: &PgPool,
    session_id: Uuid,
) -> anyhow::Result<Vec<SessionTurnRow>> {
    let turns = sqlx::query_as::<_, SessionTurnRow>(
        "select question, answer, grounding_entry_ids, grounded, fallback_used, created_at
         from session_turns
         where session_id = $1
         order by seq asc",
    )
    .bind(session_id)
    .fetch_all(pool)
    .await?;
    Ok(turns)
}

/// Persists `turn` inside a single transaction, creating the Session first
/// when `session_id` is `None` — the *only* place a Session or a Turn is
/// ever written, and only ever called by `reflect.rs::run_reflect` after a
/// successful Answer already exists. Any failure here (a dropped
/// connection, a constraint violation) rolls the whole transaction back, so
/// a failed ask can never leave a half-written Session or an orphaned Turn
/// behind — see CONTEXT.md's Session entry: "a Session can never exist
/// holding an empty Conversation."
///
/// `title` is used only when minting a new Session — an existing Session's
/// title is immutable once set (CONTEXT.md: "a title taken from its first
/// Question"), so a follow-up Question never overwrites it.
///
/// Returns the Session's id: freshly minted for a new Session, or
/// `session_id` unchanged for an existing one.
pub(crate) async fn record_turn(
    pool: &PgPool,
    session_id: Option<Uuid>,
    title: &str,
    turn: NewTurn,
) -> anyhow::Result<Uuid> {
    let mut tx = pool.begin().await?;

    let session_id = match session_id {
        Some(id) => {
            sqlx::query("update sessions set updated_at = now() where id = $1")
                .bind(id)
                .execute(&mut *tx)
                .await?;
            id
        }
        None => {
            let id = Uuid::new_v4();
            sqlx::query("insert into sessions (id, title) values ($1, $2)")
                .bind(id)
                .bind(title)
                .execute(&mut *tx)
                .await?;
            id
        }
    };

    sqlx::query(
        "insert into session_turns
            (id, session_id, question, answer, grounding_entry_ids, grounded, fallback_used)
         values ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(Uuid::new_v4())
    .bind(session_id)
    .bind(&turn.question)
    .bind(&turn.answer)
    .bind(&turn.grounding_entry_ids)
    .bind(turn.grounded)
    .bind(turn.fallback_used)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(session_id)
}
