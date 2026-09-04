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
//!
//! Issue #182 / ADR 0051's own forward reference repeats the identical move
//! four more times: Projects, Sections, Labels and Comments (ADR 0047's
//! remaining root nouns, plus #180's Comment) each get their own array,
//! their own Cursor, their own advisory-lock key, and their own
//! `insert_*`/`fetch_*_since` pair, mirroring `TaskInput`/`TaskOutput`/
//! `insert_tasks`/`fetch_tasks_since` field for field. `PROTOCOL_VERSION`
//! moves to 6; the four new streams are gated on `protocol_version >= 6`
//! in `run_sync`, the identical shape the Task stream's own `>= 5` gate
//! already takes, so a Device on 4 or 5 keeps syncing Entries and Tasks
//! unaffected and simply never sees a Project, Section, Label or Comment.
//!
//! Issue #184 / ADR 0056 adds a seventh stream, Events — Todo's own
//! activity log — the same way, but lands it **inside** the existing
//! `>= 6` gate rather than earning a bump of its own: `PROTOCOL_VERSION`
//! stays 6, because nothing about this stream's own wire shape is
//! incompatible with what a v6 Device already expects. `EventInput`/
//! `EventOutput`/`insert_events`/`fetch_events_since` mirror
//! `CommentInput`/`CommentOutput`/`insert_comments`/`fetch_comments_since`
//! in every way but one: an Event is never edited or deleted once written
//! (ADR 0056's own Decision), so it carries no `deleted_at` and
//! `insert_events`'s own upsert has nothing to reassign `seq` *for* — a
//! push that names an `id` already on this table is a replay, full stop,
//! not a change that might or might not be a no-op the way every other
//! stream's `is distinct from` guard has to work out. See `insert_events`'s
//! own doc comment for the reasoning spelled out in full. `occurred_at` is
//! whatever the pushing Device's own clock said when the act happened —
//! never reassigned, never compared against server arrival time, because
//! there is no LWW rule here to arbitrate: two Devices can never disagree
//! about the same Event row, only both hold Events the other doesn't yet.

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
///
/// Bumped again, to 6, by issue #182: four more entity streams — Projects,
/// Sections, Labels and Comments (ADR 0047's remaining root nouns, plus
/// #180's Comment) — alongside Entries and Tasks. The identical reasoning
/// as the bump to 5 applies again: a Device that has never opened a
/// Project or Label picker still deserves its journal and its Tasks to
/// keep syncing unaffected. `MIN_PROTOCOL_VERSION` stays 4 rather than
/// moving to 5 — nothing about this bump requires dropping the existing
/// 4-vs-5 transitional window, and doing so here would be an unrelated
/// policy change riding along on this one.
///
/// **Not bumped again by issue #184.** Events — Todo's own activity log,
/// ADR 0056 — are a seventh stream added the same way the previous six
/// were, but a bump exists to tell a Device "the wire shape you already
/// know has changed," and nothing about `SyncRequest`/`SyncResponse`'s
/// *existing* fields changes here: `events`/`since_event_seq` are new,
/// additive, `#[serde(default)]` fields, exactly like `tasks`/
/// `since_task_seq` were the moment protocol 5 introduced them but before
/// this constant itself had moved past 4. A v6 Device that predates this
/// ticket sends a request with no `events` key at all, gets one back with
/// `events: []`, and keeps syncing Entries, Tasks, Projects, Sections,
/// Labels and Comments exactly as it always has — there is no wire shape
/// it now fails to understand, so there is nothing here for a version
/// number to protect it from.
///
/// **If you are about to add a field to an existing kind of row here —
/// `TaskInput`/`TaskOutput`, `ProjectInput`/`ProjectOutput`, and so on —
/// read this note before you do, whether or not it also moves this
/// constant.** Issue #186 / ADR 0057: a Device's own Cursor for a stream
/// only ever advances through rows it has already asked for
/// (`fetch_*_since` below); a row it pulled before your new field existed
/// stays behind that Cursor forever, and your field never reaches that
/// Device until something unrelated edits the row and reassigns its
/// `seq`. This bit meologue once already — `TaskInput::description`
/// below, added by issue #182 onto the Task stream that already existed
/// from issue #172, is the exact case that was caught only by
/// coincidence during manual verification. `PROTOCOL_VERSION` cannot
/// carry this obligation itself: it names "the wire shape a Device's
/// whole build understands," not "which streams' rows just gained a
/// field," and the two move independently in both directions — issue
/// #184 added an entire stream (Events) with **no** bump here, and a
/// future stream could earn a bump with no existing row gaining a field
/// at all. The obligation lives client-side instead:
/// `packages/core/src/protocol.ts`'s `ROW_SHAPE_EPOCH` map, one entry per
/// stream, bumped only when that stream's row shape gains a field — see
/// its own doc comment for the mechanism (`EntryStore.catchUpRowShapeEpoch`,
/// `packages/core/src/store.ts`) and ADR 0057 for the design this
/// constant's own bumps have nothing to do with.
pub const PROTOCOL_VERSION: i32 = 6;

/// The lowest protocol version this Server still accepts, alongside
/// `PROTOCOL_VERSION` itself — together they describe an accepted
/// **range**, not a single value, for the first time since ADR 0004
/// introduced this check. See `PROTOCOL_VERSION`'s own doc comment on the
/// bump to 5 for why: a Device on 4 has no way to represent a Task at all
/// (its own `SyncRequest`/`SyncResponse` types predate the field), but it
/// has every ability to keep sending and receiving Entries exactly as it
/// always has, and there is no reason to 426 it out of that. The identical
/// argument holds for a Device on 5 once Projects/Sections/Labels/
/// Comments exist (issue #182): it has no way to represent any of the
/// four, but every ability to keep syncing Entries and Tasks. `sync_handler`
/// rejects anything outside `MIN_PROTOCOL_VERSION..=PROTOCOL_VERSION`; a
/// Device at 4 or 5 is accepted and simply never touches whichever streams
/// postdate its own build — `run_sync`'s own doc comment covers how. This
/// constant is deleted, and the check tightened back to a single accepted
/// value, once enough time has passed that no Device still speaks below
/// `PROTOCOL_VERSION` (ADR 0051's Consequences names this as a later,
/// deliberate release, not a date fixed in advance).
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

/// The advisory lock key serialising Project inserts — issue #182's own
/// repeat of `TASK_SYNC_INSERT_LOCK_KEY`'s reasoning: Projects get their
/// own `seq` sequence and their own Cursor, never compared against any
/// other stream's, so sharing a lock key would only serialise an unrelated
/// stream's push for no correctness reason. ASCII "proj".
const PROJECT_SYNC_INSERT_LOCK_KEY: i64 = 0x70726f6a;

/// The advisory lock key serialising Section inserts — a Section's own
/// `seq` sequence is independent of a Project's even though a Section
/// always belongs to one, for the identical reason `SYNC_INSERT_LOCK_KEY`
/// and `TASK_SYNC_INSERT_LOCK_KEY` are two keys rather than one shared
/// between Entries and Tasks. ASCII "sect".
const SECTION_SYNC_INSERT_LOCK_KEY: i64 = 0x73656374;

/// The advisory lock key serialising Label inserts. ASCII "labl".
const LABEL_SYNC_INSERT_LOCK_KEY: i64 = 0x6c61626c;

/// The advisory lock key serialising Comment inserts. ASCII "cmnt".
const COMMENT_SYNC_INSERT_LOCK_KEY: i64 = 0x636d6e74;

/// The advisory lock key serialising Event inserts (issue #184). Held for
/// the identical reason every stream above holds its own key — ADR 0002's
/// "commit order must equal seq-assignment order" property, so a Device
/// polling mid-transaction never advances its Cursor past a row that
/// hasn't committed yet — even though `insert_events` never reassigns a
/// `seq` the way every mutable stream's own upsert does: a fresh `bigserial`
/// value is still assigned once, at insert, and two concurrent inserts
/// could still commit out of order relative to those values without a
/// lock serialising them. ASCII "evnt".
const EVENT_SYNC_INSERT_LOCK_KEY: i64 = 0x65766e74;

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
    /// Today's own manual order (issue #182,
    /// `../../packages/core/src/task-types.ts`'s own `dayOrder` doc
    /// comment) — a second, independent fractional index alongside
    /// `order_key`, opaque text this Server never interprets, exactly as
    /// `order_key` already is (ADR 0050/0051). `#[serde(default)]`, not
    /// because a v6 Device ever omits it, but because this field did not
    /// exist before issue #182: a Device still on protocol 5 has no such
    /// key in its request body at all, the identical reasoning
    /// `SyncRequest::since_task_seq`'s own doc comment gives for a whole
    /// stream rather than one column of one. Defaulting to `""` (an empty
    /// string) is not a synthesised position — this Server does not
    /// compute one from `order_key` or anything else, the same "never
    /// generates or repairs one" restraint ADR 0051 already states for
    /// `order_key` — it is simply the type's own default, sorting first
    /// under lexicographic comparison until the Task's own Device gives it
    /// a real one.
    #[serde(default)]
    pub day_order: String,
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
    /// The Task's own words about itself (#180,
    /// `../../packages/core/src/task-types.ts`'s own `description` field) —
    /// gains a wire representation here for the first time (issue #182).
    /// Before this, `packages/core/src/mapping.ts`'s `fromWireTaskOutput`
    /// carried a Device's existing local copy through unconditionally,
    /// because the wire had nothing to say about it at all; now that it's
    /// an ordinary `Option<String>` field like every other nullable column
    /// here, that workaround is retired — see that function's own doc
    /// comment for the mechanism it keeps for a future locally-held field.
    ///
    /// This is also issue #186 / ADR 0057's own motivating case: a Device
    /// that had already pulled a Task row before this field existed kept
    /// its Cursor past that row, and this field alone never reached it.
    /// `packages/core/src/protocol.ts`'s `ROW_SHAPE_EPOCH.tasks` is bumped
    /// to 1 for exactly this addition — see `PROTOCOL_VERSION`'s own doc
    /// comment above for the obligation this places on the next field
    /// added to any row here.
    pub description: Option<String>,
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
    /// See `TaskInput::day_order`'s own doc comment.
    pub day_order: String,
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
    pub description: Option<String>,
}

/// The Project-shaped sibling of `TaskInput` (ADR 0047's second/third root
/// nouns, ADR 0051's third Sync stream, issue #182). `parent_id` is a
/// plain `Option<Uuid>`, unvalidated — a Project can nest under another
/// Project this Server has never heard of, the identical "dangling
/// cross-reference is not this server's problem" rule `TaskInput`'s own
/// doc comment states, applied here because there is nothing to validate
/// against: no foreign key, no self-join check.
#[derive(Debug, Deserialize, ToSchema)]
pub struct ProjectInput {
    pub id: Uuid,
    pub device_id: Uuid,
    pub name: String,
    pub colour: String,
    pub favourite: bool,
    pub archived: bool,
    pub parent_id: Option<Uuid>,
    pub description: Option<String>,
    pub order_key: String,
    pub created_at: DateTime<Utc>,
    /// Tombstone — see `EntryInput::deleted_at`'s own doc comment.
    pub deleted_at: Option<DateTime<Utc>>,
}

/// The Project-shaped sibling of `TaskOutput` — adds only `seq`.
#[derive(Debug, Serialize, FromRow, ToSchema)]
pub struct ProjectOutput {
    pub id: Uuid,
    pub device_id: Uuid,
    pub name: String,
    pub colour: String,
    pub favourite: bool,
    pub archived: bool,
    pub parent_id: Option<Uuid>,
    pub description: Option<String>,
    pub order_key: String,
    pub created_at: DateTime<Utc>,
    pub seq: i64,
    pub deleted_at: Option<DateTime<Utc>>,
}

/// The Section-shaped sibling of `TaskInput` — `project_id` is a plain
/// required `Uuid`, unvalidated against a `projects` table for the
/// identical reason `TaskInput::project_id`'s own doc comment gives: a
/// Section can arrive naming a Project this Server has never heard of
/// (or, within one push, a Project pushed in the very same request — this
/// Server does not require Sections to arrive after their own Project),
/// and that is an accepted, transient state carried straight through.
#[derive(Debug, Deserialize, ToSchema)]
pub struct SectionInput {
    pub id: Uuid,
    pub device_id: Uuid,
    pub project_id: Uuid,
    pub name: String,
    pub description: Option<String>,
    pub order_key: String,
    pub archived: bool,
    pub created_at: DateTime<Utc>,
    pub deleted_at: Option<DateTime<Utc>>,
}

/// The Section-shaped sibling of `TaskOutput` — adds only `seq`.
#[derive(Debug, Serialize, FromRow, ToSchema)]
pub struct SectionOutput {
    pub id: Uuid,
    pub device_id: Uuid,
    pub project_id: Uuid,
    pub name: String,
    pub description: Option<String>,
    pub order_key: String,
    pub archived: bool,
    pub created_at: DateTime<Utc>,
    pub seq: i64,
    pub deleted_at: Option<DateTime<Utc>>,
}

/// The Label-shaped sibling of `TaskInput` — no `order_key`, mirroring
/// `../../packages/core/src/label-types.ts`'s own Label (no manual order —
/// see that type's own doc comment for why).
#[derive(Debug, Deserialize, ToSchema)]
pub struct LabelInput {
    pub id: Uuid,
    pub device_id: Uuid,
    pub name: String,
    pub colour: String,
    pub created_at: DateTime<Utc>,
    pub deleted_at: Option<DateTime<Utc>>,
}

/// The Label-shaped sibling of `TaskOutput` — adds only `seq`.
#[derive(Debug, Serialize, FromRow, ToSchema)]
pub struct LabelOutput {
    pub id: Uuid,
    pub device_id: Uuid,
    pub name: String,
    pub colour: String,
    pub created_at: DateTime<Utc>,
    pub seq: i64,
    pub deleted_at: Option<DateTime<Utc>>,
}

/// The Comment-shaped sibling of `TaskInput` — `task_id` is a plain
/// required `Uuid`, unvalidated against `tasks` for the identical reason
/// `SectionInput::project_id`'s own doc comment gives.
#[derive(Debug, Deserialize, ToSchema)]
pub struct CommentInput {
    pub id: Uuid,
    pub device_id: Uuid,
    pub task_id: Uuid,
    pub text: String,
    pub created_at: DateTime<Utc>,
    pub deleted_at: Option<DateTime<Utc>>,
}

/// The Comment-shaped sibling of `TaskOutput` — adds only `seq`.
#[derive(Debug, Serialize, FromRow, ToSchema)]
pub struct CommentOutput {
    pub id: Uuid,
    pub device_id: Uuid,
    pub task_id: Uuid,
    pub text: String,
    pub created_at: DateTime<Utc>,
    pub seq: i64,
    pub deleted_at: Option<DateTime<Utc>>,
}

/// The Event-shaped sibling of `CommentInput` (issue #184 / ADR 0056) —
/// Todo's own activity log, Sync's seventh stream. No `deleted_at`: see
/// `../migrations/0017_create_events.sql`'s own header comment for why an
/// Event has no "nothing" state for a tombstone to represent. `event_type`
/// and `object_type` are plain `String`, not a Postgres `enum` — the fixed
/// vocabulary (`added`/`deleted`/`updated`/`archived`/`unarchived`/
/// `completed`/`uncompleted`/`moved`, and `task`/`comment`/`project`/
/// `section`) is enforced by ../../packages/core/src/event-types.ts's own
/// union type on every Device that writes one, the same "validated at the
/// edge that actually knows the vocabulary, not by a database constraint"
/// choice `tasks.priority`'s 1-4 range already makes
/// (../../packages/core/src/task-fields.ts) — a Postgres `enum` would also
/// need a migration of its own the day this vocabulary grows, where a
/// `text` column and a client-side union do not.
#[derive(Debug, Deserialize, ToSchema)]
pub struct EventInput {
    pub id: Uuid,
    pub device_id: Uuid,
    pub event_type: String,
    pub object_type: String,
    pub object_id: Uuid,
    pub task_id: Option<Uuid>,
    pub project_id: Option<Uuid>,
    /// The acting Device's own clock at the moment the act happened —
    /// never the time this row reaches the Server. ADR 0056's entire
    /// Decision turns on this field meaning that and only that; see this
    /// module's own top-of-file doc comment and the ADR itself for why.
    pub occurred_at: DateTime<Utc>,
    /// Whatever this event_type/object_type pair needs to say about what
    /// changed — see `../migrations/0017_create_events.sql`'s own comment
    /// on why this is one `jsonb` column rather than a wide table of
    /// nullable `last_*` columns.
    pub extra: Option<serde_json::Value>,
}

/// The Event-shaped sibling of `CommentOutput` — adds only `seq`.
#[derive(Debug, Serialize, FromRow, ToSchema)]
pub struct EventOutput {
    pub id: Uuid,
    pub device_id: Uuid,
    pub event_type: String,
    pub object_type: String,
    pub object_id: Uuid,
    pub task_id: Option<Uuid>,
    pub project_id: Option<Uuid>,
    pub occurred_at: DateTime<Utc>,
    pub extra: Option<serde_json::Value>,
    pub seq: i64,
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
    /// Issue #182: four more streams, each mirroring `since_task_seq`'s own
    /// `#[serde(default)]` reasoning exactly — a Device on 4 or 5 has none
    /// of these keys in its request body at all, and defaulting to 0 is
    /// exactly "this Device has never synced one of these," true of every
    /// such Device by construction.
    #[serde(default)]
    pub since_project_seq: i64,
    /// Mirrors `tasks`' own `#[serde(default)]` reasoning.
    #[serde(default)]
    pub projects: Vec<ProjectInput>,
    #[serde(default)]
    pub since_section_seq: i64,
    #[serde(default)]
    pub sections: Vec<SectionInput>,
    #[serde(default)]
    pub since_label_seq: i64,
    #[serde(default)]
    pub labels: Vec<LabelInput>,
    #[serde(default)]
    pub since_comment_seq: i64,
    #[serde(default)]
    pub comments: Vec<CommentInput>,
    /// Issue #184: Sync's seventh stream, Events — `#[serde(default)]`
    /// for the identical reason every stream above's own request fields
    /// are: a Device built before this ticket has no `events`/
    /// `since_event_seq` key in its request body at all. Unlike the four
    /// streams above, there was no version bump to hang this on — see
    /// `PROTOCOL_VERSION`'s own doc comment for why none was needed.
    #[serde(default)]
    pub since_event_seq: i64,
    #[serde(default)]
    pub events: Vec<EventInput>,
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
    /// Issue #182: four more pulls, each mirroring `tasks`' own doc
    /// comment exactly — always present on the wire, but `run_sync` sets
    /// each to `[]` (and each cursor to its own `since_*_seq`, unchanged)
    /// when `protocol_version < 6`, so a Device on 4 or 5 never receives
    /// data it has no representation for and never asked to see.
    pub projects: Vec<ProjectOutput>,
    pub project_cursor: i64,
    pub sections: Vec<SectionOutput>,
    pub section_cursor: i64,
    pub labels: Vec<LabelOutput>,
    pub label_cursor: i64,
    pub comments: Vec<CommentOutput>,
    pub comment_cursor: i64,
    /// Issue #184: Events, always present and always populated — unlike
    /// `tasks`/`projects`/etc. above, `run_sync` applies **no**
    /// `protocol_version` gate to this pair (see `PROTOCOL_VERSION`'s own
    /// doc comment: there is no version number that separates "a v6
    /// Device that predates this ticket" from "a v6 Device that has it,"
    /// so a gate here couldn't distinguish anything a v6 Device's own
    /// `#[serde(default)]` request fields don't already handle). A
    /// pre-#184 v6 Device that receives a populated `events` array simply
    /// never reads a JSON key its own `WireSyncResponse` type doesn't
    /// declare — the same "extra field, harmlessly ignored" tolerance
    /// every wire response in this codebase already relies on for a
    /// field it doesn't recognise.
    pub events: Vec<EventOutput>,
    pub event_cursor: i64,
}

#[utoipa::path(
    post,
    path = "/v1/sync",
    request_body = SyncRequest,
    responses(
        (status = 200, description = "Entries (from protocol 5, Tasks; from protocol 6, Projects/Sections/Labels/Comments/Events too) accepted; every change since each stream's own cursor is returned", body = SyncResponse),
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
    let projects_pushed = req.projects.len() as u64;
    let sections_pushed = req.sections.len() as u64;
    let labels_pushed = req.labels.len() as u64;
    let comments_pushed = req.comments.len() as u64;

    run_sync(&pool, &embed_tx, req)
        .await
        .map(|resp| {
            metrics::counter!("sync_entries_pushed_total").increment(pushed);
            metrics::counter!("sync_entries_pulled_total").increment(resp.entries.len() as u64);
            metrics::counter!("sync_tasks_pushed_total").increment(tasks_pushed);
            metrics::counter!("sync_tasks_pulled_total").increment(resp.tasks.len() as u64);
            metrics::counter!("sync_projects_pushed_total").increment(projects_pushed);
            metrics::counter!("sync_projects_pulled_total").increment(resp.projects.len() as u64);
            metrics::counter!("sync_sections_pushed_total").increment(sections_pushed);
            metrics::counter!("sync_sections_pulled_total").increment(resp.sections.len() as u64);
            metrics::counter!("sync_labels_pushed_total").increment(labels_pushed);
            metrics::counter!("sync_labels_pulled_total").increment(resp.labels.len() as u64);
            metrics::counter!("sync_comments_pushed_total").increment(comments_pushed);
            metrics::counter!("sync_comments_pulled_total").increment(resp.comments.len() as u64);
            Json(resp)
        })
        .map_err(|err| {
            tracing::error!(error = ?err, "sync failed");
            StatusCode::INTERNAL_SERVER_ERROR
        })
}

/// Runs every entity stream for one `/v1/sync` round trip — Entries first
/// (unchanged from before this ticket), then Tasks (ADR 0051), then
/// Projects, Sections, Labels and Comments (issue #182), each gated on its
/// own protocol version.
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

    // Issue #182: the identical protocol-6 gate, run four more times — see
    // this function's own doc comment for why the gate has to cover the
    // whole stream, push and pull alike, not merely "don't act on an empty
    // push."
    let (projects, project_cursor) = if req.protocol_version >= 6 {
        if !req.projects.is_empty() {
            insert_projects(pool, &req.projects).await?;
        }
        let projects = fetch_projects_since(pool, req.since_project_seq).await?;
        let project_cursor = projects.last().map_or(req.since_project_seq, |p| p.seq);
        (projects, project_cursor)
    } else {
        (Vec::new(), req.since_project_seq)
    };

    let (sections, section_cursor) = if req.protocol_version >= 6 {
        if !req.sections.is_empty() {
            insert_sections(pool, &req.sections).await?;
        }
        let sections = fetch_sections_since(pool, req.since_section_seq).await?;
        let section_cursor = sections.last().map_or(req.since_section_seq, |s| s.seq);
        (sections, section_cursor)
    } else {
        (Vec::new(), req.since_section_seq)
    };

    let (labels, label_cursor) = if req.protocol_version >= 6 {
        if !req.labels.is_empty() {
            insert_labels(pool, &req.labels).await?;
        }
        let labels = fetch_labels_since(pool, req.since_label_seq).await?;
        let label_cursor = labels.last().map_or(req.since_label_seq, |l| l.seq);
        (labels, label_cursor)
    } else {
        (Vec::new(), req.since_label_seq)
    };

    let (comments, comment_cursor) = if req.protocol_version >= 6 {
        if !req.comments.is_empty() {
            insert_comments(pool, &req.comments).await?;
        }
        let comments = fetch_comments_since(pool, req.since_comment_seq).await?;
        let comment_cursor = comments.last().map_or(req.since_comment_seq, |c| c.seq);
        (comments, comment_cursor)
    } else {
        (Vec::new(), req.since_comment_seq)
    };

    // Issue #184: no `protocol_version` gate — see `PROTOCOL_VERSION`'s
    // own doc comment and `SyncResponse::events`' own doc comment for why
    // one would be meaningless here. Every Device that can reach this
    // handler at all (protocol_version already checked against the
    // MIN_PROTOCOL_VERSION..=PROTOCOL_VERSION range above) pushes and
    // pulls Events unconditionally.
    if !req.events.is_empty() {
        insert_events(pool, &req.events).await?;
    }
    let events = fetch_events_since(pool, req.since_event_seq).await?;
    let event_cursor = events.last().map_or(req.since_event_seq, |e| e.seq);

    Ok(SyncResponse {
        entries,
        cursor,
        tasks,
        task_cursor,
        projects,
        project_cursor,
        sections,
        section_cursor,
        labels,
        label_cursor,
        comments,
        comment_cursor,
        events,
        event_cursor,
    })
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
                 id, device_id, content, completed_at, order_key, day_order, created_at,
                 deleted_at, date, deadline, priority, label_ids,
                 date_string, project_id, section_id, parent_id, description
             )
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
             on conflict (id) do update
               set content       = excluded.content,
                   completed_at  = excluded.completed_at,
                   order_key     = excluded.order_key,
                   day_order     = excluded.day_order,
                   deleted_at    = excluded.deleted_at,
                   date          = excluded.date,
                   deadline      = excluded.deadline,
                   priority      = excluded.priority,
                   label_ids     = excluded.label_ids,
                   date_string   = excluded.date_string,
                   project_id    = excluded.project_id,
                   section_id    = excluded.section_id,
                   parent_id     = excluded.parent_id,
                   description   = excluded.description,
                   seq           = nextval(pg_get_serial_sequence('tasks', 'seq'))
               where tasks.deleted_at is null
                 and (tasks.content      is distinct from excluded.content
                   or tasks.completed_at is distinct from excluded.completed_at
                   or tasks.order_key    is distinct from excluded.order_key
                   or tasks.day_order    is distinct from excluded.day_order
                   or tasks.deleted_at   is distinct from excluded.deleted_at
                   or tasks.date         is distinct from excluded.date
                   or tasks.deadline     is distinct from excluded.deadline
                   or tasks.priority     is distinct from excluded.priority
                   or tasks.label_ids    is distinct from excluded.label_ids
                   or tasks.date_string  is distinct from excluded.date_string
                   or tasks.project_id   is distinct from excluded.project_id
                   or tasks.section_id   is distinct from excluded.section_id
                   or tasks.parent_id    is distinct from excluded.parent_id
                   or tasks.description  is distinct from excluded.description)",
        )
        .bind(task.id)
        .bind(task.device_id)
        .bind(&task.content)
        .bind(task.completed_at)
        .bind(&task.order_key)
        .bind(&task.day_order)
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
        .bind(&task.description)
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
        "select id, device_id, content, completed_at, order_key, day_order, created_at, seq,
                deleted_at, date, deadline, priority, label_ids,
                date_string, project_id, section_id, parent_id, description
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

/// Held until commit, for the Project stream — mirrors
/// `acquire_task_insert_lock` against `PROJECT_SYNC_INSERT_LOCK_KEY`
/// instead. ADR 0002 again.
async fn acquire_project_insert_lock(conn: &mut PgConnection) -> sqlx::Result<()> {
    sqlx::query("select pg_advisory_xact_lock($1)")
        .bind(PROJECT_SYNC_INSERT_LOCK_KEY)
        .execute(conn)
        .await?;
    Ok(())
}

/// Inserts a new Project, or applies an edit/delete to an existing one —
/// the Project-shaped sibling of `insert_tasks`, reusing the identical
/// guard shape for the identical reasons that function's own doc comment
/// gives: delete is terminal (`projects.deleted_at is null`), replay is a
/// true no-op (`is distinct from` across every mutable column), and `seq`
/// is reassigned from `projects`'s own `bigserial` on every real write.
/// `device_id` and `created_at` are absent from the `set` list for the
/// identical "identified by creator, never re-attributed" reason.
async fn insert_projects(pool: &PgPool, projects: &[ProjectInput]) -> anyhow::Result<()> {
    let mut tx = pool.begin().await?;
    acquire_project_insert_lock(&mut tx).await?;

    for project in projects {
        sqlx::query(
            "insert into projects (
                 id, device_id, name, colour, favourite, archived, parent_id,
                 description, order_key, created_at, deleted_at
             )
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             on conflict (id) do update
               set name        = excluded.name,
                   colour      = excluded.colour,
                   favourite   = excluded.favourite,
                   archived    = excluded.archived,
                   parent_id   = excluded.parent_id,
                   description = excluded.description,
                   order_key   = excluded.order_key,
                   deleted_at  = excluded.deleted_at,
                   seq         = nextval(pg_get_serial_sequence('projects', 'seq'))
               where projects.deleted_at is null
                 and (projects.name        is distinct from excluded.name
                   or projects.colour      is distinct from excluded.colour
                   or projects.favourite   is distinct from excluded.favourite
                   or projects.archived    is distinct from excluded.archived
                   or projects.parent_id   is distinct from excluded.parent_id
                   or projects.description is distinct from excluded.description
                   or projects.order_key   is distinct from excluded.order_key
                   or projects.deleted_at  is distinct from excluded.deleted_at)",
        )
        .bind(project.id)
        .bind(project.device_id)
        .bind(&project.name)
        .bind(&project.colour)
        .bind(project.favourite)
        .bind(project.archived)
        .bind(project.parent_id)
        .bind(&project.description)
        .bind(&project.order_key)
        .bind(project.created_at)
        .bind(project.deleted_at)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    Ok(())
}

/// The Project-shaped sibling of `fetch_tasks_since` — `deleted_at`
/// travels unfiltered for the identical reason.
async fn fetch_projects_since(
    pool: &PgPool,
    since_seq: i64,
) -> anyhow::Result<Vec<ProjectOutput>> {
    let projects = sqlx::query_as::<_, ProjectOutput>(
        "select id, device_id, name, colour, favourite, archived, parent_id,
                description, order_key, created_at, seq, deleted_at
         from projects
         where seq > $1
         order by seq asc
         limit $2",
    )
    .bind(since_seq)
    .bind(SYNC_BATCH_SIZE)
    .fetch_all(pool)
    .await?;

    Ok(projects)
}

/// Held until commit, for the Section stream — mirrors
/// `acquire_project_insert_lock` against `SECTION_SYNC_INSERT_LOCK_KEY`.
async fn acquire_section_insert_lock(conn: &mut PgConnection) -> sqlx::Result<()> {
    sqlx::query("select pg_advisory_xact_lock($1)")
        .bind(SECTION_SYNC_INSERT_LOCK_KEY)
        .execute(conn)
        .await?;
    Ok(())
}

/// Inserts a new Section, or applies an edit/delete to an existing one —
/// mirrors `insert_projects` field for field, over `sections` instead.
async fn insert_sections(pool: &PgPool, sections: &[SectionInput]) -> anyhow::Result<()> {
    let mut tx = pool.begin().await?;
    acquire_section_insert_lock(&mut tx).await?;

    for section in sections {
        sqlx::query(
            "insert into sections (
                 id, device_id, project_id, name, description, order_key,
                 archived, created_at, deleted_at
             )
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             on conflict (id) do update
               set project_id  = excluded.project_id,
                   name        = excluded.name,
                   description = excluded.description,
                   order_key   = excluded.order_key,
                   archived    = excluded.archived,
                   deleted_at  = excluded.deleted_at,
                   seq         = nextval(pg_get_serial_sequence('sections', 'seq'))
               where sections.deleted_at is null
                 and (sections.project_id  is distinct from excluded.project_id
                   or sections.name        is distinct from excluded.name
                   or sections.description is distinct from excluded.description
                   or sections.order_key   is distinct from excluded.order_key
                   or sections.archived    is distinct from excluded.archived
                   or sections.deleted_at  is distinct from excluded.deleted_at)",
        )
        .bind(section.id)
        .bind(section.device_id)
        .bind(section.project_id)
        .bind(&section.name)
        .bind(&section.description)
        .bind(&section.order_key)
        .bind(section.archived)
        .bind(section.created_at)
        .bind(section.deleted_at)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    Ok(())
}

/// The Section-shaped sibling of `fetch_projects_since`.
async fn fetch_sections_since(
    pool: &PgPool,
    since_seq: i64,
) -> anyhow::Result<Vec<SectionOutput>> {
    let sections = sqlx::query_as::<_, SectionOutput>(
        "select id, device_id, project_id, name, description, order_key,
                archived, created_at, seq, deleted_at
         from sections
         where seq > $1
         order by seq asc
         limit $2",
    )
    .bind(since_seq)
    .bind(SYNC_BATCH_SIZE)
    .fetch_all(pool)
    .await?;

    Ok(sections)
}

/// Held until commit, for the Label stream — mirrors
/// `acquire_project_insert_lock` against `LABEL_SYNC_INSERT_LOCK_KEY`.
async fn acquire_label_insert_lock(conn: &mut PgConnection) -> sqlx::Result<()> {
    sqlx::query("select pg_advisory_xact_lock($1)")
        .bind(LABEL_SYNC_INSERT_LOCK_KEY)
        .execute(conn)
        .await?;
    Ok(())
}

/// Inserts a new Label, or applies an edit/delete to an existing one —
/// mirrors `insert_projects` field for field, over `labels` instead (no
/// `order_key` — see `LabelInput`'s own doc comment).
async fn insert_labels(pool: &PgPool, labels: &[LabelInput]) -> anyhow::Result<()> {
    let mut tx = pool.begin().await?;
    acquire_label_insert_lock(&mut tx).await?;

    for label in labels {
        sqlx::query(
            "insert into labels (id, device_id, name, colour, created_at, deleted_at)
             values ($1, $2, $3, $4, $5, $6)
             on conflict (id) do update
               set name       = excluded.name,
                   colour     = excluded.colour,
                   deleted_at = excluded.deleted_at,
                   seq        = nextval(pg_get_serial_sequence('labels', 'seq'))
               where labels.deleted_at is null
                 and (labels.name       is distinct from excluded.name
                   or labels.colour     is distinct from excluded.colour
                   or labels.deleted_at is distinct from excluded.deleted_at)",
        )
        .bind(label.id)
        .bind(label.device_id)
        .bind(&label.name)
        .bind(&label.colour)
        .bind(label.created_at)
        .bind(label.deleted_at)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    Ok(())
}

/// The Label-shaped sibling of `fetch_projects_since`.
async fn fetch_labels_since(pool: &PgPool, since_seq: i64) -> anyhow::Result<Vec<LabelOutput>> {
    let labels = sqlx::query_as::<_, LabelOutput>(
        "select id, device_id, name, colour, created_at, seq, deleted_at
         from labels
         where seq > $1
         order by seq asc
         limit $2",
    )
    .bind(since_seq)
    .bind(SYNC_BATCH_SIZE)
    .fetch_all(pool)
    .await?;

    Ok(labels)
}

/// Held until commit, for the Comment stream — mirrors
/// `acquire_project_insert_lock` against `COMMENT_SYNC_INSERT_LOCK_KEY`.
async fn acquire_comment_insert_lock(conn: &mut PgConnection) -> sqlx::Result<()> {
    sqlx::query("select pg_advisory_xact_lock($1)")
        .bind(COMMENT_SYNC_INSERT_LOCK_KEY)
        .execute(conn)
        .await?;
    Ok(())
}

/// Inserts a new Comment, or applies an edit/delete to an existing one —
/// mirrors `insert_projects` field for field, over `comments` instead.
/// `task_id` is absent from the `set` list, alongside `device_id`/
/// `created_at` — mirroring `EntryInput`'s "identified by creator, never
/// re-attributed" rule: a Comment's own Task never changes after it's
/// written, the same way an Entry's own authorship doesn't.
async fn insert_comments(pool: &PgPool, comments: &[CommentInput]) -> anyhow::Result<()> {
    let mut tx = pool.begin().await?;
    acquire_comment_insert_lock(&mut tx).await?;

    for comment in comments {
        sqlx::query(
            "insert into comments (id, device_id, task_id, text, created_at, deleted_at)
             values ($1, $2, $3, $4, $5, $6)
             on conflict (id) do update
               set text       = excluded.text,
                   deleted_at = excluded.deleted_at,
                   seq        = nextval(pg_get_serial_sequence('comments', 'seq'))
               where comments.deleted_at is null
                 and (comments.text       is distinct from excluded.text
                   or comments.deleted_at is distinct from excluded.deleted_at)",
        )
        .bind(comment.id)
        .bind(comment.device_id)
        .bind(comment.task_id)
        .bind(&comment.text)
        .bind(comment.created_at)
        .bind(comment.deleted_at)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    Ok(())
}

/// The Comment-shaped sibling of `fetch_projects_since`.
async fn fetch_comments_since(
    pool: &PgPool,
    since_seq: i64,
) -> anyhow::Result<Vec<CommentOutput>> {
    let comments = sqlx::query_as::<_, CommentOutput>(
        "select id, device_id, task_id, text, created_at, seq, deleted_at
         from comments
         where seq > $1
         order by seq asc
         limit $2",
    )
    .bind(since_seq)
    .bind(SYNC_BATCH_SIZE)
    .fetch_all(pool)
    .await?;

    Ok(comments)
}

/// Held until commit, for the Event stream — mirrors
/// `acquire_comment_insert_lock` against `EVENT_SYNC_INSERT_LOCK_KEY`.
async fn acquire_event_insert_lock(conn: &mut PgConnection) -> sqlx::Result<()> {
    sqlx::query("select pg_advisory_xact_lock($1)")
        .bind(EVENT_SYNC_INSERT_LOCK_KEY)
        .execute(conn)
        .await?;
    Ok(())
}

/// Inserts a new Event, or silently no-ops against one already on this
/// table — the one place this ticket's own replay guard genuinely
/// simplifies rather than merely mirroring `insert_comments`.
///
/// Every other `insert_*` in this file above needs an `is distinct from`
/// chain across its table's mutable columns, because the row it's
/// upserting *can* legitimately change — a retried push of the same
/// content, one that changed a field, and a stale replay of an
/// already-applied write all look identical at the SQL level (same `id`),
/// and only that comparison tells them apart. An Event has no mutable
/// column: nothing about this ticket's own Decision (ADR 0056) ever
/// writes a second version of an Event with the same `id` — there is no
/// edit door, no tombstone, nothing analogous to a Comment's `edit()` or
/// `remove()`. So a second push carrying an `id` already in this table
/// can only be one thing: a replay of the exact same row, whether from a
/// retried request, a redelivered response, or two Devices that happened
/// to both hold the same already-synced Event and both still have it in
/// their own `pending()` for some reason. `on conflict (id) do nothing`
/// says exactly that: apply it if this is the first time this table has
/// seen this `id`, otherwise there is nothing to reconcile, and
/// critically, **no `seq` reassignment** — a replayed Event must not jump
/// back to the head of the log and cost every Device a redundant re-pull
/// of a row they already have.
async fn insert_events(pool: &PgPool, events: &[EventInput]) -> anyhow::Result<()> {
    let mut tx = pool.begin().await?;
    acquire_event_insert_lock(&mut tx).await?;

    for event in events {
        sqlx::query(
            "insert into events
               (id, device_id, event_type, object_type, object_id, task_id, project_id,
                occurred_at, extra)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             on conflict (id) do nothing",
        )
        .bind(event.id)
        .bind(event.device_id)
        .bind(&event.event_type)
        .bind(&event.object_type)
        .bind(event.object_id)
        .bind(event.task_id)
        .bind(event.project_id)
        .bind(event.occurred_at)
        .bind(&event.extra)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    Ok(())
}

/// The Event-shaped sibling of `fetch_comments_since`.
async fn fetch_events_since(pool: &PgPool, since_seq: i64) -> anyhow::Result<Vec<EventOutput>> {
    let events = sqlx::query_as::<_, EventOutput>(
        "select id, device_id, event_type, object_type, object_id, task_id, project_id,
                occurred_at, extra, seq
         from events
         where seq > $1
         order by seq asc
         limit $2",
    )
    .bind(since_seq)
    .bind(SYNC_BATCH_SIZE)
    .fetch_all(pool)
    .await?;

    Ok(events)
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
