//! Issue #70: `GET /v1/digests/{period}` and `GET /v1/digests/{period}/{date}`
//! — the read side of the Digest worker `tests/digest.rs` exercises. This
//! file never runs the worker itself; every Digest here is seeded directly
//! with `insert_digest`, the same "assert against the real Router, seed the
//! database directly" shape `tests/sessions.rs` uses for its own handlers.

use std::path::PathBuf;
use std::sync::Arc;

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
/// single GET happens to surface.
#[derive(sqlx::FromRow, Debug, Clone)]
struct DigestRow {
    revision: i32,
    body: String,
}

async fn digest_revisions(pool: &PgPool, period: Period, period_start: chrono::NaiveDate) -> Vec<DigestRow> {
    sqlx::query_as::<_, DigestRow>(
        "select revision, body from digests where period = $1 and period_start = $2 order by revision asc",
    )
    .bind(period.as_str())
    .bind(period_start)
    .fetch_all(pool)
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
