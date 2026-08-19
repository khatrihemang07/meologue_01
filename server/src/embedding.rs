//! Fills `entries.embedding` for every Entry, off the request path. Spawned
//! once from `main.rs` when embedding config is present (see
//! `llm::LlmConfig::embed_worker_config`) and runs for the life of the
//! process. See ADR 0022 for the reasoning behind this shape.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use sqlx::PgPool;
use tokio::sync::mpsc::Receiver;
use tokio::time::MissedTickBehavior;
use uuid::Uuid;

use crate::llm::LlmClient;

/// How many unembedded Entries one scan pass pulls. Small enough that a
/// pass never holds the pool for long; large enough that a first-sync
/// backlog drains in a handful of ticks rather than hundreds.
pub const SCAN_BATCH_SIZE: i64 = 200;

/// How often the scan runs even with no channel activity. This is the
/// recovery path — see ADR 0022 — for a crash mid-embed, a restart during a
/// large first sync, a full or dropped channel, and the Entries that were
/// already in Postgres before the worker ever ran (no seeding step needed).
pub const SCAN_INTERVAL: Duration = Duration::from_secs(30);

/// Caps retries for one Entry, in this process's lifetime. Deliberately an
/// in-memory `HashMap`, not a column: losing the count on restart is
/// acceptable and intentional (ADR 0022) — a genuinely poison Entry fails
/// again within a few ticks and re-earns its cap, so persisting the count
/// would only buy safety this scale doesn't need.
pub const MAX_ATTEMPTS: u8 = 5;

/// Runs forever. `rx` carries ids that `/v1/sync` has a fresh hint about;
/// the interval-driven scan is the durable queue that makes those hints
/// optional rather than load-bearing. `scan_interval` is a parameter
/// (rather than always `SCAN_INTERVAL`) so tests can drive the scan on a
/// much shorter cadence without waiting 30 real seconds.
pub async fn run(
    pool: PgPool,
    client: Arc<dyn LlmClient + Send + Sync>,
    model_name: String,
    mut rx: Receiver<Uuid>,
    scan_interval: Duration,
) {
    let mut attempts: HashMap<Uuid, u8> = HashMap::new();
    let mut interval = tokio::time::interval(scan_interval);
    // The first tick fires immediately, so the scan runs once at startup —
    // that's what enqueues Entries already in Postgres, with no seeding
    // step and no dependence on a Sync ever happening.
    interval.set_missed_tick_behavior(MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            Some(id) = rx.recv() => {
                embed_one(&pool, client.as_ref(), &model_name, id, &mut attempts).await;
            }
            _ = interval.tick() => {
                match select_unembedded(&pool, SCAN_BATCH_SIZE).await {
                    Ok(ids) => {
                        for id in ids {
                            embed_one(&pool, client.as_ref(), &model_name, id, &mut attempts).await;
                        }
                    }
                    Err(err) => {
                        tracing::error!(error = ?err, "embedding scan query failed");
                    }
                }
            }
        }
    }
}

async fn select_unembedded(pool: &PgPool, limit: i64) -> sqlx::Result<Vec<Uuid>> {
    sqlx::query_scalar::<_, Uuid>(
        "select id from entries where embedding is null order by seq asc limit $1",
    )
    .bind(limit)
    .fetch_all(pool)
    .await
}

async fn embed_one(
    pool: &PgPool,
    client: &(dyn LlmClient + Send + Sync),
    model_name: &str,
    id: Uuid,
    attempts: &mut HashMap<Uuid, u8>,
) {
    if attempts.get(&id).copied().unwrap_or(0) >= MAX_ATTEMPTS {
        return;
    }

    // Guarded on `embedding is null` even though the caller usually already
    // knows that: it's what makes a duplicate hint (the same id arriving
    // from both the channel and a scan pass) a harmless no-op rather than a
    // wasted embedding call.
    let body = match sqlx::query_scalar::<_, String>(
        "select body from entries where id = $1 and embedding is null",
    )
    .bind(id)
    .fetch_optional(pool)
    .await
    {
        Ok(Some(body)) => body,
        Ok(None) => return,
        Err(err) => {
            tracing::error!(error = ?err, entry_id = %id, "failed to load entry body for embedding");
            *attempts.entry(id).or_insert(0) += 1;
            return;
        }
    };

    let vector = match client.embed_document(&body).await {
        Ok(vector) => vector,
        Err(err) => {
            let count = attempts.entry(id).or_insert(0);
            *count += 1;
            tracing::warn!(error = ?err, entry_id = %id, attempt = *count, "embedding request failed");
            return;
        }
    };

    if let Err(err) = store_embedding(pool, id, &vector, model_name).await {
        let count = attempts.entry(id).or_insert(0);
        *count += 1;
        tracing::error!(error = ?err, entry_id = %id, attempt = *count, "failed to store embedding");
        return;
    }

    // Succeeded — drop any prior failure count so the map doesn't hold a
    // stale entry for an id that will never be retried again.
    attempts.remove(&id);
}

async fn store_embedding(pool: &PgPool, id: Uuid, vector: &[f32], model_name: &str) -> sqlx::Result<()> {
    sqlx::query("update entries set embedding = $1::vector, embedding_model = $2 where id = $3")
        .bind(vector_literal(vector))
        .bind(model_name)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

/// pgvector's text input format (`[v1,v2,...]`), bound as a plain string and
/// cast at the call site with `::vector`. Deliberately not the `pgvector`
/// crate — see ADR 0022: this keeps sqlx 0.9 compatibility simple, and it's
/// the same shape the `<=>` distance queries a future ticket adds will bind.
fn vector_literal(vector: &[f32]) -> String {
    let mut out = String::with_capacity(vector.len() * 8 + 2);
    out.push('[');
    for (i, v) in vector.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str(&v.to_string());
    }
    out.push(']');
    out
}
