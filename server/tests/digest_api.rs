//! Issue #70: `GET /v1/digests/{period}` and `GET /v1/digests/{period}/{date}`
//! — the read side of the Digest worker `tests/digest.rs` exercises. This
//! file never runs the worker itself; every Digest here is seeded directly
//! with `insert_digest`, the same "assert against the real Router, seed the
//! database directly" shape `tests/sessions.rs` uses for its own handlers.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use anyhow::Result;
use async_trait::async_trait;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use chrono_tz::Tz;
use http_body_util::BodyExt;
use meologue_server::digest::DigestState;
use meologue_server::llm::{ChatMessage, ChatReply, LlmClient};
use meologue_server::period::{self, Period};
use serde_json::Value;
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

// `/v1/digests/*` never hits a static asset — any directory that exists is
// fine as the (otherwise unused) static_dir, matching tests/sessions.rs's
// own convention.
fn empty_static_dir() -> PathBuf {
    std::env::current_dir().unwrap()
}

/// Mirrors `tests/health.rs`'s own `UnusedLlmClient`: every test in this
/// file only ever exercises the two GET routes (never `regenerate`), so
/// nothing here ever calls through a `DigestState`'s `chat_client` — it
/// only has to satisfy the shape `router_with_digests` needs to register
/// the routes and resolve their `Tz` at all.
struct UnusedLlmClient;

#[async_trait]
impl LlmClient for UnusedLlmClient {
    async fn chat(&self, _messages: &[ChatMessage]) -> Result<ChatReply> {
        unimplemented!("this test file never regenerates a digest")
    }
    async fn embed_document(&self, _text: &str) -> Result<Vec<f32>> {
        unimplemented!("digest routes never embed anything")
    }
    async fn embed_query(&self, _text: &str) -> Result<Vec<f32>> {
        unimplemented!("digest routes never embed anything")
    }
}

fn unused_digest_state() -> DigestState {
    DigestState {
        chat_client: Arc::new(UnusedLlmClient),
        tz: Tz::UTC,
        // Never exercises a chat call in this file (`UnusedLlmClient`
        // panics if it ever did), so a chunking budget is moot here too —
        // an arbitrary large window, matching `tests/health.rs`'s own
        // unused fixture.
        context_window: 200_000,
    }
}

async fn request(uri: String, digests_enabled: bool, pool: &PgPool) -> (StatusCode, Value) {
    let digest = digests_enabled.then(unused_digest_state);
    let app = meologue_server::router_with_digests(
        pool.clone(),
        empty_static_dir(),
        None,
        None,
        digest,
    );
    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(uri)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let json = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap()
    };
    (status, json)
}

async fn get_latest_digest(
    pool: &PgPool,
    digests_enabled: bool,
    period: &str,
) -> (StatusCode, Value) {
    request(format!("/v1/digests/{period}"), digests_enabled, pool).await
}

async fn get_digest_at(
    pool: &PgPool,
    digests_enabled: bool,
    period: &str,
    date: &str,
) -> (StatusCode, Value) {
    request(
        format!("/v1/digests/{period}/{date}"),
        digests_enabled,
        pool,
    )
    .await
}

/// Seeds one `digests` row directly — this test file never runs
/// `digest::run`, so every row a test needs has to be inserted by hand,
/// mirroring `tests/digest.rs`'s own `insert_entry_at` in spirit.
async fn insert_digest(
    pool: &PgPool,
    period: Period,
    period_start: chrono::NaiveDate,
    body: &str,
    grounding_entry_ids: &[Uuid],
) {
    sqlx::query(
        "insert into digests (id, period, period_start, body, grounding_entry_ids)
         values ($1, $2, $3, $4, $5)",
    )
    .bind(Uuid::new_v4())
    .bind(period.as_str())
    .bind(period_start)
    .bind(body)
    .bind(grounding_entry_ids)
    .execute(pool)
    .await
    .unwrap();
}

/// Like `insert_digest`, but also names `source_seq` (issue #132 / ADR
/// 0039's staleness watermark) instead of leaving it at the column's own
/// default of `0` — every staleness test below needs to seed a Digest
/// exactly as though it had been written *after* whichever Entries it
/// should not yet consider stale.
async fn insert_digest_with_source_seq(
    pool: &PgPool,
    period: Period,
    period_start: chrono::NaiveDate,
    body: &str,
    grounding_entry_ids: &[Uuid],
    source_seq: i64,
) {
    sqlx::query(
        "insert into digests (id, period, period_start, body, grounding_entry_ids, source_seq)
         values ($1, $2, $3, $4, $5, $6)",
    )
    .bind(Uuid::new_v4())
    .bind(period.as_str())
    .bind(period_start)
    .bind(body)
    .bind(grounding_entry_ids)
    .bind(source_seq)
    .execute(pool)
    .await
    .unwrap();
}

/// Every `digests` row at one `(period, period_start)`, newest revision
/// first — what the "regenerate inserts a new revision, every earlier one
/// stays" tests assert against directly, rather than only through what a
/// single GET happens to surface. `grounding_entry_ids` and `source_seq`
/// (issue #137) are carried here too — `Digest`'s wire shape only ever
/// exposes the *derived* `stale` bool, never the raw watermark, so a test
/// that wants to assert directly on the watermark itself (`0` for a
/// partial Digest, the true max `seq` for a complete one) has to read it
/// straight off the row, the same way `tests/digest.rs`'s own `DigestRow`
/// does for the worker side.
#[derive(sqlx::FromRow, Debug, Clone)]
struct DigestRow {
    revision: i32,
    body: String,
    grounding_entry_ids: Vec<Uuid>,
    source_seq: i64,
}

async fn digest_revisions(pool: &PgPool, period: Period, period_start: chrono::NaiveDate) -> Vec<DigestRow> {
    sqlx::query_as::<_, DigestRow>(
        "select revision, body, grounding_entry_ids, source_seq from digests \
         where period = $1 and period_start = $2 order by revision asc",
    )
    .bind(period.as_str())
    .bind(period_start)
    .fetch_all(pool)
    .await
    .unwrap()
}

/// The true watermark for a set of Entries, read straight from `entries`
/// rather than derived from anything `digest.rs` computed — issue #137's
/// "a complete multi-chunk Digest keeps the true watermark" tests need an
/// answer that doesn't depend on the code under test to be a meaningful
/// check. `ids` is always non-empty in every caller here, so `max(seq)` is
/// never `null`.
async fn max_entries_seq(pool: &PgPool, ids: &[Uuid]) -> i64 {
    sqlx::query_scalar::<_, i64>("select max(seq) from entries where id = any($1)")
        .bind(ids)
        .fetch_one(pool)
        .await
        .unwrap()
}

/// Inserts an Entry directly (this file never runs Sync either), returning
/// the `seq` Postgres assigned it — mirrors `tests/digest.rs`'s own
/// `insert_entry_at`, just also handing back `seq` since every staleness
/// test here needs it to seed a Digest's `source_seq` against.
async fn insert_entry_at(
    pool: &PgPool,
    id: Uuid,
    device_id: Uuid,
    body: &str,
    created_at: chrono::DateTime<chrono::Utc>,
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

/// Reassigns an Entry's `seq` from the sequence, without touching
/// `deleted_at` — the exact half of `sync.rs`'s
/// `on conflict do update ... seq = nextval(...)` an ordinary edit
/// exercises (ADR 0028), reproduced directly here rather than through a
/// full Sync push/pull round trip: this file's staleness tests only need
/// "an Entry's `seq` moved," not the whole reconciliation machinery that
/// can cause it to.
async fn bump_entry_seq(pool: &PgPool, id: Uuid) -> i64 {
    sqlx::query_scalar::<_, i64>(
        "update entries set seq = nextval(pg_get_serial_sequence('entries', 'seq')) \
         where id = $1 returning seq",
    )
    .bind(id)
    .fetch_one(pool)
    .await
    .unwrap()
}

/// The delete half of the same reassignment — `deleted_at` set alongside
/// the `seq` bump, exactly as `sync.rs`'s upsert does for a delete push.
/// `select_is_stale` (`digest.rs`) deliberately never filters
/// `deleted_at`, so this is what proves a deletion trips staleness on its
/// own, not just an edit's `seq` bump coincidentally sharing the same
/// column.
async fn soft_delete_entry(pool: &PgPool, id: Uuid) {
    sqlx::query(
        "update entries set deleted_at = now(), seq = nextval(pg_get_serial_sequence('entries', 'seq')) \
         where id = $1",
    )
    .bind(id)
    .execute(pool)
    .await
    .unwrap();
}

/// A chat client that always succeeds with a fixed reply — mirrors
/// `tests/digest.rs`'s own `FakeChatClient`, trimmed to just the one
/// behaviour every regenerate test here needs (nothing in this file ever
/// exercises a failing chat call on the regenerate path).
struct FakeChatClient {
    reply: String,
}

#[async_trait]
impl LlmClient for FakeChatClient {
    async fn chat(&self, _messages: &[ChatMessage]) -> Result<ChatReply> {
        Ok(ChatReply::text(&self.reply))
    }
    async fn embed_document(&self, _text: &str) -> Result<Vec<f32>> {
        unimplemented!("digest routes never embed anything")
    }
    async fn embed_query(&self, _text: &str) -> Result<Vec<f32>> {
        unimplemented!("digest routes never embed anything")
    }
}

fn fake_digest_state(reply: &str) -> DigestState {
    DigestState {
        chat_client: Arc::new(FakeChatClient {
            reply: reply.to_string(),
        }),
        tz: Tz::UTC,
        // Every entry seeded in this file is a short, single sentence, far
        // under even a fraction of this window's budget — none of the
        // tests using this fixture are exercising issue #136's chunking,
        // so an arbitrary large window keeps them all single-chunk, byte-
        // identical to how they behaved before chunking existed. The
        // chunking case itself is exercised below with
        // `scripted_digest_state` and a deliberately small window.
        context_window: 200_000,
    }
}

/// A chat client that succeeds with a distinct scripted reply for each
/// call, in order, and records every call's messages — issue #136's
/// multi-chunk regenerate test needs both: distinct replies per chunk (so
/// the stored, concatenated body proves each chunk's own reply landed,
/// rather than one reply repeated verbatim `N` times), and the recorded
/// messages themselves (so the test can assert each chunk's user message
/// names *that chunk's own* date span, not the whole Period's — the same
/// assertion `tests/digest.rs`'s `is_digest_call`/`all_calls` machinery
/// makes on the worker side).
struct ScriptedChatClient {
    replies: Mutex<VecDeque<String>>,
    calls: Mutex<Vec<Vec<ChatMessage>>>,
}

impl ScriptedChatClient {
    fn new(replies: Vec<&str>) -> Self {
        Self {
            replies: Mutex::new(replies.into_iter().map(str::to_string).collect()),
            calls: Mutex::new(Vec::new()),
        }
    }

    fn all_calls(&self) -> Vec<Vec<ChatMessage>> {
        self.calls.lock().unwrap().clone()
    }
}

#[async_trait]
impl LlmClient for ScriptedChatClient {
    async fn chat(&self, messages: &[ChatMessage]) -> Result<ChatReply> {
        self.calls.lock().unwrap().push(messages.to_vec());
        let reply = self
            .replies
            .lock()
            .unwrap()
            .pop_front()
            .expect("scripted reply queue exhausted — fewer replies scripted than chat calls made");
        Ok(ChatReply::text(&reply))
    }
    async fn embed_document(&self, _text: &str) -> Result<Vec<f32>> {
        unimplemented!("digest routes never embed anything")
    }
    async fn embed_query(&self, _text: &str) -> Result<Vec<f32>> {
        unimplemented!("digest routes never embed anything")
    }
}

fn scripted_digest_state(client: Arc<ScriptedChatClient>, context_window: u32) -> DigestState {
    DigestState {
        chat_client: client,
        tz: Tz::UTC,
        context_window,
    }
}

/// A chat client that succeeds or fails per call, in order — issue #137's
/// regenerate-path tests need this and neither existing fake covers it:
/// `ScriptedChatClient` above always succeeds (it exists to prove distinct
/// replies land in the right chunk, not to fail), and `fake_digest_state`'s
/// `FakeChatClient` always does the same one thing on every call. Proving
/// "one chunk of several fails, the rest succeed" — or "every chunk
/// fails" — on the regenerate path needs a client whose calls can differ
/// from each other. Modeled on `tests/digest.rs`'s own `FakeChatClient`,
/// just scripted per-call rather than by a fixed rule, since these tests'
/// chunk counts are small and known up front.
struct FlakyScriptedChatClient {
    outcomes: Mutex<VecDeque<Result<&'static str, &'static str>>>,
    calls: Mutex<Vec<Vec<ChatMessage>>>,
}

impl FlakyScriptedChatClient {
    fn new(outcomes: Vec<Result<&'static str, &'static str>>) -> Self {
        Self {
            outcomes: Mutex::new(outcomes.into_iter().collect()),
            calls: Mutex::new(Vec::new()),
        }
    }

    fn calls(&self) -> usize {
        self.calls.lock().unwrap().len()
    }
}

#[async_trait]
impl LlmClient for FlakyScriptedChatClient {
    async fn chat(&self, messages: &[ChatMessage]) -> Result<ChatReply> {
        self.calls.lock().unwrap().push(messages.to_vec());
        let outcome = self
            .outcomes
            .lock()
            .unwrap()
            .pop_front()
            .expect("FlakyScriptedChatClient outcomes exhausted — fewer scripted than chat calls made");
        match outcome {
            Ok(reply) => Ok(ChatReply::text(reply)),
            Err(message) => Err(anyhow::anyhow!(message)),
        }
    }
    async fn embed_document(&self, _text: &str) -> Result<Vec<f32>> {
        unimplemented!("digest routes never embed anything")
    }
    async fn embed_query(&self, _text: &str) -> Result<Vec<f32>> {
        unimplemented!("digest routes never embed anything")
    }
}

fn flaky_digest_state(client: Arc<FlakyScriptedChatClient>, context_window: u32) -> DigestState {
    DigestState {
        chat_client: client,
        tz: Tz::UTC,
        context_window,
    }
}

/// `POST /v1/digests/{period}/{date}/regenerate` against a Router built
/// with `digest` — mirrors `request` above exactly, just a different verb
/// and a `DigestState` that can actually answer a chat call (`request`'s
/// own `digests_enabled: bool` only ever built an `UnusedLlmClient`, which
/// would panic if `regenerate_digest_handler` ever reached it).
async fn regenerate(pool: &PgPool, digest: DigestState, period: &str, date: &str) -> (StatusCode, Value) {
    let app = meologue_server::router_with_digests(
        pool.clone(),
        empty_static_dir(),
        None,
        None,
        Some(digest),
    );
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/v1/digests/{period}/{date}/regenerate"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let json = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap()
    };
    (status, json)
}

fn date(year: i32, month: u32, day: u32) -> chrono::NaiveDate {
    chrono::NaiveDate::from_ymd_opt(year, month, day).unwrap()
}

/// The most recent Digest of a Period comes back with its Period, its
/// inclusive date range, its prose, and the Entries it grounds in.
#[sqlx::test]
async fn the_most_recent_digest_of_a_period_comes_back_with_its_range_prose_and_grounding(
    pool: PgPool,
) {
    let entry_ids = vec![Uuid::new_v4(), Uuid::new_v4()];
    insert_digest(
        &pool,
        Period::Month,
        date(2026, 7, 1),
        "You wrote a lot about the move this month.",
        &entry_ids,
    )
    .await;

    let (status, body) = get_latest_digest(&pool, true, "month").await;

    assert_eq!(status, StatusCode::OK);
    let digest = &body["digest"];
    assert_eq!(digest["period"], "month");
    assert_eq!(digest["period_start"], "2026-07-01");
    assert_eq!(
        digest["period_end"],
        period::period_end(Period::Month, date(2026, 7, 1)).to_string()
    );
    assert_eq!(digest["body"], "You wrote a lot about the move this month.");
    let returned_ids: Vec<String> = digest["grounding_entry_ids"]
        .as_array()
        .unwrap()
        .iter()
        .map(|id| id.as_str().unwrap().to_string())
        .collect();
    assert_eq!(
        returned_ids,
        entry_ids
            .iter()
            .map(|id| id.to_string())
            .collect::<Vec<_>>()
    );
}

/// Asking for the most recent Digest of a Period returns the newest one by
/// `period_start`, not whichever was inserted last.
#[sqlx::test]
async fn the_most_recent_digest_is_the_newest_by_period_start_not_insertion_order(pool: PgPool) {
    insert_digest(&pool, Period::Day, date(2026, 8, 10), "Older.", &[]).await;
    insert_digest(&pool, Period::Day, date(2026, 8, 20), "Newer.", &[]).await;

    let (status, body) = get_latest_digest(&pool, true, "day").await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["digest"]["period_start"], "2026-08-20");
    assert_eq!(body["digest"]["body"], "Newer.");
}

/// Asking for a specific Digest by date returns that one, not the most
/// recent — proven by seeding two and asking for the older.
#[sqlx::test]
async fn a_specific_digest_by_date_comes_back(pool: PgPool) {
    insert_digest(&pool, Period::Day, date(2026, 8, 10), "The older one.", &[]).await;
    insert_digest(&pool, Period::Day, date(2026, 8, 20), "The newer one.", &[]).await;

    let (status, body) = get_digest_at(&pool, true, "day", "2026-08-10").await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["digest"]["period_start"], "2026-08-10");
    assert_eq!(body["digest"]["body"], "The older one.");
}

/// With no Digests at all, the response is 200 and explicitly says there is
/// none — never a 404, which would tell a brand-new install its Server is
/// too old (see `digest.rs::DigestResponse`'s doc comment).
#[sqlx::test]
async fn with_no_digests_at_all_the_response_is_200_with_an_explicit_none(pool: PgPool) {
    let (status, body) = get_latest_digest(&pool, true, "day").await;

    assert_eq!(status, StatusCode::OK);
    assert!(body["digest"].is_null());
}

/// With no Digest at the specific date asked for, likewise a 200 carrying
/// `digest: null` — not a 404, even though a Digest of that Period exists
/// elsewhere.
#[sqlx::test]
async fn with_no_digest_at_that_specific_date_the_response_is_200_with_an_explicit_none(
    pool: PgPool,
) {
    insert_digest(&pool, Period::Day, date(2026, 8, 10), "Something.", &[]).await;

    let (status, body) = get_digest_at(&pool, true, "day", "2026-08-11").await;

    assert_eq!(status, StatusCode::OK);
    assert!(body["digest"].is_null());
}

/// With Digests at three dates, the middle one reports both neighbours, the
/// oldest reports no previous, and the newest reports no next.
#[sqlx::test]
async fn neighbours_are_reported_and_the_archives_ends_report_none(pool: PgPool) {
    insert_digest(&pool, Period::Day, date(2026, 8, 1), "First.", &[]).await;
    insert_digest(&pool, Period::Day, date(2026, 8, 2), "Middle.", &[]).await;
    insert_digest(&pool, Period::Day, date(2026, 8, 3), "Last.", &[]).await;

    let (_, middle) = get_digest_at(&pool, true, "day", "2026-08-02").await;
    assert_eq!(middle["digest"]["prev_date"], "2026-08-01");
    assert_eq!(middle["digest"]["next_date"], "2026-08-03");

    let (_, oldest) = get_digest_at(&pool, true, "day", "2026-08-01").await;
    assert!(oldest["digest"]["prev_date"].is_null());
    assert_eq!(oldest["digest"]["next_date"], "2026-08-02");

    let (_, newest) = get_digest_at(&pool, true, "day", "2026-08-03").await;
    assert_eq!(newest["digest"]["prev_date"], "2026-08-02");
    assert!(newest["digest"]["next_date"].is_null());
}

/// Neighbours skip gaps: with Digests only at Monday and Thursday, Thursday's
/// previous is Monday, not the Wednesday that never got a Digest.
#[sqlx::test]
async fn neighbours_skip_gaps_with_no_digest(pool: PgPool) {
    let monday = date(2026, 8, 17);
    let thursday = date(2026, 8, 20);
    insert_digest(&pool, Period::Day, monday, "Monday.", &[]).await;
    insert_digest(&pool, Period::Day, thursday, "Thursday.", &[]).await;

    let (status, body) = get_digest_at(&pool, true, "day", "2026-08-20").await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["digest"]["prev_date"], "2026-08-17");
}

/// Neighbours are scoped per Period: a Week Digest never reports a Day
/// Digest as its neighbour, even when the Day Digest's date sits directly
/// beside it.
#[sqlx::test]
async fn neighbours_are_scoped_per_period(pool: PgPool) {
    let week_start = date(2026, 8, 17);
    insert_digest(&pool, Period::Week, week_start, "This week.", &[]).await;
    // Day Digests immediately before and after the Week's own period_start
    // — if the neighbour query ever forgot to filter by `period`, these
    // would wrongly show up as the Week Digest's neighbours.
    insert_digest(
        &pool,
        Period::Day,
        date(2026, 8, 16),
        "The day before.",
        &[],
    )
    .await;
    insert_digest(&pool, Period::Day, date(2026, 8, 18), "The day after.", &[]).await;

    let (status, body) = get_digest_at(&pool, true, "week", "2026-08-17").await;

    assert_eq!(status, StatusCode::OK);
    assert!(body["digest"]["prev_date"].is_null());
    assert!(body["digest"]["next_date"].is_null());
}

/// An unknown Period string (`Period::parse` returns `None`) is a 400, not
/// a 200-with-null — this is a malformed request, not an absent Digest.
#[sqlx::test]
async fn an_unknown_period_string_is_a_400(pool: PgPool) {
    let (status, _) = get_latest_digest(&pool, true, "fortnight").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

/// A malformed `{date}` (not `YYYY-MM-DD`) is a 400 for the same reason.
#[sqlx::test]
async fn a_malformed_date_is_a_400(pool: PgPool) {
    let (status, _) = get_digest_at(&pool, true, "day", "not-a-date").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

/// `/v1/digests/*` is gated on chat being configured (`digests_enabled`,
/// wired from `LlmConfig::digest_worker_config().is_some()` in `main.rs`) —
/// mirroring `tests/sessions.rs`'s `the_route_is_absent_when_chat_is_unconfigured`.
/// A Server with no chat model configured never ran the Digest worker in
/// the first place, so it must 404 exactly like an older Server that never
/// had these routes — this is precisely the signal a client reads as
/// "Server too old to know about Digests," which is why an empty Digest
/// (`DigestResponse`'s doc comment) must never also 404.
#[sqlx::test]
async fn the_routes_are_absent_when_chat_is_unconfigured(pool: PgPool) {
    let (status, _) = get_latest_digest(&pool, false, "day").await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let (status, _) = get_digest_at(&pool, false, "day", "2026-08-01").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

// ---------------------------------------------------------------------
// Staleness (issue #132 / ADR 0039): a Digest knows when it is out of
// date, reusing `entries.seq` (ADR 0028's Sync change log) as the
// watermark rather than a new `updated_at` column ADR 0028 already
// rejected by name. Three ways an Entry can move above the watermark a
// Digest recorded — added, edited, deleted — each get their own test
// below, matching the ticket's own "fires on add, on edit, AND on delete"
// wording exactly, rather than trusting one shape to stand in for all
// three.
// ---------------------------------------------------------------------

/// A brand-new Entry landing in an already-Digested Period is the
/// simplest case: the Digest's `source_seq` predates the new Entry's
/// `seq` entirely.
#[sqlx::test]
async fn adding_an_entry_to_an_already_digested_period_marks_it_stale(pool: PgPool) {
    let period_start = date(2026, 8, 10);
    let (from, _) = period::period_bounds(Period::Day, Tz::UTC, period_start);
    let device = Uuid::new_v4();

    let first_id = Uuid::new_v4();
    let first_seq = insert_entry_at(&pool, first_id, device, "first", from + chrono::Duration::hours(1)).await;
    insert_digest_with_source_seq(
        &pool,
        Period::Day,
        period_start,
        "Summary of one Entry.",
        &[first_id],
        first_seq,
    )
    .await;

    // Not stale yet — nothing has moved above the watermark this Digest
    // recorded.
    let (_, body) = get_digest_at(&pool, true, "day", "2026-08-10").await;
    assert_eq!(body["digest"]["stale"], false);

    // A second Entry, in the same Period, added after the Digest was
    // written.
    insert_entry_at(
        &pool,
        Uuid::new_v4(),
        device,
        "second, added later",
        from + chrono::Duration::hours(2),
    )
    .await;

    let (status, body) = get_digest_at(&pool, true, "day", "2026-08-10").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["digest"]["stale"], true);
}

/// Editing an existing Entry the Digest already read also marks it stale
/// — `sync.rs`'s upsert reassigns `seq` on an edit exactly as it does on
/// an insert (ADR 0028), so the same watermark comparison catches it with
/// no separate "was this Entry edited" check anywhere in `digest.rs`.
#[sqlx::test]
async fn editing_an_entry_the_digest_already_read_marks_it_stale(pool: PgPool) {
    let period_start = date(2026, 8, 10);
    let (from, _) = period::period_bounds(Period::Day, Tz::UTC, period_start);
    let device = Uuid::new_v4();

    let entry_id = Uuid::new_v4();
    let original_seq = insert_entry_at(&pool, entry_id, device, "before the edit", from + chrono::Duration::hours(1)).await;
    insert_digest_with_source_seq(
        &pool,
        Period::Day,
        period_start,
        "Summary written before the edit.",
        &[entry_id],
        original_seq,
    )
    .await;

    let (_, body) = get_digest_at(&pool, true, "day", "2026-08-10").await;
    assert_eq!(body["digest"]["stale"], false);

    // The same Entry, edited — its `seq` moves above the Digest's
    // watermark without any new row ever landing.
    bump_entry_seq(&pool, entry_id).await;

    let (status, body) = get_digest_at(&pool, true, "day", "2026-08-10").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["digest"]["stale"], true);
}

/// Deleting an Entry the Digest already read marks it stale too —
/// `select_is_stale` deliberately never filters `deleted_at`, precisely so
/// a deletion (which also reassigns `seq`, `sync.rs`'s same upsert) trips
/// this predicate exactly like an edit does, rather than silently vanishing
/// from consideration the moment it's tombstoned.
#[sqlx::test]
async fn deleting_an_entry_the_digest_already_read_marks_it_stale(pool: PgPool) {
    let period_start = date(2026, 8, 10);
    let (from, _) = period::period_bounds(Period::Day, Tz::UTC, period_start);
    let device = Uuid::new_v4();

    let entry_id = Uuid::new_v4();
    let original_seq = insert_entry_at(&pool, entry_id, device, "will be deleted", from + chrono::Duration::hours(1)).await;
    insert_digest_with_source_seq(
        &pool,
        Period::Day,
        period_start,
        "Summary written before the deletion.",
        &[entry_id],
        original_seq,
    )
    .await;

    let (_, body) = get_digest_at(&pool, true, "day", "2026-08-10").await;
    assert_eq!(body["digest"]["stale"], false);

    soft_delete_entry(&pool, entry_id).await;

    let (status, body) = get_digest_at(&pool, true, "day", "2026-08-10").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["digest"]["stale"], true);
}

// ---------------------------------------------------------------------
// Regenerate (issue #132 / ADR 0039): `POST
// /v1/digests/{period}/{date}/regenerate` inserts a new revision — never
// mutates the one before it — and reads always take the newest.
// ---------------------------------------------------------------------

/// Regenerating an already-Digested Period inserts revision 2 and leaves
/// revision 1 exactly as it was — the acceptance criterion "every earlier
/// revision remains in the table," asserted directly against the raw rows
/// rather than only through what one GET happens to surface.
#[sqlx::test]
async fn regenerating_inserts_revision_two_and_leaves_revision_one_intact(pool: PgPool) {
    let period_start = date(2026, 8, 10);
    let (from, _) = period::period_bounds(Period::Day, Tz::UTC, period_start);
    let device = Uuid::new_v4();
    let entry_id = Uuid::new_v4();
    insert_entry_at(
        &pool,
        entry_id,
        device,
        "the entry both revisions are written from",
        from + chrono::Duration::hours(1),
    )
    .await;

    insert_digest_with_source_seq(
        &pool,
        Period::Day,
        period_start,
        "The first, worker-written revision.",
        &[entry_id],
        0, // stale on purpose — every Entry here postdates this watermark
    )
    .await;

    let (status, body) = regenerate(
        &pool,
        fake_digest_state("The second, regenerated revision."),
        "day",
        "2026-08-10",
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["digest"]["body"], "The second, regenerated revision.");
    assert_eq!(body["digest"]["revision"], 2);
    // Freshly written from the current Entries, so no longer stale.
    assert_eq!(body["digest"]["stale"], false);

    let revisions = digest_revisions(&pool, Period::Day, period_start).await;
    assert_eq!(revisions.len(), 2, "regenerating must insert, never overwrite");
    assert_eq!(revisions[0].revision, 1);
    assert_eq!(revisions[0].body, "The first, worker-written revision.");
    assert_eq!(revisions[1].revision, 2);
    assert_eq!(revisions[1].body, "The second, regenerated revision.");
}

/// A plain read after regenerating returns the new revision — issue
/// #132's "reading a Digest after regeneration returns the new body
/// without a manual refresh" acceptance criterion, proven with a
/// completely separate GET (a fresh Router, exactly what an unrelated
/// client's next request would build).
#[sqlx::test]
async fn a_read_after_regenerating_returns_the_newest_revision(pool: PgPool) {
    let period_start = date(2026, 8, 10);
    let (from, _) = period::period_bounds(Period::Day, Tz::UTC, period_start);
    let device = Uuid::new_v4();
    let entry_id = Uuid::new_v4();
    insert_entry_at(
        &pool,
        entry_id,
        device,
        "grounding for every revision",
        from + chrono::Duration::hours(1),
    )
    .await;
    insert_digest_with_source_seq(&pool, Period::Day, period_start, "Revision one.", &[entry_id], 0).await;

    regenerate(&pool, fake_digest_state("Revision two."), "day", "2026-08-10").await;

    let (status, body) = get_digest_at(&pool, true, "day", "2026-08-10").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["digest"]["body"], "Revision two.");
    assert_eq!(body["digest"]["revision"], 2);

    // The archive-wide "most recent" read (no date named) also finds the
    // newest revision, not merely the newest `period_start`.
    let (status, body) = get_latest_digest(&pool, true, "day").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["digest"]["body"], "Revision two.");
}

/// Regenerate is the rescue for a Period that never got a Digest at all —
/// ADR 0027's Consequences names exactly this gap (a Period stuck past
/// `MAX_ATTEMPTS` is indistinguishable from one never attempted, since the
/// attempt count is process-local). `coalesce(max(revision), 0) + 1`
/// resolves to plain `1` when nothing exists yet, so this route can also
/// write a Period's first row, not only its second and later ones.
#[sqlx::test]
async fn regenerate_rescues_a_period_that_never_got_a_digest(pool: PgPool) {
    let period_start = date(2026, 8, 10);
    let (from, _) = period::period_bounds(Period::Day, Tz::UTC, period_start);
    let device = Uuid::new_v4();
    insert_entry_at(
        &pool,
        Uuid::new_v4(),
        device,
        "an entry from a period the worker never managed to digest",
        from + chrono::Duration::hours(1),
    )
    .await;

    let (status, body) = regenerate(
        &pool,
        fake_digest_state("Written on request, past the worker's own attempt cap."),
        "day",
        "2026-08-10",
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["digest"]["revision"], 1);
    assert_eq!(
        body["digest"]["body"],
        "Written on request, past the worker's own attempt cap."
    );

    let revisions = digest_revisions(&pool, Period::Day, period_start).await;
    assert_eq!(revisions.len(), 1);
    assert_eq!(revisions[0].revision, 1);
}

/// Issue #135: neither writer may store an unvalidated body, and the
/// regenerate route's own version of that failure is the sharper one —
/// `select_digest_at`/`select_latest_digest` always take the newest
/// revision unconditionally (ADR 0039), so a blank revision that did get
/// inserted would shadow a perfectly good earlier one, not merely fail to
/// improve on it. Seeds a genuinely good revision 1, regenerates with a
/// reply `digest::generate_digest_body` rejects, and checks all three
/// consequences at once: the route answers 500, no revision 2 is minted,
/// and a plain read afterwards still returns the good revision 1
/// untouched — proving it was never shadowed.
async fn assert_rejected_regenerate_reply_mints_no_revision_and_original_still_reads_back(
    pool: PgPool,
    rejected_reply: &'static str,
) {
    let period_start = date(2026, 8, 10);
    let (from, _) = period::period_bounds(Period::Day, Tz::UTC, period_start);
    let device = Uuid::new_v4();
    let entry_id = Uuid::new_v4();
    insert_entry_at(
        &pool,
        entry_id,
        device,
        "the entry a good revision was already written from",
        from + chrono::Duration::hours(1),
    )
    .await;

    insert_digest_with_source_seq(
        &pool,
        Period::Day,
        period_start,
        "A perfectly good revision, written before this regenerate call.",
        &[entry_id],
        0,
    )
    .await;

    let (status, body) = regenerate(&pool, fake_digest_state(rejected_reply), "day", "2026-08-10").await;

    assert_eq!(
        status,
        StatusCode::INTERNAL_SERVER_ERROR,
        "a rejected reply {rejected_reply:?} must surface as an error, not a 200 carrying a blank digest"
    );
    assert_eq!(body, Value::Null, "an error response carries no digest payload");

    let revisions = digest_revisions(&pool, Period::Day, period_start).await;
    assert_eq!(
        revisions.len(),
        1,
        "a rejected reply must mint no new revision"
    );
    assert_eq!(
        revisions[0].body,
        "A perfectly good revision, written before this regenerate call."
    );

    // The good revision is still the one a plain read returns — the exact
    // "regenerate on a Digest that was merely stale can blank it" failure
    // this ticket was filed against never gets the chance to happen.
    let (status, body) = get_digest_at(&pool, true, "day", "2026-08-10").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["digest"]["revision"], 1);
    assert_eq!(
        body["digest"]["body"],
        "A perfectly good revision, written before this regenerate call."
    );
}

#[sqlx::test]
async fn regenerating_with_an_empty_reply_mints_no_revision(pool: PgPool) {
    assert_rejected_regenerate_reply_mints_no_revision_and_original_still_reads_back(pool, "").await;
}

#[sqlx::test]
async fn regenerating_with_a_whitespace_only_reply_mints_no_revision(pool: PgPool) {
    assert_rejected_regenerate_reply_mints_no_revision_and_original_still_reads_back(pool, "   \n\t  ")
        .await;
}

#[sqlx::test]
async fn regenerating_with_a_bare_code_fence_reply_mints_no_revision(pool: PgPool) {
    assert_rejected_regenerate_reply_mints_no_revision_and_original_still_reads_back(pool, "```").await;
}

#[sqlx::test]
async fn regenerating_with_a_fenced_reply_with_nothing_between_the_fences_mints_no_revision(
    pool: PgPool,
) {
    assert_rejected_regenerate_reply_mints_no_revision_and_original_still_reads_back(pool, "```\n```")
        .await;
}

/// The other shape of "mints no revision": a Period that never had a
/// Digest at all — `regenerate_rescues_a_period_that_never_got_a_digest`'s
/// own setup, but with a rejected reply instead of a good one. Distinct
/// from the tests above (which all guard against *shadowing* an existing
/// good revision): here there is nothing to shadow, so the only thing
/// worth proving is that a rejected reply doesn't get to write revision 1
/// either — `coalesce(max(revision), 0) + 1` would happily resolve to `1`
/// for an empty body exactly as it does for a good one, if this ticket's
/// validation step weren't in the way.
#[sqlx::test]
async fn regenerating_a_never_digested_period_with_an_empty_reply_mints_no_revision(pool: PgPool) {
    let period_start = date(2026, 8, 10);
    let (from, _) = period::period_bounds(Period::Day, Tz::UTC, period_start);
    let device = Uuid::new_v4();
    insert_entry_at(
        &pool,
        Uuid::new_v4(),
        device,
        "an entry from a period the worker never managed to digest",
        from + chrono::Duration::hours(1),
    )
    .await;

    let (status, body) = regenerate(&pool, fake_digest_state(""), "day", "2026-08-10").await;

    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(body, Value::Null);

    let revisions = digest_revisions(&pool, Period::Day, period_start).await;
    assert!(
        revisions.is_empty(),
        "a rejected reply must not write revision 1 either, when nothing existed before it"
    );

    let (status, body) = get_digest_at(&pool, true, "day", "2026-08-10").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["digest"], Value::Null);
}

// ---------------------------------------------------------------------
// Chunking (issue #136): a Period too large for one chat call is split
// across several, on the regenerate path exactly as it is on the
// worker's own tick. `tests/digest.rs` carries the packing-boundary
// tests (never splitting an Entry, an oversized single Entry earning its
// own chunk); this file's own job is proving the *route* — not just
// `generate_digest_body` in isolation — actually chunks, since
// `run_regenerate` is where `DigestState::context_window` (issue #136)
// reaches this crate's only other caller of `generate_digest_body`.
// ---------------------------------------------------------------------

/// Renders exactly the shape `render_entry` (`digest.rs`) does —
/// `[YYYY-MM-DD] body` — so `body`'s length can be chosen to land the
/// rendered Entry at a known token count (chars/4) and force a chunking
/// split under a deliberately small `context_window`, the same technique
/// `tests/digest.rs`'s own chunking tests use.
fn rendered_len(body: &str) -> usize {
    format!("[2026-08-10] {body}").len()
}

/// The three-Entry, three-chunk Week fixture every test in this section
/// needs — a Monday, a Wednesday and a Friday Entry, each costing ~100
/// tokens under the `chars/4` estimate (comfortably under a 150-token
/// budget alone, but two together, ~200 tokens, exceed it), so a
/// `context_window` of 250 (`DIGEST_ENTRY_BUDGET_FRACTION`'s 0.60 gives a
/// 150-token Entry budget) forces `chunk_entries` to split at every
/// boundary here, into exactly three chunks, one Entry each — the same
/// sizing `regenerating_a_too_large_period_splits_into_several_chat_calls`
/// established, factored out because issue #137's partial-chunk tests
/// below need the identical three-chunk shape to make one chunk fail
/// without collapsing back to a single call.
async fn seed_three_chunk_week(pool: &PgPool) -> (chrono::NaiveDate, Uuid, Uuid, Uuid) {
    let week_start = date(2026, 8, 10); // a Monday
    let (from, _) = period::period_bounds(Period::Week, Tz::UTC, week_start);
    let device = Uuid::new_v4();

    let padding = "x".repeat(400 - rendered_len(""));
    let monday_id = Uuid::new_v4();
    let wednesday_id = Uuid::new_v4();
    let friday_id = Uuid::new_v4();
    insert_entry_at(
        pool,
        monday_id,
        device,
        &format!("MONDAY-{padding}"),
        from + chrono::Duration::hours(1),
    )
    .await;
    insert_entry_at(
        pool,
        wednesday_id,
        device,
        &format!("WEDNESDAY-{padding}"),
        from + chrono::Duration::days(2) + chrono::Duration::hours(1),
    )
    .await;
    insert_entry_at(
        pool,
        friday_id,
        device,
        &format!("FRIDAY-{padding}"),
        from + chrono::Duration::days(4) + chrono::Duration::hours(1),
    )
    .await;

    (week_start, monday_id, wednesday_id, friday_id)
}

/// A Period whose three Entries each cost too much of a deliberately
/// small `context_window`'s budget to share a chunk splits into three
/// chat calls, and the regenerate route stores their replies concatenated
/// with `"\n\n"` — the multi-chunk case working end to end through
/// `POST .../regenerate`, not just through `generate_digest_body` on its
/// own. Uses a Week Period specifically so each chunk's own date span
/// (Monday alone, Wednesday alone, Friday alone) is visibly narrower than
/// the whole week's `"2026-08-10 to 2026-08-16 (a week)"` — issue #101's
/// lesson, applied to a chunk boundary rather than a single Entry's
/// render: a call's own wrapper sentence must never claim a span wider
/// than what that one call was actually handed.
///
/// Issue #137: also proves the *complete* multi-chunk case keeps today's
/// true watermark and reports `stale = false` — every chunk here succeeds,
/// so this is the control this section's partial-chunk tests below are
/// measured against.
#[sqlx::test]
async fn regenerating_a_too_large_period_splits_into_several_chat_calls(pool: PgPool) {
    let (week_start, monday_id, wednesday_id, friday_id) = seed_three_chunk_week(&pool).await;

    // `context_window` of 250: `DIGEST_ENTRY_BUDGET_FRACTION` (0.60)
    // gives a 150-token Entry budget, exactly the boundary the padding
    // above was sized against.
    let client = Arc::new(ScriptedChatClient::new(vec![
        "Monday's reply.",
        "Wednesday's reply.",
        "Friday's reply.",
    ]));
    let digest = scripted_digest_state(client.clone(), 250);

    let (status, body) = regenerate(&pool, digest, "week", "2026-08-10").await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body["digest"]["body"],
        "Monday's reply.\n\nWednesday's reply.\n\nFriday's reply.",
        "the three chunk replies must be concatenated with a blank line, with no merge pass"
    );

    let mut returned_ids: Vec<String> = body["digest"]["grounding_entry_ids"]
        .as_array()
        .unwrap()
        .iter()
        .map(|id| id.as_str().unwrap().to_string())
        .collect();
    returned_ids.sort();
    let mut expected_ids: Vec<String> = [monday_id, wednesday_id, friday_id]
        .iter()
        .map(|id| id.to_string())
        .collect();
    expected_ids.sort();
    assert_eq!(
        returned_ids, expected_ids,
        "grounding must cover every Entry in the Period, regardless of which chunk read it"
    );

    // Issue #137: a *complete* multi-chunk Digest keeps today's watermark
    // exactly as before — the true max `seq` over every Entry the Period
    // holds, not the `0` a partial one would record — and so reports
    // `stale = false`.
    assert_eq!(
        body["digest"]["stale"], false,
        "a complete multi-chunk Digest must not be born stale"
    );
    let true_watermark = max_entries_seq(&pool, &[monday_id, wednesday_id, friday_id]).await;
    let stored = digest_revisions(&pool, Period::Week, week_start).await;
    assert_eq!(stored.len(), 1);
    assert_eq!(
        stored[0].source_seq, true_watermark,
        "a complete Digest's watermark is the max seq over every Entry it read, unchanged by issue #137"
    );
    let mut stored_ids: Vec<String> = stored[0]
        .grounding_entry_ids
        .iter()
        .map(|id| id.to_string())
        .collect();
    stored_ids.sort();
    assert_eq!(
        stored_ids, expected_ids,
        "the row actually stored, not just the API response, must ground every Entry in a complete Digest"
    );

    let calls = client.all_calls();
    assert_eq!(calls.len(), 3, "one chat call per chunk");

    // Each call's own user message names only that chunk's single day —
    // never the whole week's "2026-08-10 to 2026-08-16 (a week)" span,
    // and never a day it wasn't given.
    let user_content = |call: &[ChatMessage]| {
        call.iter()
            .find(|m| m.role == "user")
            .expect("every digest call carries a user message")
            .content
            .clone()
    };
    let contents: Vec<String> = calls.iter().map(|c| user_content(c)).collect();

    assert!(contents[0].starts_with("Here is everything the user wrote from 2026-08-10:"));
    assert!(contents[0].contains("MONDAY-"));
    assert!(!contents[0].contains("WEDNESDAY-") && !contents[0].contains("FRIDAY-"));

    assert!(contents[1].starts_with("Here is everything the user wrote from 2026-08-12:"));
    assert!(contents[1].contains("WEDNESDAY-"));
    assert!(!contents[1].contains("MONDAY-") && !contents[1].contains("FRIDAY-"));

    assert!(contents[2].starts_with("Here is everything the user wrote from 2026-08-14:"));
    assert!(contents[2].contains("FRIDAY-"));
    assert!(!contents[2].contains("MONDAY-") && !contents[2].contains("WEDNESDAY-"));

    for content in &contents {
        assert!(
            !content.contains("to 2026-08-16") && !content.contains("(a week)"),
            "a chunk's own message must never claim the whole Period's span: {content}"
        );
    }
}

// ---------------------------------------------------------------------
// Graceful degradation (issue #137): a chunk that fails is skipped, not
// fatal — the surviving chunks still produce a Digest, `grounding_entry_ids`
// discloses exactly which Entries made it in, and `source_seq = 0` marks
// the revision stale on arrival, end to end through `POST .../regenerate`
// and back out through a plain GET. `tests/digest.rs` proves the same
// mechanics on the worker's own tick; this file's job is proving the
// *route* behaves identically, since `run_regenerate` is
// `generate_digest_body`'s only other caller.
// ---------------------------------------------------------------------

/// The acceptance criterion at the heart of this ticket: one bad chunk out
/// of three costs only its own Entry. The Wednesday chunk's chat call
/// fails; Monday's and Friday's both succeed. The route still answers 200
/// with a Digest — never a 500, unlike every "reply rejected" test above,
/// because here *not every* chunk failed — whose body is exactly the two
/// surviving replies joined by `"\n\n"`, whose `grounding_entry_ids` holds
/// Monday and Friday but never Wednesday, and whose `source_seq` is `0`
/// rather than the true watermark those two Entries alone would imply
/// (`generate_digest_body`'s own doc comment: the `0` is deliberate, not
/// merely "whatever's cheapest to compute"). `stale` on the very next read
/// is the proof this disclosure actually reaches a reader: with a `0`
/// watermark, `select_is_stale`'s `seq > source_seq` is true for every
/// Entry in the Period — Monday and Friday included — so this Digest
/// reports itself stale immediately, with nothing having "moved" in the
/// ordinary sense at all.
#[sqlx::test]
async fn a_bad_chunk_of_three_is_skipped_and_the_surviving_two_still_produce_a_digest(
    pool: PgPool,
) {
    let (week_start, monday_id, wednesday_id, friday_id) = seed_three_chunk_week(&pool).await;

    let client = Arc::new(FlakyScriptedChatClient::new(vec![
        Ok("Monday's reply."),
        Err("the Wednesday chat call failed"),
        Ok("Friday's reply."),
    ]));
    let digest = flaky_digest_state(client.clone(), 250);

    let (status, body) = regenerate(&pool, digest, "week", "2026-08-10").await;

    assert_eq!(
        status,
        StatusCode::OK,
        "one bad chunk out of three must still produce a Digest, not a 500"
    );
    assert_eq!(
        body["digest"]["body"],
        "Monday's reply.\n\nFriday's reply.",
        "the stored body must be exactly the two surviving chunks, joined, with no trace of the failed one"
    );

    let mut returned_ids: Vec<String> = body["digest"]["grounding_entry_ids"]
        .as_array()
        .unwrap()
        .iter()
        .map(|id| id.as_str().unwrap().to_string())
        .collect();
    returned_ids.sort();
    let mut expected_ids: Vec<String> = [monday_id, friday_id].iter().map(|id| id.to_string()).collect();
    expected_ids.sort();
    assert_eq!(
        returned_ids, expected_ids,
        "grounding must hold only the surviving chunks' Entries — Wednesday's must be absent, not merely unmentioned"
    );
    assert!(
        !body["digest"]["grounding_entry_ids"]
            .as_array()
            .unwrap()
            .iter()
            .any(|id| id.as_str() == Some(&wednesday_id.to_string())),
        "the skipped chunk's Entry must never appear in grounding"
    );

    assert_eq!(client.calls(), 3, "every chunk must still get its own attempt, regardless of where the bad one fell");

    // `source_seq` is the literal `0`, not the true max over Monday and
    // Friday alone — a partial Digest is stale by construction, on every
    // Entry in the Period, not only the ones its own body happens to cover.
    let stored = digest_revisions(&pool, Period::Week, week_start).await;
    assert_eq!(stored.len(), 1, "a partial Digest is still exactly one written revision");
    assert_eq!(
        stored[0].source_seq, 0,
        "a Digest that skipped any chunk must record source_seq = 0"
    );

    // The whole point of that `0`: a plain read afterwards reports this
    // exact revision as stale, which is what prompts a reader to press
    // Regenerate again — the only way this Period could ever improve.
    let (status, reread) = get_digest_at(&pool, true, "week", "2026-08-10").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        reread["digest"]["stale"], true,
        "a partial Digest must report stale on the very next read — the disclosure mechanism this ticket exists to prove end to end"
    );
    assert_eq!(reread["digest"]["body"], "Monday's reply.\n\nFriday's reply.");
}

/// The other half of issue #137's failure semantics, unchanged from issue
/// #135: when *every* chunk fails, there is nothing to disclose partially
/// — the whole Period gets no Digest at all, and the regenerate route
/// errors exactly as it already does for a single rejected reply. Distinct
/// from the "one bad chunk" test above in the one respect that matters:
/// here `bodies` ends up empty, so `generate_digest_body` still returns
/// `Err`, `run_regenerate`'s `?` still propagates it, and `regenerate_insert`
/// is still never reached.
#[sqlx::test]
async fn every_chunk_failing_on_regenerate_mints_no_revision(pool: PgPool) {
    let (week_start, ..) = seed_three_chunk_week(&pool).await;

    let client = Arc::new(FlakyScriptedChatClient::new(vec![
        Err("Monday failed"),
        Err("Wednesday failed"),
        Err("Friday failed"),
    ]));
    let digest = flaky_digest_state(client.clone(), 250);

    let (status, body) = regenerate(&pool, digest, "week", "2026-08-10").await;

    assert_eq!(
        status,
        StatusCode::INTERNAL_SERVER_ERROR,
        "every chunk failing must surface as an error, not a 200 carrying an empty digest"
    );
    assert_eq!(body, Value::Null);
    assert_eq!(
        client.calls(),
        3,
        "every chunk must still get its own attempt before the Period is given up on"
    );

    let revisions = digest_revisions(&pool, Period::Week, week_start).await;
    assert!(
        revisions.is_empty(),
        "no revision may be minted when every chunk of a Period failed"
    );

    let (status, body) = get_digest_at(&pool, true, "week", "2026-08-10").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["digest"], Value::Null);
}

/// Issue #137's accepted risk, proven rather than merely documented: a
/// partial revision minted by regenerate can shadow a complete one that
/// came before it, because reads always take the newest revision
/// unconditionally (ADR 0039). Seeds a genuinely complete revision 1 (the
/// true watermark, not `0` — this Digest is not stale before anything
/// happens), regenerates with one chunk failing, and checks all three
/// consequences at once: the partial revision 2 is what gets returned and
/// stored, revision 1 is untouched underneath it, and a plain read
/// afterwards surfaces revision 2 as the newest — stale — rather than
/// falling back to the still-good revision 1. Nothing here refuses the
/// downgrade; the stale marker is the only mitigation, exactly as
/// `run_regenerate`'s own doc comment records.
#[sqlx::test]
async fn a_partial_regenerate_shadows_an_existing_complete_revision_and_reads_back_stale(
    pool: PgPool,
) {
    let (week_start, monday_id, wednesday_id, friday_id) = seed_three_chunk_week(&pool).await;
    let true_watermark = max_entries_seq(&pool, &[monday_id, wednesday_id, friday_id]).await;

    insert_digest_with_source_seq(
        &pool,
        Period::Week,
        week_start,
        "A complete, worker-written revision one.",
        &[monday_id, wednesday_id, friday_id],
        true_watermark,
    )
    .await;

    let (_, before) = get_digest_at(&pool, true, "week", "2026-08-10").await;
    assert_eq!(
        before["digest"]["stale"], false,
        "revision one must not be stale before anything regenerates over it"
    );

    let client = Arc::new(FlakyScriptedChatClient::new(vec![
        Ok("Monday's second reply."),
        Err("the Wednesday chat call failed again"),
        Ok("Friday's second reply."),
    ]));
    let digest = flaky_digest_state(client.clone(), 250);

    let (status, body) = regenerate(&pool, digest, "week", "2026-08-10").await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["digest"]["revision"], 2);
    assert_eq!(
        body["digest"]["body"],
        "Monday's second reply.\n\nFriday's second reply."
    );
    assert_eq!(
        body["digest"]["stale"], true,
        "the newly minted partial revision must be born stale"
    );

    let revisions = digest_revisions(&pool, Period::Week, week_start).await;
    assert_eq!(
        revisions.len(),
        2,
        "regenerating must insert a new revision, never overwrite the complete one underneath it"
    );
    assert_eq!(revisions[0].revision, 1);
    assert_eq!(revisions[0].body, "A complete, worker-written revision one.");
    assert_eq!(revisions[0].source_seq, true_watermark, "revision one's own watermark is untouched");
    assert_eq!(revisions[1].revision, 2);
    assert_eq!(revisions[1].source_seq, 0);

    // The accepted risk itself: a plain read afterwards returns the newest
    // revision unconditionally — the partial, stale revision 2 — not the
    // complete revision 1 still sitting underneath it. There is no
    // "refuse to downgrade" guard anywhere in this path.
    let (status, reread) = get_digest_at(&pool, true, "week", "2026-08-10").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(reread["digest"]["revision"], 2);
    assert_eq!(
        reread["digest"]["body"],
        "Monday's second reply.\n\nFriday's second reply."
    );
    assert_eq!(
        reread["digest"]["stale"], true,
        "the shadowed complete revision's own good watermark is irrelevant once a newer, partial revision exists"
    );
}
