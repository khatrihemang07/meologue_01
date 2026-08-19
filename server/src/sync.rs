use axum::{Json, extract::State, http::StatusCode};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgConnection, PgPool};
use tokio::sync::mpsc::Sender;
use utoipa::ToSchema;
use uuid::Uuid;

/// The only protocol version this server understands. Requests carrying any other
/// value are rejected with 426 — see ADR 0004, this can't be retrofitted later.
pub const PROTOCOL_VERSION: i32 = 1;

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
}

#[derive(Debug, Serialize, FromRow, ToSchema)]
pub struct EntryOutput {
    pub id: Uuid,
    pub device_id: Uuid,
    pub body: String,
    pub created_at: DateTime<Utc>,
    pub seq: i64,
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

/// Returns the ids that were actually inserted — a replayed Entry that hits
/// `on conflict (id) do nothing` returns no row from `returning id`, so it's
/// excluded automatically rather than needing a separate existence check.
/// The caller uses this to hint the embedding worker only about Entries
/// that are actually new (see `run_sync`).
async fn insert_entries(pool: &PgPool, entries: &[EntryInput]) -> anyhow::Result<Vec<Uuid>> {
    let mut tx = pool.begin().await?;
    acquire_insert_lock(&mut tx).await?;

    let mut inserted_ids = Vec::with_capacity(entries.len());
    for entry in entries {
        let inserted_id: Option<Uuid> = sqlx::query_scalar(
            "insert into entries (id, device_id, body, created_at)
             values ($1, $2, $3, $4)
             on conflict (id) do nothing
             returning id",
        )
        .bind(entry.id)
        .bind(entry.device_id)
        .bind(&entry.body)
        .bind(entry.created_at)
        .fetch_optional(&mut *tx)
        .await?;
        if let Some(id) = inserted_id {
            inserted_ids.push(id);
        }
    }

    tx.commit().await?;
    Ok(inserted_ids)
}

async fn fetch_entries_since(pool: &PgPool, since_seq: i64) -> anyhow::Result<Vec<EntryOutput>> {
    let entries = sqlx::query_as::<_, EntryOutput>(
        "select id, device_id, body, created_at, seq
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
