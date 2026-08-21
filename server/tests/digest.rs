use std::collections::HashSet;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Result, bail};
use async_trait::async_trait;
use chrono::{DateTime, Datelike, NaiveDate, Utc};
use chrono_tz::Tz;
use meologue_server::digest;
use meologue_server::llm::{ChatMessage, LlmClient};
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
/// whether `chat` succeeds with canned prose or always errors (the
/// attempt-cap test's whole point); every call is recorded so a test can
/// assert on exactly what the worker sent.
struct FakeChatClient {
    behavior: FakeBehavior,
    calls: Mutex<Vec<Vec<ChatMessage>>>,
    call_count: AtomicUsize,
}

enum FakeBehavior {
    AlwaysSucceed,
    AlwaysFail,
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
    async fn chat(&self, messages: &[ChatMessage]) -> Result<String> {
        self.call_count.fetch_add(1, Ordering::SeqCst);
        self.calls.lock().unwrap().push(messages.to_vec());
        match self.behavior {
            FakeBehavior::AlwaysSucceed => Ok("You wrote about a handful of things.".to_string()),
            FakeBehavior::AlwaysFail => bail!("fake chat client always errors"),
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

async fn insert_entry_at(
    pool: &PgPool,
    id: Uuid,
    device_id: Uuid,
    body: &str,
    created_at: DateTime<Utc>,
) {
    sqlx::query("insert into entries (id, device_id, body, created_at) values ($1, $2, $3, $4)")
        .bind(id)
        .bind(device_id)
        .bind(body)
        .bind(created_at)
        .execute(pool)
        .await
        .unwrap();
}

#[derive(sqlx::FromRow, Debug, Clone)]
struct DigestRow {
    period: String,
    period_start: NaiveDate,
    grounding_entry_ids: Vec<Uuid>,
}

async fn all_digests(pool: &PgPool) -> Vec<DigestRow> {
    sqlx::query_as::<_, DigestRow>("select period, period_start, grounding_entry_ids from digests")
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
        "select period, period_start, grounding_entry_ids from digests where period = $1 and period_start = $2",
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

fn spawn_worker(pool: PgPool, client: Arc<FakeChatClient>, tz: Tz) -> tokio::task::JoinHandle<()> {
    tokio::spawn(digest::run(pool, client, tz, TEST_SCAN_INTERVAL))
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
