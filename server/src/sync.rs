//! `POST /v1/sync` — pushes a Device's local changes and pulls every change
//! it hasn't seen yet.
//!
//! Ticket 2 widened what "a change" means. Through v0.1, Entries were
//! append-only, so sync only ever needed to carry one shape: `nothing ->
//! A`. Editing and deleting an existing Entry are the other two shapes the
//! same idea can take:
//!
//! ```text
//! nothing -> A   (append)
//! A -> B         (edit)
//! A -> nothing   (delete)
//! ```
//!
//! The server holds a **compacted change log**, not an immutable history:
//! one row per Entry, overwritten in place on every edit or delete, with
//! its `seq` (ADR 0002's server-assigned sequence) **reassigned** on every
//! write so the change re-enters the log at the head, above every Device's
//! Cursor. `entries.seq` is a Postgres `bigserial`, assigned once at
//! insert; a Cursor only ever advances forward through `where seq >
//! $since_seq` (`fetch_entries_since`). A plain `update` that left `seq`
//! alone would be invisible to every Device that already passed it — the
//! mutation would sit behind every Cursor forever. Reassigning `seq` is
//! what makes an edit reachable at all.
//!
//! `A -> nothing` needs a way to travel too, and absence-of-row cannot
//! carry a `seq` — there's nothing there to pull. So "nothing" is
//! represented by a **tombstone**: the row survives, `deleted_at` is set
//! (migration 0005), and the delete travels through sync exactly like an
//! edit, reassigned `seq` and all. Every change sent, in either direction,
//! is the **resulting state**, never a delta — an edit's payload is the
//! whole new body, not a diff against the old one.
//!
//! See `insert_entries` for where all of this is actually enforced (a
//! single upsert, inside ADR 0002's advisory-lock transaction), and
//! `fetch_entries_since` for why tombstones are deliberately not filtered
//! out of what a poll returns.
//!
//! Issue #172 / ADR 0051 widened what travels through `/v1/sync` again,
//! this time along a second axis: not a new *shape* of change (Tasks reuse
//! all three shapes above unchanged), but a second **entity stream**
//! alongside Entries — the first non-Entry thing this server has ever
//! Synced (ADR 0047). `TaskInput`/`TaskOutput`/`insert_tasks`/
//! `fetch_tasks_since` mirror `EntryInput`/`EntryOutput`/`insert_entries`/
//! `fetch_entries_since` closely enough that a reader of one recognises
//! the other, on purpose: nothing about *why* a compacted change log with
//! reassigned `seq` and tombstones works for an Entry stops working for a
//! Task, so nothing here reinvents it. What's genuinely new is carried in
//! `SyncRequest`/`SyncResponse` growing a second array and a second Cursor
//! rather than a second endpoint (one round trip, so a Task and the Entry
//! referencing it arrive together), a second advisory-lock key
//! (`TASK_SYNC_INSERT_LOCK_KEY`) so the two streams don't serialise
//! against each other for no reason, and `PROTOCOL_VERSION`'s bump to 5
//! accepting a transitional range rather than a single value
//! (`MIN_PROTOCOL_VERSION`) — see each constant's own doc comment.

use axum::{Json, extract::State, http::StatusCode};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgConnection, PgPool};
use tokio::sync::mpsc::Sender;
use utoipa::ToSchema;
use uuid::Uuid;

/// The only protocol version this server understands. Requests carrying any other
/// value are rejected with 426 — see ADR 0004, this can't be retrofitted later.
///
/// Bumped to 2 by ticket 2: `EntryInput`/`EntryOutput` grew `deleted_at`, and
/// `insert_entries` stopped being append-only (`on conflict (id) do nothing`
/// became a conditional `do update` that can reassign `seq`). An old client
/// speaking version 1 has no way to send or display a tombstone, so it's
/// rejected outright rather than silently degraded — a Device that can't
/// represent "deleted" must not be allowed to push or pull entries at all,
/// or it would resurrect a deleted Entry's content the next time it synced.
///
/// Bumped again, to 3, by issue #96: `POST /v1/reflect` moved from a single
/// JSON response to a `text/event-stream` of named events
/// (`reflect::reflect_handler`'s own doc comment). This one shared constant
/// is read by `sync.rs`, `reflect.rs` **and** `health.rs`, so bumping it for
/// a change that only touches Reflection's wire shape also tells every
/// `/v1/sync` caller the Server has moved on — a real consequence, not a
/// side effect to route around. It's the correct one anyway: a Device is
/// one build that either speaks the current wire protocol in full or
/// doesn't, and an old Device that predates issue #96 has no way to render
/// SSE events at all, so failing its `/v1/reflect` calls loudly (426) is
/// strictly better than a client that can't parse the response it gets back
/// and fails some other, less legible way. Sync's own wire shape
/// (`EntryInput`/`EntryOutput`/`SyncRequest`/`SyncResponse`) is completely
/// unchanged by this bump — an old Device is turned away not because
/// anything about *sync* broke, but because there is exactly one version
/// number for "this Device's whole build is current," and it just isn't.
///
/// Bumped again, to 4, by issue #104: `agent_loop::LoopEvent::TurnStart` and
/// the `turn_start` SSE event it became on the wire are renamed to
/// `StepStart`/`step_start`, so a Device still expecting `turn_start` would
/// wait on an event that no longer arrives. Same reasoning as the bump to 3
/// above — one shared constant, so this Reflection-only rename still turns
/// away a stale `/v1/sync` caller too, and that is the correct, honest
/// behaviour rather than a side effect to route around.
///
/// Bumped again, to 5, by issue #172 / ADR 0051: `SyncRequest`/
/// `SyncResponse` grow a second entity stream — Tasks, alongside Entries
/// (ADR 0047) — and that is exactly the kind of wire-shape change every
/// earlier bump on this constant was made for. Unlike every bump above,
/// this one does **not** simply turn a stale Device away: see
/// `MIN_PROTOCOL_VERSION` below for why a Device still speaking 4 keeps
/// syncing its Entries, unchanged, rather than getting a 426. Android,
/// macOS and web ship separately, so there is always a window in which
/// some Devices have updated and some haven't — a hard cutover the moment
/// the Server moves to 5 would 426 every Entry push from every
/// not-yet-updated Device, for a change that has nothing to do with
/// Entries at all. Dropping protocol 4 support is a later, deliberate
/// release (ADR 0051's Consequences), not a side effect of shipping Tasks.
pub const PROTOCOL_VERSION: i32 = 5;

/// The lowest protocol version this Server still accepts, alongside
/// `PROTOCOL_VERSION` itself — together they describe an accepted
/// **range**, not a single value, for the first time since ADR 0004
/// introduced this check. See `PROTOCOL_VERSION`'s own doc comment on the
/// bump to 5 for why: a Device on 4 has no way to represent a Task at all
/// (its own `SyncRequest`/`SyncResponse` types predate the field), but it
/// has every ability to keep sending and receiving Entries exactly as it
/// always has, and there is no reason to 426 it out of that. `sync_handler`
/// rejects anything outside `MIN_PROTOCOL_VERSION..=PROTOCOL_VERSION`; a
/// Device at exactly 4 is accepted and simply never touches the Task
/// stream — `run_sync`'s own doc comment covers how. This constant is
/// deleted, and the check tightened back to a single accepted value, once
/// enough time has passed that no Device still speaks 4 (ADR 0051's
/// Consequences names this as a later, deliberate release, not a date
/// fixed in advance).
const MIN_PROTOCOL_VERSION: i32 = 4;

/// Caps how many Entries a single sync response returns, so a Device far behind
/// doesn't pull the whole History in one response. Note: since the batch is the
/// oldest unsynced Entries first, a Device whose own backlog exceeds this size won't
/// see the Entries it just submitted in this same response — they're still the
/// freshest (highest seq) rows, so they surface once the backlog ahead of them drains
/// on a later poll.
///
/// Reused, not duplicated, for the Task stream below (`fetch_tasks_since`)
/// — the reasoning ("don't pull a whole backlog in one response") is
/// identical for either entity, and a second constant with the same value
/// would only be one more place the two could drift apart for no reason
/// either stream needs.
pub const SYNC_BATCH_SIZE: i64 = 500;

/// The advisory lock key serialising Entry inserts so commit order equals sequence
/// order. See ADR 0002 — do not remove without re-deriving that reasoning.
const SYNC_INSERT_LOCK_KEY: i64 = 0x6d656f6c;

/// The advisory lock key serialising Task inserts — same job as
/// `SYNC_INSERT_LOCK_KEY` above (ADR 0002's reasoning, reused for Tasks
/// rather than reinvented, per ADR 0047), but a **distinct** key, not a
/// second use of that one. The lock's whole purpose is making one table's
/// commit order match its own sequence-assignment order
/// (`acquire_insert_lock`'s own doc comment); Entries and Tasks each have
/// their own `seq` sequence and their own Cursor, and neither is ever
/// compared against the other's. Sharing one lock key would serialise a
/// Task push behind an unrelated, concurrent Entry push (and vice versa)
/// for no correctness reason either stream needs — it would only make the
/// two streams block each other instead of running concurrently. Spelled
/// out in hex as ASCII "task", mirroring `SYNC_INSERT_LOCK_KEY`'s own
/// ASCII "meol" above.
const TASK_SYNC_INSERT_LOCK_KEY: i64 = 0x7461736b;

#[derive(Debug, Deserialize, ToSchema)]
pub struct EntryInput {
    pub id: Uuid,
    pub device_id: Uuid,
    pub body: String,
    pub created_at: DateTime<Utc>,
    /// `Some` marks this push as a delete of an existing Entry (a tombstone
    /// — see migration 0005). `None` is an append or an edit. There is no
    /// separate "is this an edit" flag: `insert_entries`'s upsert treats a
    /// push with the same `id` as an existing row as an edit regardless of
    /// `deleted_at`, and a delete is just an edit whose `deleted_at` happens
    /// to be set.
    pub deleted_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize, FromRow, ToSchema)]
pub struct EntryOutput {
    pub id: Uuid,
    pub device_id: Uuid,
    pub body: String,
    pub created_at: DateTime<Utc>,
    pub seq: i64,
    /// `Some` means this Entry is a tombstone — see migration 0005 and
    /// `fetch_entries_since`'s doc comment for why tombstones travel
    /// through sync exactly like any other change rather than being
    /// filtered out here.
    pub deleted_at: Option<DateTime<Utc>>,
}

/// The Task-shaped sibling of `EntryInput` (ADR 0047's second root noun,
/// ADR 0051's second Sync stream). Deliberately no collaboration column —
/// see `../migrations/0010_create_tasks.sql`'s own header comment, which
/// mirrors `../../packages/core/src/task-types.ts`'s refusal exactly.
///
/// `project_id`/`section_id`/`parent_id` are plain `Option<Uuid>`, not
/// validated against anything: Projects, Sections and Labels do not sync
/// in this ticket (issue #172's own scope decision, recorded in ADR 0051),
/// so a Task can arrive here naming a Project this Server has never heard
/// of. That is an accepted, transient state carried straight through — the
/// identical "dangling cross-reference is not this store's problem to fix"
/// rule `../../packages/core/src/task-types.ts`'s own `projectId`/
/// `labelIds` doc comments already state for the client side, applied here
/// because there is genuinely nothing more this Server could check: it
/// never reads a `projects` or `labels` table at all.
#[derive(Debug, Deserialize, ToSchema)]
pub struct TaskInput {
    pub id: Uuid,
    pub device_id: Uuid,
    pub content: String,
    pub completed_at: Option<DateTime<Utc>>,
    pub order_key: String,
    pub created_at: DateTime<Utc>,
    /// Tombstone — see `EntryInput::deleted_at`'s own doc comment; the
    /// identical representation, reused for the identical reason (ADR
    /// 0028, applied to Tasks by ADR 0047).
    pub deleted_at: Option<DateTime<Utc>>,
    /// Floating (`../../packages/core/src/task-types.ts`'s `date` doc
    /// comment: never a `Z`, never an offset) — kept as a plain string
    /// rather than `DateTime<Utc>` for exactly that reason, the same way
    /// `dateString`/`deadline` below are.
    pub date: Option<String>,
    pub deadline: Option<String>,
    pub priority: i32,
    pub label_ids: Vec<Uuid>,
    pub date_string: Option<String>,
    pub project_id: Option<Uuid>,
    pub section_id: Option<Uuid>,
    pub parent_id: Option<Uuid>,
}

/// The Task-shaped sibling of `EntryOutput` — see `TaskInput`'s own doc
/// comment for the fields it shares; this adds only `seq`, exactly as
/// `EntryOutput` adds `seq` to `EntryInput`.
#[derive(Debug, Serialize, FromRow, ToSchema)]
pub struct TaskOutput {
    pub id: Uuid,
    pub device_id: Uuid,
    pub content: String,
    pub completed_at: Option<DateTime<Utc>>,
    pub order_key: String,
    pub created_at: DateTime<Utc>,
    pub seq: i64,
    pub deleted_at: Option<DateTime<Utc>>,
    pub date: Option<String>,
    pub deadline: Option<String>,
    pub priority: i32,
    pub label_ids: Vec<Uuid>,
    pub date_string: Option<String>,
    pub project_id: Option<Uuid>,
    pub section_id: Option<Uuid>,
    pub parent_id: Option<Uuid>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct SyncRequest {
    pub protocol_version: i32,
    pub device_id: Uuid,
    pub since_seq: i64,
    pub entries: Vec<EntryInput>,
    /// The Task stream's own Cursor (ADR 0051), alongside `since_seq`
    /// above — two independent streams, two independent watermarks, never
    /// one shared number (see `TASK_SYNC_INSERT_LOCK_KEY`'s doc comment
    /// for the identical reasoning applied to the advisory lock).
    /// `#[serde(default)]`, not because a v5 Device ever omits it, but
    /// because a v4 Device's request body — built against the pre-#172
    /// wire shape — genuinely has no such key at all
    /// (`PROTOCOL_VERSION`'s own doc comment on the dual-version window).
    /// Deserializing that body must not fail just because Sync grew a
    /// second stream; defaulting to 0 is exactly "this Device has never
    /// synced a Task", which is true of every v4 Device by construction.
    #[serde(default)]
    pub since_task_seq: i64,
    /// The Task stream's own pending pushes, alongside `entries` above —
    /// `#[serde(default)]` for the identical reason `since_task_seq` is: a
    /// v4 Device's request body has no `tasks` key, and an empty default
    /// is exactly what "this build has never pushed a Task, because it has
    /// no idea Tasks exist" means. `run_sync` additionally never *acts* on
    /// this even when a v4 body somehow carried one (see its own doc
    /// comment) — belt and braces, since a real v4 build could never
    /// construct such a request in the first place.
    #[serde(default)]
    pub tasks: Vec<TaskInput>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct SyncResponse {
    pub entries: Vec<EntryOutput>,
    pub cursor: i64,
    /// The Task stream's own pull, alongside `entries` above — one
    /// endpoint, one round trip (ADR 0051's own Alternatives section: a
    /// separate `/v1/tasks/sync` was rejected precisely because it opens a
    /// window where an Entry references a Task that hasn't arrived yet).
    /// Always present on the wire, unlike the request fields above:
    /// nothing about the *response* shape needs to tolerate an old
    /// Device — a v4 Device simply never reads a JSON key its own build
    /// predates, the same way it already ignores any other field it
    /// doesn't recognise. `run_sync` sets this to `[]` when
    /// `protocol_version < 5`, not because serde can't populate it, but
    /// because a v4 Device asked for Entries only and returning Tasks it
    /// has no representation for — and never requested — would be
    /// answering a question it didn't ask (see `run_sync`'s own doc
    /// comment).
    pub tasks: Vec<TaskOutput>,
    pub task_cursor: i64,
}

#[utoipa::path(
    post,
    path = "/v1/sync",
    request_body = SyncRequest,
    responses(
        (status = 200, description = "Entries (and, from protocol 5, Tasks) accepted; every change after since_seq/since_task_seq is returned", body = SyncResponse),
        (status = 426, description = "protocol_version is outside the range this server understands"),
    )
)]
pub async fn sync_handler(
    State(pool): State<PgPool>,
    State(embed_tx): State<Option<Sender<Uuid>>>,
    Json(req): Json<SyncRequest>,
) -> Result<Json<SyncResponse>, StatusCode> {
    tracing::Span::current().record("device_id", tracing::field::display(req.device_id));

    // A range, not an equality check, since issue #172 / ADR 0051 — see
    // MIN_PROTOCOL_VERSION's own doc comment for why a Device on 4 is
    // still welcome here rather than 426'd like every other stale version.
    if req.protocol_version < MIN_PROTOCOL_VERSION || req.protocol_version > PROTOCOL_VERSION {
        tracing::warn!(
            device_id = %req.device_id,
            requested_version = req.protocol_version,
            "rejecting sync: unsupported protocol version",
        );
        metrics::counter!("sync_protocol_mismatches_total").increment(1);
        return Err(StatusCode::UPGRADE_REQUIRED);
    }

    let pushed = req.entries.len() as u64;
    let tasks_pushed = req.tasks.len() as u64;

    run_sync(&pool, &embed_tx, req)
        .await
        .map(|resp| {
            metrics::counter!("sync_entries_pushed_total").increment(pushed);
            metrics::counter!("sync_entries_pulled_total").increment(resp.entries.len() as u64);
            metrics::counter!("sync_tasks_pushed_total").increment(tasks_pushed);
            metrics::counter!("sync_tasks_pulled_total").increment(resp.tasks.len() as u64);
            Json(resp)
        })
        .map_err(|err| {
            tracing::error!(error = ?err, "sync failed");
            StatusCode::INTERNAL_SERVER_ERROR
        })
}

/// Runs both entity streams for one `/v1/sync` round trip — Entries first
/// (unchanged from before this ticket), then Tasks (ADR 0051).
///
/// **The Task stream only runs for a Device speaking protocol 5 or
/// later.** `req.tasks`/`req.since_task_seq` are already `[]`/`0` for a
/// v4 Device by construction (`SyncRequest`'s own `#[serde(default)]`
/// fields — a real v4 build's request body has no such keys at all), so
/// skipping `insert_tasks` for one costs nothing beyond a redundant
/// no-op. The check earns its keep on the *response* side instead: a v4
/// Device polling from `since_task_seq: 0` — the only value it could ever
/// send, since it has no Cursor to advance in the first place — would
/// otherwise receive every Task any other Device has ever pushed, which
/// is data it has no wire representation for and never asked to see
/// (`SyncResponse::tasks`'s own doc comment). Gating the whole Task half
/// of this function on `protocol_version` is what makes "a v4 Device
/// keeps syncing Entries and simply sees no Tasks" (ADR 0051's own
/// acceptance criterion) true of the response, not only of what this
/// Server happens to have been sent.
async fn run_sync(
    pool: &PgPool,
    embed_tx: &Option<Sender<Uuid>>,
    req: SyncRequest,
) -> anyhow::Result<SyncResponse> {
    if !req.entries.is_empty() {
        let inserted_ids = insert_entries(pool, &req.entries).await?;
        if let Some(tx) = embed_tx {
            for id in inserted_ids {
                // Never `.send().await`: a full or lagging embedding worker
                // must not block `/v1/sync` — Capture is the product,
                // Reflection is a feature on top of it. Dropping a hint
                // here is safe *because* the `embedding IS NULL` scan
                // (ADR 0022) is the durable source of truth for what needs
                // embedding, not this channel.
                let _ = tx.try_send(id);
            }
        }
    }

    let entries = fetch_entries_since(pool, req.since_seq).await?;
    let cursor = entries.last().map_or(req.since_seq, |e| e.seq);

    // See this function's own doc comment for why protocol 5 is the gate,
    // not merely `!req.tasks.is_empty()` — a v4 Device pushes nothing to
    // gate on, but must still pull nothing back.
    let (tasks, task_cursor) = if req.protocol_version >= 5 {
        if !req.tasks.is_empty() {
            insert_tasks(pool, &req.tasks).await?;
        }
        let tasks = fetch_tasks_since(pool, req.since_task_seq).await?;
        let task_cursor = tasks.last().map_or(req.since_task_seq, |t| t.seq);
        (tasks, task_cursor)
    } else {
        (Vec::new(), req.since_task_seq)
    };

    Ok(SyncResponse { entries, cursor, tasks, task_cursor })
}

/// Held until commit: makes commit order equal sequence-assignment order, so a Device
/// polling mid-transaction can never advance its Cursor past a row that hasn't
/// committed yet. See ADR 0002 — two lines, don't delete them.
async fn acquire_insert_lock(conn: &mut PgConnection) -> sqlx::Result<()> {
    sqlx::query("select pg_advisory_xact_lock($1)")
        .bind(SYNC_INSERT_LOCK_KEY)
        .execute(conn)
        .await?;
    Ok(())
}

/// Inserts a new Entry, or applies an edit/delete to an existing one — see
/// the module comment at the top of this file for why sync carries changes
/// rather than immutable Entries. Returns the ids of every row this call
/// actually *changed* (a fresh insert, an edit that altered the body, or a
/// delete) — a replayed push that changes nothing returns no row from
/// `returning id`, so it's excluded automatically rather than needing a
/// separate existence check. The caller uses this to hint the embedding
/// worker only about Entries whose content actually needs re-embedding
/// (see `run_sync`); a no-op replay must not re-trigger that, which is
/// exactly what the `is distinct from` guard below buys it.
///
/// The upsert:
///
/// ```sql
/// insert into entries (id, device_id, body, created_at, deleted_at)
/// values ($1, $2, $3, $4, $5)
/// on conflict (id) do update
///   set body       = excluded.body,
///       deleted_at = excluded.deleted_at,
///       embedding  = null,
///       seq        = nextval(pg_get_serial_sequence('entries', 'seq'))
///   where entries.deleted_at is null
///     and (entries.body       is distinct from excluded.body
///       or entries.deleted_at is distinct from excluded.deleted_at)
/// returning id
/// ```
///
/// Three things in that `where` clause are each load-bearing on their own:
///
/// - `entries.deleted_at is null` — **delete is terminal.** Once an Entry
///   is tombstoned, no further push against its `id` can change it: an
///   offline Device that edited this Entry before hearing about the delete
///   pushes that edit, the `where` clause makes it a no-op (the row is
///   left exactly as the delete left it), and that Device's next poll pulls
///   the tombstone back down and discards the edit it tried to make on top
///   of a since-deleted Entry. This is the entire reconciliation policy for
///   "edit vs. delete arriving out of order" — it lives here, as a `where`
///   clause, not as branching logic anywhere else in this file or in a
///   client.
/// - the `is distinct from` pair — **replay stays a true no-op.** Without
///   it, re-pushing an Entry that hasn't actually changed would still
///   satisfy `on conflict`, bump its `seq` to the head of the log, null out
///   its `embedding`, and move every Device's cursor — on every single
///   replay of the same push, forever. `is distinct from` (not `!=`, which
///   is false when comparing against `deleted_at`'s frequent `null`) makes
///   an identical resubmission match neither branch and touch nothing.
///   `replaying_the_same_request_creates_no_duplicate_rows` in
///   `server/tests/sync.rs` asserts `first["cursor"] == second["cursor"]`
///   and would fail immediately if this pair were dropped.
/// - `seq = nextval(pg_get_serial_sequence('entries', 'seq'))` — an edit or
///   delete has to re-enter the log at the head, above every Cursor, or it
///   is exactly as unreachable as a plain `update` would leave it (see the
///   module comment). The sequence backing `entries.seq bigserial` is
///   looked up by name via `pg_get_serial_sequence` rather than hardcoding
///   `entries_seq_seq` — the generated name is a Postgres implementation
///   detail this code shouldn't need to know or keep in sync with the
///   column's actual name.
///
/// Two columns are deliberately absent from the `set` list, both on
/// purpose:
///
/// - `device_id` — an Entry is identified by the Device that *created* it.
///   An edit made from a different Device does not re-attribute authorship;
///   it only changes content.
/// - `created_at` — never changes on an edit. This is what keeps an edited
///   Entry sitting in its original place in History's chronological order,
///   even though its `seq` (sync order, not display order — ADR 0002) just
///   jumped to the head of the log.
async fn insert_entries(pool: &PgPool, entries: &[EntryInput]) -> anyhow::Result<Vec<Uuid>> {
    let mut tx = pool.begin().await?;
    acquire_insert_lock(&mut tx).await?;

    let mut inserted_ids = Vec::with_capacity(entries.len());
    for entry in entries {
        let changed_id: Option<Uuid> = sqlx::query_scalar(
            "insert into entries (id, device_id, body, created_at, deleted_at)
             values ($1, $2, $3, $4, $5)
             on conflict (id) do update
               set body       = excluded.body,
                   deleted_at = excluded.deleted_at,
                   embedding  = null,
                   seq        = nextval(pg_get_serial_sequence('entries', 'seq'))
               where entries.deleted_at is null
                 and (entries.body       is distinct from excluded.body
                   or entries.deleted_at is distinct from excluded.deleted_at)
             returning id",
        )
        .bind(entry.id)
        .bind(entry.device_id)
        .bind(&entry.body)
        .bind(entry.created_at)
        .bind(entry.deleted_at)
        .fetch_optional(&mut *tx)
        .await?;
        if let Some(id) = changed_id {
            inserted_ids.push(id);
        }
    }

    tx.commit().await?;
    Ok(inserted_ids)
}

/// `deleted_at` travels with every other column here and is filtered on by
/// **no one** in this query — that's deliberate, not an oversight. A
/// tombstone is itself the change a Device needs to receive: if it were
/// filtered out here, a Device that already pulled an Entry before it was
/// deleted would have no way to ever find out, because a delete's only
/// representation is this row reappearing at a higher `seq` with
/// `deleted_at` set (see the module comment and migration 0005). Every
/// *reader* of Entry content — `reflect.rs`, `digest.rs`, `embedding.rs` —
/// filters `deleted_at is null` on its own; this function is sync's
/// transport, not a content reader, and must carry the tombstone through
/// unfiltered.
async fn fetch_entries_since(pool: &PgPool, since_seq: i64) -> anyhow::Result<Vec<EntryOutput>> {
    let entries = sqlx::query_as::<_, EntryOutput>(
        "select id, device_id, body, created_at, seq, deleted_at
         from entries
         where seq > $1
         order by seq asc
         limit $2",
    )
    .bind(since_seq)
    .bind(SYNC_BATCH_SIZE)
    .fetch_all(pool)
    .await?;

    Ok(entries)
}

/// Held until commit, for the Task stream — the identical job
/// `acquire_insert_lock` does for Entries, against
/// `TASK_SYNC_INSERT_LOCK_KEY` instead (see that constant's own doc
/// comment for why it's a distinct key rather than a second call to
/// `acquire_insert_lock` itself). ADR 0002 again — two lines, don't
/// delete them.
async fn acquire_task_insert_lock(conn: &mut PgConnection) -> sqlx::Result<()> {
    sqlx::query("select pg_advisory_xact_lock($1)")
        .bind(TASK_SYNC_INSERT_LOCK_KEY)
        .execute(conn)
        .await?;
    Ok(())
}

/// Inserts a new Task, or applies an edit/delete to an existing one — the
/// Task-shaped sibling of `insert_entries` above, reusing every guarantee
/// that function's own doc comment argues for rather than re-deriving
/// them (ADR 0047: a Task's Sync stream reuses ADR 0002's advisory-lock
/// ordering and ADR 0028's seq-reassignment/tombstone rules unchanged).
/// Three things in the `where` clause below are each load-bearing on
/// their own, for the identical reasons `insert_entries`'s doc comment
/// gives — restated here because a Task has thirteen mutable columns
/// where an Entry has two, and it would be easy to assume the guard only
/// needs to watch the ones this ticket happens to exercise:
///
/// - `tasks.deleted_at is null` — **delete is terminal**, exactly as for
///   an Entry. Once a Task is tombstoned, no further push against its
///   `id` — a stale rename, a stale reorder, a stale completion, however
///   new any of them claim to be — can revive or change it. An offline
///   Device's late edit finds its `UPDATE` matches no row, no-ops, and
///   its next poll pulls the tombstone down and discards the edit. No
///   branching logic anywhere asks "was this deleted after my edit" —
///   this clause is the entire policy, for a Task exactly as it already
///   is for an Entry.
/// - the `is distinct from` chain — **replay stays a true no-op**, for
///   every one of a Task's own settable fields, not merely `content`. A
///   Task has many more independent setters than an Entry does
///   (`../../packages/core/src/task-store.ts`: rename, reorder, setDate,
///   setPriority, setLabelIds, setProject, and so on), each of which
///   clears the client's local `seq` to mark itself pending — but they
///   all funnel through this one upsert server-side, so the guard has to
///   compare every column a setter could have touched, or a replay of an
///   *unrelated* setter's own already-applied write would still reassign
///   `seq` and move every Device's Cursor on every redundant retry, the
///   identical bug `insert_entries`'s own `is distinct from` pair exists
///   to prevent for Entries.
/// - `seq = nextval(pg_get_serial_sequence('tasks', 'seq'))` — an edit or
///   delete has to re-enter the compacted log at the head, above every
///   Cursor, or it sits exactly as unreachable as a plain `update` would
///   leave it (the module comment at the top of this file). Looked up by
///   name for the identical reason `insert_entries` does: the generated
///   sequence name is a Postgres implementation detail this code
///   shouldn't need to track.
///
/// `device_id` and `created_at` are absent from the `set` list, for the
/// identical reasons `insert_entries`'s own doc comment gives for
/// Entries: a Task is identified by the Device that *created* it, not the
/// one that most recently edited it, and `created_at` never moves on an
/// edit.
async fn insert_tasks(pool: &PgPool, tasks: &[TaskInput]) -> anyhow::Result<()> {
    let mut tx = pool.begin().await?;
    acquire_task_insert_lock(&mut tx).await?;

    for task in tasks {
        sqlx::query(
            "insert into tasks (
                 id, device_id, content, completed_at, order_key, created_at,
                 deleted_at, date, deadline, priority, label_ids,
                 date_string, project_id, section_id, parent_id
             )
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
             on conflict (id) do update
               set content       = excluded.content,
                   completed_at  = excluded.completed_at,
                   order_key     = excluded.order_key,
                   deleted_at    = excluded.deleted_at,
                   date          = excluded.date,
                   deadline      = excluded.deadline,
                   priority      = excluded.priority,
                   label_ids     = excluded.label_ids,
                   date_string   = excluded.date_string,
                   project_id    = excluded.project_id,
                   section_id    = excluded.section_id,
                   parent_id     = excluded.parent_id,
                   seq           = nextval(pg_get_serial_sequence('tasks', 'seq'))
               where tasks.deleted_at is null
                 and (tasks.content      is distinct from excluded.content
                   or tasks.completed_at is distinct from excluded.completed_at
                   or tasks.order_key    is distinct from excluded.order_key
                   or tasks.deleted_at   is distinct from excluded.deleted_at
                   or tasks.date         is distinct from excluded.date
                   or tasks.deadline     is distinct from excluded.deadline
                   or tasks.priority     is distinct from excluded.priority
                   or tasks.label_ids    is distinct from excluded.label_ids
                   or tasks.date_string  is distinct from excluded.date_string
                   or tasks.project_id   is distinct from excluded.project_id
                   or tasks.section_id   is distinct from excluded.section_id
                   or tasks.parent_id    is distinct from excluded.parent_id)",
        )
        .bind(task.id)
        .bind(task.device_id)
        .bind(&task.content)
        .bind(task.completed_at)
        .bind(&task.order_key)
        .bind(task.created_at)
        .bind(task.deleted_at)
        .bind(&task.date)
        .bind(&task.deadline)
        .bind(task.priority)
        .bind(&task.label_ids)
        .bind(&task.date_string)
        .bind(task.project_id)
        .bind(task.section_id)
        .bind(task.parent_id)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    Ok(())
}

/// The Task-shaped sibling of `fetch_entries_since` — `deleted_at` travels
/// unfiltered for the identical reason: a tombstone is itself the change a
/// Device needs to receive, and this function is Sync's transport, not a
/// content reader. Nothing in this ticket reads live Task content
/// server-side the way `reflect.rs`/`digest.rs`/`embedding.rs` read
/// Entries (that's issue #175's own scope), so there is, for now, no
/// *reader* of Tasks that needs its own `deleted_at is null` filter the
/// way `fetch_entries_since`'s doc comment points to for Entries — only
/// this transport exists yet.
async fn fetch_tasks_since(pool: &PgPool, since_seq: i64) -> anyhow::Result<Vec<TaskOutput>> {
    let tasks = sqlx::query_as::<_, TaskOutput>(
        "select id, device_id, content, completed_at, order_key, created_at, seq,
                deleted_at, date, deadline, priority, label_ids,
                date_string, project_id, section_id, parent_id
         from tasks
         where seq > $1
         order by seq asc
         limit $2",
    )
    .bind(since_seq)
    .bind(SYNC_BATCH_SIZE)
    .fetch_all(pool)
    .await?;

    Ok(tasks)
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::*;

    // Calls the same `acquire_insert_lock` production uses (rather than `insert_entries`
    // as a whole) so the delay needed to observe blocking can sit inside the held
    // transaction without adding a test-only hook to production code.
    #[sqlx::test]
    async fn concurrent_inserts_are_serialised_so_commit_order_matches_sequence_order(pool: PgPool) {
        let pool_a = pool.clone();
        let task_a = tokio::spawn(async move {
            let mut tx = pool_a.begin().await.unwrap();
            acquire_insert_lock(&mut tx).await.unwrap();
            let seq: i64 = sqlx::query_scalar(
                "insert into entries (id, device_id, body, created_at) values ($1, $2, 'a', now()) returning seq",
            )
            .bind(Uuid::new_v4())
            .bind(Uuid::new_v4())
            .fetch_one(&mut *tx)
            .await
            .unwrap();
            // Held while still holding the lock, so task B can only acquire it after this commits.
            sqlx::query("select pg_sleep(0.3)")
                .execute(&mut *tx)
                .await
                .unwrap();
            tx.commit().await.unwrap();
            seq
        });

        // Give A a head start so it wins the race for the lock.
        tokio::time::sleep(Duration::from_millis(50)).await;

        let pool_b = pool.clone();
        let start = Instant::now();
        let task_b = tokio::spawn(async move {
            let mut tx = pool_b.begin().await.unwrap();
            acquire_insert_lock(&mut tx).await.unwrap();
            let acquired_after = start.elapsed();
            let seq: i64 = sqlx::query_scalar(
                "insert into entries (id, device_id, body, created_at) values ($1, $2, 'b', now()) returning seq",
            )
            .bind(Uuid::new_v4())
            .bind(Uuid::new_v4())
            .fetch_one(&mut *tx)
            .await
            .unwrap();
            tx.commit().await.unwrap();
            (seq, acquired_after)
        });

        let seq_a = task_a.await.unwrap();
        let (seq_b, acquired_after) = task_b.await.unwrap();

        assert!(
            seq_b > seq_a,
            "B's sequence must be assigned after A's, since B could only acquire the lock once A committed"
        );
        assert!(
            acquired_after >= Duration::from_millis(200),
            "B should have blocked on the advisory lock until A committed; only waited {acquired_after:?}"
        );
    }
}
