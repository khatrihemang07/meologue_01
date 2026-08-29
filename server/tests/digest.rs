use std::collections::{HashSet, VecDeque};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Result, bail};
use async_trait::async_trait;
use chrono::{DateTime, Datelike, NaiveDate, Utc};
use chrono_tz::Tz;
use meologue_server::digest;
use meologue_server::llm::{ChatMessage, ChatReply, LlmClient};
use meologue_server::period::{self, Period};
use sqlx::PgPool;
use uuid::Uuid;

// A short interval so tests observe several ticks well within a few
// hundred milliseconds, instead of waiting on the real 300s production
// `digest::SCAN_INTERVAL` — the same seam `tests/embedding.rs` exercises
// for the embedding worker.
const TEST_SCAN_INTERVAL: Duration = Duration::from_millis(20);
const WAIT_TIMEOUT: Duration = Duration::from_secs(5);

/// A fake chat client with no network dependency. `behavior` decides
/// whether `chat` succeeds with canned prose, always errors (the
/// attempt-cap test's whole point), or always succeeds with a fixed reply
/// of the caller's choosing (issue #135's rejected-body tests: a reply
/// that `digest::generate_digest_body` rejects looks, from this client's
/// point of view, exactly like `AlwaysSucceed` — the chat call itself
/// never fails, only validation of what it returned does, so this is a
/// separate variant from `AlwaysFail` rather than a special case of it).
/// Every call is recorded so a test can assert on exactly what the worker
/// sent.
struct FakeChatClient {
    behavior: FakeBehavior,
    calls: Mutex<Vec<Vec<ChatMessage>>>,
    call_count: AtomicUsize,
}

enum FakeBehavior {
    AlwaysSucceed,
    AlwaysFail,
    /// Always succeeds with this exact reply, verbatim — used to script an
    /// empty, whitespace-only, or fence-only reply that a real chat
    /// endpoint could return over a perfectly healthy connection.
    FixedReply(&'static str),
    /// Issue #136: succeeds with a distinct scripted reply for each call,
    /// in order — `FixedReply` returns the identical reply every time,
    /// which can't distinguish one chunk's own reply from another's, so a
    /// multi-chunk test asserting the stored body is several chunk
    /// replies joined by `"\n\n"` needs this instead. The queue rotates
    /// rather than draining (a popped reply is pushed back to the end)
    /// so a test only has to script as many replies as one attempt's
    /// chunks, even if the worker's resume rule happens to make more
    /// than one attempt before the Period is fully written.
    Scripted(Mutex<VecDeque<&'static str>>),
    /// Succeeds on every call except the `n`th, `2n`th, `3n`th ...
    /// (1-indexed), which fail. Originally issue #136's way to prove "one
    /// chunk of several failing fails the whole Period": with `n` set to a
    /// Period's own chunk count, the *last* chunk of every attempt failed,
    /// consistently, on every retry. Issue #137 repurposes the same
    /// variant for the opposite proof — with `n` set to a Period's chunk
    /// count, the last chunk fails exactly once (the Period gets a Digest
    /// on its very first attempt, so there is no second attempt to
    /// reconsider), which is exactly the "one bad chunk, the rest survive"
    /// shape that ticket needs, consistent rather than coincidental.
    FailEveryNth(usize),
}

impl FakeChatClient {
    fn new(behavior: FakeBehavior) -> Self {
        Self {
            behavior,
            calls: Mutex::new(Vec::new()),
            call_count: AtomicUsize::new(0),
        }
    }

    fn calls(&self) -> usize {
        self.call_count.load(Ordering::SeqCst)
    }

    fn all_calls(&self) -> Vec<Vec<ChatMessage>> {
        self.calls.lock().unwrap().clone()
    }
}

#[async_trait]
impl LlmClient for FakeChatClient {
    async fn chat(&self, messages: &[ChatMessage]) -> Result<ChatReply> {
        // 1-indexed call number, for `FailEveryNth` below — `fetch_add`
        // returns the *previous* value, so this call is the `previous +
        // 1`th one made against this client.
        let call_number = self.call_count.fetch_add(1, Ordering::SeqCst) + 1;
        self.calls.lock().unwrap().push(messages.to_vec());
        match &self.behavior {
            FakeBehavior::AlwaysSucceed => {
                Ok(ChatReply::text("You wrote about a handful of things."))
            }
            FakeBehavior::AlwaysFail => bail!("fake chat client always errors"),
            FakeBehavior::FixedReply(reply) => Ok(ChatReply::text(*reply)),
            FakeBehavior::Scripted(queue) => {
                let mut queue = queue.lock().unwrap();
                let reply = queue
                    .pop_front()
                    .expect("Scripted must be seeded with at least one reply");
                queue.push_back(reply);
                Ok(ChatReply::text(reply))
            }
            FakeBehavior::FailEveryNth(n) => {
                if call_number.is_multiple_of(*n) {
                    bail!("fake chat client scripted to fail on call {call_number}");
                }
                Ok(ChatReply::text("You wrote about a handful of things."))
            }
        }
    }

    async fn embed_document(&self, _text: &str) -> Result<Vec<f32>> {
        unimplemented!("the digest worker never embeds anything")
    }

    async fn embed_query(&self, _text: &str) -> Result<Vec<f32>> {
        unimplemented!("the digest worker never embeds anything")
    }
}

/// The system prompt every digest chat call must open with — see
/// `digest::digest_system_prompt`'s doc comment: this leading phrase is a
/// test contract, not a stylistic choice.
fn is_digest_call(call: &[ChatMessage]) -> bool {
    call.first()
        .is_some_and(|m| m.content.starts_with("You are the Digest writer"))
}

/// Returns the `seq` Postgres assigned the inserted Entry — issue #136's
/// own tests need it to assert `source_seq` is the max over every Entry a
/// multi-chunk Digest read, the same reason `tests/digest_api.rs`'s own
/// `insert_entry_at` already returns it. Every existing call site ignores
/// the return value, which is harmless: a bare `.await;` on a non-`()`
/// value is not a lint in Rust unless the type is `#[must_use]`, and `i64`
/// isn't.
async fn insert_entry_at(
    pool: &PgPool,
    id: Uuid,
    device_id: Uuid,
    body: &str,
    created_at: DateTime<Utc>,
) -> i64 {
    sqlx::query_scalar::<_, i64>(
        "insert into entries (id, device_id, body, created_at) values ($1, $2, $3, $4) returning seq",
    )
    .bind(id)
    .bind(device_id)
    .bind(body)
    .bind(created_at)
    .fetch_one(pool)
    .await
    .unwrap()
}

// `revision` (issue #132 / ADR 0039): carried on this row so
// `the_worker_never_mints_a_second_revision_on_a_tick` below can assert
// directly on it, rather than only inferring "still revision 1" from
// there being exactly one row. `body` and `source_seq` (issue #136): the
// chunking tests need both — `body` to assert the chunk replies were
// concatenated with `"\n\n"`, `source_seq` to assert the watermark is
// still the max over *every* Entry a Digest read, regardless of which
// chunk actually read it.
#[derive(sqlx::FromRow, Debug, Clone)]
struct DigestRow {
    period: String,
    period_start: NaiveDate,
    body: String,
    grounding_entry_ids: Vec<Uuid>,
    revision: i32,
    source_seq: i64,
}

async fn all_digests(pool: &PgPool) -> Vec<DigestRow> {
    sqlx::query_as::<_, DigestRow>(
        "select period, period_start, body, grounding_entry_ids, revision, source_seq from digests",
    )
    .fetch_all(pool)
    .await
    .unwrap()
}

async fn digest_count(pool: &PgPool) -> i64 {
    sqlx::query_scalar::<_, i64>("select count(*) from digests")
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn find_digest(pool: &PgPool, period: Period, period_start: NaiveDate) -> Option<DigestRow> {
    sqlx::query_as::<_, DigestRow>(
        "select period, period_start, body, grounding_entry_ids, revision, source_seq from digests \
         where period = $1 and period_start = $2 order by revision desc limit 1",
    )
    .bind(period.as_str())
    .bind(period_start)
    .fetch_optional(pool)
    .await
    .unwrap()
}

async fn seed_digest_row(pool: &PgPool, period: Period, period_start: NaiveDate) {
    sqlx::query(
        "insert into digests (id, period, period_start, body, grounding_entry_ids) values ($1, $2, $3, $4, $5)",
    )
    .bind(Uuid::new_v4())
    .bind(period.as_str())
    .bind(period_start)
    .bind("a Digest seeded directly, standing in for one this worker actually wrote")
    .bind(Vec::<Uuid>::new())
    .execute(pool)
    .await
    .unwrap();
}

/// Polls until a Digest exists for `(period, period_start)`, or panics
/// after `WAIT_TIMEOUT` — the worker runs concurrently with the test, so
/// there's no single await point that means "it's done."
async fn wait_for_digest(pool: &PgPool, period: Period, period_start: NaiveDate) -> DigestRow {
    let start = Instant::now();
    loop {
        if let Some(row) = find_digest(pool, period, period_start).await {
            return row;
        }
        if start.elapsed() > WAIT_TIMEOUT {
            panic!(
                "timed out waiting for a {} digest at {period_start}",
                period.as_str()
            );
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

// Large enough that none of this file's ordinary Entries (short, one-line
// bodies) could ever cross `DIGEST_ENTRY_BUDGET_FRACTION`'s threshold —
// every test using this default is implicitly a single-chunk test, the
// same "chunking is unreachable at today's corpus size" fact issue #136
// itself measured against the real Sandbox journal. The multi-chunk case
// is exercised explicitly, below, via `spawn_worker_with_context_window`
// and a deliberately small window.
const LARGE_TEST_CONTEXT_WINDOW: u32 = 1_000_000;

fn spawn_worker(pool: PgPool, client: Arc<FakeChatClient>, tz: Tz) -> tokio::task::JoinHandle<()> {
    spawn_worker_with_context_window(pool, client, tz, LARGE_TEST_CONTEXT_WINDOW)
}

/// Issue #136: like `spawn_worker`, but with an explicit `context_window`
/// — the seam this ticket adds to `digest::run` — for tests that need to
/// drive the chunking split itself.
fn spawn_worker_with_context_window(
    pool: PgPool,
    client: Arc<FakeChatClient>,
    tz: Tz,
    context_window: u32,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(digest::run(pool, client, tz, TEST_SCAN_INTERVAL, context_window))
}

#[sqlx::test]
async fn a_completed_day_holding_entries_gets_exactly_one_digest(pool: PgPool) {
    let client = Arc::new(FakeChatClient::new(FakeBehavior::AlwaysSucceed));
    let worker = spawn_worker(pool.clone(), client.clone(), Tz::UTC);

    let yesterday = period::most_recently_completed(Period::Day, Tz::UTC, Utc::now());
    let (from, _) = period::period_bounds(Period::Day, Tz::UTC, yesterday);
    let device = Uuid::new_v4();
    let entry_id = Uuid::new_v4();
    insert_entry_at(
        &pool,
        entry_id,
        device,
        "an entry from yesterday",
        from + chrono::Duration::hours(1),
    )
    .await;

    let digest = wait_for_digest(&pool, Period::Day, yesterday).await;
    assert_eq!(digest.grounding_entry_ids, vec![entry_id]);

    // Exactly one — no duplicate written for the same completed day.
    let day_digests: Vec<_> = all_digests(&pool)
        .await
        .into_iter()
        .filter(|d| d.period == "day")
        .collect();
    assert_eq!(day_digests.len(), 1);

    assert!(client.all_calls().iter().any(|c| is_digest_call(c)));

    worker.abort();
}

#[sqlx::test]
async fn a_completed_iso_week_holding_entries_gets_exactly_one_digest(pool: PgPool) {
    let client = Arc::new(FakeChatClient::new(FakeBehavior::AlwaysSucceed));
    let worker = spawn_worker(pool.clone(), client.clone(), Tz::UTC);

    let last_week = period::most_recently_completed(Period::Week, Tz::UTC, Utc::now());
    assert_eq!(last_week.weekday(), chrono::Weekday::Mon);
    let (from, _) = period::period_bounds(Period::Week, Tz::UTC, last_week);
    let device = Uuid::new_v4();
    let entry_id = Uuid::new_v4();
    insert_entry_at(
        &pool,
        entry_id,
        device,
        "an entry from last week",
        from + chrono::Duration::days(2),
    )
    .await;

    let digest = wait_for_digest(&pool, Period::Week, last_week).await;
    assert_eq!(digest.grounding_entry_ids, vec![entry_id]);

    let week_digests: Vec<_> = all_digests(&pool)
        .await
        .into_iter()
        .filter(|d| d.period == "week")
        .collect();
    assert_eq!(week_digests.len(), 1);

    worker.abort();
}

#[sqlx::test]
async fn a_completed_calendar_month_holding_entries_gets_exactly_one_digest(pool: PgPool) {
    let client = Arc::new(FakeChatClient::new(FakeBehavior::AlwaysSucceed));
    let worker = spawn_worker(pool.clone(), client.clone(), Tz::UTC);

    let last_month = period::most_recently_completed(Period::Month, Tz::UTC, Utc::now());
    assert_eq!(last_month.day(), 1);
    let (from, _) = period::period_bounds(Period::Month, Tz::UTC, last_month);
    let device = Uuid::new_v4();
    let entry_id = Uuid::new_v4();
    insert_entry_at(
        &pool,
        entry_id,
        device,
        "an entry from last month",
        from + chrono::Duration::days(3),
    )
    .await;

    let digest = wait_for_digest(&pool, Period::Month, last_month).await;
    assert_eq!(digest.grounding_entry_ids, vec![entry_id]);

    let month_digests: Vec<_> = all_digests(&pool)
        .await
        .into_iter()
        .filter(|d| d.period == "month")
        .collect();
    assert_eq!(month_digests.len(), 1);

    worker.abort();
}

/// The cold-start guarantee — ADR 0027's whole reason for existing. With no
/// prior Digest at all, and Entries spanning years of History, one worker
/// must never reach back through that entire History: it writes at most
/// one Digest per Period type, all anchored at the most-recently-completed
/// Period, and nothing older.
#[sqlx::test]
async fn a_fresh_install_with_entries_spanning_years_writes_at_most_three_digests(pool: PgPool) {
    let client = Arc::new(FakeChatClient::new(FakeBehavior::AlwaysSucceed));
    let worker = spawn_worker(pool.clone(), client.clone(), Tz::UTC);

    let now = Utc::now();
    let device = Uuid::new_v4();

    // A handful of Entries scattered across several past years — the
    // journal's deep History, none of which should ever earn a Digest
    // under the no-anchor rule.
    for years_ago in [5, 4, 3, 2, 1] {
        let created_at = now - chrono::Duration::days(365 * years_ago + 10);
        insert_entry_at(&pool, Uuid::new_v4(), device, "an old entry", created_at).await;
    }

    // Plus Entries in each of the three most-recently-completed Periods,
    // which are exactly the ones the cold start is allowed to Digest.
    let yesterday = period::most_recently_completed(Period::Day, Tz::UTC, now);
    let (day_from, _) = period::period_bounds(Period::Day, Tz::UTC, yesterday);
    insert_entry_at(
        &pool,
        Uuid::new_v4(),
        device,
        "yesterday",
        day_from + chrono::Duration::hours(1),
    )
    .await;

    let last_week = period::most_recently_completed(Period::Week, Tz::UTC, now);
    let (week_from, _) = period::period_bounds(Period::Week, Tz::UTC, last_week);
    insert_entry_at(
        &pool,
        Uuid::new_v4(),
        device,
        "last week",
        week_from + chrono::Duration::hours(2),
    )
    .await;

    let last_month = period::most_recently_completed(Period::Month, Tz::UTC, now);
    let (month_from, _) = period::period_bounds(Period::Month, Tz::UTC, last_month);
    insert_entry_at(
        &pool,
        Uuid::new_v4(),
        device,
        "last month",
        month_from + chrono::Duration::hours(3),
    )
    .await;

    wait_for_digest(&pool, Period::Day, yesterday).await;
    wait_for_digest(&pool, Period::Week, last_week).await;
    wait_for_digest(&pool, Period::Month, last_month).await;

    // Give the worker several more ticks to prove it doesn't keep going.
    tokio::time::sleep(TEST_SCAN_INTERVAL * 20).await;

    let digests = all_digests(&pool).await;
    assert_eq!(
        digests.len(),
        3,
        "expected exactly one digest per Period type, got {digests:?}"
    );

    let starts: HashSet<(String, NaiveDate)> = digests
        .iter()
        .map(|d| (d.period.clone(), d.period_start))
        .collect();
    assert!(starts.contains(&("day".to_string(), yesterday)));
    assert!(starts.contains(&("week".to_string(), last_week)));
    assert!(starts.contains(&("month".to_string(), last_month)));

    worker.abort();
}

/// Seeding a single old anchor row is the whole backfill mechanism (ADR
/// 0027): the worker should fill every completed daily Period after it, up
/// to the horizon, across as many ticks as it takes.
#[sqlx::test]
async fn seeding_one_digest_row_makes_the_worker_fill_every_period_after_it(pool: PgPool) {
    let client = Arc::new(FakeChatClient::new(FakeBehavior::AlwaysSucceed));

    let now = Utc::now();
    let device = Uuid::new_v4();
    let horizon = period::most_recently_completed(Period::Day, Tz::UTC, now);

    // An anchor five days before the horizon, with an Entry in each of the
    // days strictly between the anchor and the horizon (inclusive of the
    // horizon itself).
    let anchor = horizon - chrono::Duration::days(5);
    seed_digest_row(&pool, Period::Day, anchor).await;

    let mut expected_starts = Vec::new();
    let mut day = period::next_period_start(Period::Day, anchor);
    while day <= horizon {
        let (from, _) = period::period_bounds(Period::Day, Tz::UTC, day);
        insert_entry_at(
            &pool,
            Uuid::new_v4(),
            device,
            "backfilled day",
            from + chrono::Duration::hours(1),
        )
        .await;
        expected_starts.push(day);
        day = period::next_period_start(Period::Day, day);
    }

    let worker = spawn_worker(pool.clone(), client.clone(), Tz::UTC);

    for start in &expected_starts {
        wait_for_digest(&pool, Period::Day, *start).await;
    }

    // The seeded anchor itself is untouched, and no day Digest exists
    // before it.
    let day_digests: Vec<NaiveDate> = all_digests(&pool)
        .await
        .into_iter()
        .filter(|d| d.period == "day")
        .map(|d| d.period_start)
        .collect();
    assert_eq!(
        day_digests.len(),
        expected_starts.len() + 1,
        "the seeded anchor plus every day after it"
    );
    assert!(day_digests.iter().all(|start| *start >= anchor));

    worker.abort();
}

/// A Period with no Entries produces no Digest, and the scan window steps
/// past it — an empty day between two written ones must not stall the
/// days after it.
#[sqlx::test]
async fn an_empty_period_produces_no_digest_and_does_not_stall_the_window(pool: PgPool) {
    let client = Arc::new(FakeChatClient::new(FakeBehavior::AlwaysSucceed));

    let now = Utc::now();
    let device = Uuid::new_v4();
    let horizon = period::most_recently_completed(Period::Day, Tz::UTC, now);
    let three_days_ago = horizon - chrono::Duration::days(2);
    // `three_days_ago + 1 day` (the day in between) is left with no Entry.

    seed_digest_row(
        &pool,
        Period::Day,
        three_days_ago - chrono::Duration::days(1),
    )
    .await;

    let (from_first, _) = period::period_bounds(Period::Day, Tz::UTC, three_days_ago);
    insert_entry_at(
        &pool,
        Uuid::new_v4(),
        device,
        "written",
        from_first + chrono::Duration::hours(1),
    )
    .await;
    let (from_last, _) = period::period_bounds(Period::Day, Tz::UTC, horizon);
    insert_entry_at(
        &pool,
        Uuid::new_v4(),
        device,
        "written",
        from_last + chrono::Duration::hours(1),
    )
    .await;

    let worker = spawn_worker(pool.clone(), client.clone(), Tz::UTC);

    wait_for_digest(&pool, Period::Day, three_days_ago).await;
    wait_for_digest(&pool, Period::Day, horizon).await;

    // Give the worker time to have considered the empty middle day too.
    tokio::time::sleep(TEST_SCAN_INTERVAL * 20).await;

    let empty_day = three_days_ago + chrono::Duration::days(1);
    assert!(find_digest(&pool, Period::Day, empty_day).await.is_none());

    worker.abort();
}

/// Issue #69's acceptance criterion "A Period with no Entries produces no
/// Digest, and the window steps past it rather than stalling" has a second
/// case the sibling test above never reaches: an empty run *between* two
/// written Periods proves the window steps over a gap, but says nothing
/// about a *trailing* run — an anchor far in the past with every completed
/// Period after it empty, all the way out to the horizon. There, `fill_period`
/// (server/src/digest.rs) widens its scan window on every tick and finds
/// nothing to write, tick after tick. That has to be a benign hold, not a
/// stall: proven in two parts below, matching the ticket's own phrasing.
#[sqlx::test]
async fn a_trailing_run_of_empty_periods_does_not_wedge_the_worker(pool: PgPool) {
    let now = Utc::now();
    let device = Uuid::new_v4();
    let horizon = period::most_recently_completed(Period::Day, Tz::UTC, now);

    // An anchor well over a year before the horizon, with no Entry
    // anywhere in the database yet — not even outside its window. Week and
    // Month have no anchor of their own either, so the cold-start rule
    // (ADR 0027) only ever considers their single most-recently-completed
    // Period, which is equally empty here — nothing is eligible for any of
    // the three Period types.
    let anchor = horizon - chrono::Duration::days(400);
    seed_digest_row(&pool, Period::Day, anchor).await;

    let client = Arc::new(FakeChatClient::new(FakeBehavior::AlwaysSucceed));
    let worker = spawn_worker(pool.clone(), client.clone(), Tz::UTC);

    // Part 1: several ticks over the whole (empty) trailing run write
    // nothing new. This alone doesn't distinguish "holding correctly" from
    // "wedged" — both look like silence — which is exactly why Part 2
    // below is the half that actually proves the window moved.
    tokio::time::sleep(TEST_SCAN_INTERVAL * 20).await;
    assert_eq!(
        digest_count(&pool).await,
        1,
        "only the seeded anchor should exist while every Period after it is empty"
    );

    // Part 2: an Entry lands inside a completed Period well after the
    // anchor (`anchor + 50 days`, still far short of the horizon). If the
    // worker had stalled — stuck re-deriving the same empty window instead
    // of re-scanning it fresh on every tick — this Entry would never earn
    // a Digest and `wait_for_digest` would time out. It doesn't: the
    // worker had nothing to write before, not nowhere left to look.
    let target = anchor + chrono::Duration::days(50);
    let (from, _) = period::period_bounds(Period::Day, Tz::UTC, target);
    let entry_id = Uuid::new_v4();
    insert_entry_at(
        &pool,
        entry_id,
        device,
        "finally, something written",
        from + chrono::Duration::hours(1),
    )
    .await;

    let digest = wait_for_digest(&pool, Period::Day, target).await;
    assert_eq!(digest.grounding_entry_ids, vec![entry_id]);

    worker.abort();
}

/// Once every eligible Period has a Digest, further ticks write nothing
/// new — the resume rule converges, and the schema's unique constraint
/// backs that up structurally.
#[sqlx::test]
async fn running_further_ticks_after_catching_up_writes_nothing_new(pool: PgPool) {
    let client = Arc::new(FakeChatClient::new(FakeBehavior::AlwaysSucceed));
    let worker = spawn_worker(pool.clone(), client.clone(), Tz::UTC);

    let yesterday = period::most_recently_completed(Period::Day, Tz::UTC, Utc::now());
    let (from, _) = period::period_bounds(Period::Day, Tz::UTC, yesterday);
    let device = Uuid::new_v4();
    insert_entry_at(
        &pool,
        Uuid::new_v4(),
        device,
        "an entry",
        from + chrono::Duration::hours(1),
    )
    .await;

    wait_for_digest(&pool, Period::Day, yesterday).await;
    let count_after_first = digest_count(&pool).await;

    tokio::time::sleep(TEST_SCAN_INTERVAL * 30).await;

    assert_eq!(digest_count(&pool).await, count_after_first);

    worker.abort();
}

/// Issue #132 / ADR 0039: the worker generates, it never regenerates. Once
/// a Period has any Digest at all, `latest_digest_start`'s anchor (`max(period_start)`,
/// unaffected by revision) advances past it, and the resume rule
/// (`fill_period`'s `first > horizon` early-out) never reconsiders that
/// Period on any later tick. Proven directly, not just inferred from the
/// resume rule's own logic: seed a Digest, let an Entry land late in the
/// same already-Digested Period (the exact shape a stale Digest looks
/// like from the worker's side), run many more ticks, and assert only
/// revision 1 ever exists.
#[sqlx::test]
async fn the_worker_never_mints_a_second_revision_on_a_tick(pool: PgPool) {
    let yesterday = period::most_recently_completed(Period::Day, Tz::UTC, Utc::now());
    let (from, _) = period::period_bounds(Period::Day, Tz::UTC, yesterday);
    let device = Uuid::new_v4();
    insert_entry_at(
        &pool,
        Uuid::new_v4(),
        device,
        "an entry",
        from + chrono::Duration::hours(1),
    )
    .await;

    let client = Arc::new(FakeChatClient::new(FakeBehavior::AlwaysSucceed));
    let worker = spawn_worker(pool.clone(), client.clone(), Tz::UTC);

    let first = wait_for_digest(&pool, Period::Day, yesterday).await;
    assert_eq!(first.revision, 1);

    // A further Entry lands in the same, already-Digested Period — the
    // real-world trigger for staleness (see `digest_api.rs`'s own
    // staleness tests), but the worker has no mechanism that reacts to it
    // at all; it only ever asks "which completed Periods have no Digest
    // yet."
    insert_entry_at(
        &pool,
        Uuid::new_v4(),
        device,
        "a late arrival, after the digest was written",
        from + chrono::Duration::hours(2),
    )
    .await;

    // Many more ticks than it would ever need to notice and (wrongly) act
    // on the late arrival, if it somehow did.
    tokio::time::sleep(TEST_SCAN_INTERVAL * 30).await;

    let day_digests: Vec<_> = all_digests(&pool)
        .await
        .into_iter()
        .filter(|d| d.period == "day" && d.period_start == yesterday)
        .collect();
    assert_eq!(
        day_digests.len(),
        1,
        "the worker must never mint a second revision for an already-Digested Period"
    );
    assert_eq!(day_digests[0].revision, 1);

    worker.abort();
}

/// Issue #69's acceptance criterion "Running the worker again writes
/// nothing new, and the schema makes a duplicate impossible" has two
/// clauses; the sibling test above only exercises the first. This test
/// exercises the second directly, without the worker at all.
///
/// `insert_digest` (server/src/digest.rs) always issues its insert with
/// `on conflict (period, period_start) do nothing`, so calling it twice
/// would only prove that the worker's own SQL is polite about a duplicate
/// it might cause itself — not that the database refuses one from some
/// other writer that never says "on conflict do nothing". Deliberately
/// testing the stronger claim instead: this bypasses `insert_digest` and
/// issues a second **plain** insert (no `on conflict` clause) at the same
/// `(period, period_start)`, asserting the raw `unique` constraint from
/// migration `0004_create_digests.sql` rejects it outright as a genuine
/// constraint-violation error. That is what makes CONTEXT.md's "a Digest
/// is immutable once written" structural rather than a convention every
/// writer has to remember to honour.
#[sqlx::test]
async fn the_schema_makes_a_duplicate_digest_impossible(pool: PgPool) {
    let period = Period::Day;
    let period_start = period::most_recently_completed(Period::Day, Tz::UTC, Utc::now());

    // The first row, written the same plain way `seed_digest_row` always
    // has — no `on conflict` clause, so this is exactly the kind of write
    // the constraint has to survive a second copy of.
    seed_digest_row(&pool, period, period_start).await;

    let duplicate = sqlx::query(
        "insert into digests (id, period, period_start, body, grounding_entry_ids) values ($1, $2, $3, $4, $5)",
    )
    .bind(Uuid::new_v4())
    .bind(period.as_str())
    .bind(period_start)
    .bind("a second Digest for the same Period, which must never land")
    .bind(Vec::<Uuid>::new())
    .execute(&pool)
    .await;

    assert!(
        duplicate.is_err(),
        "a second plain insert at the same (period, period_start) must violate the unique constraint, not silently succeed"
    );

    let matching = all_digests(&pool)
        .await
        .into_iter()
        .filter(|d| d.period == period.as_str() && d.period_start == period_start)
        .count();
    assert_eq!(
        matching, 1,
        "exactly the first row must exist for this (period, period_start) — the rejected insert must not have landed a second one"
    );

    // No `worker.abort()` here, unlike every other test in this file — the
    // constraint being proved is a property of the schema itself, not of
    // `digest::run`'s loop, so no worker was ever spawned to abort.
}

/// A Digest records the ids of the Entries in its own Period — and only
/// those, not Entries from an adjacent Period.
#[sqlx::test]
async fn a_digest_records_only_the_entries_in_its_own_period(pool: PgPool) {
    let yesterday = period::most_recently_completed(Period::Day, Tz::UTC, Utc::now());
    let (from, to) = period::period_bounds(Period::Day, Tz::UTC, yesterday);
    let device = Uuid::new_v4();

    let in_period_a = Uuid::new_v4();
    let in_period_b = Uuid::new_v4();
    insert_entry_at(
        &pool,
        in_period_a,
        device,
        "inside the period, early",
        from + chrono::Duration::minutes(1),
    )
    .await;
    insert_entry_at(
        &pool,
        in_period_b,
        device,
        "inside the period, late",
        to - chrono::Duration::minutes(1),
    )
    .await;

    // Just outside the period on either side — must never show up as
    // Grounding for yesterday's Digest.
    insert_entry_at(
        &pool,
        Uuid::new_v4(),
        device,
        "the period before",
        from - chrono::Duration::minutes(1),
    )
    .await;
    insert_entry_at(
        &pool,
        Uuid::new_v4(),
        device,
        "the period after",
        to + chrono::Duration::minutes(1),
    )
    .await;

    // Every Entry is seeded before the worker ever starts ticking, so the
    // first tick sees the whole picture at once — otherwise the worker
    // could legitimately write yesterday's Digest from whichever Entries
    // had landed so far, and (correctly, by immutability) never revisit it
    // once `in_period_b` arrives a moment later.
    let client = Arc::new(FakeChatClient::new(FakeBehavior::AlwaysSucceed));
    let worker = spawn_worker(pool.clone(), client.clone(), Tz::UTC);

    let digest = wait_for_digest(&pool, Period::Day, yesterday).await;
    let mut ids = digest.grounding_entry_ids.clone();
    ids.sort();
    let mut expected = vec![in_period_a, in_period_b];
    expected.sort();
    assert_eq!(ids, expected);

    worker.abort();
}

/// A chat client that always fails must stop being retried after exactly
/// `MAX_ATTEMPTS` calls, and never write a Digest for that Period.
#[sqlx::test]
async fn a_chat_client_that_always_fails_stops_after_exactly_max_attempts(pool: PgPool) {
    let client = Arc::new(FakeChatClient::new(FakeBehavior::AlwaysFail));
    let worker = spawn_worker(pool.clone(), client.clone(), Tz::UTC);

    let yesterday = period::most_recently_completed(Period::Day, Tz::UTC, Utc::now());
    let (from, _) = period::period_bounds(Period::Day, Tz::UTC, yesterday);
    let device = Uuid::new_v4();
    insert_entry_at(
        &pool,
        Uuid::new_v4(),
        device,
        "a poison period",
        from + chrono::Duration::hours(1),
    )
    .await;

    // The Period stays un-Digested forever (chat always errors), so every
    // tick re-selects it — long enough for many more than `MAX_ATTEMPTS`
    // ticks to have fired if the cap weren't enforced.
    tokio::time::sleep(TEST_SCAN_INTERVAL * 40).await;

    assert_eq!(client.calls(), digest::MAX_ATTEMPTS as usize);
    assert!(find_digest(&pool, Period::Day, yesterday).await.is_none());

    worker.abort();
}

/// Issue #135: a reply that is empty, whitespace-only, or only a code
/// fence is rejected by `digest::generate_digest_body`, and a rejected
/// reply is treated exactly as a failed chat call already was — attempt
/// consumed, nothing written, retried on the next tick. Each of the four
/// shapes below drives the worker with a chat client that *always*
/// succeeds at the transport level with that one rejected reply, and
/// proves the same thing `a_chat_client_that_always_fails_stops_after_exactly_max_attempts`
/// proves for a transport failure: the worker keeps retrying — this is
/// what rules out "the first rejection silently gives up" — right up to
/// `MAX_ATTEMPTS`, and never writes a Digest for the Period.
async fn assert_rejected_reply_never_writes_a_digest_and_stops_at_max_attempts(
    pool: PgPool,
    rejected_reply: &'static str,
) {
    let client = Arc::new(FakeChatClient::new(FakeBehavior::FixedReply(rejected_reply)));
    let worker = spawn_worker(pool.clone(), client.clone(), Tz::UTC);

    let yesterday = period::most_recently_completed(Period::Day, Tz::UTC, Utc::now());
    let (from, _) = period::period_bounds(Period::Day, Tz::UTC, yesterday);
    let device = Uuid::new_v4();
    insert_entry_at(
        &pool,
        Uuid::new_v4(),
        device,
        "an entry whose digest reply keeps getting rejected",
        from + chrono::Duration::hours(1),
    )
    .await;

    // Same rationale as the always-fails test: the Period never gets a
    // Digest, so every tick re-selects it, for long enough that many more
    // than `MAX_ATTEMPTS` ticks would have fired if the cap weren't
    // enforced against a rejected reply the same way it is against a
    // transport error.
    tokio::time::sleep(TEST_SCAN_INTERVAL * 40).await;

    assert_eq!(
        client.calls(),
        digest::MAX_ATTEMPTS as usize,
        "a rejected reply must count toward MAX_ATTEMPTS exactly like a failed chat call"
    );
    assert!(
        find_digest(&pool, Period::Day, yesterday).await.is_none(),
        "a rejected reply {rejected_reply:?} must never become a stored Digest"
    );

    worker.abort();
}

#[sqlx::test]
async fn an_empty_reply_never_writes_a_digest_and_stops_at_max_attempts(pool: PgPool) {
    assert_rejected_reply_never_writes_a_digest_and_stops_at_max_attempts(pool, "").await;
}

#[sqlx::test]
async fn a_whitespace_only_reply_never_writes_a_digest_and_stops_at_max_attempts(pool: PgPool) {
    assert_rejected_reply_never_writes_a_digest_and_stops_at_max_attempts(pool, "   \n\t  ").await;
}

/// The bare-fence form: a reply that is nothing but an opening and closing
/// ``` ``` on the same "line", with nothing between them.
#[sqlx::test]
async fn a_bare_code_fence_reply_never_writes_a_digest_and_stops_at_max_attempts(pool: PgPool) {
    assert_rejected_reply_never_writes_a_digest_and_stops_at_max_attempts(pool, "```").await;
}

/// The other fence form `strip_code_fences` recognises: an opening fence,
/// a newline, and a closing fence, with nothing in between — distinct from
/// the single-token "```" case above because it exercises the branch that
/// looks past the opening line's newline before finding the close.
#[sqlx::test]
async fn a_fenced_reply_with_nothing_between_the_fences_never_writes_a_digest_and_stops_at_max_attempts(
    pool: PgPool,
) {
    assert_rejected_reply_never_writes_a_digest_and_stops_at_max_attempts(pool, "```\n```").await;
}

/// The timezone parameter decides which local day an Entry belongs to,
/// half of the pair: an Entry at 18:45 UTC, on the UTC calendar date that
/// is `Tz::UTC`'s own most-recently-completed day, lands in that same UTC
/// day. (The instant is deliberately pinned to the *worker's own* horizon
/// — see `an_entry_at_1845_utc_lands_in_the_next_day_under_asia_kolkata`
/// for why: with no prior Digest, the cold-start rule only ever considers
/// the single most-recently-completed Period, so an instant chosen without
/// regard to that horizon could land in a Period this worker would never
/// even look at.)
#[sqlx::test]
async fn an_entry_at_1845_utc_lands_in_the_same_day_under_utc(pool: PgPool) {
    let now = Utc::now();
    let horizon = period::most_recently_completed(Period::Day, Tz::UTC, now);
    let naive_evening = horizon.and_hms_opt(18, 45, 0).unwrap();
    let instant = DateTime::<Utc>::from_naive_utc_and_offset(naive_evening, Utc);

    // Sanity check on the premise: the very same instant would bucket into
    // the *next* local day under Asia/Kolkata (UTC+5:30) — proving it's
    // `tz`, not a fixed UTC assumption, deciding the bucket.
    let kolkata: Tz = "Asia/Kolkata".parse().unwrap();
    assert_eq!(
        period::period_start_of(Period::Day, Tz::UTC, instant),
        horizon
    );
    assert_eq!(
        period::period_start_of(Period::Day, kolkata, instant),
        horizon + chrono::Duration::days(1)
    );

    let client = Arc::new(FakeChatClient::new(FakeBehavior::AlwaysSucceed));
    let worker = spawn_worker(pool.clone(), client.clone(), Tz::UTC);

    let device = Uuid::new_v4();
    let entry_id = Uuid::new_v4();
    insert_entry_at(&pool, entry_id, device, "an evening entry", instant).await;

    let digest = wait_for_digest(&pool, Period::Day, horizon).await;
    assert_eq!(digest.grounding_entry_ids, vec![entry_id]);

    worker.abort();
}

/// The other half of the pair: an instant at 18:45 UTC — chosen so its
/// *Kolkata*-local date is `Asia/Kolkata`'s own most-recently-completed
/// day — lands in that next local day (UTC+5:30 makes 18:45 UTC already
/// 00:15 the following date), not the UTC calendar date it was written on.
/// A worker configured with a different `Tz` genuinely buckets the same
/// wall-clock instant differently, which is the property the whole
/// resume rule (`period::most_recently_completed`, `period::period_start_of`)
/// depends on.
#[sqlx::test]
async fn an_entry_at_1845_utc_lands_in_the_next_day_under_asia_kolkata(pool: PgPool) {
    let kolkata: Tz = "Asia/Kolkata".parse().unwrap();
    let now = Utc::now();
    let horizon = period::most_recently_completed(Period::Day, kolkata, now);
    // The UTC calendar date one day before the Kolkata horizon — 18:45 UTC
    // on that date is 00:15 on the Kolkata horizon date itself.
    let utc_calendar_date = horizon - chrono::Duration::days(1);
    let naive_evening = utc_calendar_date.and_hms_opt(18, 45, 0).unwrap();
    let instant = DateTime::<Utc>::from_naive_utc_and_offset(naive_evening, Utc);

    assert_eq!(
        period::period_start_of(Period::Day, kolkata, instant),
        horizon
    );
    assert_eq!(
        period::period_start_of(Period::Day, Tz::UTC, instant),
        utc_calendar_date
    );

    let client = Arc::new(FakeChatClient::new(FakeBehavior::AlwaysSucceed));
    let worker = spawn_worker(pool.clone(), client.clone(), kolkata);

    let device = Uuid::new_v4();
    let entry_id = Uuid::new_v4();
    insert_entry_at(&pool, entry_id, device, "an evening entry", instant).await;

    let digest = wait_for_digest(&pool, Period::Day, horizon).await;
    assert_eq!(digest.grounding_entry_ids, vec![entry_id]);

    // Never Digested under the UTC calendar date it was written on — this
    // worker's own clock puts it a full day later.
    assert!(
        find_digest(&pool, Period::Day, utc_calendar_date)
            .await
            .is_none()
    );

    worker.abort();
}

/// Issue #101: bucketing an Entry into the right Period (the pair of
/// tests above) is only half the fix — the Entry also has to be *rendered*
/// to the model under that same local day, not the UTC day `created_at`
/// is stored in. Same instant and the same Kolkata-boundary shape as
/// `an_entry_at_1845_utc_lands_in_the_next_day_under_asia_kolkata` above,
/// but this asserts on the digest chat call's own message content
/// (`client.all_calls()`) rather than which `digests` row gets written:
/// the rendered Entry must say `[<Kolkata day>]`, never the UTC
/// `[<utc_calendar_date>]`.
#[sqlx::test]
async fn a_digest_renders_an_entry_by_its_configured_local_day_not_utc(pool: PgPool) {
    let kolkata: Tz = "Asia/Kolkata".parse().unwrap();
    let now = Utc::now();
    let horizon = period::most_recently_completed(Period::Day, kolkata, now);
    let utc_calendar_date = horizon - chrono::Duration::days(1);
    let naive_evening = utc_calendar_date.and_hms_opt(18, 45, 0).unwrap();
    let instant = DateTime::<Utc>::from_naive_utc_and_offset(naive_evening, Utc);

    let client = Arc::new(FakeChatClient::new(FakeBehavior::AlwaysSucceed));
    let worker = spawn_worker(pool.clone(), client.clone(), kolkata);

    let device = Uuid::new_v4();
    insert_entry_at(&pool, Uuid::new_v4(), device, "an evening entry", instant).await;

    wait_for_digest(&pool, Period::Day, horizon).await;
    worker.abort();

    let digest_call = client
        .all_calls()
        .into_iter()
        .find(|call| is_digest_call(call))
        .expect("the worker made at least one digest chat call");
    let rendered = digest_call
        .iter()
        .find(|m| m.role == "user")
        .expect("a digest call always carries a user message with the rendered Entries")
        .content
        .clone();

    let kolkata_label = format!("[{}]", horizon.format("%Y-%m-%d"));
    let utc_label = format!("[{}]", utc_calendar_date.format("%Y-%m-%d"));
    assert!(
        rendered.contains(&kolkata_label),
        "expected the Entry rendered under its Kolkata-local day {kolkata_label}, got: {rendered}"
    );
    assert!(
        !rendered.contains(&utc_label),
        "must not render the UTC calendar day {utc_label}, which is one day earlier: {rendered}"
    );
}

/// The other half of issue #101's acceptance criteria: rendering must be
/// **unchanged** when `MEOLOGUE_TZ` is UTC (the default/unset case) — a
/// plain UTC-day Entry renders under that same UTC day, exactly as it
/// always did.
#[sqlx::test]
async fn a_digest_renders_entries_unchanged_under_utc(pool: PgPool) {
    let now = Utc::now();
    let horizon = period::most_recently_completed(Period::Day, Tz::UTC, now);
    let naive_evening = horizon.and_hms_opt(9, 0, 0).unwrap();
    let instant = DateTime::<Utc>::from_naive_utc_and_offset(naive_evening, Utc);

    let client = Arc::new(FakeChatClient::new(FakeBehavior::AlwaysSucceed));
    let worker = spawn_worker(pool.clone(), client.clone(), Tz::UTC);

    let device = Uuid::new_v4();
    insert_entry_at(&pool, Uuid::new_v4(), device, "a morning entry", instant).await;

    wait_for_digest(&pool, Period::Day, horizon).await;
    worker.abort();

    let digest_call = client
        .all_calls()
        .into_iter()
        .find(|call| is_digest_call(call))
        .expect("the worker made at least one digest chat call");
    let rendered = digest_call
        .iter()
        .find(|m| m.role == "user")
        .expect("a digest call always carries a user message with the rendered Entries")
        .content
        .clone();

    let utc_label = format!("[{}]", horizon.format("%Y-%m-%d"));
    assert!(
        rendered.contains(&utc_label),
        "expected the Entry rendered under its UTC day {utc_label} (MEOLOGUE_TZ unset means UTC), got: {rendered}"
    );
}

// ---------------------------------------------------------------------
// Chunking (issue #136): a Period whose Entries exceed
// `digest::DIGEST_ENTRY_BUDGET_FRACTION` of the resolved context window
// is split across several chat calls rather than one call silently
// overrunning the model's own limit. Every test below drives the split
// with `spawn_worker_with_context_window` and a deliberately small
// window — issue #136's own numbers show a real corpus (the heaviest
// month in the Sandbox journal, ~2,576 tokens against a 32,000 window)
// is nowhere near this threshold, so these tests are the only thing that
// can actually prove the split correct.
// ---------------------------------------------------------------------

/// A body whose rendered Entry (`[YYYY-MM-DD] body`) costs approximately
/// `tokens` under the chars/4 estimate `digest::chunk_entries` uses
/// internally — every date this module renders is exactly 10 characters
/// (`%Y-%m-%d`), so the `"[...] "` wrapper around it is a fixed 13
/// characters regardless of which date it is, which is what makes sizing
/// against an arbitrary placeholder date safe here.
fn padded_body(marker: &str, tokens: usize) -> String {
    const RENDER_WRAPPER_CHARS: usize = 13; // `"[YYYY-MM-DD] "`.len()
    let target_chars = tokens * 4;
    let padding_len = target_chars.saturating_sub(RENDER_WRAPPER_CHARS + marker.len());
    format!("{marker}{}", "x".repeat(padding_len))
}

/// Issue #136's single-chunk acceptance criterion: a Period whose Entries
/// fit inside the budget makes exactly one chat call, and that call's own
/// user message still names the whole Period's range exactly as it did
/// before chunking existed — `"YYYY-MM-DD (day)"`, never a chunk-shaped
/// label. The stored body is the model's reply, verbatim, proving nothing
/// about the single-chunk path changed shape just because chunking now
/// exists as a possibility.
#[sqlx::test]
async fn a_period_that_fits_the_budget_makes_one_call_with_the_unchanged_period_range(
    pool: PgPool,
) {
    let client = Arc::new(FakeChatClient::new(FakeBehavior::FixedReply(
        "Byte-identical single-chunk prose.",
    )));
    let worker = spawn_worker(pool.clone(), client.clone(), Tz::UTC);

    let yesterday = period::most_recently_completed(Period::Day, Tz::UTC, Utc::now());
    let (from, _) = period::period_bounds(Period::Day, Tz::UTC, yesterday);
    let device = Uuid::new_v4();
    insert_entry_at(
        &pool,
        Uuid::new_v4(),
        device,
        "a small entry, nowhere near any budget",
        from + chrono::Duration::hours(1),
    )
    .await;

    let digest = wait_for_digest(&pool, Period::Day, yesterday).await;
    worker.abort();

    assert_eq!(digest.body, "Byte-identical single-chunk prose.");

    let digest_calls: Vec<_> = client
        .all_calls()
        .into_iter()
        .filter(|call| is_digest_call(call))
        .collect();
    assert_eq!(
        digest_calls.len(),
        1,
        "a Period that fits the budget must make exactly one chat call"
    );

    let user_content = digest_calls[0]
        .iter()
        .find(|m| m.role == "user")
        .expect("a digest call always carries a user message")
        .content
        .clone();
    let expected_range = format!("{} (day)", yesterday.format("%Y-%m-%d"));
    assert!(
        user_content.starts_with(&format!("Here is everything the user wrote from {expected_range}:")),
        "the single-chunk case must render the Period's own range, unchanged: {user_content}"
    );
}

/// Issue #136's core acceptance criterion: a Period whose Entries exceed
/// the budget splits into several chat calls, and the stored body is
/// those calls' replies concatenated with `"\n\n"` — no merge pass, see
/// `digest::generate_digest_body`'s own doc comment for why. Three
/// same-day Entries, each costing ~100 tokens under a 250-token
/// `context_window` (a 150-token budget, `DIGEST_ENTRY_BUDGET_FRACTION`
/// applied), force one chunk per Entry: two together (~200 tokens) always
/// exceed 150, so `chunk_entries` must start a new chunk at every
/// boundary here.
///
/// This one test also covers three more of issue #136's criteria at
/// once, each easy to check once the calls are recorded: every chunk's
/// user message names only that chunk's own single local day (never a
/// `"(day)"`-suffixed Period-wide range, and never a day it wasn't
/// given — issue #101's lesson, one level up); every Entry appears in
/// exactly one call's content, so none was split or duplicated; and the
/// stored `grounding_entry_ids`/`source_seq` still cover every Entry and
/// the true max `seq`, not just whichever chunk happened to read them.
///
/// Every Entry is seeded before the worker ever starts ticking — the
/// same "whole picture at once" discipline
/// `a_digest_records_only_the_entries_in_its_own_period` documents above:
/// spawning the worker first risks it writing (and, by immutability,
/// never revisiting) this Period from only whichever Entry had landed by
/// its first tick, which would prove nothing about chunking at all.
#[sqlx::test]
async fn a_period_too_large_for_the_budget_splits_into_several_calls_each_naming_its_own_span(
    pool: PgPool,
) {
    let yesterday = period::most_recently_completed(Period::Day, Tz::UTC, Utc::now());
    let (from, _) = period::period_bounds(Period::Day, Tz::UTC, yesterday);
    let device = Uuid::new_v4();

    let id_a = Uuid::new_v4();
    let id_b = Uuid::new_v4();
    let id_c = Uuid::new_v4();
    let seq_a = insert_entry_at(
        &pool,
        id_a,
        device,
        &padded_body("ENTRY-A-", 100),
        from + chrono::Duration::hours(1),
    )
    .await;
    let seq_b = insert_entry_at(
        &pool,
        id_b,
        device,
        &padded_body("ENTRY-B-", 100),
        from + chrono::Duration::hours(2),
    )
    .await;
    let seq_c = insert_entry_at(
        &pool,
        id_c,
        device,
        &padded_body("ENTRY-C-", 100),
        from + chrono::Duration::hours(3),
    )
    .await;

    let client = Arc::new(FakeChatClient::new(FakeBehavior::Scripted(Mutex::new(
        VecDeque::from(["Reply A.", "Reply B.", "Reply C."]),
    ))));
    let worker = spawn_worker_with_context_window(pool.clone(), client.clone(), Tz::UTC, 250);

    let digest = wait_for_digest(&pool, Period::Day, yesterday).await;
    worker.abort();

    assert_eq!(
        digest.body, "Reply A.\n\nReply B.\n\nReply C.",
        "chunk replies must be concatenated with a blank line, with no merge pass"
    );

    let mut ids = digest.grounding_entry_ids.clone();
    ids.sort();
    let mut expected_ids = vec![id_a, id_b, id_c];
    expected_ids.sort();
    assert_eq!(
        ids, expected_ids,
        "grounding must cover every Entry regardless of which chunk read it"
    );
    assert_eq!(
        digest.source_seq,
        seq_a.max(seq_b).max(seq_c),
        "the watermark must be the max seq over every Entry, not just one chunk's"
    );

    let digest_calls: Vec<_> = client
        .all_calls()
        .into_iter()
        .filter(|call| is_digest_call(call))
        .collect();
    assert_eq!(digest_calls.len(), 3, "one chat call per chunk");

    let user_content = |call: &[ChatMessage]| {
        call.iter()
            .find(|m| m.role == "user")
            .expect("a digest call always carries a user message")
            .content
            .clone()
    };
    let contents: Vec<String> = digest_calls.iter().map(|c| user_content(c)).collect();
    let today_label = yesterday.format("%Y-%m-%d").to_string();

    for (marker, own_content) in [
        ("ENTRY-A-", &contents[0]),
        ("ENTRY-B-", &contents[1]),
        ("ENTRY-C-", &contents[2]),
    ] {
        assert!(
            own_content.starts_with(&format!("Here is everything the user wrote from {today_label}:")),
            "a multi-chunk call must name its own span, with no \"(day)\" Period-wide suffix: {own_content}"
        );
        assert!(
            own_content.contains(marker),
            "the chunk containing {marker} must render it"
        );
    }

    // No Entry appears in more than one call's content — proof nothing was
    // duplicated across chunks, alongside the ids check above proving
    // nothing was dropped.
    for (marker, other_markers) in [
        ("ENTRY-A-", ["ENTRY-B-", "ENTRY-C-"]),
        ("ENTRY-B-", ["ENTRY-A-", "ENTRY-C-"]),
        ("ENTRY-C-", ["ENTRY-A-", "ENTRY-B-"]),
    ] {
        let owner = contents
            .iter()
            .find(|content| content.contains(marker))
            .unwrap_or_else(|| panic!("{marker} must appear in exactly one call"));
        for other in other_markers {
            assert!(
                !owner.contains(other),
                "the call carrying {marker} must not also carry {other}: {owner}"
            );
        }
    }
}

/// Issue #136's completeness guarantee: an Entry that alone exceeds the
/// budget still gets a chunk of its own — never dropped — and the
/// packing loop still terminates rather than spinning on it. A single
/// huge Entry (~1,000 tokens, well past a 150-token budget) followed by
/// an ordinary small one: `chunk_entries` must put the huge Entry in its
/// own chunk (there is no smaller unit to split it into) and start a
/// fresh chunk for the small one rather than folding it into the
/// already-over-budget first chunk. `wait_for_digest`'s own timeout is
/// itself part of what this test proves — a packing loop that spun
/// forever on the oversized Entry would never produce a Digest at all,
/// and this test would fail by timing out rather than by a failed
/// assertion.
#[sqlx::test]
async fn a_single_entry_larger_than_the_budget_still_gets_its_own_chunk(pool: PgPool) {
    let yesterday = period::most_recently_completed(Period::Day, Tz::UTC, Utc::now());
    let (from, _) = period::period_bounds(Period::Day, Tz::UTC, yesterday);
    let device = Uuid::new_v4();

    let huge_id = Uuid::new_v4();
    let small_id = Uuid::new_v4();
    // Both Entries seeded before the worker starts ticking — see the
    // sibling split test above for why.
    insert_entry_at(
        &pool,
        huge_id,
        device,
        &padded_body("HUGE-", 1_000),
        from + chrono::Duration::hours(1),
    )
    .await;
    insert_entry_at(
        &pool,
        small_id,
        device,
        &padded_body("SMALL-", 20),
        from + chrono::Duration::hours(2),
    )
    .await;

    let client = Arc::new(FakeChatClient::new(FakeBehavior::Scripted(Mutex::new(
        VecDeque::from(["Huge reply.", "Small reply."]),
    ))));
    let worker = spawn_worker_with_context_window(pool.clone(), client.clone(), Tz::UTC, 250);

    let digest = wait_for_digest(&pool, Period::Day, yesterday).await;
    worker.abort();

    assert_eq!(
        digest.body, "Huge reply.\n\nSmall reply.",
        "the oversized Entry's own chunk, then the small Entry's, joined"
    );

    let mut ids = digest.grounding_entry_ids.clone();
    ids.sort();
    let mut expected_ids = vec![huge_id, small_id];
    expected_ids.sort();
    assert_eq!(
        ids, expected_ids,
        "the oversized Entry must never be dropped from Grounding"
    );

    let digest_calls: Vec<_> = client
        .all_calls()
        .into_iter()
        .filter(|call| is_digest_call(call))
        .collect();
    assert_eq!(
        digest_calls.len(),
        2,
        "the oversized Entry gets its own chunk, separate from the small Entry's"
    );
}

/// Issue #137's core acceptance criterion, on the worker's own tick: one
/// bad chunk out of three costs only its own Entry, not the Period. Three
/// same-day Entries force exactly three chunks (the same sizing as the
/// split test above), and `FailEveryNth(3)` fails only the *third* call of
/// every attempt, consistently — here that is Entry C's own chunk, always,
/// so the very first attempt already writes a Digest: chunk A and chunk B
/// both succeed, chunk C is skipped, and the surviving two bodies are
/// stored joined by `"\n\n"`. This supersedes issue #136's original
/// stricter rule (a bad chunk anywhere failed the *whole* Period, which
/// this exact `FailEveryNth(3)` setup used to prove by asserting no Digest
/// was ever written) — see `generate_digest_body`'s own doc comment for
/// why that rule was softened.
#[sqlx::test]
async fn a_bad_chunk_of_three_is_skipped_and_the_surviving_two_still_write_a_digest(
    pool: PgPool,
) {
    let yesterday = period::most_recently_completed(Period::Day, Tz::UTC, Utc::now());
    let (from, _) = period::period_bounds(Period::Day, Tz::UTC, yesterday);
    let device = Uuid::new_v4();
    // All three seeded before the worker starts ticking — the same "whole
    // picture at once" discipline the split test above documents: an
    // early tick seeing only one or two of these Entries would make fewer
    // than three chunks for that attempt, throwing off which chunk
    // `FailEveryNth(3)` actually lands on.
    let id_a = Uuid::new_v4();
    let id_b = Uuid::new_v4();
    let id_c = Uuid::new_v4();
    let seq_a = insert_entry_at(
        &pool,
        id_a,
        device,
        &padded_body("ENTRY-A-", 100),
        from + chrono::Duration::hours(1),
    )
    .await;
    let seq_b = insert_entry_at(
        &pool,
        id_b,
        device,
        &padded_body("ENTRY-B-", 100),
        from + chrono::Duration::hours(2),
    )
    .await;
    insert_entry_at(
        &pool,
        id_c,
        device,
        &padded_body("ENTRY-C-", 100),
        from + chrono::Duration::hours(3),
    )
    .await;

    let client = Arc::new(FakeChatClient::new(FakeBehavior::FailEveryNth(3)));
    let worker = spawn_worker_with_context_window(pool.clone(), client.clone(), Tz::UTC, 250);

    let digest = wait_for_digest(&pool, Period::Day, yesterday).await;

    assert_eq!(
        digest.body,
        "You wrote about a handful of things.\n\nYou wrote about a handful of things.",
        "the stored body is exactly the two surviving chunks' replies, joined, with nothing standing in for the skipped one"
    );

    let mut ids = digest.grounding_entry_ids.clone();
    ids.sort();
    let mut expected_ids = vec![id_a, id_b];
    expected_ids.sort();
    assert_eq!(
        ids, expected_ids,
        "grounding must hold only chunk A's and chunk B's Entries — chunk C's Entry must be absent entirely"
    );
    assert_eq!(
        digest.source_seq, 0,
        "a Digest that skipped a chunk must record source_seq = 0, not the max over its own surviving Entries (would be seq_a.max(seq_b))"
    );
    // Confirms the watermark really was overridden to 0, not coincidentally
    // equal to it: seq_a and seq_b are freshly assigned, strictly positive
    // sequence values on a fresh test database.
    assert!(seq_a > 0 && seq_b > 0);

    // The Period never gets a second look — a written Digest (however
    // partial) still advances `fill_period`'s anchor, so give the worker
    // several more ticks and confirm the call count and the row are both
    // final.
    tokio::time::sleep(TEST_SCAN_INTERVAL * 20).await;
    assert_eq!(
        client.calls(),
        3,
        "every chunk gets exactly one attempt on the one tick that wrote this Digest, and the worker never revisits it afterwards"
    );

    worker.abort();
}

/// The other half of issue #137's failure semantics, unchanged from issue
/// #135/#136: when *every* chunk in a Period fails, there is nothing to
/// disclose partially — the Period gets no Digest at all, the worker
/// consumes an attempt exactly as it already did for a single-chunk
/// failure, and keeps retrying up to `MAX_ATTEMPTS`. Three same-day
/// Entries force the same three chunks as the sibling test above, but
/// `AlwaysFail` (rather than `FailEveryNth`) fails every one of them, on
/// every attempt.
#[sqlx::test]
async fn every_chunk_failing_writes_no_digest_and_stops_after_max_attempts(pool: PgPool) {
    let yesterday = period::most_recently_completed(Period::Day, Tz::UTC, Utc::now());
    let (from, _) = period::period_bounds(Period::Day, Tz::UTC, yesterday);
    let device = Uuid::new_v4();
    insert_entry_at(
        &pool,
        Uuid::new_v4(),
        device,
        &padded_body("ENTRY-A-", 100),
        from + chrono::Duration::hours(1),
    )
    .await;
    insert_entry_at(
        &pool,
        Uuid::new_v4(),
        device,
        &padded_body("ENTRY-B-", 100),
        from + chrono::Duration::hours(2),
    )
    .await;
    insert_entry_at(
        &pool,
        Uuid::new_v4(),
        device,
        &padded_body("ENTRY-C-", 100),
        from + chrono::Duration::hours(3),
    )
    .await;

    let client = Arc::new(FakeChatClient::new(FakeBehavior::AlwaysFail));
    let worker = spawn_worker_with_context_window(pool.clone(), client.clone(), Tz::UTC, 250);

    // Long enough for every attempt up to `MAX_ATTEMPTS` to have run —
    // the same margin `a_chat_client_that_always_fails_stops_after_exactly_max_attempts`
    // uses for a single-chunk failure.
    tokio::time::sleep(TEST_SCAN_INTERVAL * 40).await;

    assert_eq!(
        client.calls(),
        3 * digest::MAX_ATTEMPTS as usize,
        "every attempt must still make all 3 chunk calls (no short-circuit on the first failure), across exactly MAX_ATTEMPTS attempts"
    );
    assert!(
        find_digest(&pool, Period::Day, yesterday).await.is_none(),
        "a Period must never get a Digest when every one of its chunks always fails"
    );

    worker.abort();
}
