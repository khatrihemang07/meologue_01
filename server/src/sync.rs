use axum::{Json, extract::State, http::StatusCode};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgConnection, PgPool};
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
    Json(req): Json<SyncRequest>,
) -> Result<Json<SyncResponse>, StatusCode> {
    if req.protocol_version != PROTOCOL_VERSION {
        return Err(StatusCode::UPGRADE_REQUIRED);
    }

    run_sync(&pool, req).await.map(Json).map_err(|err| {
        eprintln!("sync failed: {err:?}");
        StatusCode::INTERNAL_SERVER_ERROR
    })
}

async fn run_sync(pool: &PgPool, req: SyncRequest) -> anyhow::Result<SyncResponse> {
    if !req.entries.is_empty() {
        insert_entries(pool, &req.entries).await?;
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

async fn insert_entries(pool: &PgPool, entries: &[EntryInput]) -> anyhow::Result<()> {
    let mut tx = pool.begin().await?;
    acquire_insert_lock(&mut tx).await?;

    for entry in entries {
        sqlx::query(
            "insert into entries (id, device_id, body, created_at)
             values ($1, $2, $3, $4)
             on conflict (id) do nothing",
        )
        .bind(entry.id)
        .bind(entry.device_id)
        .bind(&entry.body)
        .bind(entry.created_at)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    Ok(())
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
