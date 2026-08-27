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
//!
//! ## The entry tree (issue #91)
//!
//! Underneath the Turn shape above, a Session is really an append-only tree
//! of entries (`session_entries`, migration `0006`) — the shape a harness
//! needs, where the model speaks, calls a tool, reads a result, and speaks
//! again, none of which fits "one Question, one Answer." This is the
//! expand half of an expand-and-contract: `session_turns` stays exactly as
//! it was (issue #64's Search still queries it directly), `record_turn`
//! now writes *both* shapes in one transaction, and `load_turns` — used by
//! both `GET /v1/sessions/{id}` and `reflect.rs`'s prior-Turns read — now
//! rebuilds its answer by walking the tree rather than by reading
//! `session_turns`. Nothing here is removed until issue #99, the contract
//! half.
//!
//! A few names worth knowing before reading the functions below:
//!
//! - **`EntryRow`** is one row of `session_entries`: `parent_id` is the
//!   entry it was appended after (`null` for a root), and `payload` carries
//!   whatever `type` (`EntryType`) needs — a `message` entry's payload is a
//!   `MessagePayload`.
//! - **`walk_to_root`** is how a Conversation is actually read: starting
//!   from a Session's `main_leaf_id` and following `parent_id` back to a
//!   root, then reversing. This is deliberately not `order by seq` —
//!   `seq` alone can't tell a live lane from an abandoned fork once forking
//!   exists, even though this ticket exposes no interface that forks.
//! - **`project_from_last_compaction`** trims a walked path down to the
//!   last `compaction` entry on it (or leaves it untouched if there isn't
//!   one, which is every path today — issue #97 is what writes the first
//!   compaction).
//! - **`session_records`** is a separate, non-tree operation log —
//!   `append_record`/`load_records` — that this ticket writes and makes
//!   readable and nothing more. See its own doc comments for why entries
//!   and records share one `seq` counter.
//! - **`fork_session`** copies a root-to-node path into a new Session,
//!   preserving every copied entry's `id`. Nothing calls it outside tests
//!   yet — no HTTP route offers forking — which is why it stays
//!   `pub(crate)` rather than `pub`.

use std::collections::{HashMap, HashSet};

use anyhow::Context as _;
use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{FromRow, PgPool, Postgres, Transaction};
use utoipa::{IntoParams, ToSchema};
use uuid::Uuid;

use crate::reflect::ReflectState;

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
    /// Issue #103: whether this Turn's run called a tool at all, kept apart
    /// from `grounded` for the same reason `reflect::ReflectResponse::tool_called`
    /// is (see that field's own doc comment) — `grounding_entry_ids` alone
    /// cannot tell "a tool ran and found nothing" from "no tool ever ran."
    /// No column backs this on `session_turns`: it's derived, not stored —
    /// `entries_to_turns` computes it from whether a `tool_result` entry
    /// appears anywhere in the Turn's own run through the tree, the same
    /// tree `session_entries` already holds every tool call in
    /// (`harness::agent_loop::Step::ToolResult`, via
    /// `reflect.rs::build_tree_payloads`), rather than adding a second,
    /// independently-writable flag that a future write path could forget to
    /// set — the derivation precedent `docs/adr/0024` already set for
    /// `grounded` itself.
    pub tool_called: bool,
    /// Issue #98: the model that produced this Turn's Answer — never
    /// stored on the Turn itself (there is no `model` column on
    /// `session_turns`, and `record_turn`/`record_turn_from_steps` gained
    /// no new field either). Derived the same way `tool_called` above is:
    /// `entries_to_turns` tracks whichever model a `model_change` entry
    /// most recently named while it walks the tree, and stamps that value
    /// onto every Turn it finishes — see `ModelChangePayload`'s own doc
    /// comment for why that's the single source of truth this field reads
    /// from, rather than a second, independently-writable value. A Turn
    /// read off the pre-#91 `session_turns` fallback (`load_turns_from_session_turns`)
    /// has no tree to derive this from at all; it's set to `load_turns`'s
    /// own `default_model` there, which is simply true — every Turn that
    /// old only ever had one model to run on, the Server's sole configured
    /// one, because per-Conversation choice didn't exist yet.
    pub model: String,
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

/// The five kinds an entry in a Session's tree can be (migration `0006`'s
/// `session_entries.type` check constraint) — ported from pi's own entry
/// kinds. Issue #98 is what finally writes `ModelChange` (see
/// `ModelChangePayload`) and reads it back (`decode_model_change`,
/// `entries_to_turns`); `BranchSummary`/`Custom` still have no writer, so
/// `#[allow(dead_code)]` stays on those two only — the same reasoning the
/// original comment gave for all four still applies to them: the schema
/// shouldn't need a new migration the day something starts writing one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum EntryType {
    Message,
    ModelChange,
    Compaction,
    #[allow(dead_code)]
    BranchSummary,
    #[allow(dead_code)]
    Custom,
}

impl EntryType {
    fn as_str(self) -> &'static str {
        match self {
            EntryType::Message => "message",
            EntryType::ModelChange => "model_change",
            EntryType::Compaction => "compaction",
            EntryType::BranchSummary => "branch_summary",
            EntryType::Custom => "custom",
        }
    }
}

/// The six kinds a row in the operation log (`session_records`, migration
/// `0006`) can be — what the Server was *doing*, as distinct from what was
/// said. This ticket writes and reads this log as an audit trail only
/// (issue #91: "nothing resumes from it yet"), so nothing here does
/// anything with a record's `kind` beyond storing and returning it. No
/// production caller writes any record yet either — that's the harness
/// this ticket lays the storage for, not this ticket's own job — so this
/// whole type is exercised only by `append_record`'s own tests today.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RecordKind {
    OperationStarted,
    OperationFinished,
    StepAttempt,
    ToolStarted,
    AbortRequested,
    Usage,
}

impl RecordKind {
    #[allow(dead_code)]
    fn as_str(self) -> &'static str {
        match self {
            RecordKind::OperationStarted => "operation_started",
            RecordKind::OperationFinished => "operation_finished",
            RecordKind::StepAttempt => "step_attempt",
            RecordKind::ToolStarted => "tool_started",
            RecordKind::AbortRequested => "abort_requested",
            RecordKind::Usage => "usage",
        }
    }
}

/// One row of `session_entries` — a node in a Session's tree. `parent_id`
/// is `None` only for a root (the first thing ever said in a Session);
/// every other entry points at the entry it was appended after.
/// `entry_type` is `type`'s column value under a Rust-legal field name
/// (`type` is a keyword) — see `EntryType` for the fixed set of values it
/// actually holds, and `decode_message` for turning a `message` entry's
/// `payload` into a typed `MessagePayload`. `session_id` and `seq` are read
/// by every row this struct's own `FromRow` decodes (and by tests), but no
/// production code path reads them back off an already-loaded `EntryRow`
/// today — `walk_to_root` and `entries_to_turns` both work from `id` and
/// `parent_id` alone — hence the `#[allow(dead_code)]`.
#[allow(dead_code)]
#[derive(Debug, Clone, FromRow)]
pub(crate) struct EntryRow {
    pub session_id: Uuid,
    pub id: Uuid,
    pub parent_id: Option<Uuid>,
    pub seq: i64,
    pub entry_type: String,
    pub payload: Value,
    pub created_at: DateTime<Utc>,
}

/// One row of `session_records` — the operation log, not the tree. No
/// `parent_id`: a record doesn't have a "before it" the way an entry does,
/// only a `seq` (shared with `session_entries`, see `append_record`'s doc
/// comment) and a time it happened. Exercised only by `load_records`'s own
/// tests today — see `RecordKind`'s doc comment for why nothing production
/// writes one yet.
#[allow(dead_code)]
#[derive(Debug, Clone, FromRow)]
pub(crate) struct RecordRow {
    pub session_id: Uuid,
    pub id: Uuid,
    pub seq: i64,
    pub kind: String,
    pub payload: Value,
    pub created_at: DateTime<Utc>,
}

/// The type-specific shape a `message` entry's `payload` holds — tagged on
/// `role` so `serde_json` reads `{"role": "user", ...}` back into exactly
/// the variant that wrote it. `entries_to_turns` walks a run of these
/// looking for the *last* `Assistant` entry between one `User` entry and
/// the next (see that function's own doc comment for why "last", not
/// "immediately following" — issue #93 pass 2's loop can write several);
/// `ToolResult` was reserved for exactly the harness that now writes it
/// (`reflect.rs::build_tree_payloads`) — `tool_name`, `is_error` and
/// `details` are this ticket's own addition to what CONTEXT.md's
/// Conversation entry already admitted a harness could store: `details` in
/// particular is the structured half `harness::tools::ToolOutcome` carries,
/// which issue #93 is explicit the Conversation stores even though the
/// model itself never sees it.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "role", rename_all = "snake_case")]
pub(crate) enum MessagePayload {
    User {
        text: String,
    },
    Assistant {
        text: String,
        #[serde(default)]
        grounding_entry_ids: Vec<Uuid>,
        #[serde(default)]
        grounded: bool,
        #[serde(default)]
        fallback_used: bool,
    },
    ToolResult {
        text: String,
        #[serde(default)]
        tool_name: String,
        #[serde(default)]
        is_error: bool,
        #[serde(default)]
        details: Value,
    },
}

/// The type-specific shape a `model_change` entry's `payload` holds —
/// issue #98's own addition to the tree's fixed vocabulary of entry kinds
/// (`EntryType::ModelChange`, reserved but unwritten since migration
/// `0006`). `model` is the model id a Conversation moves onto from this
/// point forward: `entries_to_turns` treats every Turn it reads after this
/// entry, up to the next `model_change` (or the end of the path), as
/// having run on it — that's the whole mechanism behind "reading a
/// Conversation back shows which model produced which part," the
/// acceptance criterion issue #98 names directly. `reflect.rs` appends one
/// of these — chained into the same `payloads` list `build_tree_payloads`
/// already builds, immediately before the Question it precedes — whenever
/// the model a Turn is about to run under differs from whatever the
/// Conversation was already on; an unbroken run on one model needs no
/// entries here at all, which is exactly why a Session that never changes
/// models reads identically to how it always has.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub(crate) struct ModelChangePayload {
    pub model: String,
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
    State(reflect): State<Option<ReflectState>>,
    Path(id): Path<Uuid>,
) -> Result<Json<SessionResponse>, StatusCode> {
    // Issue #98: reading a Turn's `model` back (`SessionTurnRow::model`,
    // via `load_turns`) needs the Server's own configured default to
    // attribute a Turn that predates any `model_change` entry — the same
    // defensive fallback `reflect_handler`/`models_handler` already take
    // for this route's registration invariant (`lib.rs`: this route only
    // exists when `reflect.is_some()`), not the mechanism a client is
    // meant to observe.
    let Some(reflect) = reflect else {
        tracing::error!(
            "get_session_handler invoked with no ReflectState — route should not be registered"
        );
        return Err(StatusCode::NOT_FOUND);
    };
    match run_get_session(&pool, id, &reflect.chat_model).await {
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

async fn run_get_session(
    pool: &PgPool,
    id: Uuid,
    default_model: &str,
) -> anyhow::Result<Option<SessionResponse>> {
    let Some(session) = find_session(pool, id).await? else {
        return Ok(None);
    };
    let turns = load_turns(pool, id, default_model).await?;
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
///
/// Issue #91: this reads the *tree* when `session_id` has one —
/// `main_leaf_id` walked back to a root (`walk_to_root`), trimmed to
/// whatever lies at or after the last compaction on that path
/// (`project_from_last_compaction`, a no-op today since nothing writes a
/// compaction yet), and paired back into Turns (`entries_to_turns`). This
/// is what lets both callers of `load_turns` — `run_get_session` below and
/// `reflect.rs`'s prior-Turns read — see a forked Session's Turns
/// correctly: `fork_session` copies tree entries only, never
/// `session_turns` rows, so a `session_turns`-based read alone would see a
/// forked Session as having no Turns at all.
///
/// **A Session with no `main_leaf_id` falls back to reading `session_turns`
/// directly.** This is not a hedge — it is the correct answer for a real
/// state the database can be in: `record_turn` always writes both shapes
/// from this point on, and migration `0006`'s backfill gives every
/// pre-#91 Session a tree too, but a row written some other way (most
/// visibly, the direct `insert into session_turns` this module's own tests
/// and `reflect.rs`'s use to seed a Conversation without going through
/// `record_turn`, exactly as `insert_turn`/`insert_session_with_turns`
/// there do) has no entries at all. Falling back to `session_turns` for
/// exactly that case is what keeps `load_turns` telling the truth about
/// what a Session holds regardless of which path wrote it — and keeps
/// `reflect.rs`, which this ticket must leave unedited, seeing the
/// Conversations its own tests build the same way it always has.
///
/// `default_model` (issue #98) is the model to attribute a Turn to when
/// nothing in the tree says otherwise — the Server's own configured
/// default, `reflect::ReflectState::chat_model`. It seeds `entries_to_turns`'s
/// walk directly for a Session that has never changed models at all, and
/// also (via `model_before_projection`) for the Turns that survive a
/// compaction: `project_from_last_compaction` trims everything *before*
/// the compaction away, which would otherwise silently drop whatever
/// `model_change` entry was still in force at that point and misattribute
/// every Turn after it back to the default.
pub(crate) async fn load_turns(
    pool: &PgPool,
    session_id: Uuid,
    default_model: &str,
) -> anyhow::Result<Vec<SessionTurnRow>> {
    let Some(leaf_id) = session_main_leaf_id(pool, session_id).await? else {
        return load_turns_from_session_turns(pool, session_id, default_model).await;
    };
    let entries = load_entries(pool, session_id).await?;
    let path = walk_to_root(&entries, leaf_id)?;
    let seed_model = model_before_projection(&path, default_model)?;
    let projected = project_from_last_compaction(&path);
    entries_to_turns(&projected, &seed_model)
}

/// The summary text of the *last* compaction on `session_id`'s current
/// path, or `None` if it has never been compacted. Issue #97: without this,
/// a compaction's summary would only ever reach the one Question that
/// happened to trigger it (`reflect.rs::run_reflect_loop` prepends it as a
/// synthetic message that call alone) — every *later* Question would read
/// `load_turns`'s already-correctly-trimmed `prior_turns` (starting right
/// after the compaction) with no idea *why* the Conversation starts there,
/// silently losing everything the summary stood in for. Calling this on
/// every `/v1/reflect` request, not just the one where compaction fires, is
/// what keeps "reading a summarised Conversation starts from the summary"
/// true for every read, not just the first one after it happened.
///
/// Shares `load_turns`'s own walk-and-project logic (`project_from_last_compaction`
/// — literally the same call, since `entries_to_turns` and this function are
/// two different things to extract from the identical projected path)
/// rather than re-deriving it, and its own `None`-for-no-tree behaviour: a
/// Session with no entries yet has never been compacted, by construction.
pub(crate) async fn latest_compaction_summary(
    pool: &PgPool,
    session_id: Uuid,
) -> anyhow::Result<Option<String>> {
    let Some(leaf_id) = session_main_leaf_id(pool, session_id).await? else {
        return Ok(None);
    };
    let entries = load_entries(pool, session_id).await?;
    let path = walk_to_root(&entries, leaf_id)?;
    let projected = project_from_last_compaction(&path);

    match projected.first() {
        Some(entry) if entry.entry_type == EntryType::Compaction.as_str() => Ok(entry
            .payload
            .get("summary")
            .and_then(Value::as_str)
            .map(str::to_string)),
        _ => Ok(None),
    }
}

/// The exact columns `session_turns` itself carries — kept as its own row
/// type, rather than decoding straight into `SessionTurnRow` the way this
/// query did before issue #103, because `SessionTurnRow::tool_called` has
/// no column here to decode from (see that field's own doc comment: it's
/// derived from the tree, not stored). This struct exists only to give
/// `sqlx::query_as` something whose fields match the query one for one;
/// `load_turns_from_session_turns` immediately turns each row into a real
/// `SessionTurnRow` below.
#[derive(Debug, FromRow)]
struct LegacySessionTurnRow {
    question: String,
    answer: String,
    grounding_entry_ids: Vec<Uuid>,
    grounded: bool,
    fallback_used: bool,
    created_at: DateTime<Utc>,
}

/// The pre-#91 read `load_turns` always did — kept verbatim as the
/// fallback for a Session with no tree entries yet. See `load_turns`'s own
/// doc comment for when this path is taken and why.
///
/// `tool_called` is hardcoded `true` for every row this reads, not left to
/// default or guessed at: a Session still being read off `session_turns`
/// alone has no tree (`load_turns`'s own doc comment — this is the
/// fallback for exactly that case), which means it predates issue #91's
/// entry tree and, with it, issue #93 pass 2's tool-calling loop. The fixed
/// pipeline that wrote it always ran all three retrievals directly
/// (`docs/adr/0023`) — there was no model-issued call it could ever decline
/// to make, so issue #103's failure mode is structurally impossible on data
/// this old. Reporting `false` here would be a plausible-looking guess
/// about something this function actually knows.
///
/// `model` is `default_model` for the same reason `tool_called` is a fixed
/// `true`: data this old predates per-Conversation model choice entirely,
/// so the Server's single configured model is not a guess about what ran
/// it — it is the only model that could have.
async fn load_turns_from_session_turns(
    pool: &PgPool,
    session_id: Uuid,
    default_model: &str,
) -> anyhow::Result<Vec<SessionTurnRow>> {
    let turns = sqlx::query_as::<_, LegacySessionTurnRow>(
        "select question, answer, grounding_entry_ids, grounded, fallback_used, created_at
         from session_turns
         where session_id = $1
         order by seq asc",
    )
    .bind(session_id)
    .fetch_all(pool)
    .await?;
    Ok(turns
        .into_iter()
        .map(|row| SessionTurnRow {
            question: row.question,
            answer: row.answer,
            grounding_entry_ids: row.grounding_entry_ids,
            grounded: row.grounded,
            fallback_used: row.fallback_used,
            tool_called: true,
            model: default_model.to_string(),
            created_at: row.created_at,
        })
        .collect())
}

/// `session_id`'s current `main_leaf_id` — `None` both when no Session has
/// this id and when a Session exists but has never had anything appended
/// to it (a state `record_turn` never leaves committed, per `0006`'s own
/// header, but not this function's job to assume). Kept separate from
/// `find_session`/`SessionRow` deliberately: `main_leaf_id` is an
/// implementation detail of how a Conversation is read, not part of the
/// wire shape `SessionRow` and `SessionResponse` serialize to a client.
async fn session_main_leaf_id(pool: &PgPool, session_id: Uuid) -> anyhow::Result<Option<Uuid>> {
    let leaf: Option<Option<Uuid>> =
        sqlx::query_scalar("select main_leaf_id from sessions where id = $1")
            .bind(session_id)
            .fetch_optional(pool)
            .await?;
    Ok(leaf.flatten())
}

/// Persists `turn` inside a single transaction, creating the Session first
/// when `session_id` is `None` — the *only* place a Session or a Turn is
/// ever written, and only ever called by `reflect.rs::run_reflect` after a
/// successful Answer already exists. Any failure here (a dropped
/// connection, a constraint violation) rolls the whole transaction back, so
/// a failed ask can never leave a half-written Session or an orphaned Turn
/// behind — see `docs/adr/0025`, which is where "a Session holding an empty
/// Conversation is unrepresentable" is decided. (CONTEXT.md defines what a
/// Session *is*; it deliberately carries no implementation guarantees.)
///
/// `title` is used only when minting a new Session — an existing Session's
/// title is immutable once set (CONTEXT.md: "a title taken from its first
/// Question"), so a follow-up Question never overwrites it.
///
/// Issue #91: alongside the `session_turns` row this always wrote, this now
/// also appends two chained tree entries — a `user` `message` carrying the
/// Question, then an `assistant` `message` carrying the Answer and its
/// Grounding — onto whatever `main_leaf_id` the Session had before this
/// call (`None` for a brand-new Session, so the `user` entry becomes a
/// root). This is the *only* place either shape is ever written, which is
/// exactly what "dual-writing must be done inside `record_turn`" buys:
/// `reflect.rs` calls this one function after a successful Answer and
/// neither knows nor needs to know that two representations exist behind
/// it. Both entries' `seq` come from the same `sessions.next_seq` counter
/// `session_records` also draws from — see `allocate_seq`.
///
/// Returns the Session's id: freshly minted for a new Session, or
/// `session_id` unchanged for an existing one.
pub(crate) async fn record_turn(
    pool: &PgPool,
    session_id: Option<Uuid>,
    title: &str,
    turn: NewTurn,
) -> anyhow::Result<Uuid> {
    let (mut tx, session_id, parent_leaf) = begin_turn(pool, session_id, title).await?;

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

    let user_entry_id = Uuid::new_v4();
    let user_payload = serde_json::to_value(MessagePayload::User {
        text: turn.question.clone(),
    })
    .context("serializing a user message payload can't fail")?;
    append_entry(
        &mut tx,
        session_id,
        user_entry_id,
        parent_leaf,
        EntryType::Message,
        user_payload,
    )
    .await?;

    let assistant_entry_id = Uuid::new_v4();
    let assistant_payload = serde_json::to_value(MessagePayload::Assistant {
        text: turn.answer.clone(),
        grounding_entry_ids: turn.grounding_entry_ids.clone(),
        grounded: turn.grounded,
        fallback_used: turn.fallback_used,
    })
    .context("serializing an assistant message payload can't fail")?;
    append_entry(
        &mut tx,
        session_id,
        assistant_entry_id,
        Some(user_entry_id),
        EntryType::Message,
        assistant_payload,
    )
    .await?;

    sqlx::query("update sessions set main_leaf_id = $1 where id = $2")
        .bind(assistant_entry_id)
        .bind(session_id)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;
    Ok(session_id)
}

/// Opens a transaction and resolves the Session a new Turn is about to be
/// appended to — an existing Session's `main_leaf_id` (its current leaf,
/// about to be extended) for `Some(session_id)`, or a freshly minted
/// Session with no leaf yet for `None`. Factored out of `record_turn` so a
/// harness-driven persistence path (`reflect.rs::run_reflect_loop`, issue
/// #93 pass 2) that appends more than the one User/Assistant pair
/// `record_turn` itself writes — a loop can call a tool, or several, before
/// it answers — can share the same session-upsert logic rather than
/// duplicating it. Returns the still-open transaction: every caller has
/// more to do inside it (an insert, one or more `append_entry` calls, a
/// `main_leaf_id` update) before committing.
async fn begin_turn<'a>(
    pool: &'a PgPool,
    session_id: Option<Uuid>,
    title: &str,
) -> anyhow::Result<(Transaction<'a, Postgres>, Uuid, Option<Uuid>)> {
    let mut tx = pool.begin().await?;

    let (session_id, parent_leaf) = match session_id {
        Some(id) => {
            let leaf: Option<Uuid> = sqlx::query_scalar(
                "update sessions set updated_at = now() where id = $1 returning main_leaf_id",
            )
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
            (id, leaf)
        }
        None => {
            let id = Uuid::new_v4();
            sqlx::query("insert into sessions (id, title) values ($1, $2)")
                .bind(id)
                .bind(title)
                .execute(&mut *tx)
                .await?;
            (id, None)
        }
    };

    Ok((tx, session_id, parent_leaf))
}

/// The harness-driven twin of `record_turn` (issue #93 pass 2): still
/// exactly one `session_turns` row per request — `NewTurn` is unchanged,
/// and Search (issue #64) still only ever needs one Question/Answer pair
/// per Turn to index — but the tree underneath it can hold more than the
/// one User/Assistant pair `record_turn` itself appends, because a loop can
/// call a tool (or several) before it answers. `payloads` is every entry
/// this Turn adds to the tree, in the order they happened, already encoded
/// as `(EntryType, Value)` pairs by the caller — `reflect.rs`'s
/// `build_tree_payloads`, which is what actually knows the shape of a
/// loop's steps; this function only chains them onto the Session's existing
/// leaf and commits, exactly like `record_turn` does for its own two.
/// `payloads` must not be empty — a Turn with no entries at all is not a
/// Turn, the same invariant `record_turn` upholds by construction (it always
/// writes exactly two).
pub(crate) async fn record_turn_from_steps(
    pool: &PgPool,
    session_id: Option<Uuid>,
    title: &str,
    turn: NewTurn,
    payloads: Vec<(EntryType, Value)>,
) -> anyhow::Result<Uuid> {
    anyhow::ensure!(
        !payloads.is_empty(),
        "record_turn_from_steps requires at least one entry to append"
    );

    let (mut tx, session_id, mut leaf) = begin_turn(pool, session_id, title).await?;

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

    for (entry_type, payload) in payloads {
        let id = Uuid::new_v4();
        append_entry(&mut tx, session_id, id, leaf, entry_type, payload).await?;
        leaf = Some(id);
    }

    sqlx::query("update sessions set main_leaf_id = $1 where id = $2")
        .bind(leaf.expect("checked non-empty above"))
        .bind(session_id)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;
    Ok(session_id)
}

/// Issue #97: the *first* thing that ever writes an `EntryType::Compaction`
/// entry — `EntryType`'s own doc comment, and `project_from_last_compaction`'s,
/// both name this as issue #97's job, not issue #91's, which only had to
/// build the read side and prove it against a hand-built entry. Called by
/// `reflect.rs::maybe_compact_prior_turns`, strictly *before* the Turn that
/// triggered it appends anything of its own — see that function's own doc
/// comment for why this ordering is what keeps a compaction from ever
/// landing inside a Turn's own step chain rather than cleanly between two
/// Turns.
///
/// `payload` is `{"summary": summary}` — a plain, ad hoc shape rather than
/// a typed struct alongside `MessagePayload`, matching how loosely
/// `EntryType::Compaction`'s own test (`project_from_last_compaction_drops_everything_before_it`)
/// already treats it: nothing decodes a `Compaction` payload back into a
/// Rust type today (`decode_message` only ever looks at `Message` entries),
/// so there is nothing yet for a typed shape to buy.
///
/// Returns `Ok(false)`, writing nothing, for a Session with no
/// `main_leaf_id` yet — the same real, pre-#91 state `load_turns`'s own
/// `session_turns` fallback exists for (that function's own doc comment):
/// chaining a fresh tree entry onto a Session that has none would make this
/// entry the tree's *root*, which would flip `load_turns` from its
/// `session_turns` fallback over to reading a tree holding only this one
/// node — silently hiding every Turn that Session already had rather than
/// summarising them. `Ok(true)` for the ordinary case: the entry was
/// written and `sessions.main_leaf_id` now points at it.
///
/// **Always chains onto the *current* leaf — there is no partial-keep
/// variant, and there cannot be one.** `session_entries` is append-only
/// (this module's own header); a Turn already appended before this call has
/// a `parent_id` fixed at the moment it was written, so a compaction cannot
/// retroactively insert itself *between* two already-persisted Turns to
/// keep the newer one out of `project_from_last_compaction`'s cut —
/// whatever is currently the leaf is, by construction, everything this call
/// can still choose to summarise away. `reflect.rs::maybe_compact_prior_turns`
/// is written around exactly this constraint: when it compacts, it
/// summarises *every* not-yet-compacted Turn, never a suffix of them.
pub(crate) async fn append_compaction(
    pool: &PgPool,
    session_id: Uuid,
    summary: &str,
) -> anyhow::Result<bool> {
    let mut tx = pool.begin().await?;

    let Some(leaf) = session_main_leaf_id_tx(&mut tx, session_id).await? else {
        return Ok(false);
    };

    let id = Uuid::new_v4();
    let payload = serde_json::json!({ "summary": summary });
    append_entry(
        &mut tx,
        session_id,
        id,
        Some(leaf),
        EntryType::Compaction,
        payload,
    )
    .await?;

    sqlx::query("update sessions set main_leaf_id = $1 where id = $2")
        .bind(id)
        .bind(session_id)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;
    Ok(true)
}

/// `session_main_leaf_id`'s twin for a caller that already has an open
/// transaction (`append_compaction`) — reading `main_leaf_id` through the
/// same transaction the write happens in, rather than a separate
/// pre-transaction `PgPool` read, is what keeps a concurrent append to the
/// same Session from racing this one to decide what "current leaf" means.
async fn session_main_leaf_id_tx(
    tx: &mut Transaction<'_, Postgres>,
    session_id: Uuid,
) -> anyhow::Result<Option<Uuid>> {
    let leaf: Option<Option<Uuid>> =
        sqlx::query_scalar("select main_leaf_id from sessions where id = $1")
            .bind(session_id)
            .fetch_optional(&mut **tx)
            .await?;
    Ok(leaf.flatten())
}

/// Hands out the next value in `session_id`'s single shared ordering —
/// `session_entries.seq` and `session_records.seq` are cut from the same
/// counter, `sessions.next_seq` (migration `0006`), precisely so a harness
/// replaying "what happened, in order" never has to interleave two
/// separately-numbered logs itself (issue #91: "entries and records share
/// ONE strictly consecutive per-session sequence"). `update ... returning`
/// both assigns and reads the value in one round trip, and does it "inside
/// the same transaction as the append" by construction — every caller
/// passes an already-open `Transaction`, never a bare `PgPool` — so the row
/// lock Postgres takes for the update is held until that transaction
/// commits or rolls back, and two concurrent appends to the same Session
/// serialize on it rather than racing for the same seq.
async fn allocate_seq(tx: &mut Transaction<'_, Postgres>, session_id: Uuid) -> anyhow::Result<i64> {
    let seq: i64 = sqlx::query_scalar(
        "update sessions set next_seq = next_seq + 1 where id = $1 returning next_seq - 1",
    )
    .bind(session_id)
    .fetch_one(&mut **tx)
    .await?;
    Ok(seq)
}

/// Appends one entry to `session_id`'s tree and returns the seq it was
/// assigned. Takes an already-open transaction rather than a `PgPool`
/// because every real caller (`record_turn`, `fork_session`) appends more
/// than one row atomically, and `allocate_seq`'s row lock only serializes
/// concurrent appends if the whole append stays inside one transaction.
/// `id` is the caller's to choose — `record_turn` mints a fresh one,
/// `fork_session` reuses the id being copied — rather than this function
/// generating it, which is what lets a fork preserve entry ids at all.
pub(crate) async fn append_entry(
    tx: &mut Transaction<'_, Postgres>,
    session_id: Uuid,
    id: Uuid,
    parent_id: Option<Uuid>,
    entry_type: EntryType,
    payload: Value,
) -> anyhow::Result<i64> {
    let seq = allocate_seq(tx, session_id).await?;
    sqlx::query(
        "insert into session_entries (session_id, id, parent_id, seq, type, payload)
         values ($1, $2, $3, $4, $5, $6)",
    )
    .bind(session_id)
    .bind(id)
    .bind(parent_id)
    .bind(seq)
    .bind(entry_type.as_str())
    .bind(payload)
    .execute(&mut **tx)
    .await?;
    Ok(seq)
}

/// Appends one row to `session_id`'s operation log and returns the seq it
/// was assigned — the `session_records` twin of `append_entry`, minus a
/// `parent_id` (a record has no "before it", only a `seq`). `id` is the
/// caller's to choose for the same reason `append_entry`'s is: issue #91's
/// "identities are reserved before the work starts" means a caller mints a
/// record's id *before* doing the work it describes, not when this
/// function is called to log that the work happened.
///
/// No production caller writes a record yet (see `RecordKind`'s doc
/// comment) — `#[allow(dead_code)]` records that this is the storage a
/// future harness will call, proven correct now by its own tests, rather
/// than dead weight.
#[allow(dead_code)]
pub(crate) async fn append_record(
    tx: &mut Transaction<'_, Postgres>,
    session_id: Uuid,
    id: Uuid,
    kind: RecordKind,
    payload: Value,
) -> anyhow::Result<i64> {
    let seq = allocate_seq(tx, session_id).await?;
    sqlx::query(
        "insert into session_records (session_id, id, seq, kind, payload)
         values ($1, $2, $3, $4, $5)",
    )
    .bind(session_id)
    .bind(id)
    .bind(seq)
    .bind(kind.as_str())
    .bind(payload)
    .execute(&mut **tx)
    .await?;
    Ok(seq)
}

/// Every entry `session_id` has, in no particular guaranteed order beyond
/// `seq asc` (the order they were appended in — not the order a walk visits
/// them in, which follows `parent_id` and can revisit an earlier part of
/// Session's timeline after a fork existed). Loaded all at once rather than
/// one row per `parent_id` hop: a Session's entry count is small enough
/// that one query and an in-memory walk (`walk_to_root`) beats a
/// round-trip per hop, the same trade `load_turns` already made reading
/// `session_turns` in full before this ticket.
pub(crate) async fn load_entries(pool: &PgPool, session_id: Uuid) -> anyhow::Result<Vec<EntryRow>> {
    let entries = sqlx::query_as::<_, EntryRow>(
        "select session_id, id, parent_id, seq, type as entry_type, payload, created_at
         from session_entries
         where session_id = $1
         order by seq asc",
    )
    .bind(session_id)
    .fetch_all(pool)
    .await?;
    Ok(entries)
}

/// Every record `session_id`'s operation log has, oldest first — the read
/// side of `append_record`. This ticket's whole claim on `session_records`
/// is "written and readable" (no resume path), so this function's only job
/// is to hand every record back in the order they were appended and let a
/// caller (a test, or a future resume path) decide what to make of them.
#[allow(dead_code)]
pub(crate) async fn load_records(
    pool: &PgPool,
    session_id: Uuid,
) -> anyhow::Result<Vec<RecordRow>> {
    let records = sqlx::query_as::<_, RecordRow>(
        "select session_id, id, seq, kind, payload, created_at
         from session_records
         where session_id = $1
         order by seq asc",
    )
    .bind(session_id)
    .fetch_all(pool)
    .await?;
    Ok(records)
}

/// Reads a Conversation the way issue #91 actually defines reading one:
/// starting from `leaf_id` and following `parent_id` back to a root, then
/// reversing so the result reads oldest-first — never `entries.iter()`
/// filtered and sorted by `seq`, which cannot distinguish an abandoned fork
/// from the lane that's actually live once more than one lineage shares a
/// `seq` range. `entries` is loaded once by the caller (`load_entries`) and
/// walked here in memory against a `HashMap`, so this function itself talks
/// to nothing — which is what makes it cheap to unit-test directly against
/// hand-built `EntryRow` values (`tests::cycle_is_rejected_not_looped`)
/// without a database at all.
///
/// A malformed tree — a `parent_id` that names no entry in `entries`, or a
/// cycle — is rejected with an error rather than silently truncating or
/// looping forever (issue #91: "A Conversation containing a cycle is
/// rejected rather than looping forever"). Neither should be reachable
/// through `append_entry` alone, since every real parent already exists
/// before a child is appended, but a function this central to what a
/// Conversation *is* should not have to trust that its caller can't
/// construct one — a bug that broke that invariant elsewhere should surface
/// here as a loud error, not a wrong Conversation.
pub(crate) fn walk_to_root(entries: &[EntryRow], leaf_id: Uuid) -> anyhow::Result<Vec<&EntryRow>> {
    let by_id: HashMap<Uuid, &EntryRow> = entries.iter().map(|entry| (entry.id, entry)).collect();

    let mut path = Vec::new();
    let mut visited = HashSet::new();
    let mut current = Some(leaf_id);

    while let Some(id) = current {
        if !visited.insert(id) {
            anyhow::bail!("cycle detected in session entry tree at entry {id}");
        }
        let entry = *by_id
            .get(&id)
            .ok_or_else(|| anyhow::anyhow!("entry {id} is referenced but does not exist"))?;
        current = entry.parent_id;
        path.push(entry);
    }

    path.reverse();
    Ok(path)
}

/// Trims a root-first path down to whatever lies at or after the last
/// `compaction` entry on it, or leaves it untouched if there isn't one.
/// This is the "context projection" issue #91 asks for even though nothing
/// writes a compaction yet (issue #97 does): the rule — drop everything
/// before the most recent compaction — belongs with the rest of how a
/// Conversation is read, not bolted on later as a special case once a
/// compaction finally exists to trigger it. Kept the compaction entry
/// itself rather than dropping it too, since a real compaction's payload is
/// expected to be the summary that stands in for what was dropped — an
/// empty projection would discard that summary along with the history it
/// replaces.
pub(crate) fn project_from_last_compaction<'a>(path: &[&'a EntryRow]) -> Vec<&'a EntryRow> {
    match path
        .iter()
        .rposition(|entry| entry.entry_type == EntryType::Compaction.as_str())
    {
        Some(index) => path[index..].to_vec(),
        None => path.to_vec(),
    }
}

/// Decodes a `message` entry's `payload` into a typed `MessagePayload`, or
/// `None` for any other `entry_type` — never an error for a non-`message`
/// entry, since `entries_to_turns` walks a path that may hold entry kinds
/// it has no interest in pairing (a `model_change` sitting between two
/// Turns, say) and treats them the same way it treats a `message` entry it
/// doesn't recognise as half of a pair: skip it, don't fail the whole read.
/// A `message` entry whose `payload` doesn't actually parse as a
/// `MessagePayload` *is* an error — that can only mean this module itself
/// wrote something it can't read back, which is a bug worth surfacing
/// loudly rather than silently dropping the entry.
fn decode_message(entry: &EntryRow) -> anyhow::Result<Option<MessagePayload>> {
    if entry.entry_type != EntryType::Message.as_str() {
        return Ok(None);
    }
    let payload = serde_json::from_value(entry.payload.clone())
        .with_context(|| format!("entry {} has a malformed message payload", entry.id))?;
    Ok(Some(payload))
}

/// Issue #98's counterpart to `decode_message`: decodes a `model_change`
/// entry's `payload` into the model id it names, or `None` for any other
/// `entry_type` — same "skip, don't fail" posture as `decode_message` for
/// an entry kind it isn't looking for, same "a malformed payload of the
/// kind this *is* looking for is a real bug" posture for one it is.
fn decode_model_change(entry: &EntryRow) -> anyhow::Result<Option<String>> {
    if entry.entry_type != EntryType::ModelChange.as_str() {
        return Ok(None);
    }
    let payload: ModelChangePayload = serde_json::from_value(entry.payload.clone())
        .with_context(|| format!("entry {} has a malformed model_change payload", entry.id))?;
    Ok(Some(payload.model))
}

/// The model in force at the *start* of `project_from_last_compaction`'s
/// trim point — `default_model` when the path holds no `compaction` entry
/// at all (in which case `entries_to_turns` will walk every `model_change`
/// on the untrimmed path itself and never needs this seed to be anything
/// but the Server's own default), or whatever `model_change` entry was
/// nearest the compaction, scanning backward from it, when one exists.
/// Without this, a Session that changed models and *then* compacted would
/// have that `model_change` entry trimmed away with everything else before
/// the cut, and every Turn after it would silently misattribute back to
/// `default_model` — the same class of bug `project_from_last_compaction`'s
/// own doc comment is careful never to lose the compaction's summary to,
/// applied here to the model instead of the text.
fn model_before_projection(path: &[&EntryRow], default_model: &str) -> anyhow::Result<String> {
    let Some(cut) = path
        .iter()
        .rposition(|entry| entry.entry_type == EntryType::Compaction.as_str())
    else {
        return Ok(default_model.to_string());
    };
    for entry in path[..cut].iter().rev() {
        if let Some(model) = decode_model_change(entry)? {
            return Ok(model);
        }
    }
    Ok(default_model.to_string())
}

/// Rebuilds `SessionTurnRow`s from a root-first path of entries — the
/// inverse of what `record_turn`/`record_turn_from_steps` write. A `user`
/// `message` starts a Turn; everything after it up to (not including) the
/// *next* `user` `message`, or the end of the path, belongs to that same
/// Turn's own run — which, since issue #93 pass 2, can hold more than the
/// single `assistant` entry `record_turn` itself ever wrote: a loop can
/// call a tool (or several `assistant`/`tool_result` entries deep) before
/// it actually answers. The Turn's answer is the *last* `assistant` entry
/// in that run, not the first — the first one right after a `user` entry
/// may only be "I'm going to look that up," with the tool call attached;
/// the last one is what the loop's own stopping rule
/// (`harness::agent_loop::run`) guarantees has no tool call left in it,
/// which is what makes it the real Answer. `created_at` is taken from that
/// same entry, matching what `session_turns.created_at` always meant: when
/// the Answer, not the Question, was recorded.
///
/// A `user` entry whose run never contains an `assistant` entry at all (an
/// interrupted Turn — the loop errored, aborted, or unanimously terminated
/// before ever answering) contributes no Turn: a Conversation with a gap in
/// it is still a Conversation, just one with fewer Turns than entries.
/// `tool_result` entries, and any other non-`message` entry type, are
/// walked over without changing which `assistant` entry is "last" — but
/// issue #103 gives `tool_result` one effect here that "walked over"
/// undersells: seeing even one anywhere in the run sets the reconstructed
/// `SessionTurnRow::tool_called`, which is how that field stays derived
/// from the tree rather than a second value someone has to remember to
/// write — see that field's own doc comment.
///
/// Issue #98: also tracks `current_model`, seeded from `seed_model`
/// (`load_turns`'s `model_before_projection`) and updated every time a
/// `model_change` entry is walked over, wherever in the path it falls —
/// between two Turns (the ordinary case: `reflect.rs` always appends one
/// immediately before the Question it precedes) or, in principle, inside
/// one. Every Turn this function finishes is stamped with whatever
/// `current_model` holds at the moment its own answering `assistant` entry
/// is reached, which is what makes a change that happens to land mid-Turn
/// attribute to the model that actually produced the Answer rather than
/// the one the Question was asked under.
fn entries_to_turns(path: &[&EntryRow], seed_model: &str) -> anyhow::Result<Vec<SessionTurnRow>> {
    let mut turns = Vec::new();
    let mut index = 0;
    let mut current_model = seed_model.to_string();

    while index < path.len() {
        if let Some(model) = decode_model_change(path[index])? {
            current_model = model;
            index += 1;
            continue;
        }
        let Some(MessagePayload::User { text: question }) = decode_message(path[index])? else {
            index += 1;
            continue;
        };

        let mut cursor = index + 1;
        let mut answer: Option<SessionTurnRow> = None;
        // Issue #103: tracks whether any `tool_result` entry has been seen
        // yet in this Turn's own run, from the `user` entry above down to
        // whichever `assistant` entry ends up "last" (below). Read, not
        // reset, every time a new `assistant` entry overwrites `answer` —
        // a run can call a tool, then write intermediate prose with another
        // tool call attached, then answer for real; whether *any* of those
        // steps touched a tool is what distinguishes the run from one that
        // never did, not only what happened immediately before the final
        // reply.
        let mut tool_called = false;
        while cursor < path.len() {
            if let Some(model) = decode_model_change(path[cursor])? {
                current_model = model;
                cursor += 1;
                continue;
            }
            match decode_message(path[cursor])? {
                Some(MessagePayload::User { .. }) => break,
                Some(MessagePayload::Assistant {
                    text,
                    grounding_entry_ids,
                    grounded,
                    fallback_used,
                }) => {
                    answer = Some(SessionTurnRow {
                        question: question.clone(),
                        answer: text,
                        grounding_entry_ids,
                        grounded,
                        fallback_used,
                        tool_called,
                        model: current_model.clone(),
                        created_at: path[cursor].created_at,
                    });
                }
                Some(MessagePayload::ToolResult { .. }) => {
                    tool_called = true;
                }
                None => {}
            }
            cursor += 1;
        }

        if let Some(turn) = answer {
            turns.push(turn);
        }
        index = cursor;
    }

    Ok(turns)
}

/// Copies the root-to-`at_entry_id` path of `source_session_id`'s tree into
/// a brand new Session, preserving every copied entry's `id` — issue #91's
/// "Entry identities survive a fork". Ported from pi, where this matters
/// because each Session is its own file and a forked entry is meant to be
/// indistinguishable, id and all, from the entry it was forked from; a
/// composite primary key (`session_id, id`) is what lets that hold here too
/// even though every Session now shares one table. Entries are re-numbered
/// with fresh `seq` values in the new Session (its own `next_seq` starts at
/// 1, independent of the source Session's), because `seq` is "when this
/// happened in *this* Session's timeline" — the copy has its own timeline,
/// starting now, even though its content is a shared history.
///
/// `session_turns` is deliberately not copied — a fork can happen at any
/// entry, not only at a Turn boundary a legacy read would recognise, and
/// `load_turns` reads the tree regardless of which Session it's asked
/// about, so a forked Session's Turns are already correct without a
/// `session_turns` row to back them (see `load_turns`'s own doc comment).
///
/// No HTTP route calls this (issue #91: "no interface offers it yet") —
/// `pub(crate)` records that on its own, the same way `NewTurn` does for
/// "only `reflect.rs` builds one of these." `#[allow(dead_code)]` for the
/// same reason: `fork_preserves_entry_ids` is this function's only caller
/// today, and that's the point of this ticket, not an oversight.
#[allow(dead_code)]
pub(crate) async fn fork_session(
    pool: &PgPool,
    source_session_id: Uuid,
    at_entry_id: Uuid,
    title: &str,
) -> anyhow::Result<Uuid> {
    let entries = load_entries(pool, source_session_id).await?;
    let path = walk_to_root(&entries, at_entry_id)?;

    let mut tx = pool.begin().await?;

    let new_session_id = Uuid::new_v4();
    sqlx::query("insert into sessions (id, title) values ($1, $2)")
        .bind(new_session_id)
        .bind(title)
        .execute(&mut *tx)
        .await?;

    let mut new_leaf = None;
    for entry in &path {
        let seq = allocate_seq(&mut tx, new_session_id).await?;
        sqlx::query(
            "insert into session_entries (session_id, id, parent_id, seq, type, payload, created_at)
             values ($1, $2, $3, $4, $5, $6, $7)",
        )
        .bind(new_session_id)
        .bind(entry.id)
        .bind(entry.parent_id)
        .bind(seq)
        .bind(&entry.entry_type)
        .bind(&entry.payload)
        .bind(entry.created_at)
        .execute(&mut *tx)
        .await?;
        new_leaf = Some(entry.id);
    }

    if let Some(leaf) = new_leaf {
        sqlx::query("update sessions set main_leaf_id = $1 where id = $2")
            .bind(leaf)
            .bind(new_session_id)
            .execute(&mut *tx)
            .await?;
    }

    tx.commit().await?;
    Ok(new_session_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn insert_bare_session(pool: &PgPool, id: Uuid) {
        sqlx::query("insert into sessions (id, title) values ($1, 'Test session')")
            .bind(id)
            .execute(pool)
            .await
            .unwrap();
    }

    /// A fixture `EntryRow` for the pure, no-database tests below
    /// (`walk_to_root`, `project_from_last_compaction`) — `seq` and
    /// `created_at` are never read by either function, so they're filled
    /// with placeholders rather than threaded through every call site.
    fn entry(id: Uuid, parent_id: Option<Uuid>, entry_type: EntryType, payload: Value) -> EntryRow {
        EntryRow {
            session_id: Uuid::nil(),
            id,
            parent_id,
            seq: 0,
            entry_type: entry_type.as_str().to_string(),
            payload,
            created_at: Utc::now(),
        }
    }

    fn user_message(id: Uuid, parent_id: Option<Uuid>, text: &str) -> EntryRow {
        entry(
            id,
            parent_id,
            EntryType::Message,
            serde_json::to_value(MessagePayload::User {
                text: text.to_string(),
            })
            .unwrap(),
        )
    }

    fn assistant_message(id: Uuid, parent_id: Option<Uuid>, text: &str) -> EntryRow {
        entry(
            id,
            parent_id,
            EntryType::Message,
            serde_json::to_value(MessagePayload::Assistant {
                text: text.to_string(),
                grounding_entry_ids: Vec::new(),
                grounded: true,
                fallback_used: false,
            })
            .unwrap(),
        )
    }

    fn tool_result_message(id: Uuid, parent_id: Option<Uuid>, text: &str) -> EntryRow {
        entry(
            id,
            parent_id,
            EntryType::Message,
            serde_json::to_value(MessagePayload::ToolResult {
                text: text.to_string(),
                tool_name: "entries_in_range".to_string(),
                is_error: false,
                details: serde_json::json!({}),
            })
            .unwrap(),
        )
    }

    /// Issue #98: a `model_change` entry — never paired with a Question the
    /// way `user_message`/`assistant_message` are, since a real one always
    /// sits *before* the Question it precedes (`reflect.rs::build_tree_payloads`).
    fn model_change_entry(id: Uuid, parent_id: Option<Uuid>, model: &str) -> EntryRow {
        entry(
            id,
            parent_id,
            EntryType::ModelChange,
            serde_json::to_value(ModelChangePayload {
                model: model.to_string(),
            })
            .unwrap(),
        )
    }

    /// Every hand-built-tree test in this module that doesn't care what a
    /// Turn's model reads as (i.e. every one written before issue #98) uses
    /// this as `entries_to_turns`'/`load_turns`'s `default_model` — a real,
    /// specific value rather than an empty string or `"test"`, matching
    /// this file's own precedent of preferring a plausible value a stray
    /// assertion couldn't confuse with "unset."
    const DEFAULT_MODEL: &str = "codex-terra";

    /// The basic contract `append_entry`/`load_entries` exist to provide:
    /// what's appended is what comes back, in `seq` order, with the parent
    /// chain intact.
    #[sqlx::test]
    async fn append_and_read_back(pool: PgPool) {
        let session_id = Uuid::new_v4();
        insert_bare_session(&pool, session_id).await;

        let mut tx = pool.begin().await.unwrap();
        let root_id = Uuid::new_v4();
        let root_seq = append_entry(
            &mut tx,
            session_id,
            root_id,
            None,
            EntryType::Message,
            serde_json::to_value(MessagePayload::User {
                text: "How has my knee been?".to_string(),
            })
            .unwrap(),
        )
        .await
        .unwrap();

        let child_id = Uuid::new_v4();
        let child_seq = append_entry(
            &mut tx,
            session_id,
            child_id,
            Some(root_id),
            EntryType::Message,
            serde_json::to_value(MessagePayload::Assistant {
                text: "Recurring since February.".to_string(),
                grounding_entry_ids: Vec::new(),
                grounded: true,
                fallback_used: false,
            })
            .unwrap(),
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();

        assert_eq!(root_seq, 1);
        assert_eq!(child_seq, 2);

        let entries = load_entries(&pool, session_id).await.unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].id, root_id);
        assert_eq!(entries[0].parent_id, None);
        assert_eq!(entries[1].id, child_id);
        assert_eq!(entries[1].parent_id, Some(root_id));
    }

    /// Issue #91: "reading a Conversation walks back from its latest
    /// entry" — a root-first path built by following `parent_id` from a
    /// leaf, not `entries` in `seq` order (which would already be correct
    /// here, and is exactly the case this test must not accidentally rely
    /// on: `walk_to_root` is given `entries` shuffled out of `seq` order to
    /// prove it's actually walking `parent_id`, not trusting input order).
    #[test]
    fn walk_to_root_reads_a_conversation_oldest_first() {
        let root_id = Uuid::new_v4();
        let child_id = Uuid::new_v4();
        let grandchild_id = Uuid::new_v4();

        let root = user_message(root_id, None, "How has my knee been?");
        let child = assistant_message(child_id, Some(root_id), "Recurring since February.");
        let grandchild = user_message(grandchild_id, Some(child_id), "Did PT help?");

        // Deliberately out of seq/append order.
        let entries = vec![grandchild.clone(), root.clone(), child.clone()];

        let path = walk_to_root(&entries, grandchild_id).unwrap();

        assert_eq!(
            path.iter().map(|e| e.id).collect::<Vec<_>>(),
            vec![root_id, child_id, grandchild_id]
        );
    }

    /// Issue #91: "A Conversation containing a cycle is rejected rather
    /// than looping forever." Two entries pointing at each other can never
    /// be produced by `append_entry` (a parent must already exist before a
    /// child references it), but `walk_to_root` doesn't get to assume that
    /// — it has to detect this itself rather than trust its input.
    #[test]
    fn a_cycle_is_rejected_not_looped() {
        let a_id = Uuid::new_v4();
        let b_id = Uuid::new_v4();

        let a = user_message(a_id, Some(b_id), "A");
        let b = assistant_message(b_id, Some(a_id), "B");
        let entries = vec![a, b];

        let result = walk_to_root(&entries, a_id);

        assert!(
            result.is_err(),
            "a cycle must be rejected, not looped forever"
        );
    }

    /// A leaf naming an entry that doesn't exist at all (a `parent_id`
    /// with no matching row, or a `main_leaf_id` pointing nowhere) is the
    /// same kind of malformed tree a cycle is — rejected, not silently
    /// truncated into a shorter Conversation than actually happened.
    #[test]
    fn a_dangling_parent_is_rejected() {
        let leaf_id = Uuid::new_v4();
        let missing_parent_id = Uuid::new_v4();
        let entries = vec![user_message(leaf_id, Some(missing_parent_id), "orphaned")];

        let result = walk_to_root(&entries, leaf_id);

        assert!(result.is_err());
    }

    /// Issue #91: "Entries and operation-log records share one strictly
    /// consecutive ordering per Session." Interleaving `append_entry` and
    /// `append_record` calls on the same Session must hand out 1, 2, 3, 4…
    /// across *both* — never two independent counters that each start at 1.
    #[sqlx::test]
    async fn seq_is_strictly_consecutive_across_entries_and_records(pool: PgPool) {
        let session_id = Uuid::new_v4();
        insert_bare_session(&pool, session_id).await;

        let mut tx = pool.begin().await.unwrap();

        let entry_seq_1 = append_entry(
            &mut tx,
            session_id,
            Uuid::new_v4(),
            None,
            EntryType::Message,
            serde_json::to_value(MessagePayload::User {
                text: "Q".to_string(),
            })
            .unwrap(),
        )
        .await
        .unwrap();

        let record_seq_1 = append_record(
            &mut tx,
            session_id,
            Uuid::new_v4(),
            RecordKind::OperationStarted,
            serde_json::json!({}),
        )
        .await
        .unwrap();

        let record_seq_2 = append_record(
            &mut tx,
            session_id,
            Uuid::new_v4(),
            RecordKind::ToolStarted,
            serde_json::json!({"tool_name": "search"}),
        )
        .await
        .unwrap();

        let entry_seq_2 = append_entry(
            &mut tx,
            session_id,
            Uuid::new_v4(),
            None,
            EntryType::Message,
            serde_json::to_value(MessagePayload::Assistant {
                text: "A".to_string(),
                grounding_entry_ids: Vec::new(),
                grounded: true,
                fallback_used: false,
            })
            .unwrap(),
        )
        .await
        .unwrap();

        tx.commit().await.unwrap();

        assert_eq!(
            vec![entry_seq_1, record_seq_1, record_seq_2, entry_seq_2],
            vec![1, 2, 3, 4]
        );

        let records = load_records(&pool, session_id).await.unwrap();
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].kind, "operation_started");
        assert_eq!(records[1].kind, "tool_started");
    }

    /// Issue #91: "Entry identities survive a fork." Forking mid-Conversation
    /// must copy exactly the root-to-`at` path — not anything appended
    /// after it — into a new Session, with every copied entry keeping the
    /// same `id` it had in the source Session.
    #[sqlx::test]
    async fn fork_preserves_entry_ids(pool: PgPool) {
        let source_id = Uuid::new_v4();
        insert_bare_session(&pool, source_id).await;

        let mut tx = pool.begin().await.unwrap();
        let root_id = Uuid::new_v4();
        append_entry(
            &mut tx,
            source_id,
            root_id,
            None,
            EntryType::Message,
            serde_json::to_value(MessagePayload::User {
                text: "How has my knee been?".to_string(),
            })
            .unwrap(),
        )
        .await
        .unwrap();
        let fork_point_id = Uuid::new_v4();
        append_entry(
            &mut tx,
            source_id,
            fork_point_id,
            Some(root_id),
            EntryType::Message,
            serde_json::to_value(MessagePayload::Assistant {
                text: "Recurring since February.".to_string(),
                grounding_entry_ids: Vec::new(),
                grounded: true,
                fallback_used: false,
            })
            .unwrap(),
        )
        .await
        .unwrap();
        // Appended after the fork point — must not be copied.
        let after_fork_id = Uuid::new_v4();
        append_entry(
            &mut tx,
            source_id,
            after_fork_id,
            Some(fork_point_id),
            EntryType::Message,
            serde_json::to_value(MessagePayload::User {
                text: "Did PT help?".to_string(),
            })
            .unwrap(),
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();

        let forked_id = fork_session(&pool, source_id, fork_point_id, "Forked session")
            .await
            .unwrap();

        let forked_entries = load_entries(&pool, forked_id).await.unwrap();
        let mut forked_ids: Vec<Uuid> = forked_entries.iter().map(|e| e.id).collect();
        forked_ids.sort();
        let mut expected_ids = vec![root_id, fork_point_id];
        expected_ids.sort();
        assert_eq!(forked_ids, expected_ids, "fork must preserve entry ids");
        assert!(
            !forked_entries.iter().any(|e| e.id == after_fork_id),
            "fork must not copy entries appended after the fork point"
        );

        // The new Session's own timeline starts at 1, independent of the
        // source Session's seq range.
        let mut forked_seqs: Vec<i64> = forked_entries.iter().map(|e| e.seq).collect();
        forked_seqs.sort();
        assert_eq!(forked_seqs, vec![1, 2]);

        let forked_leaf: Option<Uuid> =
            sqlx::query_scalar("select main_leaf_id from sessions where id = $1")
                .bind(forked_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(forked_leaf, Some(fork_point_id));

        // The Turn is readable through the tree in the forked Session too.
        let forked_turns = load_turns(&pool, forked_id, DEFAULT_MODEL).await.unwrap();
        assert_eq!(forked_turns.len(), 1);
        assert_eq!(forked_turns[0].question, "How has my knee been?");
        assert_eq!(forked_turns[0].answer, "Recurring since February.");
    }

    /// Issue #91: "the context projection ... belongs here" even with no
    /// compaction ever written yet. A path with no compaction entry at all
    /// is returned unchanged; a path with one is trimmed down to that
    /// entry and everything after it.
    #[test]
    fn project_from_last_compaction_drops_everything_before_it() {
        let first_user = user_message(Uuid::new_v4(), None, "first question");
        let first_assistant =
            assistant_message(Uuid::new_v4(), Some(first_user.id), "first answer");
        let compaction = entry(
            Uuid::new_v4(),
            Some(first_assistant.id),
            EntryType::Compaction,
            serde_json::json!({"summary": "the Conversation so far, condensed"}),
        );
        let second_user = user_message(Uuid::new_v4(), Some(compaction.id), "second question");
        let second_assistant =
            assistant_message(Uuid::new_v4(), Some(second_user.id), "second answer");

        let full_path = vec![
            &first_user,
            &first_assistant,
            &compaction,
            &second_user,
            &second_assistant,
        ];

        let projected = project_from_last_compaction(&full_path);
        assert_eq!(
            projected.iter().map(|e| e.id).collect::<Vec<_>>(),
            vec![compaction.id, second_user.id, second_assistant.id]
        );

        // No compaction on the path at all: unchanged.
        let no_compaction_path = vec![&first_user, &first_assistant];
        let unprojected = project_from_last_compaction(&no_compaction_path);
        assert_eq!(
            unprojected.iter().map(|e| e.id).collect::<Vec<_>>(),
            vec![first_user.id, first_assistant.id]
        );
    }

    /// Issue #98: `project_from_last_compaction` trims everything *before*
    /// the compaction away — including, on a Session that changed models,
    /// whatever `model_change` entry was still in force at that point.
    /// `model_before_projection` is what `load_turns` seeds `entries_to_turns`
    /// with instead of blindly reaching for `default_model`, so a Turn that
    /// survives the trim still reads as the model it actually ran on rather
    /// than silently reverting to the Server's default.
    #[test]
    fn model_before_projection_carries_a_changed_model_across_a_compaction() {
        let first_user = user_message(Uuid::new_v4(), None, "first question");
        let change = model_change_entry(Uuid::new_v4(), Some(first_user.id), "claude-sonnet");
        let second_user = user_message(Uuid::new_v4(), Some(change.id), "second question");
        let second_assistant =
            assistant_message(Uuid::new_v4(), Some(second_user.id), "second answer");
        let compaction = entry(
            Uuid::new_v4(),
            Some(second_assistant.id),
            EntryType::Compaction,
            serde_json::json!({"summary": "the Conversation so far, condensed"}),
        );
        let third_user = user_message(Uuid::new_v4(), Some(compaction.id), "third question");
        let third_assistant =
            assistant_message(Uuid::new_v4(), Some(third_user.id), "third answer");

        let full_path = vec![
            &first_user,
            &change,
            &second_user,
            &second_assistant,
            &compaction,
            &third_user,
            &third_assistant,
        ];

        let seed = model_before_projection(&full_path, DEFAULT_MODEL).unwrap();
        assert_eq!(
            seed, "claude-sonnet",
            "the model_change entry sits before the compaction and must still seed the model \
             that survives the trim"
        );

        // Read straight through `entries_to_turns` as `load_turns` actually
        // uses these together — the third Turn (the only one that survives
        // `project_from_last_compaction`) must read as "claude-sonnet", not
        // silently revert to `DEFAULT_MODEL`.
        let projected = project_from_last_compaction(&full_path);
        let turns = entries_to_turns(&projected, &seed).unwrap();
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].model, "claude-sonnet");

        // No compaction at all: the seed is just `default_model`, since
        // `entries_to_turns` will walk the untrimmed path's own
        // `model_change` entries itself.
        let no_compaction_path = vec![&first_user, &change, &second_user, &second_assistant];
        assert_eq!(
            model_before_projection(&no_compaction_path, DEFAULT_MODEL).unwrap(),
            DEFAULT_MODEL
        );
    }

    /// Ties `record_turn` (the only place either shape is written) to
    /// `load_turns` (the only place the tree is read back into Turns),
    /// across two calls — a fresh Session, then a follow-up on it — to
    /// prove the dual-write chains correctly and that
    /// `session_turns`/the tree agree on what happened.
    #[sqlx::test]
    async fn record_turn_writes_both_shapes_and_load_turns_reads_the_tree(pool: PgPool) {
        let session_id = record_turn(
            &pool,
            None,
            "How has my knee been?",
            NewTurn {
                question: "How has my knee been?".to_string(),
                answer: "Recurring since February.".to_string(),
                grounding_entry_ids: Vec::new(),
                grounded: true,
                fallback_used: false,
            },
        )
        .await
        .unwrap();

        record_turn(
            &pool,
            Some(session_id),
            "unused for an existing session",
            NewTurn {
                question: "Did PT help?".to_string(),
                answer: "Yes.".to_string(),
                grounding_entry_ids: Vec::new(),
                grounded: true,
                fallback_used: false,
            },
        )
        .await
        .unwrap();

        let turn_count: i64 =
            sqlx::query_scalar("select count(*) from session_turns where session_id = $1")
                .bind(session_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(turn_count, 2, "session_turns must still get a row per Turn");

        let entry_count: i64 =
            sqlx::query_scalar("select count(*) from session_entries where session_id = $1")
                .bind(session_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(entry_count, 4, "two chained entries per Turn");

        let turns = load_turns(&pool, session_id, DEFAULT_MODEL).await.unwrap();
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].question, "How has my knee been?");
        assert_eq!(turns[0].answer, "Recurring since February.");
        assert_eq!(turns[1].question, "Did PT help?");
        assert_eq!(turns[1].answer, "Yes.");
    }

    /// Issue #103: a Session with a `session_turns` row but no tree at all
    /// — the state a pre-#91 Session is still in (`load_turns_from_session_turns`'s
    /// own doc comment) — reads back `tool_called: true`, not `false`. This
    /// is not the derived-from-the-tree answer (there is no tree here to
    /// derive it from); it is the honest one, because the fixed pipeline
    /// that wrote every row shaped like this always ran its three
    /// retrievals directly, with no model-issued call it could ever decline
    /// to make. Data this old cannot exhibit issue #103's failure, so
    /// reporting `false` for it would be a guess dressed up as a reading.
    #[sqlx::test]
    async fn a_session_turns_only_row_with_no_tree_reads_back_as_tool_called(pool: PgPool) {
        let session_id = Uuid::new_v4();
        sqlx::query("insert into sessions (id, title) values ($1, 'Pre-tree session')")
            .bind(session_id)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "insert into session_turns
                (id, session_id, question, answer, grounding_entry_ids, grounded, fallback_used)
             values ($1, $2, 'Anything?', 'Nothing recorded.', '{}', false, false)",
        )
        .bind(Uuid::new_v4())
        .bind(session_id)
        .execute(&pool)
        .await
        .unwrap();

        let turns = load_turns(&pool, session_id, DEFAULT_MODEL).await.unwrap();
        assert_eq!(turns.len(), 1);
        assert!(
            turns[0].tool_called,
            "a Turn with no tree at all predates the loop's tool-calling protocol entirely, so \
             it must never read back as the no-tool-call shape issue #103 is about"
        );
        // Issue #98: same reasoning, applied to `model` — a Turn this old
        // predates per-Conversation model choice too, so `default_model` is
        // the only model it could have run on, not a guess.
        assert_eq!(turns[0].model, DEFAULT_MODEL);
    }

    // -- issue #93 pass 2: a loop-driven Turn's run can hold more than one
    // Assistant entry -----------------------------------------------------

    /// The correctness property `run_reflect_loop`'s own persistence
    /// depends on: a Turn whose run is `user -> assistant (tool call) ->
    /// tool_result -> assistant (the real answer)` must read back as one
    /// Turn whose answer is the *last* assistant entry, not the first — the
    /// first is only "I'm going to look that up," not the Answer. Before
    /// issue #93 pass 2's fix, `entries_to_turns` paired a `user` entry with
    /// whatever `assistant` entry immediately followed it, which for a run
    /// like this would have surfaced the tool-call announcement as the
    /// Turn's answer instead.
    #[test]
    fn a_loop_turns_run_reads_back_with_the_last_assistant_entry_as_the_answer() {
        let question_id = Uuid::new_v4();
        let question = user_message(question_id, None, "What did I write about running?");

        let first_assistant_id = Uuid::new_v4();
        let first_assistant = assistant_message(
            first_assistant_id,
            Some(question_id),
            "[called entries_in_range({\"from\":\"2026-07-01\",\"to\":\"2026-07-31\"})]",
        );

        let tool_result_id = Uuid::new_v4();
        let tool_result = tool_result_message(
            tool_result_id,
            Some(first_assistant_id),
            "[2026-07-05] Ran 5k this morning.",
        );

        let final_assistant_id = Uuid::new_v4();
        let final_assistant = assistant_message(
            final_assistant_id,
            Some(tool_result_id),
            "You ran a 5k on July 5th.",
        );

        let path = vec![&question, &first_assistant, &tool_result, &final_assistant];
        let turns = entries_to_turns(&path, DEFAULT_MODEL).unwrap();

        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].question, "What did I write about running?");
        assert_eq!(turns[0].answer, "You ran a 5k on July 5th.");
    }

    /// Two consecutive loop-driven Turns in the same Session — the run
    /// boundary (the *next* `user` entry) must correctly separate them, not
    /// just the presence of an `assistant` entry.
    ///
    /// Issue #103: this fixture already has exactly the shape that ticket's
    /// acceptance criterion needs pinned, on both sides — the first Turn's
    /// run never has a `tool_result` entry in it at all, the second's does
    /// — so it also proves `SessionTurnRow::tool_called` reads back `false`
    /// for the one and `true` for the other, reconstructed from the tree
    /// alone, with no separate flag written anywhere to keep in sync.
    #[test]
    fn two_consecutive_loop_turns_are_read_back_separately() {
        let q1_id = Uuid::new_v4();
        let q1 = user_message(q1_id, None, "First question?");
        let a1_id = Uuid::new_v4();
        let a1 = assistant_message(a1_id, Some(q1_id), "First answer.");

        let q2_id = Uuid::new_v4();
        let q2 = user_message(q2_id, Some(a1_id), "Second question?");
        let tool_id = Uuid::new_v4();
        let tool_call = assistant_message(tool_id, Some(q2_id), "[calling a tool]");
        let result_id = Uuid::new_v4();
        let result = tool_result_message(result_id, Some(tool_id), "found something");
        let a2_id = Uuid::new_v4();
        let a2 = assistant_message(a2_id, Some(result_id), "Second answer.");

        let path = vec![&q1, &a1, &q2, &tool_call, &result, &a2];
        let turns = entries_to_turns(&path, DEFAULT_MODEL).unwrap();

        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].answer, "First answer.");
        assert_eq!(turns[1].answer, "Second answer.");
        assert!(
            !turns[0].tool_called,
            "the first Turn's run never called a tool and must read back as such"
        );
        assert!(
            turns[1].tool_called,
            "the second Turn's run called a tool and must read back as such, distinguishable \
             from the first Turn above"
        );
    }

    /// Issue #98's own acceptance criterion: "reading a Conversation back
    /// shows which model produced which part." A Session that never
    /// changed models reads every Turn as `seed_model` — the ordinary case,
    /// and the one every test above this one already exercises implicitly
    /// via `DEFAULT_MODEL`.
    #[test]
    fn a_session_that_never_changes_models_attributes_every_turn_to_the_seed() {
        let q_id = Uuid::new_v4();
        let q = user_message(q_id, None, "First question?");
        let a_id = Uuid::new_v4();
        let a = assistant_message(a_id, Some(q_id), "First answer.");

        let path = vec![&q, &a];
        let turns = entries_to_turns(&path, DEFAULT_MODEL).unwrap();

        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].model, DEFAULT_MODEL);
    }

    /// The mechanism itself: a `model_change` entry, chained exactly where
    /// `reflect.rs::build_tree_payloads` puts a real one (immediately
    /// before the Question it precedes), moves every Turn after it — but
    /// not before it — onto the new model.
    #[test]
    fn a_model_change_entry_attributes_every_turn_after_it_to_the_new_model() {
        let q1_id = Uuid::new_v4();
        let q1 = user_message(q1_id, None, "First question?");
        let a1_id = Uuid::new_v4();
        let a1 = assistant_message(a1_id, Some(q1_id), "First answer.");

        let change_id = Uuid::new_v4();
        let change = model_change_entry(change_id, Some(a1_id), "claude-sonnet");

        let q2_id = Uuid::new_v4();
        let q2 = user_message(q2_id, Some(change_id), "Second question?");
        let a2_id = Uuid::new_v4();
        let a2 = assistant_message(a2_id, Some(q2_id), "Second answer.");

        let path = vec![&q1, &a1, &change, &q2, &a2];
        let turns = entries_to_turns(&path, DEFAULT_MODEL).unwrap();

        assert_eq!(turns.len(), 2);
        assert_eq!(
            turns[0].model, DEFAULT_MODEL,
            "the Turn before the model_change entry must still read as the seed model"
        );
        assert_eq!(
            turns[1].model, "claude-sonnet",
            "the Turn after the model_change entry must read as the new model"
        );
    }

    /// A run that never produces an `assistant` entry at all — the loop
    /// errored, aborted, or unanimously terminated before ever answering —
    /// contributes no Turn, not a Turn with an empty answer.
    #[test]
    fn a_user_entry_with_no_assistant_answer_contributes_no_turn() {
        let q_id = Uuid::new_v4();
        let question = user_message(q_id, None, "Unanswered?");
        let tool_id = Uuid::new_v4();
        let tool_call = assistant_message(tool_id, Some(q_id), "[calling a tool]");
        let result_id = Uuid::new_v4();
        let result = tool_result_message(result_id, Some(tool_id), "found something");

        let path = vec![&question, &tool_call, &result];
        // The last "assistant" entry here has a tool call in it and no real
        // answer text followed — this fixture is only exercising "no
        // trailing assistant reply exists at all"; a still-more-realistic
        // fixture (an aborted run with no assistant entries whatsoever)
        // behaves identically since `entries_to_turns` only ever looks for
        // *some* assistant entry in the run, not one with particular
        // content.
        let no_assistant_path = vec![&question, &result];
        let turns = entries_to_turns(&no_assistant_path, DEFAULT_MODEL).unwrap();
        assert_eq!(turns.len(), 0);

        // Sanity: the tool-call-bearing fixture above still finds an
        // assistant entry (it has one), proving the empty case above is
        // really about absence, not some other defect.
        let turns_with_assistant = entries_to_turns(&path, DEFAULT_MODEL).unwrap();
        assert_eq!(turns_with_assistant.len(), 1);
    }

    /// `sessions::record_turn_from_steps` (issue #93 pass 2): every payload
    /// lands in the tree in order, chained onto the Session's leaf, and
    /// `load_turns` reads the Turn back using the *last* Assistant payload
    /// as the answer.
    #[sqlx::test]
    async fn record_turn_from_steps_chains_every_payload_in_order(pool: PgPool) {
        let payloads = vec![
            (
                EntryType::Message,
                serde_json::to_value(MessagePayload::User {
                    text: "What did I write about running?".to_string(),
                })
                .unwrap(),
            ),
            (
                EntryType::Message,
                serde_json::to_value(MessagePayload::Assistant {
                    text: "[calling entries_in_range]".to_string(),
                    grounding_entry_ids: Vec::new(),
                    grounded: false,
                    fallback_used: false,
                })
                .unwrap(),
            ),
            (
                EntryType::Message,
                serde_json::to_value(MessagePayload::ToolResult {
                    text: "[2026-07-05] Ran 5k this morning.".to_string(),
                    tool_name: "entries_in_range".to_string(),
                    is_error: false,
                    details: serde_json::json!({"total": 1}),
                })
                .unwrap(),
            ),
            (
                EntryType::Message,
                serde_json::to_value(MessagePayload::Assistant {
                    text: "You ran a 5k on July 5th.".to_string(),
                    grounding_entry_ids: Vec::new(),
                    grounded: true,
                    fallback_used: false,
                })
                .unwrap(),
            ),
        ];

        let turn = NewTurn {
            question: "What did I write about running?".to_string(),
            answer: "You ran a 5k on July 5th.".to_string(),
            grounding_entry_ids: Vec::new(),
            grounded: true,
            fallback_used: false,
        };

        let session_id = record_turn_from_steps(&pool, None, "Running", turn, payloads)
            .await
            .unwrap();

        let entries = load_entries(&pool, session_id).await.unwrap();
        assert_eq!(entries.len(), 4);
        assert_eq!(entries[0].parent_id, None);
        for i in 1..entries.len() {
            assert_eq!(
                entries[i].parent_id,
                Some(entries[i - 1].id),
                "every entry must chain onto the previous one in order"
            );
        }

        let leaf: Option<Uuid> =
            sqlx::query_scalar("select main_leaf_id from sessions where id = $1")
                .bind(session_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(leaf, Some(entries[3].id));

        let turns = load_turns(&pool, session_id, DEFAULT_MODEL).await.unwrap();
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].answer, "You ran a 5k on July 5th.");
    }
}
