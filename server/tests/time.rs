//! `/v1/time/sources` and `/v1/time/intervals` (issue #419) — the Toggl
//! Activity Recording adapter, its Postgres persistence and the two shapes
//! the same Activity interval is served in.
//!
//! `src/time.rs`'s own unit tests cover the two pure conversions
//! (`apple_timestamp`, `base64`) against values whose answers can be stated
//! in a line. Everything below needs the parts those can't reach: a real
//! SQLite file on disk, the real HTTP routes, and the real `activity_intervals`
//! table with its `(source_id, provider_record_id)` uniqueness boundary.
//!
//! The fixtures here are not invented. `ZMANAGEDACTIVITY`'s column list,
//! every column's declared type, and the fact that `ZID` is a **BLOB** while
//! Clockify's equivalent is TEXT were all read off this machine's own Toggl
//! Track install before these tests were written. That matters for
//! `read_toggl`, which asks rusqlite for `ZID` as a `Vec<u8>`: a fixture
//! that stored the identity as text would pass while the real database it
//! is modelled on silently imported nothing.
//!
//! Two conventions are load-bearing here and easy to lose:
//!
//! - **Nothing sleeps for a fixed interval and then asserts.** The import is
//!   `tokio::spawn`ed by the create handler and returns before it finishes,
//!   so every test that reads imported rows waits for a *positive* count to
//!   settle first (`wait_for_intervals`). A fixed sleep either flakes under
//!   load or, worse, samples a half-finished import and reports the partial
//!   count as the answer.
//! - **No test proves something is absent without first proving the observer
//!   works.** The still-open-record and raw-row-omission tests both wait for
//!   a row they *expect* to arrive before asserting on the one that must not.

use std::path::{Path, PathBuf};
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use chrono::TimeZone as _;
use http_body_util::BodyExt;
use meologue_server::settings::InstanceMode;
use rusqlite::Connection;
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

// None of these routes serve a static asset, so any existing directory works
// as the otherwise-unused static_dir — the same convention tests/settings.rs
// and tests/models.rs already use.
fn empty_static_dir() -> PathBuf {
    std::env::current_dir().unwrap()
}

fn app(pool: &PgPool, locked: bool) -> Router {
    meologue_server::router_with_settings(
        pool.clone(),
        empty_static_dir(),
        None,
        None,
        None,
        locked,
        InstanceMode::Production,
    )
}

async fn send(app: Router, request: Request<Body>) -> (StatusCode, Vec<u8>) {
    let response = app.oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, bytes.to_vec())
}

async fn create_source(pool: &PgPool, name: &str, kind: &str, path: &str) -> (StatusCode, Vec<u8>) {
    let body = json!({ "name": name, "kind": kind, "path": path });
    send(
        app(pool, false),
        Request::builder()
            .method("POST")
            .uri("/v1/time/sources")
            .header("Content-Type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap(),
    )
    .await
}

/// Creates a source that is expected to succeed and hands back its id.
async fn create_toggl_source(pool: &PgPool, name: &str, path: &Path) -> Uuid {
    let (status, bytes) =
        create_source(pool, name, "toggl_activity", &path.to_string_lossy()).await;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "creating {name} failed: {}",
        String::from_utf8_lossy(&bytes)
    );
    let value: Value = serde_json::from_slice(&bytes).unwrap();
    Uuid::parse_str(value["id"].as_str().unwrap()).unwrap()
}

async fn list_intervals(pool: &PgPool, day: &str, source: Option<Uuid>) -> (StatusCode, Value) {
    let uri = match source {
        Some(id) => format!("/v1/time/intervals?day={day}&source_ids={id}"),
        None => format!("/v1/time/intervals?day={day}"),
    };
    let (status, bytes) = send(
        app(pool, false),
        Request::builder()
            .method("GET")
            .uri(uri)
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    let json = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap()
    };
    (status, json)
}

/// The daily query with every filter it accepts, for the cases that exercise
/// more than one source or a search term.
async fn query_intervals(pool: &PgPool, query: &str) -> (StatusCode, Value) {
    let (status, bytes) = send(
        app(pool, false),
        Request::builder()
            .method("GET")
            .uri(format!("/v1/time/intervals?{query}"))
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    let json = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap()
    };
    (status, json)
}

async fn interval_detail(pool: &PgPool, id: &str) -> (StatusCode, Value) {
    let (status, bytes) = send(
        app(pool, false),
        Request::builder()
            .method("GET")
            .uri(format!("/v1/time/intervals/{id}"))
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    let json = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap()
    };
    (status, json)
}

/// Waits for the spawned import to have inserted at least `expected` rows for
/// `source`, then for the count to stop moving, and returns the settled count.
///
/// Both halves matter. Waiting only for `>= expected` catches an import
/// mid-flight and lets a test that meant "exactly 3" pass against a run that
/// was on its way to 4; waiting only for stability returns 0 for an import
/// that has not started yet.
async fn wait_for_intervals(pool: &PgPool, source: Uuid, expected: i64) -> i64 {
    let count = |pool: PgPool| async move {
        sqlx::query_scalar::<_, i64>("select count(*) from activity_intervals where source_id = $1")
            .bind(source)
            .fetch_one(&pool)
            .await
            .unwrap()
    };

    let mut settled = 0;
    for _ in 0..400 {
        let now = count(pool.clone()).await;
        if now >= expected {
            if now == settled {
                return now;
            }
            settled = now;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("import never reached {expected} rows for {source} (last saw {settled})");
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/// Core Data's epoch, 2001-01-01T00:00:00Z, as a Unix timestamp. Duplicated
/// from `src/time.rs`'s private `APPLE_EPOCH` on purpose: a test that imported
/// the constant it is checking would agree with the implementation even if
/// both were wrong.
const APPLE_EPOCH: f64 = 978_307_200.0;

/// One `ZMANAGEDACTIVITY` row. `end: None` is Toggl's still-recording state.
struct Activity<'a> {
    id: &'a [u8],
    start: f64,
    end: Option<f64>,
    filename: &'a str,
    title: Option<&'a str>,
    idle: i64,
    client: &'a [u8],
}

fn scratch_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("meologue-time-{tag}-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Writes a Toggl Track Activity Recording database whose schema matches the
/// real one column for column, including the declared types (`TIMESTAMP` for
/// the Core Data reals, `BLOB` for `ZID`) and the unique index on `ZID`.
fn write_toggl_db(path: &Path, rows: &[Activity<'_>]) {
    write_toggl_db_with(path, rows, false);
}

/// `unique_ids = false` drops the real database's unique index on `ZID`, which
/// is the only way to hand the importer two records carrying the same provider
/// identity inside a single run — see the idempotency test.
fn write_toggl_db_with(path: &Path, rows: &[Activity<'_>], unique_ids: bool) {
    let connection = Connection::open(path).unwrap();
    connection
        .execute_batch(
            "create table ZMANAGEDACTIVITY (
               Z_PK integer primary key, Z_ENT integer, Z_OPT integer,
               ZISIDLE integer, ZSYNCSTATUS integer,
               ZEND timestamp, ZSTART timestamp,
               ZFILENAME varchar, ZTITLE varchar,
               ZCLIENT blob, ZID blob)",
        )
        .unwrap();
    if unique_ids {
        connection
            .execute_batch("create unique index z_activity_id on ZMANAGEDACTIVITY (ZID)")
            .unwrap();
    }
    insert_rows(&connection, rows);
    connection.close().unwrap();
}

fn insert_rows(connection: &Connection, rows: &[Activity<'_>]) {
    for (index, row) in rows.iter().enumerate() {
        connection
            .execute(
                "insert into ZMANAGEDACTIVITY
                   (Z_ENT, Z_OPT, ZISIDLE, ZSYNCSTATUS, ZEND, ZSTART, ZFILENAME, ZTITLE, ZCLIENT, ZID)
                 values (1, ?1, ?2, 1, ?3, ?4, ?5, ?6, ?7, ?8)",
                rusqlite::params![
                    index as i64 + 1,
                    row.idle,
                    row.end,
                    row.start,
                    row.filename,
                    row.title,
                    row.client,
                    row.id,
                ],
            )
            .unwrap();
    }
}

/// 2026-03-15T09:30:00.250Z and 2026-03-15T11:45:30.500Z as Core Data seconds.
/// The fractional parts are the point: `apple_timestamp` splits the value into
/// whole seconds and nanoseconds, and a `.25`/`.5` that survived the round trip
/// is what distinguishes a real conversion from a truncating one.
const MORNING_START: f64 = 795_259_800.25;
const MORNING_END: f64 = 795_267_930.5;
const AFTERNOON_START: f64 = 795_276_000.0; // 2026-03-15T14:00:00Z
const AFTERNOON_END: f64 = 795_276_300.0; // 2026-03-15T14:05:00Z
const MIDNIGHT_START: f64 = 795_310_800.0; // 2026-03-15T23:40:00Z
const MIDNIGHT_END: f64 = 795_313_200.0; // 2026-03-16T00:20:00Z
const OTHER_DAY_START: f64 = 795_427_200.0; // 2026-03-17T08:00:00Z
const OTHER_DAY_END: f64 = 795_428_100.0; // 2026-03-17T08:15:00Z

const DAY: &str = "2026-03-15";

fn labels(intervals: &Value) -> Vec<String> {
    intervals
        .as_array()
        .unwrap()
        .iter()
        .map(|interval| interval["label"].as_str().unwrap().to_owned())
        .collect()
}

// ---------------------------------------------------------------------------
// Validation — nothing is stored until the file has been proved readable
// ---------------------------------------------------------------------------

#[sqlx::test]
async fn rejects_a_sqlite_file_that_is_not_an_activity_recording_database(pool: PgPool) {
    let dir = scratch_dir("not-toggl");
    let path = dir.join("other.sqlite");
    let connection = Connection::open(&path).unwrap();
    connection
        .execute_batch("create table something_else (a integer)")
        .unwrap();
    connection.close().unwrap();

    let (status, body) = create_source(
        &pool,
        "Wrong shape",
        "toggl_activity",
        &path.to_string_lossy(),
    )
    .await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        String::from_utf8_lossy(&body).contains("not a Toggl Activity Recording database"),
        "unhelpful rejection: {}",
        String::from_utf8_lossy(&body)
    );
    assert_eq!(sources_in_table(&pool).await, 0);
}

#[sqlx::test]
async fn rejects_the_right_table_carrying_the_wrong_columns(pool: PgPool) {
    // The failure a table-name check alone cannot see: a database that really
    // does have `ZMANAGEDACTIVITY` but not the columns the importer reads out
    // of it — a different Toggl schema version, or another application that
    // happens to use the name. Saving it would produce a configured source
    // that imports nothing while looking perfectly healthy in Settings.
    //
    // This case is why `validate_source` names every mapped column rather than
    // probing the table: with the probe reduced to `select 1 from <table>`,
    // this test is the only one in the file that goes red.
    let dir = scratch_dir("right-table-wrong-columns");
    let path = dir.join("old-schema.sqlite");
    let connection = Connection::open(&path).unwrap();
    connection
        .execute_batch(
            "create table ZMANAGEDACTIVITY (
               Z_PK integer primary key, ZID blob, ZSTART timestamp, ZEND timestamp)",
        )
        .unwrap();
    connection.close().unwrap();

    let (status, body) = create_source(
        &pool,
        "Old Toggl",
        "toggl_activity",
        &path.to_string_lossy(),
    )
    .await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        String::from_utf8_lossy(&body).contains("Toggl Activity Recording"),
        "unhelpful rejection: {}",
        String::from_utf8_lossy(&body)
    );
    assert_eq!(sources_in_table(&pool).await, 0);
}

#[sqlx::test]
async fn rejects_a_path_that_does_not_exist(pool: PgPool) {
    let (status, body) = create_source(
        &pool,
        "Missing",
        "toggl_activity",
        "/nonexistent/meologue/activity.sqlite",
    )
    .await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        String::from_utf8_lossy(&body).contains("unreadable"),
        "unhelpful rejection: {}",
        String::from_utf8_lossy(&body)
    );
    assert_eq!(sources_in_table(&pool).await, 0);
}

#[sqlx::test]
async fn rejects_a_blank_name_and_an_unsupported_adapter_kind(pool: PgPool) {
    let dir = scratch_dir("reject-shape");
    let path = dir.join("db.sqlite");
    write_toggl_db(&path, &[]);
    let path = path.to_string_lossy().into_owned();

    // A name of nothing but whitespace is blank — the source list would render
    // an unidentifiable row, which is the whole reason the handler trims first.
    let (blank, _) = create_source(&pool, "   ", "toggl_activity", &path).await;
    assert_eq!(blank, StatusCode::BAD_REQUEST);

    // A kind no adapter answers to. Since #420 there are two real kinds, so
    // this names one that is not either rather than one not yet built —
    // otherwise the case would quietly become "a Clockify database was offered
    // as Toggl", which `rejects_each_provider_database_offered_as_the_other`
    // covers separately.
    let (wrong_kind, _) = create_source(&pool, "RescueTime", "rescuetime", &path).await;
    assert_eq!(wrong_kind, StatusCode::BAD_REQUEST);

    assert_eq!(sources_in_table(&pool).await, 0);
}

#[sqlx::test]
async fn refuses_to_add_a_source_while_server_configuration_is_locked(pool: PgPool) {
    let dir = scratch_dir("locked");
    let path = dir.join("db.sqlite");
    write_toggl_db(&path, &[]);

    let body = json!({ "name": "Toggl", "kind": "toggl_activity", "path": path.to_string_lossy() });
    let (status, _) = send(
        app(&pool, true),
        Request::builder()
            .method("POST")
            .uri("/v1/time/sources")
            .header("Content-Type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap(),
    )
    .await;

    assert_eq!(status, StatusCode::LOCKED);
    assert_eq!(sources_in_table(&pool).await, 0);
}

#[sqlx::test]
async fn stores_an_absolute_canonical_path_rather_than_what_was_typed(pool: PgPool) {
    let dir = scratch_dir("canonical");
    let nested = dir.join("nested");
    std::fs::create_dir_all(&nested).unwrap();
    let real = nested.join("db.sqlite");
    write_toggl_db(&real, &[]);

    // The same file, named the long way round. Two Settings entries typed like
    // this would otherwise both be stored and both be imported.
    let detour = nested.join("..").join("nested").join("db.sqlite");
    assert!(detour.to_string_lossy().contains(".."));

    let id = create_toggl_source(&pool, "Detour", &detour).await;

    let stored: String = sqlx::query_scalar("select path from time_sources where id = $1")
        .bind(id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        Path::new(&stored),
        std::fs::canonicalize(&real).unwrap().as_path()
    );
    assert!(Path::new(&stored).is_absolute());
    assert!(!stored.contains(".."));
}

async fn sources_in_table(pool: &PgPool) -> i64 {
    sqlx::query_scalar("select count(*) from time_sources")
        .fetch_one(pool)
        .await
        .unwrap()
}

// ---------------------------------------------------------------------------
// The adapter — what a Toggl row becomes
// ---------------------------------------------------------------------------

#[sqlx::test]
async fn maps_every_toggl_field_onto_the_provider_neutral_interval(pool: PgPool) {
    let dir = scratch_dir("mapping");
    let path = dir.join("db.sqlite");
    write_toggl_db(
        &path,
        &[
            Activity {
                id: &[0xaa, 0xbb, 0x0c, 0xff],
                start: MORNING_START,
                end: Some(MORNING_END),
                filename: "Xcode",
                title: Some("time.rs — meologue"),
                idle: 0,
                client: &[0x01],
            },
            // A record with no window title at all. Toggl leaves ZTITLE NULL
            // for applications that expose none, and the whole row must still
            // import rather than being dropped for want of a detail.
            Activity {
                id: &[0x01, 0x02],
                start: AFTERNOON_START,
                end: Some(AFTERNOON_END),
                filename: "Music",
                title: None,
                idle: 1,
                client: &[0x02],
            },
        ],
    );

    let source = create_toggl_source(&pool, "Toggl", &path).await;
    wait_for_intervals(&pool, source, 2).await;

    let (status, intervals) = list_intervals(&pool, DAY, Some(source)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(labels(&intervals), vec!["Xcode", "Music"]);

    let morning = &intervals[0];
    // ZID is a BLOB in the real database; the provider identity is its hex.
    assert_eq!(morning["provider_record_id"], "aabb0cff");
    assert_eq!(morning["label"], "Xcode");
    assert_eq!(morning["detail"], "time.rs — meologue");
    assert_eq!(morning["source_id"], source.to_string());

    let afternoon = &intervals[1];
    assert_eq!(afternoon["provider_record_id"], "0102");
    assert_eq!(afternoon["label"], "Music");
    assert_eq!(
        afternoon["detail"],
        Value::Null,
        "a NULL ZTITLE must import as no detail, not as an empty string"
    );
}

#[sqlx::test]
async fn converts_core_data_seconds_into_sub_second_utc_instants(pool: PgPool) {
    let dir = scratch_dir("timestamps");
    let path = dir.join("db.sqlite");
    write_toggl_db(
        &path,
        &[Activity {
            id: &[0x10],
            start: MORNING_START,
            end: Some(MORNING_END),
            filename: "Xcode",
            title: None,
            idle: 0,
            client: &[],
        }],
    );

    let source = create_toggl_source(&pool, "Toggl", &path).await;
    wait_for_intervals(&pool, source, 1).await;

    let (_, intervals) = list_intervals(&pool, DAY, Some(source)).await;
    let interval = &intervals[0];

    // Core Data counts from 2001-01-01, not 1970 — an importer that forgot the
    // 978307200-second offset would land these in 1996 and still look plausible.
    assert_eq!(interval["started_at"], "2026-03-15T09:30:00.250Z");
    assert_eq!(interval["ended_at"], "2026-03-15T11:45:30.500Z");

    // The same claim stated independently of serde's formatting, so a change
    // in how chrono renders the instant can't quietly rewrite what is asserted.
    let (start, end): (chrono::DateTime<chrono::Utc>, chrono::DateTime<chrono::Utc>) =
        sqlx::query_as("select started_at, ended_at from activity_intervals where source_id = $1")
            .bind(source)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        start.timestamp_millis(),
        ((MORNING_START + APPLE_EPOCH) * 1000.0) as i64
    );
    assert_eq!(
        end.timestamp_millis(),
        ((MORNING_END + APPLE_EPOCH) * 1000.0) as i64
    );
}

#[sqlx::test]
async fn leaves_a_still_recording_row_out_until_it_closes(pool: PgPool) {
    let dir = scratch_dir("open-row");
    let path = dir.join("db.sqlite");
    write_toggl_db(
        &path,
        &[
            Activity {
                id: &[0x20],
                start: MORNING_START,
                end: Some(MORNING_END),
                filename: "Closed",
                title: None,
                idle: 0,
                client: &[],
            },
            // Toggl writes the row when recording begins and fills ZEND when it
            // ends. An importer that treated a missing end as "now" would mint
            // an interval that changes length every time it is read.
            Activity {
                id: &[0x21],
                start: AFTERNOON_START,
                end: None,
                filename: "Still recording",
                title: None,
                idle: 0,
                client: &[],
            },
        ],
    );

    let source = create_toggl_source(&pool, "Toggl", &path).await;
    // Waiting for the closed row first is what makes the absence below mean
    // something: the importer demonstrably ran and demonstrably skipped one.
    let settled = wait_for_intervals(&pool, source, 1).await;

    assert_eq!(settled, 1);
    let (_, intervals) = list_intervals(&pool, DAY, Some(source)).await;
    assert_eq!(labels(&intervals), vec!["Closed"]);
}

// ---------------------------------------------------------------------------
// Evidence — the raw provider row, and where it is and is not served
// ---------------------------------------------------------------------------

#[sqlx::test]
async fn keeps_every_source_column_with_its_sqlite_type_on_the_single_interval_route(pool: PgPool) {
    let dir = scratch_dir("raw-row");
    let path = dir.join("db.sqlite");
    write_toggl_db(
        &path,
        &[Activity {
            id: &[0x00, 0xff, 0x01],
            start: MORNING_START,
            end: Some(MORNING_END),
            filename: "Xcode",
            title: Some("detail"),
            idle: 1,
            client: &[0xde, 0xad, 0xbe, 0xef],
        }],
    );

    let source = create_toggl_source(&pool, "Toggl", &path).await;
    wait_for_intervals(&pool, source, 1).await;
    let (_, intervals) = list_intervals(&pool, DAY, Some(source)).await;
    let id = intervals[0]["id"].as_str().unwrap();

    let (status, detail) = interval_detail(&pool, id).await;
    assert_eq!(status, StatusCode::OK);
    let raw = &detail["raw_row"];

    // Every column the table has, not merely the ones the adapter reads. The
    // point of keeping the raw row is the fields nobody has found a use for
    // yet — ZSYNCSTATUS and Z_ENT are exactly those.
    let mut columns: Vec<&str> = raw
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    columns.sort_unstable();
    assert_eq!(
        columns,
        // Sorted the way Rust sorts `&str`, which is by byte: `_` (0x5F)
        // lands after the uppercase letters, so the Z_ columns come last.
        vec![
            "ZCLIENT",
            "ZEND",
            "ZFILENAME",
            "ZID",
            "ZISIDLE",
            "ZSTART",
            "ZSYNCSTATUS",
            "ZTITLE",
            "Z_ENT",
            "Z_OPT",
            "Z_PK",
        ]
    );

    // Each value carries its SQLite storage class, so a consumer can tell an
    // integer 0 from a real 0.0 from a text "0" without guessing.
    assert_eq!(
        raw["ZSTART"],
        json!({ "type": "real", "value": MORNING_START })
    );
    assert_eq!(raw["ZISIDLE"], json!({ "type": "integer", "value": 1 }));
    assert_eq!(
        raw["ZFILENAME"],
        json!({ "type": "text", "value": "Xcode" })
    );

    // BLOBs survive as base64 rather than being lost to a lossy string
    // conversion. 0xdeadbeef is "3q2+7w==" — stated here rather than computed,
    // so the test disagrees with a broken encoder instead of matching it.
    assert_eq!(
        raw["ZCLIENT"],
        json!({ "type": "blob", "base64": "3q2+7w==" })
    );
    assert_eq!(raw["ZID"], json!({ "type": "blob", "base64": "AP8B" }));

    // The normalized fields are served alongside the raw row, not instead of it.
    assert_eq!(detail["label"], "Xcode");
    assert_eq!(detail["provider_record_id"], "00ff01");
}

#[sqlx::test]
async fn never_puts_raw_provider_rows_on_the_daily_timeline(pool: PgPool) {
    let dir = scratch_dir("no-raw");
    let path = dir.join("db.sqlite");
    write_toggl_db(
        &path,
        &[Activity {
            id: &[0x30],
            start: MORNING_START,
            end: Some(MORNING_END),
            filename: "Xcode",
            title: Some("detail"),
            idle: 0,
            // A deliberately fat BLOB: the reason the daily response must not
            // carry raw rows is that a dense day would otherwise drag every
            // provider's binary payload down with it.
            client: &[0x5a; 4096],
        }],
    );

    let source = create_toggl_source(&pool, "Toggl", &path).await;
    wait_for_intervals(&pool, source, 1).await;

    let (_, intervals) = list_intervals(&pool, DAY, Some(source)).await;
    let interval = intervals[0].as_object().unwrap();

    // The observer is proved to work by the positive assertion first.
    assert_eq!(interval["label"], "Xcode");
    assert!(
        !interval.contains_key("raw_row"),
        "daily timeline leaked a raw provider row: {:?}",
        interval.keys().collect::<Vec<_>>()
    );

    // And the evidence really is retained — absent from the list is not the
    // same as never stored.
    let (_, detail) = interval_detail(&pool, interval["id"].as_str().unwrap()).await;
    assert_eq!(detail["raw_row"]["ZCLIENT"]["type"], "blob");
}

#[sqlx::test]
async fn answers_404_for_an_interval_that_does_not_exist(pool: PgPool) {
    let (status, _) = interval_detail(&pool, &Uuid::new_v4().to_string()).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

#[sqlx::test]
async fn importing_one_provider_identity_twice_never_duplicates_or_rewrites_it(pool: PgPool) {
    let dir = scratch_dir("idempotent");
    let path = dir.join("db.sqlite");
    // Two rows carrying the SAME ZID, with different labels and different
    // times. The real database's unique index on ZID is dropped here precisely
    // so a single import run has to walk the `on conflict do nothing` path —
    // without it there is no way to exercise re-import until #421 adds a
    // refresh trigger, and a SQL-level assertion would only be testing
    // Postgres rather than the importer.
    write_toggl_db_with(
        &path,
        &[
            Activity {
                id: &[0x40, 0x41],
                start: MORNING_START,
                end: Some(MORNING_END),
                filename: "First write wins",
                title: Some("original"),
                idle: 0,
                client: &[],
            },
            Activity {
                id: &[0x40, 0x41],
                start: AFTERNOON_START,
                end: Some(AFTERNOON_END),
                filename: "Second write must not land",
                title: Some("rewritten"),
                idle: 0,
                client: &[],
            },
        ],
        false,
    );

    let source = create_toggl_source(&pool, "Toggl", &path).await;
    let settled = wait_for_intervals(&pool, source, 1).await;

    assert_eq!(settled, 1, "the same provider identity was imported twice");

    // Measured, not assumed: removing `on conflict ... do nothing` from the
    // importer leaves this test green, because `activity_intervals`' own
    // `unique (source_id, provider_record_id)` then rejects the second insert
    // and the loop's `let _ =` swallows the error. Two guards agree on the
    // outcome. The assertion below is the one that distinguishes them —
    // swapping `do nothing` for `do update` turns it red.

    let (_, intervals) = list_intervals(&pool, DAY, Some(source)).await;
    assert_eq!(labels(&intervals), vec!["First write wins"]);
    assert_eq!(
        intervals[0]["detail"], "original",
        "a re-imported record rewrote evidence that was already stored"
    );
}

#[sqlx::test]
async fn two_sources_reading_the_same_records_keep_their_own_copies(pool: PgPool) {
    // The uniqueness boundary is (source_id, provider_record_id), not
    // provider_record_id alone: two recorders observing the same period are
    // two pieces of evidence, and neither may swallow the other.
    let dir = scratch_dir("two-sources");
    let rows = [Activity {
        id: &[0x50],
        start: MORNING_START,
        end: Some(MORNING_END),
        filename: "Xcode",
        title: None,
        idle: 0,
        client: &[],
    }];
    let first = dir.join("one.sqlite");
    let second = dir.join("two.sqlite");
    write_toggl_db(&first, &rows);
    write_toggl_db(&second, &rows);

    let a = create_toggl_source(&pool, "Laptop", &first).await;
    let b = create_toggl_source(&pool, "Desktop", &second).await;
    wait_for_intervals(&pool, a, 1).await;
    wait_for_intervals(&pool, b, 1).await;

    let (_, all) = list_intervals(&pool, DAY, None).await;
    assert_eq!(all.as_array().unwrap().len(), 2);

    let (_, only_a) = list_intervals(&pool, DAY, Some(a)).await;
    assert_eq!(only_a.as_array().unwrap().len(), 1);
    assert_eq!(only_a[0]["source_id"], a.to_string());
}

// ---------------------------------------------------------------------------
// The daily query
// ---------------------------------------------------------------------------

/// Core Data seconds for a wall-clock time **in the Server's own timezone**.
///
/// Boundary fixtures have to be built this way rather than from fixed UTC
/// instants. `#[sqlx::test]` loads `server/.env`, so these tests run under
/// whatever `MEOLOGUE_TZ` a given machine has configured — Asia/Kolkata on
/// the one this was written on — and a fixture pinned to UTC would pass or
/// fail depending on whose checkout it ran in. Expressing the fixture in the
/// same terms as the question ("does a record spanning local midnight show up
/// on both local days") makes the test mean the same thing everywhere.
fn core_data_local(year: i32, month: u32, day: u32, hour: u32, minute: u32) -> f64 {
    let tz = meologue_server::period::server_timezone();
    let naive = chrono::NaiveDate::from_ymd_opt(year, month, day)
        .unwrap()
        .and_hms_opt(hour, minute, 0)
        .unwrap();
    let instant = tz
        .from_local_datetime(&naive)
        .earliest()
        .expect("the fixture times chosen here exist in every zone");
    instant.timestamp() as f64 - APPLE_EPOCH
}

#[sqlx::test]
async fn a_record_spanning_midnight_belongs_to_both_days_it_covers(pool: PgPool) {
    let dir = scratch_dir("midnight");
    let path = dir.join("db.sqlite");
    write_toggl_db(
        &path,
        &[
            Activity {
                id: &[0x60],
                start: core_data_local(2026, 3, 15, 23, 40),
                end: Some(core_data_local(2026, 3, 16, 0, 20)),
                filename: "Across midnight",
                title: None,
                idle: 0,
                client: &[],
            },
            Activity {
                id: &[0x61],
                start: core_data_local(2026, 3, 17, 8, 0),
                end: Some(core_data_local(2026, 3, 17, 8, 15)),
                filename: "Two days later",
                title: None,
                idle: 0,
                client: &[],
            },
        ],
    );

    let source = create_toggl_source(&pool, "Toggl", &path).await;
    wait_for_intervals(&pool, source, 2).await;

    // A record is on a day when it overlaps it, not when it started on it —
    // truncating a night's work out of the morning it ran into would be a
    // silent hole in the evidence.
    let (_, fifteenth) = list_intervals(&pool, "2026-03-15", Some(source)).await;
    assert_eq!(labels(&fifteenth), vec!["Across midnight"]);

    let (_, sixteenth) = list_intervals(&pool, "2026-03-16", Some(source)).await;
    assert_eq!(labels(&sixteenth), vec!["Across midnight"]);

    let (_, seventeenth) = list_intervals(&pool, "2026-03-17", Some(source)).await;
    assert_eq!(labels(&seventeenth), vec!["Two days later"]);

    // A day the source recorded nothing on is empty rather than an error.
    let (status, empty) = list_intervals(&pool, "2026-03-18", Some(source)).await;
    assert_eq!(status, StatusCode::OK);
    assert!(empty.as_array().unwrap().is_empty());
}

#[sqlx::test]
async fn rejects_a_day_that_is_not_a_calendar_date(pool: PgPool) {
    let (status, _) = list_intervals(&pool, "not-a-day", None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

// ---------------------------------------------------------------------------
// Reading a live database
// ---------------------------------------------------------------------------

#[sqlx::test]
async fn reads_committed_wal_data_and_leaves_the_source_files_alone(pool: PgPool) {
    // Toggl Track runs in WAL mode and is normally still running when the
    // Server reads its database. Records committed since the last checkpoint
    // live only in the `-wal` file: an importer that opened the main database
    // alone would import a stale prefix and look entirely healthy doing it,
    // which is why this test checkpoints one row away and leaves the other
    // behind rather than trusting a plain read to have seen both.
    let dir = scratch_dir("wal");
    let path = dir.join("db.sqlite");

    let connection = Connection::open(&path).unwrap();
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .unwrap();
    connection
        .pragma_update(None, "wal_autocheckpoint", 0)
        .unwrap();
    connection
        .execute_batch(
            "create table ZMANAGEDACTIVITY (
               Z_PK integer primary key, Z_ENT integer, Z_OPT integer,
               ZISIDLE integer, ZSYNCSTATUS integer,
               ZEND timestamp, ZSTART timestamp,
               ZFILENAME varchar, ZTITLE varchar,
               ZCLIENT blob, ZID blob)",
        )
        .unwrap();
    insert_rows(
        &connection,
        &[Activity {
            id: &[0x70],
            start: MORNING_START,
            end: Some(MORNING_END),
            filename: "Checkpointed into the main file",
            title: None,
            idle: 0,
            client: &[],
        }],
    );
    connection
        .execute_batch("pragma wal_checkpoint(TRUNCATE)")
        .unwrap();
    insert_rows(
        &connection,
        &[Activity {
            id: &[0x71],
            start: AFTERNOON_START,
            end: Some(AFTERNOON_END),
            filename: "Committed, still only in the WAL",
            title: None,
            idle: 0,
            client: &[],
        }],
    );

    let wal = dir.join("db.sqlite-wal");
    assert!(
        std::fs::metadata(&wal).map(|meta| meta.len()).unwrap_or(0) > 0,
        "fixture is not exercising the WAL — the second row was checkpointed away"
    );

    // Closing would checkpoint the second row into the main file and destroy
    // the very condition under test, so the handle is deliberately leaked for
    // the rest of this test — exactly the state Toggl leaves its file in while
    // it is running.
    std::mem::forget(connection);

    let before = std::fs::read(&path).unwrap();
    let wal_before = std::fs::read(&wal).unwrap();

    let source = create_toggl_source(&pool, "Toggl", &path).await;
    let settled = wait_for_intervals(&pool, source, 2).await;
    assert_eq!(settled, 2);

    let (_, intervals) = list_intervals(&pool, DAY, Some(source)).await;
    assert_eq!(
        labels(&intervals),
        vec![
            "Checkpointed into the main file",
            "Committed, still only in the WAL"
        ]
    );

    // Read-only means read-only: the Server must not checkpoint, vacuum or
    // otherwise rewrite a file another application owns. (`-shm` is SQLite's
    // shared-memory index, not database content, and is expected to change.)
    assert_eq!(
        std::fs::read(&path).unwrap(),
        before,
        "the Server mutated the source database"
    );
    assert_eq!(
        std::fs::read(&wal).unwrap(),
        wal_before,
        "the Server checkpointed or truncated the source WAL"
    );
}

// ---------------------------------------------------------------------------
// Clockify Desktop's Auto Tracker (issue #420)
// ---------------------------------------------------------------------------

/// One `ZCDAUTOTRACKERITEM` row.
///
/// `idle_seconds` is Clockify's own shape and deliberately not a flag: it
/// counts idle seconds *inside* the record, where Toggl's `ZISIDLE` marks the
/// record itself. The neutral `idle` boolean has to come out right from both.
struct AutoTrackerItem<'a> {
    id: &'a str,
    started: TimestampValue,
    ended: Option<TimestampValue>,
    name: &'a str,
    description: Option<&'a str>,
    idle_seconds: f64,
    icon: &'a [u8],
}

/// Core Data keeps these columns as REAL in Toggl's database and as INTEGER in
/// Clockify's — measured on both installs. The importer reads them as `f64`
/// either way, so the fixtures have to be able to write either.
enum TimestampValue {
    Real(f64),
    Integer(i64),
}

impl rusqlite::ToSql for TimestampValue {
    fn to_sql(&self) -> rusqlite::Result<rusqlite::types::ToSqlOutput<'_>> {
        match self {
            Self::Real(value) => value.to_sql(),
            Self::Integer(value) => value.to_sql(),
        }
    }
}

/// Writes a Clockify Desktop Auto Tracker database matching the real schema
/// column for column, including `ZID` being TEXT where Toggl's is a BLOB and
/// `ZICONDATA` carrying a binary app icon.
fn write_clockify_db(path: &Path, rows: &[AutoTrackerItem<'_>]) {
    let connection = Connection::open(path).unwrap();
    connection
        .execute_batch(
            "create table ZCDAUTOTRACKERITEM (
               Z_PK integer primary key, Z_ENT integer, Z_OPT integer,
               ZITEMNO integer, ZTIMEENTRYADDED integer,
               ZIDLETIME float,
               ZTIMEENDED timestamp, ZTIMESTARTED timestamp,
               ZCOLOR varchar, ZICONID varchar, ZID varchar,
               ZITEMDESCRIPTION varchar, ZITEMURL varchar, ZNAME varchar,
               ZICONDATA blob)",
        )
        .unwrap();
    for (index, row) in rows.iter().enumerate() {
        connection
            .execute(
                "insert into ZCDAUTOTRACKERITEM
                   (Z_ENT, Z_OPT, ZITEMNO, ZTIMEENTRYADDED, ZIDLETIME, ZTIMEENDED,
                    ZTIMESTARTED, ZCOLOR, ZICONID, ZID, ZITEMDESCRIPTION, ZITEMURL,
                    ZNAME, ZICONDATA)
                 values (2, ?1, ?1, 0, ?2, ?3, ?4, '#aabbcc', 'icon', ?5, ?6, 'https://example.test', ?7, ?8)",
                rusqlite::params![
                    index as i64 + 1,
                    row.idle_seconds,
                    row.ended.as_ref(),
                    &row.started,
                    row.id,
                    row.description,
                    row.name,
                    row.icon,
                ],
            )
            .unwrap();
    }
    connection.close().unwrap();
}

async fn create_clockify_source(pool: &PgPool, name: &str, path: &Path) -> Uuid {
    let (status, bytes) =
        create_source(pool, name, "clockify_auto_tracker", &path.to_string_lossy()).await;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "creating {name} failed: {}",
        String::from_utf8_lossy(&bytes)
    );
    let value: Value = serde_json::from_slice(&bytes).unwrap();
    Uuid::parse_str(value["id"].as_str().unwrap()).unwrap()
}

#[sqlx::test]
async fn maps_every_clockify_field_onto_the_same_provider_neutral_interval(pool: PgPool) {
    let dir = scratch_dir("clockify-mapping");
    let path = dir.join("clockify.sqlite");
    write_clockify_db(
        &path,
        &[
            AutoTrackerItem {
                // 24 hex characters, the shape the real database stores.
                id: "68cf0a1b2c3d4e5f60718293",
                started: TimestampValue::Real(MORNING_START),
                ended: Some(TimestampValue::Real(MORNING_END)),
                name: "Figma",
                description: Some("Time lanes — exploration"),
                idle_seconds: 0.0,
                icon: &[0xde, 0xad, 0xbe, 0xef],
            },
            // Integers, which is how the real install stores them, and no
            // description at all.
            AutoTrackerItem {
                id: "68cf0a1b2c3d4e5f60718294",
                started: TimestampValue::Integer(AFTERNOON_START as i64),
                ended: Some(TimestampValue::Integer(AFTERNOON_END as i64)),
                name: "Slack",
                description: None,
                idle_seconds: 34.0,
                icon: &[],
            },
        ],
    );

    let source = create_clockify_source(&pool, "Clockify", &path).await;
    wait_for_intervals(&pool, source, 2).await;

    let (status, intervals) = list_intervals(&pool, DAY, Some(source)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(labels(&intervals), vec!["Figma", "Slack"]);

    let first = &intervals[0];
    // TEXT identity survives as itself — it is not hex-encoded the way Toggl's
    // BLOB is, which is the whole reason identity is read by storage class.
    assert_eq!(first["provider_record_id"], "68cf0a1b2c3d4e5f60718293");
    assert_eq!(first["label"], "Figma");
    assert_eq!(first["detail"], "Time lanes — exploration");
    assert_eq!(first["source_kind"], "clockify_auto_tracker");
    assert_eq!(first["source_name"], "Clockify");
    assert_eq!(
        first["started_at"], "2026-03-15T09:30:00.250Z",
        "a REAL Core Data timestamp must keep its sub-second part"
    );
    assert_eq!(first["idle"], false);

    let second = &intervals[1];
    assert_eq!(second["detail"], Value::Null);
    assert_eq!(
        second["started_at"], "2026-03-15T14:00:00Z",
        "an INTEGER Core Data timestamp must convert the same way a REAL one does"
    );
    assert_eq!(
        second["idle"], true,
        "Clockify reports idleness as a count of seconds, not a flag"
    );
}

#[sqlx::test]
async fn preserves_clockify_icon_blobs_through_the_same_lossless_encoding(pool: PgPool) {
    let dir = scratch_dir("clockify-icon");
    let path = dir.join("clockify.sqlite");
    write_clockify_db(
        &path,
        &[AutoTrackerItem {
            id: "68cf0a1b2c3d4e5f60718295",
            started: TimestampValue::Integer(MORNING_START as i64),
            ended: Some(TimestampValue::Integer(MORNING_END as i64)),
            name: "Figma",
            description: None,
            idle_seconds: 0.0,
            icon: &[0x00, 0xff, 0x01],
        }],
    );

    let source = create_clockify_source(&pool, "Clockify", &path).await;
    wait_for_intervals(&pool, source, 1).await;
    let (_, intervals) = list_intervals(&pool, DAY, Some(source)).await;
    let id = intervals[0]["id"].as_str().unwrap();

    // The daily response must not carry the icon — app icons repeat on every
    // record of the same application, which is exactly the payload a dense day
    // must not drag down with it.
    assert!(!intervals[0].as_object().unwrap().contains_key("raw_row"));

    let (_, detail) = interval_detail(&pool, id).await;
    let raw = &detail["raw_row"];
    assert_eq!(
        raw["ZICONDATA"],
        json!({ "type": "blob", "base64": "AP8B" })
    );
    // And Clockify's own columns are kept whole, not just the mapped six.
    assert_eq!(raw["ZCOLOR"], json!({ "type": "text", "value": "#aabbcc" }));
    assert_eq!(
        raw["ZITEMURL"],
        json!({ "type": "text", "value": "https://example.test" })
    );
    assert_eq!(raw["ZIDLETIME"], json!({ "type": "real", "value": 0.0 }));
}

#[sqlx::test]
async fn rejects_each_provider_database_offered_as_the_other(pool: PgPool) {
    let dir = scratch_dir("cross-kind");
    let toggl = dir.join("toggl.sqlite");
    let clockify = dir.join("clockify.sqlite");
    write_toggl_db(&toggl, &[]);
    write_clockify_db(&clockify, &[]);

    // Validation names every column the importer will later read, so a
    // same-shaped-but-different database fails at Settings rather than being
    // saved and then importing nothing.
    let (toggl_as_clockify, _) = create_source(
        &pool,
        "Wrong",
        "clockify_auto_tracker",
        &toggl.to_string_lossy(),
    )
    .await;
    assert_eq!(toggl_as_clockify, StatusCode::BAD_REQUEST);

    let (clockify_as_toggl, body) = create_source(
        &pool,
        "Wrong",
        "toggl_activity",
        &clockify.to_string_lossy(),
    )
    .await;
    assert_eq!(clockify_as_toggl, StatusCode::BAD_REQUEST);
    assert!(
        String::from_utf8_lossy(&body).contains("Toggl Activity Recording"),
        "the rejection should name the kind that was asked for: {}",
        String::from_utf8_lossy(&body)
    );

    assert_eq!(sources_in_table(&pool).await, 0);
}

#[sqlx::test]
async fn both_adapters_import_the_same_clock_period_without_merging_either(pool: PgPool) {
    // Two recorders watching the same stretch of a day are two pieces of
    // evidence. Neither may absorb, reorder away or outrank the other, and the
    // timeline has to be able to tell which lane a record belongs to.
    let dir = scratch_dir("two-providers");
    let toggl = dir.join("toggl.sqlite");
    let clockify = dir.join("clockify.sqlite");
    write_toggl_db(
        &toggl,
        &[Activity {
            id: &[0x80],
            start: MORNING_START,
            end: Some(MORNING_END),
            filename: "Xcode",
            title: Some("seen by Toggl"),
            idle: 0,
            client: &[],
        }],
    );
    write_clockify_db(
        &clockify,
        &[AutoTrackerItem {
            id: "68cf0a1b2c3d4e5f60718296",
            // Deliberately the identical clock period.
            started: TimestampValue::Real(MORNING_START),
            ended: Some(TimestampValue::Real(MORNING_END)),
            name: "Xcode",
            description: Some("seen by Clockify"),
            idle_seconds: 0.0,
            icon: &[],
        }],
    );

    let toggl_source = create_toggl_source(&pool, "Toggl Track", &toggl).await;
    let clockify_source = create_clockify_source(&pool, "Clockify Desktop", &clockify).await;
    wait_for_intervals(&pool, toggl_source, 1).await;
    wait_for_intervals(&pool, clockify_source, 1).await;

    let (_, all) = list_intervals(&pool, DAY, None).await;
    let rows = all.as_array().unwrap();
    assert_eq!(rows.len(), 2, "one recorder swallowed the other's record");

    // Every row names its own lane, so a client can split the day into lanes
    // without a second request to resolve source ids.
    let mut lanes: Vec<(&str, &str, &str)> = rows
        .iter()
        .map(|row| {
            (
                row["source_name"].as_str().unwrap(),
                row["source_kind"].as_str().unwrap(),
                row["detail"].as_str().unwrap(),
            )
        })
        .collect();
    lanes.sort_unstable();
    assert_eq!(
        lanes,
        vec![
            (
                "Clockify Desktop",
                "clockify_auto_tracker",
                "seen by Clockify"
            ),
            ("Toggl Track", "toggl_activity", "seen by Toggl"),
        ]
    );
    assert!(rows.iter().all(|row| row["source_enabled"] == true));

    // And each lane is still separately addressable.
    let (_, only_clockify) = list_intervals(&pool, DAY, Some(clockify_source)).await;
    assert_eq!(only_clockify.as_array().unwrap().len(), 1);
    assert_eq!(only_clockify[0]["source_name"], "Clockify Desktop");
}

#[sqlx::test]
async fn leaves_a_clockify_item_that_is_still_recording_out_of_the_timeline(pool: PgPool) {
    let dir = scratch_dir("clockify-open");
    let path = dir.join("clockify.sqlite");
    write_clockify_db(
        &path,
        &[
            AutoTrackerItem {
                id: "68cf0a1b2c3d4e5f60718297",
                started: TimestampValue::Integer(MORNING_START as i64),
                ended: Some(TimestampValue::Integer(MORNING_END as i64)),
                name: "Closed",
                description: None,
                idle_seconds: 0.0,
                icon: &[],
            },
            AutoTrackerItem {
                id: "68cf0a1b2c3d4e5f60718298",
                started: TimestampValue::Integer(AFTERNOON_START as i64),
                ended: None,
                name: "Still recording",
                description: None,
                idle_seconds: 0.0,
                icon: &[],
            },
        ],
    );

    let source = create_clockify_source(&pool, "Clockify", &path).await;
    let settled = wait_for_intervals(&pool, source, 1).await;

    assert_eq!(settled, 1);
    let (_, intervals) = list_intervals(&pool, DAY, Some(source)).await;
    assert_eq!(labels(&intervals), vec!["Closed"]);
}

// ---------------------------------------------------------------------------
// Source lifecycle: archive, re-enable, and when identity stops moving (#423)
// ---------------------------------------------------------------------------

async fn patch_source(pool: &PgPool, id: Uuid, body: Value, locked: bool) -> (StatusCode, Vec<u8>) {
    send(
        app(pool, locked),
        Request::builder()
            .method("PATCH")
            .uri(format!("/v1/time/sources/{id}"))
            .header("Content-Type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap(),
    )
    .await
}

async fn source_row(pool: &PgPool, id: Uuid) -> (String, String, String, bool) {
    sqlx::query_as("select name, kind, path, enabled from time_sources where id = $1")
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap()
}

/// One closed record, so a fixture can be imported and then archived.
fn one_activity<'a>(id: &'a [u8], filename: &'a str) -> Activity<'a> {
    Activity {
        id,
        start: MORNING_START,
        end: Some(MORNING_END),
        filename,
        title: None,
        idle: 0,
        client: &[],
    }
}

#[sqlx::test]
async fn archiving_a_source_keeps_its_intervals_and_their_attribution(pool: PgPool) {
    // Archival stops future imports. It is not a delete, and there is no
    // destructive delete in v1: the days a recorder already covered stay
    // queryable, and stay identifiable as its work.
    let dir = scratch_dir("archive");
    let path = dir.join("db.sqlite");
    write_toggl_db(&path, &[one_activity(&[0x90], "Xcode")]);

    let source = create_toggl_source(&pool, "Retiring recorder", &path).await;
    wait_for_intervals(&pool, source, 1).await;

    let (status, body) = patch_source(&pool, source, json!({ "enabled": false }), false).await;
    assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
    assert_eq!(source_row(&pool, source).await.3, false);

    let (status, intervals) = list_intervals(&pool, DAY, Some(source)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(labels(&intervals), vec!["Xcode"]);
    assert_eq!(
        intervals[0]["source_name"], "Retiring recorder",
        "an archived source's rows must still name the recorder they came from"
    );
    assert_eq!(
        intervals[0]["source_enabled"], false,
        "and must say the source is no longer active, so a timeline can mark it historical"
    );
}

#[sqlx::test]
async fn re_enabling_resumes_importing_without_duplicating_what_is_already_stored(pool: PgPool) {
    let dir = scratch_dir("re-enable");
    let path = dir.join("db.sqlite");
    write_toggl_db(&path, &[one_activity(&[0xa0], "Before archiving")]);

    let source = create_toggl_source(&pool, "Toggl", &path).await;
    wait_for_intervals(&pool, source, 1).await;
    let before: Vec<String> =
        sqlx::query_scalar("select id::text from activity_intervals where source_id = $1")
            .bind(source)
            .fetch_all(&pool)
            .await
            .unwrap();

    patch_source(&pool, source, json!({ "enabled": false }), false).await;

    // The recorder kept running while the source was archived.
    let connection = Connection::open(&path).unwrap();
    insert_rows(
        &connection,
        &[Activity {
            id: &[0xa1],
            start: AFTERNOON_START,
            end: Some(AFTERNOON_END),
            filename: "While archived",
            title: None,
            idle: 0,
            client: &[],
        }],
    );
    connection.close().unwrap();

    let (status, _) = patch_source(&pool, source, json!({ "enabled": true }), false).await;
    assert_eq!(status, StatusCode::OK);
    wait_for_intervals(&pool, source, 2).await;

    let (_, intervals) = list_intervals(&pool, DAY, Some(source)).await;
    assert_eq!(
        labels(&intervals),
        vec!["Before archiving", "While archived"]
    );

    // Resuming uses the existing source identity, so the uniqueness boundary
    // still holds: what was already stored is skipped, not re-inserted under
    // a new row id.
    let after: Vec<String> = sqlx::query_scalar(
        "select id::text from activity_intervals where source_id = $1 and label = 'Before archiving'",
    )
    .bind(source)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        after, before,
        "re-enabling rewrote evidence it should have skipped"
    );
}

#[sqlx::test]
async fn a_source_may_be_repointed_only_until_it_has_imported(pool: PgPool) {
    let dir = scratch_dir("repoint");
    let first = dir.join("first.sqlite");
    let second = dir.join("second.sqlite");
    write_toggl_db(&first, &[]);
    write_toggl_db(&second, &[one_activity(&[0xb0], "Second database")]);

    // An empty database still imports *successfully* — it simply has nothing
    // to import. That is exactly why this cannot be derived from whether any
    // intervals exist, and why `first_imported_at` is stored.
    let source = create_toggl_source(&pool, "Mistyped", &first).await;
    wait_for_first_import(&pool, source).await;

    let (status, body) = patch_source(
        &pool,
        source,
        json!({ "path": second.to_string_lossy() }),
        false,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert!(
        String::from_utf8_lossy(&body).contains("new source"),
        "the rejection should say what to do instead: {}",
        String::from_utf8_lossy(&body)
    );
    assert_eq!(
        source_row(&pool, source).await.2,
        std::fs::canonicalize(&first).unwrap().to_string_lossy(),
        "a refused repoint must not half-apply"
    );
}

#[sqlx::test]
async fn a_mistyped_path_can_be_corrected_before_the_first_import(pool: PgPool) {
    // The other side of the rule above. Without this, a typo in Settings would
    // mean a permanently dead source row that cannot be deleted either.
    let dir = scratch_dir("correct");
    let real = dir.join("real.sqlite");
    write_toggl_db(&real, &[one_activity(&[0xb1], "Corrected")]);

    // Created directly, so it has never imported — the state a source is in
    // between being saved and its first run finishing.
    let id = Uuid::new_v4();
    sqlx::query("insert into time_sources (id,name,kind,path,enabled) values ($1,$2,$3,$4,true)")
        .bind(id)
        .bind("Typo")
        .bind("toggl_activity")
        .bind("/not/the/right/database.sqlite")
        .execute(&pool)
        .await
        .unwrap();

    let (status, body) =
        patch_source(&pool, id, json!({ "path": real.to_string_lossy() }), false).await;
    assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
    assert_eq!(
        source_row(&pool, id).await.2,
        std::fs::canonicalize(&real).unwrap().to_string_lossy()
    );
}

#[sqlx::test]
async fn a_repoint_is_validated_against_the_kind_it_will_have(pool: PgPool) {
    let dir = scratch_dir("repoint-validate");
    let clockify = dir.join("clockify.sqlite");
    write_clockify_db(&clockify, &[]);

    let id = Uuid::new_v4();
    sqlx::query("insert into time_sources (id,name,kind,path,enabled) values ($1,$2,$3,$4,true)")
        .bind(id)
        .bind("Toggl")
        .bind("toggl_activity")
        .bind("/not/yet/real.sqlite")
        .execute(&pool)
        .await
        .unwrap();

    // Path alone, leaving the kind as Toggl: the Clockify database must be
    // rejected against the kind the source will actually have.
    let (rejected, _) = patch_source(
        &pool,
        id,
        json!({ "path": clockify.to_string_lossy() }),
        false,
    )
    .await;
    assert_eq!(rejected, StatusCode::BAD_REQUEST);

    // Both together: now it is a Clockify source reading a Clockify database.
    let (accepted, body) = patch_source(
        &pool,
        id,
        json!({ "kind": "clockify_auto_tracker", "path": clockify.to_string_lossy() }),
        false,
    )
    .await;
    assert_eq!(
        accepted,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&body)
    );
    let (_, kind, _, _) = source_row(&pool, id).await;
    assert_eq!(kind, "clockify_auto_tracker");
}

#[sqlx::test]
async fn renaming_stays_allowed_however_long_ago_a_source_imported(pool: PgPool) {
    // A name is a label, not an identity. Locking it down with the path would
    // leave an archived recorder stuck under whatever it was first called.
    let dir = scratch_dir("rename");
    let path = dir.join("db.sqlite");
    write_toggl_db(&path, &[one_activity(&[0xc0], "Xcode")]);

    let source = create_toggl_source(&pool, "Old name", &path).await;
    wait_for_intervals(&pool, source, 1).await;

    let (status, _) = patch_source(&pool, source, json!({ "name": "New name" }), false).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(source_row(&pool, source).await.0, "New name");

    let (_, intervals) = list_intervals(&pool, DAY, Some(source)).await;
    assert_eq!(intervals[0]["source_name"], "New name");

    let (blank, _) = patch_source(&pool, source, json!({ "name": "  " }), false).await;
    assert_eq!(blank, StatusCode::BAD_REQUEST);
}

#[sqlx::test]
async fn lifecycle_changes_are_refused_while_configuration_is_locked(pool: PgPool) {
    let dir = scratch_dir("locked-patch");
    let path = dir.join("db.sqlite");
    write_toggl_db(&path, &[one_activity(&[0xd0], "Xcode")]);
    let source = create_toggl_source(&pool, "Toggl", &path).await;
    wait_for_intervals(&pool, source, 1).await;

    let (status, _) = patch_source(&pool, source, json!({ "enabled": false }), true).await;
    assert_eq!(status, StatusCode::LOCKED);
    assert_eq!(
        source_row(&pool, source).await.3,
        true,
        "a locked Server must not half-apply the change it refused"
    );

    // Reading stays available while mutation is locked.
    let (listed, _) = list_intervals(&pool, DAY, Some(source)).await;
    assert_eq!(listed, StatusCode::OK);
}

#[sqlx::test]
async fn patching_a_source_that_does_not_exist_is_a_404(pool: PgPool) {
    let (status, _) = patch_source(&pool, Uuid::new_v4(), json!({ "enabled": false }), false).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

/// Waits for the spawned import to finish, which is what closes the window in
/// which a source may still be repointed. Distinct from `wait_for_intervals`
/// because a successful import can insert nothing at all.
async fn wait_for_first_import(pool: &PgPool, source: Uuid) {
    for _ in 0..400 {
        let stamped: Option<Option<chrono::DateTime<chrono::Utc>>> =
            sqlx::query_scalar("select first_imported_at from time_sources where id = $1")
                .bind(source)
                .fetch_optional(pool)
                .await
                .unwrap();
        if stamped.flatten().is_some() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("the import for {source} never recorded a first successful run");
}

// ---------------------------------------------------------------------------
// Filtering and search (issue #424)
// ---------------------------------------------------------------------------

/// A day holding one record per label, across two sources.
async fn seed_searchable_day(pool: &PgPool) -> (Uuid, Uuid) {
    let dir = scratch_dir("search");
    let toggl = dir.join("toggl.sqlite");
    let clockify = dir.join("clockify.sqlite");
    write_toggl_db(
        &toggl,
        &[
            Activity {
                id: &[0xe0],
                start: MORNING_START,
                end: Some(MORNING_END),
                filename: "Xcode",
                title: Some("time.rs \u{2014} meologue"),
                idle: 0,
                client: &[],
            },
            Activity {
                id: &[0xe1],
                start: AFTERNOON_START,
                end: Some(AFTERNOON_END),
                filename: "Music",
                title: Some("100% volume"),
                idle: 0,
                client: &[],
            },
        ],
    );
    write_clockify_db(
        &clockify,
        &[AutoTrackerItem {
            id: "68cf0a1b2c3d4e5f6071829a",
            started: TimestampValue::Real(MORNING_START),
            ended: Some(TimestampValue::Real(MORNING_END)),
            name: "Figma",
            description: Some("meologue \u{2014} Time lanes"),
            idle_seconds: 0.0,
            icon: &[],
        }],
    );
    let a = create_toggl_source(pool, "Toggl Track", &toggl).await;
    let b = create_clockify_source(pool, "Clockify Desktop", &clockify).await;
    wait_for_intervals(pool, a, 2).await;
    wait_for_intervals(pool, b, 1).await;
    (a, b)
}

#[sqlx::test]
async fn a_day_can_be_narrowed_to_the_selected_source_lanes(pool: PgPool) {
    let (toggl, clockify) = seed_searchable_day(&pool).await;

    let (status, all) = query_intervals(&pool, &format!("day={DAY}")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(all.as_array().unwrap().len(), 3);

    // Several ids at once — the shape a reader with three lanes and one
    // switched off actually produces.
    let (_, both) =
        query_intervals(&pool, &format!("day={DAY}&source_ids={toggl},{clockify}")).await;
    assert_eq!(both.as_array().unwrap().len(), 3);

    let (_, only_clockify) =
        query_intervals(&pool, &format!("day={DAY}&source_ids={clockify}")).await;
    assert_eq!(labels(&only_clockify), vec!["Figma"]);

    // Every lane switched off asks for nothing, and must not be read as
    // asking for everything.
    let (status, none) = query_intervals(&pool, &format!("day={DAY}&source_ids=")).await;
    assert_eq!(status, StatusCode::OK);
    assert!(none.as_array().unwrap().is_empty());

    let (bad, _) = query_intervals(&pool, &format!("day={DAY}&source_ids=not-a-uuid")).await;
    assert_eq!(bad, StatusCode::BAD_REQUEST);
}

#[sqlx::test]
async fn search_matches_label_and_detail_without_leaving_the_day(pool: PgPool) {
    let (_toggl, _clockify) = seed_searchable_day(&pool).await;

    // Label, case-insensitively.
    let (status, by_label) = query_intervals(&pool, &format!("day={DAY}&q=xcode")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(labels(&by_label), vec!["Xcode"]);

    // Detail, across both recorders — the text lives in different provider
    // columns, and the search is against the normalized field, not either of
    // the provider ones.
    let (_, by_detail) = query_intervals(&pool, &format!("day={DAY}&q=meologue")).await;
    let mut found = labels(&by_detail);
    found.sort();
    assert_eq!(found, vec!["Figma", "Xcode"]);

    // A cleared search box shows the whole day rather than nothing.
    let (_, blank) = query_intervals(&pool, &format!("day={DAY}&q=%20%20")).await;
    assert_eq!(blank.as_array().unwrap().len(), 3);

    let (_, nothing) = query_intervals(&pool, &format!("day={DAY}&q=nothingmatchesthis")).await;
    assert!(nothing.as_array().unwrap().is_empty());
}

#[sqlx::test]
async fn a_wildcard_typed_into_search_looks_for_itself(pool: PgPool) {
    // `%` is a SQL wildcard and also an ordinary character in a window title
    // ("100% volume"). Unescaped it would match every record of the day, which
    // is the opposite of narrowing one.
    seed_searchable_day(&pool).await;

    let (_, literal) = query_intervals(&pool, &format!("day={DAY}&q=100%25")).await;
    assert_eq!(labels(&literal), vec!["Music"]);

    let (_, bare) = query_intervals(&pool, &format!("day={DAY}&q=%25")).await;
    assert_eq!(
        labels(&bare),
        vec!["Music"],
        "a bare % must match the record that literally contains one, not the day"
    );
}

#[sqlx::test]
async fn search_and_source_selection_narrow_together(pool: PgPool) {
    let (toggl, clockify) = seed_searchable_day(&pool).await;

    let (_, toggl_only) =
        query_intervals(&pool, &format!("day={DAY}&source_ids={toggl}&q=meologue")).await;
    assert_eq!(labels(&toggl_only), vec!["Xcode"]);

    let (_, clockify_only) = query_intervals(
        &pool,
        &format!("day={DAY}&source_ids={clockify}&q=meologue"),
    )
    .await;
    assert_eq!(labels(&clockify_only), vec!["Figma"]);
}

#[sqlx::test]
async fn a_filtered_day_still_serves_only_normalized_fields(pool: PgPool) {
    // Filtering must not become a way to pull raw provider rows out in bulk:
    // a search that matched every record of a dense day would otherwise drag
    // every icon and BLOB down with it.
    seed_searchable_day(&pool).await;

    let (_, matched) = query_intervals(&pool, &format!("day={DAY}&q=e")).await;
    let rows = matched.as_array().unwrap();
    assert!(!rows.is_empty(), "the search should have matched something");
    for row in rows {
        assert!(
            !row.as_object().unwrap().contains_key("raw_row"),
            "a filtered day leaked a raw provider row"
        );
    }
}

// ---------------------------------------------------------------------------
// Refresh runs (issue #421)
// ---------------------------------------------------------------------------

/// Posts a refresh through a *given* app, so several requests can share one
/// `ImportRuns`.
///
/// Every other helper here builds a fresh router per request, which is fine
/// for handlers that keep nothing in memory. The refresh guard is exactly the
/// thing that does, and two requests through two routers would each have their
/// own — a test written that way would pass while proving nothing.
async fn post_refresh(app: Router) -> (StatusCode, Vec<u8>) {
    send(
        app,
        Request::builder()
            .method("POST")
            .uri("/v1/time/refresh")
            .body(Body::empty())
            .unwrap(),
    )
    .await
}

async fn sources_of(pool: &PgPool) -> Vec<Value> {
    let (status, bytes) = send(
        app(pool, false),
        Request::builder()
            .method("GET")
            .uri("/v1/time/sources")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    serde_json::from_slice::<Vec<Value>>(&bytes).unwrap()
}

async fn source_status(pool: &PgPool, id: Uuid) -> Value {
    sources_of(pool)
        .await
        .into_iter()
        .find(|source| source["id"] == id.to_string())
        .expect("the source should still be listed")
}

/// Waits for every source to have been attempted at least `rounds` times.
async fn wait_for_attempts(pool: &PgPool, source: Uuid, rounds: i64) {
    for _ in 0..400 {
        let seen: i64 = sqlx::query_scalar(
            "select count(*) from time_sources where id = $1 and last_attempt_at is not null",
        )
        .bind(source)
        .fetch_one(pool)
        .await
        .unwrap();
        if seen >= rounds.min(1) {
            // The attempt stamp only tells us a run touched it; wait for the
            // run itself to settle before reading counts.
            let running: Option<chrono::DateTime<chrono::Utc>> =
                sqlx::query_scalar("select last_success_at from time_sources where id = $1")
                    .bind(source)
                    .fetch_one(pool)
                    .await
                    .unwrap();
            if running.is_some() {
                return;
            }
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("source {source} was never imported");
}

#[sqlx::test]
async fn refresh_imports_every_enabled_source_and_reports_each_one_separately(pool: PgPool) {
    let dir = scratch_dir("refresh");
    let good = dir.join("good.sqlite");
    let gone = dir.join("gone.sqlite");
    let archived = dir.join("archived.sqlite");
    write_toggl_db(&good, &[one_activity(&[0xf0], "Xcode")]);
    write_toggl_db(&gone, &[one_activity(&[0xf1], "Will vanish")]);
    write_toggl_db(&archived, &[one_activity(&[0xf2], "Archived")]);

    // The broken source is created FIRST on purpose. Sources are imported in
    // creation order, so with it last an importer that gave up on the first
    // error would still have done the healthy one and this test would pass
    // while proving nothing — measured: that mutation survived until the
    // order was flipped.
    let broken = create_toggl_source(&pool, "Broken", &gone).await;
    let healthy = create_toggl_source(&pool, "Healthy", &good).await;
    let retired = create_toggl_source(&pool, "Retired", &archived).await;
    wait_for_intervals(&pool, healthy, 1).await;
    wait_for_intervals(&pool, broken, 1).await;
    wait_for_intervals(&pool, retired, 1).await;

    patch_source(&pool, retired, json!({ "enabled": false }), false).await;
    // The recorder's database is deleted out from under the Server between
    // runs — the ordinary way a source breaks.
    std::fs::remove_file(&gone).unwrap();

    // Recorded before the run so the wait below can tell this run's success
    // from the initial import's.
    let healthy_before = source_status(&pool, healthy).await["last_success_at"].clone();

    let (status, body) = post_refresh(app(&pool, false)).await;
    assert_eq!(
        status,
        StatusCode::ACCEPTED,
        "{}",
        String::from_utf8_lossy(&body)
    );
    let accepted: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(
        accepted["queued"], 2,
        "an archived source must not be queued for import"
    );

    // Wait on the LAST source the run touches, not the first. The broken one
    // is imported first, so its error appears while the healthy one has not
    // run yet — keying the wait on it read the healthy source's *initial*
    // import and failed under load.
    for _ in 0..400 {
        if source_status(&pool, healthy).await["last_success_at"] != healthy_before {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }

    let healthy_status = source_status(&pool, healthy).await;
    let broken_status = source_status(&pool, broken).await;
    let retired_status = source_status(&pool, retired).await;

    // A failing source does not stop the others: the healthy one still ran.
    assert!(healthy_status["last_success_at"].is_string());
    assert_eq!(
        healthy_status["last_inserted_count"], 0,
        "a repeated import of unchanged evidence inserts nothing"
    );
    assert!(healthy_status["last_error"].is_null());

    assert!(
        broken_status["last_error"].is_string(),
        "a broken source must say why, not fail silently: {broken_status}"
    );
    assert!(broken_status["last_attempt_at"].is_string());

    // The archived source was skipped entirely — its status is whatever its
    // last real run left, untouched by this one.
    assert!(retired_status["last_error"].is_null());
    assert_eq!(retired_status["last_inserted_count"], 1);
}

#[sqlx::test]
async fn a_second_refresh_while_one_is_running_is_told_so(pool: PgPool) {
    // Two runs over the same sources would race each other's writes, so the
    // second must be refused rather than queued behind the first.
    //
    // Made deterministic by size rather than timing: the first run has two
    // thousand records to insert, one statement at a time, so it is still
    // going microseconds later when the second request arrives. Both requests
    // go through the *same* app, because the guard lives in its state.
    let dir = scratch_dir("concurrent");
    let path = dir.join("big.sqlite");
    let rows: Vec<Vec<u8>> = (0..2000u32).map(|n| n.to_be_bytes().to_vec()).collect();
    let activities: Vec<Activity<'_>> = rows
        .iter()
        .enumerate()
        .map(|(index, id)| Activity {
            id,
            start: MORNING_START + index as f64,
            end: Some(MORNING_END + index as f64),
            filename: "Xcode",
            title: None,
            idle: 0,
            client: &[],
        })
        .collect();
    write_toggl_db(&path, &activities);

    let source = create_toggl_source(&pool, "Big", &path).await;
    wait_for_intervals(&pool, source, 2000).await;

    let shared = app(&pool, false);
    let (first, _) = post_refresh(shared.clone()).await;
    assert_eq!(first, StatusCode::ACCEPTED);

    let (second, body) = post_refresh(shared.clone()).await;
    assert_eq!(
        second,
        StatusCode::CONFLICT,
        "a second run was allowed to start alongside the first"
    );
    assert!(String::from_utf8_lossy(&body).contains("already running"));

    // And the run really does finish, freeing the slot for a later refresh.
    for _ in 0..800 {
        let (status, _) = post_refresh(shared.clone()).await;
        if status == StatusCode::ACCEPTED {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("the refresh slot was never released");
}

#[sqlx::test]
async fn malformed_records_are_skipped_with_warnings_while_the_rest_import(pool: PgPool) {
    // One unreadable row must not stop a day's evidence importing — but it
    // must not vanish either, or a recorder quietly losing half its records
    // would look perfectly healthy.
    let dir = scratch_dir("malformed");
    let path = dir.join("db.sqlite");
    write_toggl_db(
        &path,
        &[
            one_activity(&[0xc1], "Good"),
            // Ends before it starts: a real Toggl database has produced these.
            Activity {
                id: &[0xc2],
                start: MORNING_END,
                end: Some(MORNING_START),
                filename: "Backwards",
                title: None,
                idle: 0,
                client: &[],
            },
        ],
    );
    // And one with no identity at all, which cannot be deduplicated.
    let connection = Connection::open(&path).unwrap();
    connection
        .execute(
            "insert into ZMANAGEDACTIVITY (Z_ENT, Z_OPT, ZISIDLE, ZSYNCSTATUS, ZEND, ZSTART, ZFILENAME, ZTITLE, ZCLIENT, ZID)
             values (1, 9, 0, 1, ?1, ?2, 'No identity', null, null, null)",
            rusqlite::params![AFTERNOON_END, AFTERNOON_START],
        )
        .unwrap();
    connection.close().unwrap();

    let source = create_toggl_source(&pool, "Mixed", &path).await;
    wait_for_intervals(&pool, source, 1).await;
    wait_for_attempts(&pool, source, 1).await;

    let status = source_status(&pool, source).await;
    assert_eq!(
        status["last_inserted_count"], 1,
        "the good record must import"
    );
    assert_eq!(
        status["last_warning_count"], 2,
        "both unusable records must be counted, not dropped: {status}"
    );
    assert!(
        status["last_error"].is_null(),
        "skipping bad rows is not a failed import"
    );

    let (_, intervals) = list_intervals(&pool, DAY, Some(source)).await;
    assert_eq!(labels(&intervals), vec!["Good"]);
}

#[sqlx::test]
async fn a_still_open_record_is_deferred_rather_than_warned_about(pool: PgPool) {
    // Deferring is the ordinary state of the record a recorder is writing
    // right now. Counting it as a warning would make every healthy source
    // look like it had a problem.
    let dir = scratch_dir("deferred");
    let path = dir.join("db.sqlite");
    write_toggl_db(
        &path,
        &[
            one_activity(&[0xc3], "Closed"),
            Activity {
                id: &[0xc4],
                start: AFTERNOON_START,
                end: None,
                filename: "Still recording",
                title: None,
                idle: 0,
                client: &[],
            },
        ],
    );

    let source = create_toggl_source(&pool, "Toggl", &path).await;
    wait_for_attempts(&pool, source, 1).await;

    let status = source_status(&pool, source).await;
    assert_eq!(status["last_warning_count"], 0);
    assert_eq!(status["last_inserted_count"], 1);
    assert!(status["last_error"].is_null());
}

#[sqlx::test]
async fn repeated_refreshes_stay_idempotent_and_say_so(pool: PgPool) {
    let dir = scratch_dir("repeat");
    let path = dir.join("db.sqlite");
    write_toggl_db(&path, &[one_activity(&[0xc5], "Xcode")]);

    let source = create_toggl_source(&pool, "Toggl", &path).await;
    wait_for_intervals(&pool, source, 1).await;
    wait_for_attempts(&pool, source, 1).await;
    assert_eq!(source_status(&pool, source).await["last_inserted_count"], 1);

    let ids_before: Vec<String> =
        sqlx::query_scalar("select id::text from activity_intervals where source_id = $1")
            .bind(source)
            .fetch_all(&pool)
            .await
            .unwrap();

    let shared = app(&pool, false);
    assert_eq!(post_refresh(shared.clone()).await.0, StatusCode::ACCEPTED);
    for _ in 0..400 {
        if source_status(&pool, source).await["last_inserted_count"] == 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }

    assert_eq!(
        source_status(&pool, source).await["last_inserted_count"],
        0,
        "a refresh that found nothing new must report nothing new"
    );
    let ids_after: Vec<String> =
        sqlx::query_scalar("select id::text from activity_intervals where source_id = $1")
            .bind(source)
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(ids_after, ids_before, "a refresh rewrote stored evidence");
}

#[sqlx::test]
async fn deleting_a_record_from_the_source_never_removes_imported_evidence(pool: PgPool) {
    // Activity intervals are append-only evidence (ADR 0091). A recorder that
    // prunes its own database must not take the Server's history with it.
    let dir = scratch_dir("source-deletes");
    let path = dir.join("db.sqlite");
    write_toggl_db(
        &path,
        &[
            one_activity(&[0xc6], "Kept"),
            one_activity(&[0xc7], "Pruned"),
        ],
    );

    let source = create_toggl_source(&pool, "Toggl", &path).await;
    wait_for_intervals(&pool, source, 2).await;

    let connection = Connection::open(&path).unwrap();
    connection
        .execute(
            "delete from ZMANAGEDACTIVITY where ZFILENAME = 'Pruned'",
            [],
        )
        .unwrap();
    connection.close().unwrap();

    let shared = app(&pool, false);
    assert_eq!(post_refresh(shared).await.0, StatusCode::ACCEPTED);
    wait_for_attempts(&pool, source, 2).await;
    tokio::time::sleep(Duration::from_millis(200)).await;

    let (_, intervals) = list_intervals(&pool, DAY, Some(source)).await;
    let mut found = labels(&intervals);
    found.sort();
    assert_eq!(found, vec!["Kept", "Pruned"]);
}

#[sqlx::test]
async fn a_locked_server_still_imports(pool: PgPool) {
    // `MEOLOGUE_CONFIG_LOCK` makes a Server's *configuration* read-only. An
    // import changes evidence, not settings, and a managed Server whose
    // sources were seeded from the environment still has to be able to import
    // them (issue #425) — so refresh is deliberately not gated on the lock,
    // while adding, archiving and repointing a source all are.
    let dir = scratch_dir("locked-refresh");
    let path = dir.join("db.sqlite");
    write_toggl_db(&path, &[one_activity(&[0xe9], "Xcode")]);
    let source = create_toggl_source(&pool, "Toggl", &path).await;
    wait_for_intervals(&pool, source, 1).await;

    let (status, _) = post_refresh(app(&pool, true)).await;
    assert_eq!(status, StatusCode::ACCEPTED);

    // The mutations stay locked.
    let (archive, _) = patch_source(&pool, source, json!({ "enabled": false }), true).await;
    assert_eq!(archive, StatusCode::LOCKED);
    let (create, _) = send(
        app(&pool, true),
        Request::builder()
            .method("POST")
            .uri("/v1/time/sources")
            .header("Content-Type", "application/json")
            .body(Body::from(
                json!({ "name": "New", "kind": "toggl_activity", "path": path.to_string_lossy() })
                    .to_string(),
            ))
            .unwrap(),
    )
    .await;
    assert_eq!(create, StatusCode::LOCKED);

    // And reading is untouched.
    let (listed, _) = list_intervals(&pool, DAY, Some(source)).await;
    assert_eq!(listed, StatusCode::OK);
    assert_eq!(sources_of(&pool).await.len(), 1);
}

#[sqlx::test]
async fn a_source_reports_no_run_state_when_nothing_is_running(pool: PgPool) {
    let dir = scratch_dir("idle-state");
    let path = dir.join("db.sqlite");
    write_toggl_db(&path, &[one_activity(&[0xc8], "Xcode")]);
    let source = create_toggl_source(&pool, "Toggl", &path).await;
    wait_for_attempts(&pool, source, 1).await;

    assert_eq!(
        source_status(&pool, source).await["state"],
        "idle",
        "run state is memory, not a column: a Server that restarted has nothing queued"
    );
}

// ---------------------------------------------------------------------------
// The nightly run and its catch-up (issue #422)
// ---------------------------------------------------------------------------

use chrono::NaiveDate;
use meologue_server::time::{ImportRuns, catch_up_if_missed, run_scheduled_import};

fn server_tz() -> chrono_tz::Tz {
    meologue_server::period::server_timezone()
}

/// The Server-local date `days_ago` days before now — the shape the schedule
/// reasons in, built here rather than pinned to a UTC date so these tests mean
/// the same thing under whatever `MEOLOGUE_TZ` a checkout configures.
fn local_date(days_ago: i64) -> NaiveDate {
    chrono::Utc::now().with_timezone(&server_tz()).date_naive() - chrono::Duration::days(days_ago)
}

async fn scheduled_day_of(pool: &PgPool, source: Uuid) -> Option<NaiveDate> {
    sqlx::query_scalar("select last_scheduled_run_on from time_sources where id = $1")
        .bind(source)
        .fetch_one(pool)
        .await
        .unwrap()
}

#[sqlx::test]
async fn a_scheduled_run_imports_and_records_the_night_it_was_for(pool: PgPool) {
    let dir = scratch_dir("scheduled");
    let path = dir.join("db.sqlite");
    write_toggl_db(&path, &[one_activity(&[0xd1], "Xcode")]);
    let source = create_toggl_source(&pool, "Toggl", &path).await;
    wait_for_intervals(&pool, source, 1).await;

    // A manual or initial import must NOT look like a completed daily run,
    // or a Server would think a night had happened that never did.
    assert_eq!(scheduled_day_of(&pool, source).await, None);

    let runs = ImportRuns::default();
    let night = local_date(0);
    assert!(run_scheduled_import(&pool, &runs, night).await);

    assert_eq!(scheduled_day_of(&pool, source).await, Some(night));
    // And it went through the same import path, so the same statuses moved.
    let status = source_status(&pool, source).await;
    assert!(status["last_success_at"].is_string());
    assert_eq!(status["last_inserted_count"], 0);
}

#[sqlx::test]
async fn a_night_a_source_failed_stays_owed(pool: PgPool) {
    // Recording a night that did not actually import would let one bad night
    // be forgotten forever: the next startup would see the date and conclude
    // there was nothing to catch up.
    let dir = scratch_dir("failed-night");
    let path = dir.join("db.sqlite");
    write_toggl_db(&path, &[one_activity(&[0xd2], "Xcode")]);
    let source = create_toggl_source(&pool, "Toggl", &path).await;
    wait_for_intervals(&pool, source, 1).await;
    std::fs::remove_file(&path).unwrap();

    let runs = ImportRuns::default();
    assert!(run_scheduled_import(&pool, &runs, local_date(0)).await);

    assert_eq!(
        scheduled_day_of(&pool, source).await,
        None,
        "a failed import recorded a night it never completed"
    );
    assert!(source_status(&pool, source).await["last_error"].is_string());
}

#[sqlx::test]
async fn startup_catches_up_one_missed_night_and_then_stops(pool: PgPool) {
    let dir = scratch_dir("catch-up");
    let path = dir.join("db.sqlite");
    write_toggl_db(&path, &[one_activity(&[0xd3], "Xcode")]);
    let source = create_toggl_source(&pool, "Toggl", &path).await;
    wait_for_intervals(&pool, source, 1).await;

    // Several nights missed — the Server was off for a week.
    sqlx::query("update time_sources set last_scheduled_run_on = $2 where id = $1")
        .bind(source)
        .bind(local_date(7))
        .execute(&pool)
        .await
        .unwrap();

    let runs = ImportRuns::default();
    let now = chrono::Utc::now();
    assert!(
        catch_up_if_missed(&pool, &runs, server_tz(), now).await,
        "a week of missed nights should be caught up"
    );
    let caught_up_to = scheduled_day_of(&pool, source).await;
    assert!(caught_up_to > Some(local_date(7)));

    // Starting again immediately must not run a second time: one pass over
    // the source already found everything a per-night loop would have.
    assert!(
        !catch_up_if_missed(&pool, &runs, server_tz(), now).await,
        "a repeated startup ran a second catch-up"
    );
    assert_eq!(scheduled_day_of(&pool, source).await, caught_up_to);
}

#[sqlx::test]
async fn startup_does_nothing_when_last_night_already_ran(pool: PgPool) {
    let dir = scratch_dir("no-catch-up");
    let path = dir.join("db.sqlite");
    write_toggl_db(&path, &[one_activity(&[0xd4], "Xcode")]);
    let source = create_toggl_source(&pool, "Toggl", &path).await;
    wait_for_intervals(&pool, source, 1).await;

    // Recorded as of today, which is at or after the night most recently due
    // however far through the day it currently is.
    sqlx::query("update time_sources set last_scheduled_run_on = $2 where id = $1")
        .bind(source)
        .bind(local_date(0))
        .execute(&pool)
        .await
        .unwrap();

    let runs = ImportRuns::default();
    assert!(!catch_up_if_missed(&pool, &runs, server_tz(), chrono::Utc::now()).await);
}

#[sqlx::test]
async fn a_server_with_no_enabled_sources_has_no_night_to_catch_up(pool: PgPool) {
    // Otherwise a Server that has never been given a recorder would queue a
    // catch-up run over nothing on every single startup.
    let runs = ImportRuns::default();
    assert!(!catch_up_if_missed(&pool, &runs, server_tz(), chrono::Utc::now()).await);

    let dir = scratch_dir("archived-only");
    let path = dir.join("db.sqlite");
    write_toggl_db(&path, &[one_activity(&[0xd5], "Xcode")]);
    let source = create_toggl_source(&pool, "Toggl", &path).await;
    wait_for_intervals(&pool, source, 1).await;
    patch_source(&pool, source, json!({ "enabled": false }), false).await;

    assert!(
        !catch_up_if_missed(&pool, &runs, server_tz(), chrono::Utc::now()).await,
        "an archived source is not a missed night"
    );
}

#[sqlx::test]
async fn a_manual_refresh_never_counts_as_a_completed_daily_run(pool: PgPool) {
    // The two triggers share everything except this. If Refresh now stamped
    // the scheduled date, pressing it once would silence the catch-up for a
    // night that never actually ran.
    let dir = scratch_dir("manual-vs-scheduled");
    let path = dir.join("db.sqlite");
    write_toggl_db(&path, &[one_activity(&[0xd6], "Xcode")]);
    let source = create_toggl_source(&pool, "Toggl", &path).await;
    wait_for_intervals(&pool, source, 1).await;

    let shared = app(&pool, false);
    assert_eq!(post_refresh(shared).await.0, StatusCode::ACCEPTED);
    wait_for_attempts(&pool, source, 2).await;
    tokio::time::sleep(Duration::from_millis(200)).await;

    assert_eq!(
        scheduled_day_of(&pool, source).await,
        None,
        "a manual refresh recorded itself as the night's run"
    );
}

#[sqlx::test]
async fn a_nightly_tick_is_skipped_while_another_run_is_in_flight(pool: PgPool) {
    // The run already happening reads the same databases, and the next tick
    // is a day away — queueing a second would only race the first's writes.
    let runs = ImportRuns::default();
    assert!(
        runs.try_start(vec![Uuid::new_v4()]),
        "the slot should be free"
    );

    assert!(
        !run_scheduled_import(&pool, &runs, local_date(0)).await,
        "a nightly tick started alongside a run already in flight"
    );
}

// ---------------------------------------------------------------------------
// Bootstrapping a managed Server (issue #425)
// ---------------------------------------------------------------------------

use meologue_server::time::bootstrap_sources;

/// The env value as an operator would write it, for one Toggl database.
fn bootstrap_json(entries: &[(&str, &str, &Path, Option<bool>)]) -> String {
    let items: Vec<Value> = entries
        .iter()
        .map(|(name, kind, path, enabled)| {
            let mut item = json!({ "name": name, "kind": kind, "path": path.to_string_lossy() });
            if let Some(enabled) = enabled {
                item["enabled"] = json!(enabled);
            }
            item
        })
        .collect();
    Value::Array(items).to_string()
}

#[sqlx::test]
async fn an_empty_server_is_seeded_from_the_environment_and_imports_at_once(pool: PgPool) {
    let dir = scratch_dir("bootstrap");
    let toggl = dir.join("toggl.sqlite");
    let clockify = dir.join("clockify.sqlite");
    write_toggl_db(&toggl, &[one_activity(&[0xe2], "Xcode")]);
    write_clockify_db(
        &clockify,
        &[AutoTrackerItem {
            id: "68cf0a1b2c3d4e5f607182b0",
            started: TimestampValue::Real(MORNING_START),
            ended: Some(TimestampValue::Real(MORNING_END)),
            name: "Figma",
            description: None,
            idle_seconds: 0.0,
            icon: &[],
        }],
    );

    let seeded = bootstrap_sources(
        &pool,
        Some(&bootstrap_json(&[
            ("Work", "toggl_activity", &toggl, None),
            ("Desktop", "clockify_auto_tracker", &clockify, Some(false)),
        ])),
    )
    .await;
    assert_eq!(seeded, 2);

    let sources = sources_of(&pool).await;
    assert_eq!(sources.len(), 2);
    assert_eq!(sources[0]["name"], "Work");
    assert_eq!(sources[0]["enabled"], true, "enabled is the default");
    assert_eq!(sources[1]["name"], "Desktop");
    assert_eq!(sources[1]["enabled"], false);
    // The path is canonicalised exactly as one typed into Settings would be.
    assert_eq!(
        sources[0]["path"],
        std::fs::canonicalize(&toggl)
            .unwrap()
            .to_string_lossy()
            .as_ref()
    );

    // A seeded ENABLED source imports immediately, as one added in Settings
    // does — an operator should not have to press Refresh now to make a
    // Server they just configured useful.
    let work = Uuid::parse_str(sources[0]["id"].as_str().unwrap()).unwrap();
    wait_for_intervals(&pool, work, 1).await;
    let (_, intervals) = list_intervals(&pool, DAY, Some(work)).await;
    assert_eq!(labels(&intervals), vec!["Xcode"]);

    // The archived one is not imported, the same way archival works anywhere
    // else.
    let desktop = Uuid::parse_str(sources[1]["id"].as_str().unwrap()).unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    let stored: i64 =
        sqlx::query_scalar("select count(*) from activity_intervals where source_id = $1")
            .bind(desktop)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(stored, 0);
}

#[sqlx::test]
async fn once_any_source_exists_the_environment_stops_being_consulted(pool: PgPool) {
    // The one-time ownership transfer. Without it the environment would be a
    // permanent overlay, rewriting whatever an operator changed in Settings
    // on every single restart.
    let dir = scratch_dir("ownership");
    let first = dir.join("first.sqlite");
    let second = dir.join("second.sqlite");
    write_toggl_db(&first, &[one_activity(&[0xe3], "First")]);
    write_toggl_db(&second, &[one_activity(&[0xe4], "Second")]);

    assert_eq!(
        bootstrap_sources(
            &pool,
            Some(&bootstrap_json(&[("Work", "toggl_activity", &first, None)]))
        )
        .await,
        1
    );

    // A restart with a *different* environment adds nothing and replaces
    // nothing.
    assert_eq!(
        bootstrap_sources(
            &pool,
            Some(&bootstrap_json(&[
                ("Work", "toggl_activity", &first, None),
                ("Extra", "toggl_activity", &second, None),
            ]))
        )
        .await,
        0
    );
    let sources = sources_of(&pool).await;
    assert_eq!(sources.len(), 1);
    assert_eq!(sources[0]["name"], "Work");

    // And an empty environment does not remove what is already configured.
    assert_eq!(bootstrap_sources(&pool, None).await, 0);
    assert_eq!(sources_of(&pool).await.len(), 1);
}

#[sqlx::test]
async fn an_archived_source_counts_as_configuration_and_is_not_re_seeded(pool: PgPool) {
    // The case a naive "no *enabled* sources, so seed again" check would get
    // wrong: archiving is the clearest decision an operator can make after
    // seeding, and a restart must not undo it.
    let dir = scratch_dir("archived-bootstrap");
    let path = dir.join("db.sqlite");
    let other = dir.join("other.sqlite");
    write_toggl_db(&path, &[one_activity(&[0xe5], "Xcode")]);
    write_toggl_db(&other, &[one_activity(&[0xea], "Elsewhere")]);

    assert_eq!(
        bootstrap_sources(
            &pool,
            Some(&bootstrap_json(&[("Work", "toggl_activity", &path, None)]))
        )
        .await,
        1
    );
    let id = Uuid::parse_str(sources_of(&pool).await[0]["id"].as_str().unwrap()).unwrap();
    patch_source(&pool, id, json!({ "enabled": false }), false).await;

    // The restart names a source at a DIFFERENT path. Naming the same one
    // would be caught by the unique path constraint whatever the rule here
    // said, and the test would pass while proving nothing — measured: that
    // is exactly what happened before this line changed.
    assert_eq!(
        bootstrap_sources(
            &pool,
            Some(&bootstrap_json(&[(
                "Elsewhere",
                "toggl_activity",
                &other,
                None
            )]))
        )
        .await,
        0
    );

    let sources = sources_of(&pool).await;
    assert_eq!(sources.len(), 1, "an archived source was seeded over");
    assert_eq!(
        sources[0]["enabled"], false,
        "a restart re-enabled a source an operator had archived"
    );
}

#[sqlx::test]
async fn invalid_definitions_are_skipped_without_stopping_the_valid_ones(pool: PgPool) {
    // Nothing here may prevent the Server starting, and nothing may hide the
    // repair path: whatever was skipped can still be added in Settings.
    let dir = scratch_dir("invalid-bootstrap");
    let good = dir.join("good.sqlite");
    write_toggl_db(&good, &[one_activity(&[0xe6], "Xcode")]);

    // A file that exists and canonicalises but is not a provider database at
    // all. Without this the only invalid entries would be ones rejected
    // before validation is even reached, and removing the schema check would
    // leave this test green — measured.
    let not_a_recorder = dir.join("not-a-recorder.sqlite");
    let connection = Connection::open(&not_a_recorder).unwrap();
    connection
        .execute_batch("create table something_else (a integer)")
        .unwrap();
    connection.close().unwrap();

    let env = json!([
        { "name": "", "kind": "toggl_activity", "path": good.to_string_lossy() },
        { "name": "Unknown kind", "kind": "rescuetime", "path": good.to_string_lossy() },
        { "name": "Missing file", "kind": "toggl_activity", "path": "/nowhere/at/all.sqlite" },
        { "name": "Wrong shape", "kind": "toggl_activity", "path": not_a_recorder.to_string_lossy() },
        { "name": "Good", "kind": "toggl_activity", "path": good.to_string_lossy() },
    ])
    .to_string();

    assert_eq!(bootstrap_sources(&pool, Some(&env)).await, 1);
    let sources = sources_of(&pool).await;
    assert_eq!(sources.len(), 1);
    assert_eq!(sources[0]["name"], "Good");
}

#[sqlx::test]
async fn invalid_json_is_ignored_rather_than_fatal(pool: PgPool) {
    for raw in [
        "not json at all",
        "{}",
        "[{\"name\": \"No path\"}]",
        "",
        "   ",
    ] {
        assert_eq!(
            bootstrap_sources(&pool, Some(raw)).await,
            0,
            "{raw:?} should have been ignored"
        );
    }
    assert!(sources_of(&pool).await.is_empty());

    // And a Server left in that state can still be repaired through Settings.
    let dir = scratch_dir("repairable");
    let path = dir.join("db.sqlite");
    write_toggl_db(&path, &[one_activity(&[0xe7], "Xcode")]);
    let source = create_toggl_source(&pool, "Added by hand", &path).await;
    wait_for_intervals(&pool, source, 1).await;
}
