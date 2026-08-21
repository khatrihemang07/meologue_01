//! Writes `digests` ahead of time, off the request path — copying
//! `embedding.rs`'s worker shape directly (ADR 0022), for a different
//! queue: rather than "which Entries lack an embedding," the state
//! question here is "which completed Periods lack a Digest." See ADR 0027
//! for the full reasoning behind every decision below, and `period.rs` for
//! every timezone and calendar computation this module defers to rather
//! than re-deriving.
//!
//! Unlike the embedding worker there is no per-request hint to react to —
//! nothing asks for a Digest, ever (CONTEXT.md's Digest entry: "nobody
//! asked; the Server simply wrote") — so `run` is a plain periodic loop,
//! with no channel alongside the interval.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, NaiveDate, Utc};
use chrono_tz::Tz;
use sqlx::PgPool;
use tokio::time::MissedTickBehavior;
use uuid::Uuid;

use crate::llm::{ChatMessage, LlmClient};
use crate::period::{self, Period};

/// How often the worker re-scans for Periods that completed since the last
/// pass. 5 minutes, much coarser than the embedding worker's 30 seconds
/// (`embedding::SCAN_INTERVAL`): a Digest only ever becomes writable once a
/// whole day, week or month has elapsed, so there is no latency win to
/// chase by polling faster — this cadence exists purely so the worker
/// notices "a Period just ended" within a few minutes rather than waiting
/// on a restart.
pub const SCAN_INTERVAL: Duration = Duration::from_secs(300);

/// Caps how many Digests one tick writes, across all three Periods
/// combined — counting Digests actually **written**, not Periods merely
/// considered, so a run of empty Periods never eats into the budget a
/// Period that actually needs an LLM call would use. This bounds a single
/// tick's LLM calls even when the resume rule (see `run`) finds a long
/// backlog to fill — e.g. right after seeding an anchor row far in the
/// past (`docs/adr/0027`'s backfill mechanism) or after the worker was
/// down for a while. The cold-start guarantee itself never needs this cap
/// — with no prior Digest, each Period type has exactly one candidate
/// (`most_recently_completed`) — but the resumed case has no such limit,
/// which is what this constant is actually for.
pub const MAX_DIGESTS_PER_TICK: usize = 3;

/// Caps retries for one `(Period, period_start)` pair, in this process's
/// lifetime. Process-local, not a column — the same choice ADR 0022 made
/// for the embedding worker's attempt cap, and for the same reason: losing
/// the count on restart just means a genuinely poison Period re-earns its
/// cap over a few more ticks, which isn't worth a schema change and a
/// write on every failure. See `run`'s `attempts` map.
pub const MAX_ATTEMPTS: u8 = 5;

/// One Entry read out of a Period's window, in the shape `build_messages`
/// needs to render it and `write_digest_for` needs to record its id as
/// Grounding.
#[derive(Debug, Clone, sqlx::FromRow)]
struct DigestEntry {
    id: Uuid,
    body: String,
    created_at: DateTime<Utc>,
}

/// Runs forever. `tz` and `scan_interval` are parameters rather than
/// constants read inside — the same testability seam ADR 0022 established
/// for the embedding worker's `scan_interval`, load-bearing here too:
/// `server/tests/digest.rs` drives this on a ~20ms interval instead of
/// waiting on real wall-clock Periods to complete, and passes whichever
/// `Tz` a given test wants to prove buckets Entries differently.
///
/// There is no channel: unlike embedding, nothing has a fresh hint about
/// which Period just became eligible, so every tick simply re-derives "what
/// still needs doing" from `digests` and `entries` — the state rule ADR
/// 0027 chose over a time rule (a cron firing at each Period's own
/// boundary), because a state rule catches up on the next tick after any
/// downtime instead of losing the Period the cron would have fired for.
pub async fn run(
    pool: PgPool,
    client: Arc<dyn LlmClient + Send + Sync>,
    tz: Tz,
    scan_interval: Duration,
) {
    let mut attempts: HashMap<(Period, NaiveDate), u8> = HashMap::new();
    let mut interval = tokio::time::interval(scan_interval);
    // The first tick fires immediately, matching `embedding::run` — a
    // freshly started worker doesn't wait a full `scan_interval` before its
    // first pass.
    interval.set_missed_tick_behavior(MissedTickBehavior::Delay);

    loop {
        interval.tick().await;

        // `MAX_DIGESTS_PER_TICK` applies separately to each Period type,
        // not as one budget shared across all three — a backlog on, say,
        // the daily Period (after seeding an old anchor, see ADR 0027)
        // must not starve the weekly or monthly Period of the same tick's
        // progress. The cold-start guarantee (at most one Digest per
        // Period type with no prior anchor) holds either way, since each
        // Period type only ever has a single candidate in that case.
        for period in Period::ALL {
            fill_period(
                &pool,
                client.as_ref(),
                tz,
                period,
                MAX_DIGESTS_PER_TICK,
                &mut attempts,
            )
            .await;
        }
    }
}

/// Fills every writable Digest for one Period type, oldest first, up to
/// `budget` writes — the resume rule, in full:
///
/// 1. `anchor` = the most recent Digest of this Period type, if any.
/// 2. `horizon` = the newest Period of this type that has fully completed
///    as of now (`period::most_recently_completed`).
/// 3. The scan window's first eligible Period start is `anchor`'s next
///    Period if an anchor exists, or **`horizon` itself** if it doesn't.
///    That `None` clause is the whole point of the ticket (ADR 0027): with
///    no anchor, only the single most-recently-completed Period is ever
///    eligible, so a fresh install never reaches backwards through the
///    journal's full History looking for every day, week and month it has
///    ever held.
/// 4. If the first eligible start is already past the horizon, there is
///    nothing to do.
/// 5. Otherwise, find which Periods in that window actually hold Entries —
///    by pulling their raw UTC timestamps and bucketing them in Rust
///    (`period::period_start_of`), never in SQL — and write a Digest for
///    each such start, oldest first, until `budget` is spent.
async fn fill_period(
    pool: &PgPool,
    client: &(dyn LlmClient + Send + Sync),
    tz: Tz,
    period: Period,
    budget: usize,
    attempts: &mut HashMap<(Period, NaiveDate), u8>,
) -> usize {
    if budget == 0 {
        return 0;
    }

    let horizon = period::most_recently_completed(period, tz, Utc::now());

    let anchor = match latest_digest_start(pool, period).await {
        Ok(anchor) => anchor,
        Err(err) => {
            tracing::error!(error = ?err, period = period.as_str(), "failed to load the latest digest anchor");
            return 0;
        }
    };

    let first = match anchor {
        Some(a) => period::next_period_start(period, a),
        None => horizon,
    };

    if first > horizon {
        // The anchor already covers everything up to the horizon — nothing
        // new has completed since the last Digest of this Period type was
        // written. (In the no-anchor case `first == horizon` always, so
        // this branch is only ever reached when an anchor exists.)
        return 0;
    }

    // The scan window spans from `first`'s own start to the *end* of
    // `horizon` — i.e. every instant any Period from `first` through
    // `horizon` (inclusive) could contain.
    let (window_start, _) = period::period_bounds(period, tz, first);
    let (_, window_end) = period::period_bounds(period, tz, horizon);

    let timestamps = match select_entry_timestamps(pool, window_start, window_end).await {
        Ok(timestamps) => timestamps,
        Err(err) => {
            tracing::error!(error = ?err, period = period.as_str(), "failed to load entry timestamps for the digest scan window");
            return 0;
        }
    };

    // Bucket in Rust, never in SQL — see this module's and `period.rs`'s
    // doc comments on why exactly one implementation of this maths exists.
    let mut starts: Vec<NaiveDate> = timestamps
        .into_iter()
        .map(|created_at| period::period_start_of(period, tz, created_at))
        .collect();
    starts.sort();
    starts.dedup();

    let mut written = 0usize;
    for start in starts {
        if written >= budget {
            break;
        }
        if write_digest_for(pool, client, tz, period, start, attempts).await {
            written += 1;
        }
    }
    written
}

/// Generates and inserts one Digest, or returns `false` without writing
/// anything — because it's already at `MAX_ATTEMPTS`, the Period turned out
/// to hold no Entries after all (defensive; `fill_period` only ever calls
/// this for a `start` its own scan found Entries at), the chat call
/// failed, or the insert failed. Counts and clears `attempts` itself so
/// `fill_period` never has to know which failure mode occurred.
async fn write_digest_for(
    pool: &PgPool,
    client: &(dyn LlmClient + Send + Sync),
    tz: Tz,
    period: Period,
    start: NaiveDate,
    attempts: &mut HashMap<(Period, NaiveDate), u8>,
) -> bool {
    let key = (period, start);
    if attempts.get(&key).copied().unwrap_or(0) >= MAX_ATTEMPTS {
        return false;
    }

    let (from_utc, to_utc) = period::period_bounds(period, tz, start);
    let entries = match select_entries(pool, from_utc, to_utc).await {
        Ok(entries) => entries,
        Err(err) => {
            let count = attempts.entry(key).or_insert(0);
            *count += 1;
            tracing::error!(error = ?err, period = period.as_str(), %start, attempt = *count, "failed to load entries for a digest");
            return false;
        }
    };

    // Defensive: `fill_period`'s own scan only calls this for a `start` it
    // already found at least one Entry's timestamp bucketed into. This
    // should never fire, but guards against writing an empty, pointless
    // Digest if it somehow does.
    if entries.is_empty() {
        return false;
    }

    let messages = build_messages(period, start, &entries);
    let body = match client.chat(&messages).await {
        Ok(body) => body,
        Err(err) => {
            let count = attempts.entry(key).or_insert(0);
            *count += 1;
            tracing::warn!(error = ?err, period = period.as_str(), %start, attempt = *count, "digest chat call failed");
            return false;
        }
    };

    let entry_ids: Vec<Uuid> = entries.iter().map(|entry| entry.id).collect();
    match insert_digest(pool, period, start, &body, &entry_ids).await {
        Ok(inserted) => {
            // Succeeded (or lost a race to another writer of the exact
            // same Period — the `on conflict do nothing` in `insert_digest`
            // makes that indistinguishable from success, which is correct:
            // either way this Period now has a Digest). Either way, drop
            // any prior failure count so the map doesn't hold a stale entry
            // for a key that will never be retried again.
            attempts.remove(&key);
            inserted
        }
        Err(err) => {
            let count = attempts.entry(key).or_insert(0);
            *count += 1;
            tracing::error!(error = ?err, period = period.as_str(), %start, attempt = *count, "failed to store a digest");
            false
        }
    }
}

async fn latest_digest_start(pool: &PgPool, period: Period) -> sqlx::Result<Option<NaiveDate>> {
    sqlx::query_scalar::<_, Option<NaiveDate>>(
        "select max(period_start) from digests where period = $1",
    )
    .bind(period.as_str())
    .fetch_one(pool)
    .await
}

/// Pulls just the raw UTC timestamps in `[from_utc, to_utc)` — deliberately
/// not `select distinct date(...)` or anything else that would bucket in
/// SQL; `fill_period` buckets every one of these with `period::period_start_of`
/// after they're back in Rust.
async fn select_entry_timestamps(
    pool: &PgPool,
    from_utc: DateTime<Utc>,
    to_utc: DateTime<Utc>,
) -> sqlx::Result<Vec<DateTime<Utc>>> {
    sqlx::query_scalar::<_, DateTime<Utc>>(
        "select created_at from entries where created_at >= $1 and created_at < $2",
    )
    .bind(from_utc)
    .bind(to_utc)
    .fetch_all(pool)
    .await
}

/// Loads the actual Entries (id, body, timestamp) for one Period's window
/// — used only once `fill_period` has already decided this exact `start`
/// needs a Digest, so this always runs against the tight `period_bounds`
/// range rather than the wider scan window `select_entry_timestamps` reads.
async fn select_entries(
    pool: &PgPool,
    from_utc: DateTime<Utc>,
    to_utc: DateTime<Utc>,
) -> sqlx::Result<Vec<DigestEntry>> {
    sqlx::query_as::<_, DigestEntry>(
        "select id, body, created_at from entries where created_at >= $1 and created_at < $2 order by created_at asc",
    )
    .bind(from_utc)
    .bind(to_utc)
    .fetch_all(pool)
    .await
}

/// Inserts one Digest, returning whether a row was actually written.
/// `on conflict (period, period_start) do nothing` is what makes the
/// `unique` constraint from migration `0004_create_digests.sql` a safe
/// target for a retry or a race, rather than something this code has to
/// avoid hitting on its own — immutability is structural (the schema
/// enforces it), not a discipline the worker has to maintain by checking
/// first and hoping nothing else wrote in between.
async fn insert_digest(
    pool: &PgPool,
    period: Period,
    start: NaiveDate,
    body: &str,
    entry_ids: &[Uuid],
) -> sqlx::Result<bool> {
    let result = sqlx::query(
        "insert into digests (id, period, period_start, body, grounding_entry_ids) values ($1, $2, $3, $4, $5) \
         on conflict (period, period_start) do nothing",
    )
    .bind(Uuid::new_v4())
    .bind(period.as_str())
    .bind(start)
    .bind(body)
    .bind(entry_ids)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() > 0)
}

/// The system prompt for the one chat call this worker ever makes.
///
/// Must begin with the exact phrase "You are the Digest writer" — this is
/// a **test contract, not a stylistic choice**: `server/tests/digest.rs`'s
/// fake chat client sniffs this exact leading phrase to identify a digest
/// call, exactly as `reflect.rs`'s `extraction_system_prompt` documents
/// "Today's date" as a leading phrase `tests/reflect.rs::is_extraction_call`
/// depends on. Changing this opening without updating that test's matcher
/// would silently break the test, not the feature.
///
/// Deliberately carries no per-Period length target — CONTEXT.md and ADR
/// 0027 are explicit that the model sizes the prose to the material, and a
/// numeric target for "a day" vs. "a month" would be a guess this worker
/// has no basis to make.
fn digest_system_prompt() -> &'static str {
    "You are the Digest writer for meologue, a personal journal. You will be given everything \
     the user wrote during a named stretch of time, with each Entry labelled with the date it \
     was written. Write a short piece of prose describing what they wrote about during that \
     time, speaking directly to the user in the second person. Use only what the Entries say — \
     invent nothing: a Digest that invents a past the user did not live is worse than one that \
     says little. Do not pad. If there is little here, write little. Do not include a title, a \
     preamble, headings or bullet points — just the prose itself, with no length target to hit."
}

/// The user message naming the Period and its inclusive local date range,
/// followed by its Entries rendered as `[YYYY-MM-DD] body`, blank-line
/// separated — the same shape `reflect.rs::build_messages` renders its
/// Grounding block in, reused deliberately so there is one recognisable
/// Entry rendering across the codebase rather than two subtly different
/// ones.
fn build_messages(period: Period, start: NaiveDate, entries: &[DigestEntry]) -> Vec<ChatMessage> {
    let end = period::period_end(period, start);
    let range = if start == end {
        format!("{} ({})", start.format("%Y-%m-%d"), period.as_str())
    } else {
        format!(
            "{} to {} (a {})",
            start.format("%Y-%m-%d"),
            end.format("%Y-%m-%d"),
            period.as_str()
        )
    };

    let entries_block = entries
        .iter()
        .map(|entry| format!("[{}] {}", entry.created_at.format("%Y-%m-%d"), entry.body))
        .collect::<Vec<_>>()
        .join("\n\n");

    vec![
        ChatMessage {
            role: "system".to_string(),
            content: digest_system_prompt().to_string(),
        },
        ChatMessage {
            role: "user".to_string(),
            content: format!("Here is everything the user wrote from {range}:\n\n{entries_block}"),
        },
    ]
}
