//! Issue #70: `GET /v1/digests/{period}` and `GET /v1/digests/{period}/{date}`
//! — the read side of the Digest worker `tests/digest.rs` exercises. This
//! file never runs the worker itself; every Digest here is seeded directly
//! with `insert_digest`, the same "assert against the real Router, seed the
//! database directly" shape `tests/sessions.rs` uses for its own handlers.

use std::path::PathBuf;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
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

async fn request(uri: String, digests_enabled: bool, pool: &PgPool) -> (StatusCode, Value) {
    let app = meologue_server::router_with_digests(
        pool.clone(),
        empty_static_dir(),
        None,
        None,
        digests_enabled,
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
