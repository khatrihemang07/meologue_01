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
        Some(id) => format!("/v1/time/intervals?day={day}&source_id={id}"),
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

    // Clockify's adapter is issue #420. Until it exists, claiming its kind has
    // to fail rather than be quietly imported by the Toggl reader.
    let (wrong_kind, _) = create_source(&pool, "Clockify", "clockify_auto_tracker", &path).await;
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

#[sqlx::test]
async fn a_record_spanning_midnight_belongs_to_both_days_it_covers(pool: PgPool) {
    let dir = scratch_dir("midnight");
    let path = dir.join("db.sqlite");
    write_toggl_db(
        &path,
        &[
            Activity {
                id: &[0x60],
                start: MIDNIGHT_START,
                end: Some(MIDNIGHT_END),
                filename: "Across midnight",
                title: None,
                idle: 0,
                client: &[],
            },
            Activity {
                id: &[0x61],
                start: OTHER_DAY_START,
                end: Some(OTHER_DAY_END),
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
