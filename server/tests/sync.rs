use std::path::PathBuf;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use chrono::Utc;
use http_body_util::BodyExt;
use meologue_server::sync::SYNC_BATCH_SIZE;
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

// These tests only ever hit /v1/sync, never a static asset — any directory
// that exists is fine as the (otherwise unused) static_dir.
fn empty_static_dir() -> PathBuf {
    std::env::current_dir().unwrap()
}

async fn post_sync(pool: &PgPool, body: Value) -> (StatusCode, Value) {
    let app = meologue_server::router(pool.clone(), empty_static_dir());
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/sync")
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
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

fn entry(id: Uuid, device_id: Uuid, body: &str) -> Value {
    json!({
        "id": id,
        "device_id": device_id,
        "body": body,
        "created_at": "2026-01-01T00:00:00Z",
        "deleted_at": Value::Null,
    })
}

/// Like `entry`, but marks the push as a delete (ticket 2) — same `id` as
/// whatever Entry is being tombstoned, with `deleted_at` set. `body` is
/// still supplied because `EntryInput::body` isn't optional, mirroring what
/// a real client sends (a blank body alongside the tombstone timestamp —
/// see `server/src/sync.rs`'s module comment).
fn deleted_entry(id: Uuid, device_id: Uuid, deleted_at: &str) -> Value {
    json!({
        "id": id,
        "device_id": device_id,
        "body": "",
        "created_at": "2026-01-01T00:00:00Z",
        "deleted_at": deleted_at,
    })
}

#[sqlx::test]
async fn an_entry_round_trips_to_a_later_poll_with_a_lower_cursor(pool: PgPool) {
    let device_a = Uuid::new_v4();
    let device_b = Uuid::new_v4();
    let entry_id = Uuid::new_v4();

    let (status, posted) = post_sync(
        &pool,
        json!({
            "protocol_version": 2,
            "device_id": device_a,
            "since_seq": 0,
            "entries": [entry(entry_id, device_a, "hello meologue")],
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let cursor = posted["cursor"].as_i64().unwrap();
    assert!(cursor > 0);

    // A different device, polling from before the entry existed, should read it back.
    let (status, polled) = post_sync(
        &pool,
        json!({
            "protocol_version": 2,
            "device_id": device_b,
            "since_seq": 0,
            "entries": [],
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let entries = polled["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["id"], entry_id.to_string());
    assert_eq!(entries[0]["seq"], cursor);
    assert_eq!(polled["cursor"], cursor);
}

#[sqlx::test]
async fn replaying_the_same_request_creates_no_duplicate_rows(pool: PgPool) {
    let device = Uuid::new_v4();
    let entry_id = Uuid::new_v4();
    let request = json!({
        "protocol_version": 2,
        "device_id": device,
        "since_seq": 0,
        "entries": [entry(entry_id, device, "hello meologue")],
    });

    let (status_first, first) = post_sync(&pool, request.clone()).await;
    let (status_second, second) = post_sync(&pool, request).await;
    assert_eq!(status_first, StatusCode::OK);
    assert_eq!(status_second, StatusCode::OK);
    assert_eq!(first["cursor"], second["cursor"]);

    let count: i64 = sqlx::query_scalar("select count(*) from entries where id = $1")
        .bind(entry_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
}

#[sqlx::test]
async fn an_unrecognised_protocol_version_is_rejected(pool: PgPool) {
    let (status, _) = post_sync(
        &pool,
        json!({
            "protocol_version": 999,
            "device_id": Uuid::new_v4(),
            "since_seq": 0,
            "entries": [],
        }),
    )
    .await;
    assert_eq!(status, StatusCode::UPGRADE_REQUIRED);
}

#[sqlx::test]
async fn the_response_is_capped_at_the_bounded_batch_size(pool: PgPool) {
    let device = Uuid::new_v4();
    let total = SYNC_BATCH_SIZE + 10;

    // Seed directly — it's the read side's batching under test, not the write path.
    let ids: Vec<Uuid> = (0..total).map(|_| Uuid::new_v4()).collect();
    let device_ids: Vec<Uuid> = std::iter::repeat_n(device, total as usize).collect();
    let bodies: Vec<String> = (0..total).map(|i| format!("entry-{i}")).collect();
    let created_ats: Vec<chrono::DateTime<Utc>> = std::iter::repeat_n(Utc::now(), total as usize).collect();

    sqlx::query(
        "insert into entries (id, device_id, body, created_at)
         select * from unnest($1::uuid[], $2::uuid[], $3::text[], $4::timestamptz[])",
    )
    .bind(&ids)
    .bind(&device_ids)
    .bind(&bodies)
    .bind(&created_ats)
    .execute(&pool)
    .await
    .unwrap();

    let (status, body) = post_sync(
        &pool,
        json!({
            "protocol_version": 2,
            "device_id": device,
            "since_seq": 0,
            "entries": [],
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let entries = body["entries"].as_array().unwrap();
    assert_eq!(entries.len() as i64, SYNC_BATCH_SIZE);

    let expected_cursor: i64 = sqlx::query_scalar(
        "select seq from entries order by seq asc limit 1 offset $1",
    )
    .bind(SYNC_BATCH_SIZE - 1)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(body["cursor"], expected_cursor);
}

/// This is the property ticket 2 exists for: `entries.seq` is assigned once
/// at insert (a plain Postgres `bigserial`), so a Device whose cursor has
/// already advanced past an Entry's original `seq` can only ever see an
/// edit to it if the edit is reassigned a *new*, higher `seq` — a plain
/// `update` would leave the mutation sitting behind that Device's cursor
/// forever. Exercised end to end through two real `post_sync` round trips
/// (push the original, advance a second device's cursor past it, push the
/// edit, poll again) rather than by inspecting `entries` directly, because
/// the SQL alone can't tell you whether sync as a *protocol* actually
/// delivers the edit.
#[sqlx::test]
async fn an_edit_reaches_a_device_whose_cursor_already_passed_the_original(pool: PgPool) {
    let device_a = Uuid::new_v4();
    let device_b = Uuid::new_v4();
    let entry_id = Uuid::new_v4();

    let (_, posted) = post_sync(
        &pool,
        json!({
            "protocol_version": 2,
            "device_id": device_a,
            "since_seq": 0,
            "entries": [entry(entry_id, device_a, "original body")],
        }),
    )
    .await;
    let original_cursor = posted["cursor"].as_i64().unwrap();

    // Device B polls now, moving its cursor to (at least) the original's seq —
    // it has genuinely seen this Entry, before the edit exists.
    let (_, polled) = post_sync(
        &pool,
        json!({
            "protocol_version": 2,
            "device_id": device_b,
            "since_seq": 0,
            "entries": [],
        }),
    )
    .await;
    let device_b_cursor = polled["cursor"].as_i64().unwrap();
    assert!(device_b_cursor >= original_cursor);

    // Device A pushes an edit to the same Entry — same id, new body.
    let (status, edited) = post_sync(
        &pool,
        json!({
            "protocol_version": 2,
            "device_id": device_a,
            "since_seq": original_cursor,
            "entries": [entry(entry_id, device_a, "edited body")],
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let edit_cursor = edited["cursor"].as_i64().unwrap();
    assert!(
        edit_cursor > device_b_cursor,
        "the edit's reassigned seq ({edit_cursor}) must land above the cursor \
         device B already advanced past ({device_b_cursor}), or the edit is unreachable"
    );

    // Device B polls again from its already-advanced cursor and must receive the edit.
    let (status, repolled) = post_sync(
        &pool,
        json!({
            "protocol_version": 2,
            "device_id": device_b,
            "since_seq": device_b_cursor,
            "entries": [],
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let entries = repolled["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["id"], entry_id.to_string());
    assert_eq!(entries[0]["body"], "edited body");
    assert_eq!(entries[0]["deleted_at"], Value::Null);
}

#[sqlx::test]
async fn a_tombstone_is_returned_by_a_poll_with_deleted_at_set_and_a_blank_body(pool: PgPool) {
    let device = Uuid::new_v4();
    let entry_id = Uuid::new_v4();

    post_sync(
        &pool,
        json!({
            "protocol_version": 2,
            "device_id": device,
            "since_seq": 0,
            "entries": [entry(entry_id, device, "gone soon")],
        }),
    )
    .await;

    let (status, _deleted) = post_sync(
        &pool,
        json!({
            "protocol_version": 2,
            "device_id": device,
            "since_seq": 0,
            "entries": [deleted_entry(entry_id, device, "2026-02-01T00:00:00Z")],
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // Polling from before this Entry ever existed still surfaces it — as a tombstone.
    let (status, polled) = post_sync(
        &pool,
        json!({
            "protocol_version": 2,
            "device_id": Uuid::new_v4(),
            "since_seq": 0,
            "entries": [],
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let entries = polled["entries"].as_array().unwrap();
    let tombstone = entries.iter().find(|e| e["id"] == entry_id.to_string()).unwrap();
    assert_eq!(tombstone["deleted_at"], "2026-02-01T00:00:00Z");
    assert_eq!(tombstone["body"], "");
}

/// Delete is terminal (`sync.rs::insert_entries`'s `where entries.deleted_at
/// is null` guard): once an Entry is tombstoned, no further push against
/// its `id` — however new the pushed body claims to be — can revive or
/// change it. This is what lets an offline Device's stale edit, pushed
/// after the Entry was deleted elsewhere, resolve itself with no
/// reconciliation logic anywhere: the upsert's `where` clause is the whole
/// policy.
#[sqlx::test]
async fn pushing_an_edit_to_an_already_deleted_entry_is_a_no_op(pool: PgPool) {
    let device = Uuid::new_v4();
    let entry_id = Uuid::new_v4();

    post_sync(
        &pool,
        json!({
            "protocol_version": 2,
            "device_id": device,
            "since_seq": 0,
            "entries": [entry(entry_id, device, "original body")],
        }),
    )
    .await;
    let (_, deleted) = post_sync(
        &pool,
        json!({
            "protocol_version": 2,
            "device_id": device,
            "since_seq": 0,
            "entries": [deleted_entry(entry_id, device, "2026-02-01T00:00:00Z")],
        }),
    )
    .await;
    let cursor_after_delete = deleted["cursor"].as_i64().unwrap();

    // An offline device's stale edit, pushed after the delete already happened server-side.
    let (status, edited) = post_sync(
        &pool,
        json!({
            "protocol_version": 2,
            "device_id": device,
            "since_seq": 0,
            "entries": [entry(entry_id, device, "an edit that arrived too late")],
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        edited["cursor"], cursor_after_delete,
        "a no-op push must not move the cursor"
    );

    let row: (String, Option<chrono::DateTime<Utc>>) =
        sqlx::query_as("select body, deleted_at from entries where id = $1")
            .bind(entry_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(row.0, "", "the tombstone's body must not be overwritten by the late edit");
    assert!(row.1.is_some(), "deleted_at must remain set");
}

/// Guards the `is distinct from` pair in `insert_entries`'s upsert `where`
/// clause: without it, re-pushing an unchanged Entry would still match
/// `on conflict` and reassign `seq`, moving every Device's cursor on every
/// single replay. `replaying_the_same_request_creates_no_duplicate_rows`
/// above already covers the identical-request case within one `post_sync`
/// call; this test isolates the same guarantee across two independent
/// pushes of the same unchanged Entry, since it's specifically that pair of
/// `is distinct from` comparisons — not `on conflict do nothing` — doing
/// the work now.
#[sqlx::test]
async fn replaying_an_unchanged_entry_across_two_pushes_does_not_move_the_cursor(pool: PgPool) {
    let device = Uuid::new_v4();
    let entry_id = Uuid::new_v4();

    let (_, first) = post_sync(
        &pool,
        json!({
            "protocol_version": 2,
            "device_id": device,
            "since_seq": 0,
            "entries": [entry(entry_id, device, "unchanged body")],
        }),
    )
    .await;
    let first_cursor = first["cursor"].as_i64().unwrap();

    let (status, second) = post_sync(
        &pool,
        json!({
            "protocol_version": 2,
            "device_id": device,
            "since_seq": 0,
            "entries": [entry(entry_id, device, "unchanged body")],
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(second["cursor"], first_cursor);

    let seq: i64 = sqlx::query_scalar("select seq from entries where id = $1")
        .bind(entry_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(seq, first_cursor, "an unchanged replay must not reassign seq");
}

#[sqlx::test]
async fn protocol_version_1_is_now_rejected(pool: PgPool) {
    let (status, _) = post_sync(
        &pool,
        json!({
            "protocol_version": 1,
            "device_id": Uuid::new_v4(),
            "since_seq": 0,
            "entries": [],
        }),
    )
    .await;
    assert_eq!(status, StatusCode::UPGRADE_REQUIRED);
}
