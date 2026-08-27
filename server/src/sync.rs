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
pub const PROTOCOL_VERSION: i32 = 3;

/// Caps how many Entries a single sync response returns, so a Device far behind
/// doesn't pull the whole History in one response. Note: since the batch is the
/// oldest unsynced Entries first, a Device whose own backlog exceeds this size won't
/// see the Entries it just submitted in this same response — they're still the
/// freshest (highest seq) rows, so they surface once the backlog ahead of them drains
/// on a later poll.
pub const SYNC_BATCH_SIZE: i64 = 500;

/// The advisory lock key serialising Entry inserts so commit order equals sequence
/// order. See ADR 0002 — do not remove without re-deriving that reasoning.
const SYNC_INSERT_LOCK_KEY: i64 = 0x6d656f6c;

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

#[derive(Debug, Deserialize, ToSchema)]
pub struct SyncRequest {
    pub protocol_version: i32,
    pub device_id: Uuid,
    pub since_seq: i64,
    pub entries: Vec<EntryInput>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct SyncResponse {
    pub entries: Vec<EntryOutput>,
    pub cursor: i64,
}

#[utoipa::path(
    post,
    path = "/v1/sync",
    request_body = SyncRequest,
    responses(
        (status = 200, description = "Entries accepted; every Entry after since_seq is returned", body = SyncResponse),
        (status = 426, description = "protocol_version is not one this server understands"),
    )
)]
pub async fn sync_handler(
    State(pool): State<PgPool>,
    State(embed_tx): State<Option<Sender<Uuid>>>,
    Json(req): Json<SyncRequest>,
) -> Result<Json<SyncResponse>, StatusCode> {
    tracing::Span::current().record("device_id", tracing::field::display(req.device_id));

    if req.protocol_version != PROTOCOL_VERSION {
        tracing::warn!(
            device_id = %req.device_id,
            requested_version = req.protocol_version,
            "rejecting sync: unsupported protocol version",
        );
        metrics::counter!("sync_protocol_mismatches_total").increment(1);
        return Err(StatusCode::UPGRADE_REQUIRED);
    }

    let pushed = req.entries.len() as u64;

    run_sync(&pool, &embed_tx, req)
        .await
        .map(|resp| {
            metrics::counter!("sync_entries_pushed_total").increment(pushed);
            metrics::counter!("sync_entries_pulled_total").increment(resp.entries.len() as u64);
            Json(resp)
        })
        .map_err(|err| {
            tracing::error!(error = ?err, "sync failed");
            StatusCode::INTERNAL_SERVER_ERROR
        })
}

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
    Ok(SyncResponse { entries, cursor })
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
