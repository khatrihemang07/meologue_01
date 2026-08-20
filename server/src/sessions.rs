//! `GET /v1/sessions/{id}` — fetches one Session and its whole Conversation,
//! oldest Turn first. This is a fetch you make when you open a Session, not
//! a background loop with a Cursor (`docs/adr/0025`): unlike `/v1/sync`,
//! there is no incremental "what's new since" shape here.
//!
//! `GET /v1/sessions` (ticket 62) lists every Session's own row — no
//! Turns, so it stays cheap regardless of how long any one Conversation
//! has grown — newest first by `updated_at`, the column `record_turn` bumps
//! on every appended Turn. An optional `?q=` (issue #64) narrows that list
//! to Sessions whose Conversation — the full text of every Turn's Question
//! and Answer inside `session_turns`, not just the Session's title —
//! contains the given text, case-insensitively. A title is only a
//! truncated first Question (CONTEXT.md's Session entry), so matching the
//! title alone would find a Session by how it opened and by nothing it
//! went on to discuss. This is Search (CONTEXT.md): plain SQL `ILIKE`
//! against Postgres, deliberately not the vector search `reflect.rs` uses
//! to find Grounding for a Question — that exists to answer a different
//! question ("what's relevant to this Question") and reusing it here would
//! blur the two jobs and mean embedding every Question and Answer into a
//! queue that exists for Entries.
//!
//! `DELETE /v1/sessions/{id}` (issue #63) removes a Session outright.
//! `session_turns.session_id references sessions(id) on delete cascade`
//! (migration `0003`) does the rest — deleting the Session row is enough to
//! take every Turn inside it with it, so this handler issues exactly one
//! `delete from sessions` and nothing against `session_turns` directly.
//! Deleting an id that doesn't exist is a 404, the same as `GET
//! /v1/sessions/{id}` — so a client can tell "already gone" (someone else
//! deleted it, or it never existed) from "I just deleted it."
//!
//! This module also holds the row types and SQL `reflect.rs` uses to load a
//! Session's prior Turns before asking, and to persist a new Turn (creating
//! the Session first if it doesn't exist yet) once an Answer succeeds —
//! kept here rather than duplicated in `reflect.rs` so there is exactly one
//! place that knows the shape of `sessions`/`session_turns`.

use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool};
use utoipa::{IntoParams, ToSchema};
use uuid::Uuid;

/// A Session's own row — everything about it except its Turns. `Serialize`
/// and `ToSchema` earn their keep here (rather than living on a
/// list-only-shaped twin) because this is *exactly* the wire shape
/// `list_sessions_handler` returns for each Session: id, title,
/// created_at, updated_at, nothing else — the same fields `SessionResponse`
/// embeds alongside `turns` for the single-Session fetch.
#[derive(Debug, Clone, FromRow, Serialize, ToSchema)]
pub struct SessionRow {
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

/// Deletes a Session outright — the id itself, not its Turns, which
/// `session_turns_session_id_fkey`'s `on delete cascade` (migration `0003`)
/// removes as a consequence of this one statement. `204 No Content` on
/// success, `404` when `id` names no Session — never a distinct "already
/// deleted" status, since from the Server's point of view those are the
/// same fact: there's nothing at `id` to delete.
#[utoipa::path(
    delete,
    path = "/v1/sessions/{id}",
    params(("id" = Uuid, Path, description = "The Session's id")),
    responses(
        (status = 204, description = "The Session, and every Turn inside it, is gone"),
        (status = 404, description = "No Session with this id exists"),
    )
)]
pub async fn delete_session_handler(
    State(pool): State<PgPool>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, StatusCode> {
    match run_delete_session(&pool, id).await {
        Ok(true) => Ok(StatusCode::NO_CONTENT),
        Ok(false) => Err(StatusCode::NOT_FOUND),
        Err(err) => {
            tracing::error!(error = ?err, session_id = %id, "deleting session failed");
            Err(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

/// Returns whether a row actually existed to delete — `rows_affected() ==
/// 0` is exactly "no Session with this id," the same distinction
/// `find_session`'s `Option` draws for the read side, just shaped for a
/// statement that has no row to return.
async fn run_delete_session(pool: &PgPool, id: Uuid) -> anyhow::Result<bool> {
    let result = sqlx::query("delete from sessions where id = $1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(result.rows_affected() > 0)
}

/// The optional `?q=` query string (issue #64). `None` and `Some("")` (and
/// whitespace-only) are all treated identically by `list_sessions` below —
/// every shape a client could send for "no filter" collapses to the same
/// unfiltered list, matching today's behaviour before this ticket.
#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct ListSessionsQuery {
    q: Option<String>,
}

#[utoipa::path(
    get,
    path = "/v1/sessions",
    params(ListSessionsQuery),
    responses(
        (status = 200, description = "Every Session the Server holds whose Conversation matches `q` (or every Session, when `q` is absent or blank), newest first by when it was last used", body = Vec<SessionRow>),
    )
)]
pub async fn list_sessions_handler(
    State(pool): State<PgPool>,
    Query(query): Query<ListSessionsQuery>,
) -> Result<Json<Vec<SessionRow>>, StatusCode> {
    match list_sessions(&pool, query.q.as_deref()).await {
        Ok(sessions) => Ok(Json(sessions)),
        Err(err) => {
            tracing::error!(error = ?err, "listing sessions failed");
            Err(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

/// Every Session's own row, newest first by `updated_at` — the column
/// `record_turn` bumps on every appended Turn, so "newest" here means
/// "most recently used," not "most recently created." No Turns are loaded;
/// a list of every Session's whole Conversation would be unbounded in a
/// way one Session's fetch (`load_turns`) never is. An empty table returns
/// an empty `Vec`, not an error — there is no such thing as "no Sessions
/// yet" as a failure.
///
/// `q` narrows the list to Sessions with at least one Turn (Question or
/// Answer) matching, case-insensitively (issue #64). Absent or
/// whitespace-only is exactly "no filter" — the same unfiltered query this
/// ran before the `q` param existed. `select distinct` on `s.*` is what
/// collapses a Session with two matching Turns (e.g. a Question and its own
/// Answer both containing the term) back down to one row: the join against
/// `session_turns` fans a Session out per matching Turn, and `distinct`
/// folds it back by the Session's own columns before `order by` sees it.
async fn list_sessions(pool: &PgPool, q: Option<&str>) -> anyhow::Result<Vec<SessionRow>> {
    let term = q.map(str::trim).filter(|term| !term.is_empty());
    let sessions =
        match term {
            None => sqlx::query_as::<_, SessionRow>(
                "select id, title, created_at, updated_at from sessions order by updated_at desc",
            )
            .fetch_all(pool)
            .await?,
            Some(term) => {
                let pattern = format!("%{}%", escape_like_pattern(term));
                sqlx::query_as::<_, SessionRow>(
                    "select distinct s.id, s.title, s.created_at, s.updated_at
                 from sessions s
                 join session_turns t on t.session_id = s.id
                 where t.question ilike $1 or t.answer ilike $1
                 order by s.updated_at desc",
                )
                .bind(pattern)
                .fetch_all(pool)
                .await?
            }
        };
    Ok(sessions)
}

/// Escapes `ILIKE`'s three special characters — `\`, `%`, `_` — in a
/// user-typed Search term before it's wrapped in `%…%` and bound as the
/// pattern. Postgres's `LIKE`/`ILIKE` already use `\` as their escape
/// character by default, so a literal backslash in the term needs escaping
/// too, or it could turn the very `%`/`_` escape this function just added
/// back into a wildcard. Without this, a term containing a literal `%`
/// would match every Session's every Turn instead of Sessions that actually
/// contain a percent sign — the one behaviour issue #64 calls out by name.
fn escape_like_pattern(term: &str) -> String {
    let mut escaped = String::with_capacity(term.len());
    for ch in term.chars() {
        if matches!(ch, '\\' | '%' | '_') {
            escaped.push('\\');
        }
        escaped.push(ch);
    }
    escaped
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
