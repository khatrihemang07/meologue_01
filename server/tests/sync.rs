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
            "protocol_version": 4,
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
            "protocol_version": 4,
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
        "protocol_version": 4,
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
            "protocol_version": 4,
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
            "protocol_version": 4,
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
            "protocol_version": 4,
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
            "protocol_version": 4,
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
            "protocol_version": 4,
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
            "protocol_version": 4,
            "device_id": device,
            "since_seq": 0,
            "entries": [entry(entry_id, device, "gone soon")],
        }),
    )
    .await;

    let (status, _deleted) = post_sync(
        &pool,
        json!({
            "protocol_version": 4,
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
            "protocol_version": 4,
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
            "protocol_version": 4,
            "device_id": device,
            "since_seq": 0,
            "entries": [entry(entry_id, device, "original body")],
        }),
    )
    .await;
    let (_, deleted) = post_sync(
        &pool,
        json!({
            "protocol_version": 4,
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
            "protocol_version": 4,
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
            "protocol_version": 4,
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
            "protocol_version": 4,
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

/// Issue #194 — the case no existing test covers, named explicitly in the
/// ticket's own acceptance bar: an identical-content re-push against a
/// Cursor that has **already advanced past** the row's own seq, not merely
/// a re-push from `since_seq: 0` the way every replay test above this one
/// happens to use. A `since_seq: 0` poll always gets everything back
/// regardless of whether `is distinct from` fired, which is exactly why
/// nothing above ever needed `acknowledged_entries` to pass. A Device that
/// already holds this row's own seq as its Cursor is the shape that
/// actually reproduces the bug: `entries` (the Cursor-paged read) must
/// come back empty — `seq` genuinely didn't move — and without
/// `acknowledged_entries`, that Device would have no way to learn its push
/// was received at all, and would re-push this exact row on every future
/// poll forever.
#[sqlx::test]
async fn a_no_op_replay_past_the_cursor_is_still_acknowledged(pool: PgPool) {
    let device = Uuid::new_v4();
    let entry_id = Uuid::new_v4();

    let (_, first) = post_sync(
        &pool,
        json!({
            "protocol_version": 4,
            "device_id": device,
            "since_seq": 0,
            "entries": [entry(entry_id, device, "unchanged body")],
        }),
    )
    .await;
    let cursor = first["cursor"].as_i64().unwrap();

    // Same content, but `since_seq` is now the row's own seq — this
    // Device has genuinely already seen it, unlike every replay test
    // above that keeps polling from 0.
    let (status, second) = post_sync(
        &pool,
        json!({
            "protocol_version": 4,
            "device_id": device,
            "since_seq": cursor,
            "entries": [entry(entry_id, device, "unchanged body")],
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    assert_eq!(
        second["entries"].as_array().unwrap().len(),
        0,
        "seq didn't move, so a Cursor already at it correctly gets nothing back from the ordinary read"
    );
    assert_eq!(second["cursor"], cursor, "acknowledging a no-op must not move the cursor");

    let acknowledged = second["acknowledged_entries"].as_array().unwrap();
    assert_eq!(acknowledged.len(), 1);
    assert_eq!(acknowledged[0]["id"], entry_id.to_string());
    assert_eq!(acknowledged[0]["body"], "unchanged body");
    assert_eq!(acknowledged[0]["seq"], cursor, "the unchanged row's own seq must not have moved");
}

/// Issue #194's other acceptance criterion: a push whose edit the
/// delete-is-terminal guard refuses must still tell the pushing Device the
/// truth about the row — the tombstone it was refused against — rather
/// than leaving that Device believing its own (rejected) edit landed.
/// Without `acknowledged_entries`, this Device has no way to learn the
/// refusal except waiting for the tombstone to happen to fall inside some
/// later poll's Cursor-paged `entries`.
#[sqlx::test]
async fn acknowledged_entries_returns_the_tombstone_when_an_edit_is_refused(pool: PgPool) {
    let device = Uuid::new_v4();
    let entry_id = Uuid::new_v4();

    post_sync(
        &pool,
        json!({
            "protocol_version": 4,
            "device_id": device,
            "since_seq": 0,
            "entries": [entry(entry_id, device, "original body")],
        }),
    )
    .await;
    post_sync(
        &pool,
        json!({
            "protocol_version": 4,
            "device_id": device,
            "since_seq": 0,
            "entries": [deleted_entry(entry_id, device, "2026-02-01T00:00:00Z")],
        }),
    )
    .await;

    // An offline Device's stale edit, pushed after the delete already
    // happened server-side — refused by the `where entries.deleted_at is
    // null` guard (`pushing_an_edit_to_an_already_deleted_entry_is_a_no_op`
    // above already proves the row itself is untouched by this push; this
    // test is about what the *response* tells the Device that sent it).
    let (status, edited) = post_sync(
        &pool,
        json!({
            "protocol_version": 4,
            "device_id": device,
            "since_seq": 0,
            "entries": [entry(entry_id, device, "an edit that arrived too late")],
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let acknowledged = edited["acknowledged_entries"].as_array().unwrap();
    assert_eq!(acknowledged.len(), 1);
    assert_eq!(acknowledged[0]["id"], entry_id.to_string());
    assert_eq!(
        acknowledged[0]["deleted_at"], "2026-02-01T00:00:00Z",
        "the Device must learn the tombstone its edit was refused against"
    );
    assert_eq!(
        acknowledged[0]["body"], "",
        "the tombstone's body must not be overwritten by the refused edit"
    );
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

/// Issue #96 bumped `PROTOCOL_VERSION` from 2 to 3 — for a `/v1/reflect`
/// wire change, not anything about sync's own shape (`sync::PROTOCOL_VERSION`'s
/// own doc comment covers why one shared constant means a Device that
/// predates issue #96 is turned away here too). This is the sharper version
/// of `an_unrecognised_protocol_version_is_rejected` above: not an
/// arbitrary invalid number, but the *real* version every Device spoke
/// before this ticket — proving the bump actually took effect for `/v1/sync`,
/// exactly as `reflect.rs`'s own
/// `a_device_speaking_the_pre_bump_protocol_version_is_rejected` proves it
/// for `/v1/reflect`.
#[sqlx::test]
async fn protocol_version_2_is_now_rejected(pool: PgPool) {
    let (status, _) = post_sync(
        &pool,
        json!({
            "protocol_version": 2,
            "device_id": Uuid::new_v4(),
            "since_seq": 0,
            "entries": [],
        }),
    )
    .await;
    assert_eq!(status, StatusCode::UPGRADE_REQUIRED);
}

/// Issue #104 bumped `PROTOCOL_VERSION` from 3 to 4 — for the
/// `turn_start` -> `step_start` SSE rename (`sync::PROTOCOL_VERSION`'s own
/// doc comment covers why one shared constant means a Device that predates
/// issue #104 is turned away here too, even though nothing about sync's own
/// shape changed). This is the sharper version of
/// `an_unrecognised_protocol_version_is_rejected` above: not an arbitrary
/// invalid number, but the *real* version every Device spoke before this
/// ticket — proving the bump actually took effect for `/v1/sync`, exactly
/// as `reflect.rs`'s own `a_device_speaking_the_pre_bump_protocol_version_is_rejected`
/// proves it for `/v1/reflect`.
#[sqlx::test]
async fn protocol_version_3_is_now_rejected(pool: PgPool) {
    let (status, _) = post_sync(
        &pool,
        json!({
            "protocol_version": 3,
            "device_id": Uuid::new_v4(),
            "since_seq": 0,
            "entries": [],
        }),
    )
    .await;
    assert_eq!(status, StatusCode::UPGRADE_REQUIRED);
}

// Issue #172 / ADR 0051: Tasks are the first non-Entry thing this Server
// has ever Synced. `task`/`deleted_task` mirror `entry`/`deleted_entry`
// above field for field — see `server/src/sync.rs`'s own `TaskInput` doc
// comment for what each one means — and every test below mirrors the
// identically-named Entry test above it, proving the same guarantee holds
// for the second entity stream rather than assuming ADR 0028's rules
// "just work" because the code happens to look similar.
fn task(id: Uuid, device_id: Uuid, content: &str) -> Value {
    json!({
        "id": id,
        "device_id": device_id,
        "content": content,
        "completed_at": Value::Null,
        "order_key": "V",
        "created_at": "2026-01-01T00:00:00Z",
        "deleted_at": Value::Null,
        "date": Value::Null,
        "deadline": Value::Null,
        "priority": 1,
        "label_ids": Value::Array(vec![]),
        "date_string": Value::Null,
        "project_id": Value::Null,
        "section_id": Value::Null,
        "parent_id": Value::Null,
    })
}

/// Like `task`, but marks the push as a delete — same shape
/// `deleted_entry` gives for Entries, with the same `content: ""` +
/// `deleted_at` set representation (ADR 0028, applied to Tasks by ADR
/// 0047).
fn deleted_task(id: Uuid, device_id: Uuid, deleted_at: &str) -> Value {
    let mut t = task(id, device_id, "");
    t["deleted_at"] = json!(deleted_at);
    t
}

fn sync_request(protocol_version: i32, device_id: Uuid, tasks: Vec<Value>) -> Value {
    json!({
        "protocol_version": protocol_version,
        "device_id": device_id,
        "since_seq": 0,
        "entries": [],
        "since_task_seq": 0,
        "tasks": tasks,
    })
}

#[sqlx::test]
async fn a_task_round_trips_to_a_later_poll_with_a_lower_task_cursor(pool: PgPool) {
    let device_a = Uuid::new_v4();
    let device_b = Uuid::new_v4();
    let task_id = Uuid::new_v4();

    let (status, posted) = post_sync(
        &pool,
        sync_request(5, device_a, vec![task(task_id, device_a, "buy milk")]),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let task_cursor = posted["task_cursor"].as_i64().unwrap();
    assert!(task_cursor > 0);
    // The Entry stream is untouched by a Task-only push — ADR 0051's two
    // independent Cursors, proven here rather than only asserted in a
    // doc comment.
    assert_eq!(posted["cursor"], 0);
    assert_eq!(posted["entries"].as_array().unwrap().len(), 0);

    let (status, polled) =
        post_sync(&pool, sync_request(5, device_b, vec![])).await;
    assert_eq!(status, StatusCode::OK);
    let tasks = polled["tasks"].as_array().unwrap();
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0]["id"], task_id.to_string());
    assert_eq!(tasks[0]["content"], "buy milk");
    assert_eq!(tasks[0]["seq"], task_cursor);
    assert_eq!(polled["task_cursor"], task_cursor);
}

#[sqlx::test]
async fn replaying_the_same_task_request_creates_no_duplicate_rows(pool: PgPool) {
    let device = Uuid::new_v4();
    let task_id = Uuid::new_v4();
    let request = sync_request(5, device, vec![task(task_id, device, "buy milk")]);

    let (status_first, first) = post_sync(&pool, request.clone()).await;
    let (status_second, second) = post_sync(&pool, request).await;
    assert_eq!(status_first, StatusCode::OK);
    assert_eq!(status_second, StatusCode::OK);
    assert_eq!(first["task_cursor"], second["task_cursor"]);

    let count: i64 = sqlx::query_scalar("select count(*) from tasks where id = $1")
        .bind(task_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
}

/// Guards the (much longer) `is distinct from` chain in `insert_tasks`'s
/// upsert `where` clause — the Task-shaped sibling of
/// `replaying_an_unchanged_entry_across_two_pushes_does_not_move_the_cursor`.
#[sqlx::test]
async fn replaying_an_unchanged_task_across_two_pushes_does_not_move_the_task_cursor(pool: PgPool) {
    let device = Uuid::new_v4();
    let task_id = Uuid::new_v4();

    let (_, first) = post_sync(
        &pool,
        sync_request(5, device, vec![task(task_id, device, "unchanged content")]),
    )
    .await;
    let first_cursor = first["task_cursor"].as_i64().unwrap();

    let (status, second) = post_sync(
        &pool,
        sync_request(5, device, vec![task(task_id, device, "unchanged content")]),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(second["task_cursor"], first_cursor);

    let seq: i64 = sqlx::query_scalar("select seq from tasks where id = $1")
        .bind(task_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(seq, first_cursor, "an unchanged replay must not reassign seq");
}

/// The Task-shaped sibling of
/// `a_no_op_replay_past_the_cursor_is_still_acknowledged` — the identical
/// case, over the second stream: an identical-content re-push against a
/// Task Cursor that has already advanced past the row's own seq, not
/// merely a re-push from `since_task_seq: 0`.
#[sqlx::test]
async fn a_no_op_task_replay_past_the_cursor_is_still_acknowledged(pool: PgPool) {
    let device = Uuid::new_v4();
    let task_id = Uuid::new_v4();

    let (_, first) = post_sync(
        &pool,
        sync_request(5, device, vec![task(task_id, device, "unchanged content")]),
    )
    .await;
    let task_cursor = first["task_cursor"].as_i64().unwrap();

    let mut second_request = sync_request(5, device, vec![task(task_id, device, "unchanged content")]);
    second_request["since_task_seq"] = json!(task_cursor);
    let (status, second) = post_sync(&pool, second_request).await;
    assert_eq!(status, StatusCode::OK);

    assert_eq!(
        second["tasks"].as_array().unwrap().len(),
        0,
        "seq didn't move, so a Task Cursor already at it correctly gets nothing back from the ordinary read"
    );
    assert_eq!(
        second["task_cursor"], task_cursor,
        "acknowledging a no-op must not move the task cursor"
    );

    let acknowledged = second["acknowledged_tasks"].as_array().unwrap();
    assert_eq!(acknowledged.len(), 1);
    assert_eq!(acknowledged[0]["id"], task_id.to_string());
    assert_eq!(acknowledged[0]["content"], "unchanged content");
    assert_eq!(
        acknowledged[0]["seq"], task_cursor,
        "the unchanged row's own seq must not have moved"
    );
}

/// Issue #182 put `day_order` on the wire in the same bump as `description`
/// (`TaskInput::day_order`'s own doc comment) — this is the one guard this
/// change is riskiest to get wrong silently: `insert_tasks`'s `where`
/// clause has to name `day_order` in its `is distinct from` chain, or a
/// push that changes *only* `day_order` (a Today drag, with no rename, no
/// reschedule, nothing else different) satisfies none of the other
/// columns' `is distinct from` checks, the `where` evaluates false, and
/// the whole `on conflict do update` silently does not fire at all — not
/// merely "seq doesn't move," but the new `day_order` value is never
/// written and never reaches another Device. Pushing an *unchanged*
/// `content` alongside a *changed* `day_order` is what isolates this: if
/// `day_order` were missing from the guard, this second push would look
/// exactly like the unchanged-replay case just above and be silently
/// dropped.
#[sqlx::test]
async fn a_push_that_changes_only_day_order_still_reassigns_seq_and_is_not_dropped(pool: PgPool) {
    let device = Uuid::new_v4();
    let task_id = Uuid::new_v4();

    let mut first_push = task(task_id, device, "unchanged content");
    first_push["day_order"] = json!("A");
    let (_, first) = post_sync(&pool, sync_request(6, device, vec![first_push])).await;
    let first_cursor = first["task_cursor"].as_i64().unwrap();

    let mut second_push = task(task_id, device, "unchanged content");
    second_push["day_order"] = json!("B");
    let (status, second) = post_sync(&pool, sync_request(6, device, vec![second_push])).await;
    assert_eq!(status, StatusCode::OK);
    let second_cursor = second["task_cursor"].as_i64().unwrap();
    assert!(
        second_cursor > first_cursor,
        "a day_order-only change must reassign seq, exactly like a content-only change already does"
    );

    let (day_order, seq): (String, i64) =
        sqlx::query_as("select day_order, seq from tasks where id = $1")
            .bind(task_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(day_order, "B", "the changed day_order must actually be written, not dropped");
    assert_eq!(seq, second_cursor);
}

#[sqlx::test]
async fn a_tombstoned_task_is_returned_by_a_poll_with_deleted_at_set_and_a_blank_content(
    pool: PgPool,
) {
    let device = Uuid::new_v4();
    let task_id = Uuid::new_v4();

    post_sync(
        &pool,
        sync_request(5, device, vec![task(task_id, device, "gone soon")]),
    )
    .await;

    let (status, _deleted) = post_sync(
        &pool,
        sync_request(
            5,
            device,
            vec![deleted_task(task_id, device, "2026-02-01T00:00:00Z")],
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, polled) = post_sync(&pool, sync_request(5, Uuid::new_v4(), vec![])).await;
    assert_eq!(status, StatusCode::OK);
    let tasks = polled["tasks"].as_array().unwrap();
    let tombstone = tasks.iter().find(|t| t["id"] == task_id.to_string()).unwrap();
    assert_eq!(tombstone["deleted_at"], "2026-02-01T00:00:00Z");
    assert_eq!(tombstone["content"], "");
}

/// Delete is terminal for a Task too (`insert_tasks`'s `where
/// tasks.deleted_at is null` guard) — the Task-shaped sibling of
/// `pushing_an_edit_to_an_already_deleted_entry_is_a_no_op`.
#[sqlx::test]
async fn pushing_an_edit_to_an_already_deleted_task_is_a_no_op(pool: PgPool) {
    let device = Uuid::new_v4();
    let task_id = Uuid::new_v4();

    post_sync(
        &pool,
        sync_request(5, device, vec![task(task_id, device, "original content")]),
    )
    .await;
    let (_, deleted) = post_sync(
        &pool,
        sync_request(
            5,
            device,
            vec![deleted_task(task_id, device, "2026-02-01T00:00:00Z")],
        ),
    )
    .await;
    let cursor_after_delete = deleted["task_cursor"].as_i64().unwrap();

    // An offline Device's stale edit, pushed after the delete already
    // happened server-side.
    let (status, edited) = post_sync(
        &pool,
        sync_request(
            5,
            device,
            vec![task(task_id, device, "an edit that arrived too late")],
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        edited["task_cursor"], cursor_after_delete,
        "a no-op push must not move the task cursor"
    );

    let row: (String, Option<chrono::DateTime<Utc>>) =
        sqlx::query_as("select content, deleted_at from tasks where id = $1")
            .bind(task_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        row.0, "",
        "the tombstone's content must not be overwritten by the late edit"
    );
    assert!(row.1.is_some(), "deleted_at must remain set");
}

/// The Task-shaped sibling of
/// `an_edit_reaches_a_device_whose_cursor_already_passed_the_original` —
/// proves `seq = nextval(...)` reassignment (the mechanism the module
/// comment at the top of `sync.rs` describes) makes a Task edit reachable
/// by a Device that already advanced its Task Cursor past the original.
#[sqlx::test]
async fn a_task_edit_reaches_a_device_whose_task_cursor_already_passed_the_original(pool: PgPool) {
    let device_a = Uuid::new_v4();
    let device_b = Uuid::new_v4();
    let task_id = Uuid::new_v4();

    let (_, posted) = post_sync(
        &pool,
        sync_request(5, device_a, vec![task(task_id, device_a, "original content")]),
    )
    .await;
    let original_cursor = posted["task_cursor"].as_i64().unwrap();

    let (_, polled) = post_sync(&pool, sync_request(5, device_b, vec![])).await;
    let device_b_cursor = polled["task_cursor"].as_i64().unwrap();
    assert!(device_b_cursor >= original_cursor);

    let (status, edited) = post_sync(
        &pool,
        sync_request(5, device_a, vec![task(task_id, device_a, "edited content")]),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let edit_cursor = edited["task_cursor"].as_i64().unwrap();
    assert!(
        edit_cursor > device_b_cursor,
        "the edit's reassigned seq ({edit_cursor}) must land above the task cursor \
         device B already advanced past ({device_b_cursor}), or the edit is unreachable"
    );

    let mut repoll = sync_request(5, device_b, vec![]);
    repoll["since_task_seq"] = json!(device_b_cursor);
    let (status, repolled) = post_sync(&pool, repoll).await;
    assert_eq!(status, StatusCode::OK);
    let tasks = repolled["tasks"].as_array().unwrap();
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0]["id"], task_id.to_string());
    assert_eq!(tasks[0]["content"], "edited content");
}

#[sqlx::test]
async fn the_task_response_is_capped_at_the_bounded_batch_size(pool: PgPool) {
    let device = Uuid::new_v4();
    let total = SYNC_BATCH_SIZE + 10;

    let ids: Vec<Uuid> = (0..total).map(|_| Uuid::new_v4()).collect();
    let device_ids: Vec<Uuid> = std::iter::repeat_n(device, total as usize).collect();
    let contents: Vec<String> = (0..total).map(|i| format!("task-{i}")).collect();
    let order_keys: Vec<String> = (0..total).map(|i| format!("k{i}")).collect();
    let created_ats: Vec<chrono::DateTime<Utc>> =
        std::iter::repeat_n(Utc::now(), total as usize).collect();
    let priorities: Vec<i32> = std::iter::repeat_n(1, total as usize).collect();

    sqlx::query(
        "insert into tasks (id, device_id, content, order_key, day_order, created_at, priority)
         select * from unnest($1::uuid[], $2::uuid[], $3::text[], $4::text[], $4::text[], $5::timestamptz[], $6::int[])",
    )
    .bind(&ids)
    .bind(&device_ids)
    .bind(&contents)
    .bind(&order_keys)
    .bind(&created_ats)
    .bind(&priorities)
    .execute(&pool)
    .await
    .unwrap();

    let (status, body) = post_sync(&pool, sync_request(5, device, vec![])).await;
    assert_eq!(status, StatusCode::OK);
    let tasks = body["tasks"].as_array().unwrap();
    assert_eq!(tasks.len() as i64, SYNC_BATCH_SIZE);

    let expected_cursor: i64 =
        sqlx::query_scalar("select seq from tasks order by seq asc limit 1 offset $1")
            .bind(SYNC_BATCH_SIZE - 1)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(body["task_cursor"], expected_cursor);
}

/// ADR 0051's whole reason for one endpoint rather than two: an Entry and
/// a Task pushed in the same request travel through, and arrive on
/// another Device, together — never one without the other because a
/// second round trip hadn't happened yet.
#[sqlx::test]
async fn an_entry_and_a_task_travel_together_in_one_round_trip(pool: PgPool) {
    let device_a = Uuid::new_v4();
    let device_b = Uuid::new_v4();
    let entry_id = Uuid::new_v4();
    let task_id = Uuid::new_v4();

    let (status, posted) = post_sync(
        &pool,
        json!({
            "protocol_version": 5,
            "device_id": device_a,
            "since_seq": 0,
            "entries": [entry(entry_id, device_a, "wrote about buying milk")],
            "since_task_seq": 0,
            "tasks": [task(task_id, device_a, "buy milk")],
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(posted["cursor"].as_i64().unwrap() > 0);
    assert!(posted["task_cursor"].as_i64().unwrap() > 0);

    let (status, polled) = post_sync(&pool, sync_request(5, device_b, vec![])).await;
    assert_eq!(status, StatusCode::OK);
    let entries = polled["entries"].as_array().unwrap();
    let tasks = polled["tasks"].as_array().unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(tasks.len(), 1);
    assert_eq!(entries[0]["id"], entry_id.to_string());
    assert_eq!(tasks[0]["id"], task_id.to_string());
}

/// The acceptance criterion issue #172 names explicitly: a Device still on
/// protocol 4 — built before Tasks existed, so its own request body has no
/// `tasks`/`since_task_seq` keys at all — keeps syncing Entries exactly as
/// before, and simply never sees a Task, even though another Device has
/// pushed one. Built by hand rather than through `sync_request` above,
/// specifically *without* the two new keys, to model what a real v4
/// build's JSON actually looks like rather than a v5 request that merely
/// claims to be v4.
#[sqlx::test]
async fn a_v4_client_syncs_entries_and_receives_no_tasks(pool: PgPool) {
    let device_v5 = Uuid::new_v4();
    let device_v4 = Uuid::new_v4();
    let entry_id = Uuid::new_v4();
    let task_id = Uuid::new_v4();

    // A v5 Device pushes a Task first, so there is something a v4 Device
    // could wrongly receive if the dual-version gate didn't hold.
    post_sync(
        &pool,
        sync_request(5, device_v5, vec![task(task_id, device_v5, "buy milk")]),
    )
    .await;

    let (status, response) = post_sync(
        &pool,
        json!({
            "protocol_version": 4,
            "device_id": device_v4,
            "since_seq": 0,
            "entries": [entry(entry_id, device_v4, "a v4 Device's own Entry")],
        }),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    let entries = response["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 1, "Entries must sync exactly as before protocol 5");
    assert_eq!(entries[0]["id"], entry_id.to_string());
    assert_eq!(
        response["tasks"].as_array().unwrap().len(),
        0,
        "a v4 Device must receive no Tasks, even though one was pushed by another Device"
    );
}

/// The decision ADR 0051 records for issue #172's own open question:
/// Projects, Sections and Labels do not sync in this ticket, so a Task can
/// arrive naming a `project_id` no Project row will ever back on this
/// Server. That must round-trip honestly — never rejected, never nulled
/// out, never dropped from the poll a later Device receives — because a
/// Task must never vanish because its Project hasn't arrived.
#[sqlx::test]
async fn a_task_naming_an_unresolved_project_round_trips_with_the_dangling_id_intact(pool: PgPool) {
    let device = Uuid::new_v4();
    let task_id = Uuid::new_v4();
    let unresolved_project_id = Uuid::new_v4();

    let mut pushed = task(task_id, device, "buy milk");
    pushed["project_id"] = json!(unresolved_project_id);

    let (status, _) = post_sync(&pool, sync_request(5, device, vec![pushed])).await;
    assert_eq!(status, StatusCode::OK);

    let (status, polled) = post_sync(&pool, sync_request(5, Uuid::new_v4(), vec![])).await;
    assert_eq!(status, StatusCode::OK);
    let tasks = polled["tasks"].as_array().unwrap();
    let pulled = tasks.iter().find(|t| t["id"] == task_id.to_string()).unwrap();
    assert_eq!(pulled["project_id"], unresolved_project_id.to_string());
    assert_eq!(pulled["deleted_at"], Value::Null);
}

// Issue #182 / ADR 0051's own forward reference, delivered: four more
// entity streams, protocol 6. `project`/`section`/`label`/`comment` mirror
// `task` above field for field — see `server/src/sync.rs`'s own
// `ProjectInput`/`SectionInput`/`LabelInput`/`CommentInput` doc comments —
// and every test below mirrors the identically-shaped Task test above it,
// proving the same guarantees (compacted change log, replay-is-a-no-op,
// delete-is-terminal) hold for each of the four rather than assuming they
// "just work" because the code looks similar.

fn project(id: Uuid, device_id: Uuid, name: &str) -> Value {
    json!({
        "id": id,
        "device_id": device_id,
        "name": name,
        "colour": "#b8256f",
        "favourite": false,
        "archived": false,
        "parent_id": Value::Null,
        "description": Value::Null,
        "order_key": "V",
        "created_at": "2026-01-01T00:00:00Z",
        "deleted_at": Value::Null,
    })
}

fn section(id: Uuid, device_id: Uuid, project_id: Uuid, name: &str) -> Value {
    json!({
        "id": id,
        "device_id": device_id,
        "project_id": project_id,
        "name": name,
        "description": Value::Null,
        "order_key": "V",
        "archived": false,
        "created_at": "2026-01-01T00:00:00Z",
        "deleted_at": Value::Null,
    })
}

fn label(id: Uuid, device_id: Uuid, name: &str) -> Value {
    json!({
        "id": id,
        "device_id": device_id,
        "name": name,
        "colour": "#b8256f",
        "created_at": "2026-01-01T00:00:00Z",
        "deleted_at": Value::Null,
    })
}

fn comment(id: Uuid, device_id: Uuid, task_id: Uuid, text: &str) -> Value {
    json!({
        "id": id,
        "device_id": device_id,
        "task_id": task_id,
        "text": text,
        "created_at": "2026-01-01T00:00:00Z",
        "deleted_at": Value::Null,
    })
}

/// A protocol-6 `SyncRequest` carrying only one of the four new streams at
/// a time — every other stream (Entries, Tasks, and the other three of
/// these four) empty, mirroring `sync_request`'s own "everything else
/// empty" shape.
#[allow(clippy::too_many_arguments)]
fn sync_request_v6(
    device_id: Uuid,
    projects: Vec<Value>,
    sections: Vec<Value>,
    labels: Vec<Value>,
    comments: Vec<Value>,
) -> Value {
    json!({
        "protocol_version": 6,
        "device_id": device_id,
        "since_seq": 0,
        "entries": [],
        "since_task_seq": 0,
        "tasks": [],
        "since_project_seq": 0,
        "projects": projects,
        "since_section_seq": 0,
        "sections": sections,
        "since_label_seq": 0,
        "labels": labels,
        "since_comment_seq": 0,
        "comments": comments,
    })
}

#[sqlx::test]
async fn a_project_round_trips_to_a_later_poll_with_a_lower_project_cursor(pool: PgPool) {
    let device_a = Uuid::new_v4();
    let device_b = Uuid::new_v4();
    let project_id = Uuid::new_v4();

    let (status, posted) = post_sync(
        &pool,
        sync_request_v6(
            device_a,
            vec![project(project_id, device_a, "Errands")],
            vec![],
            vec![],
            vec![],
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let project_cursor = posted["project_cursor"].as_i64().unwrap();
    assert!(project_cursor > 0);

    let (status, polled) =
        post_sync(&pool, sync_request_v6(device_b, vec![], vec![], vec![], vec![])).await;
    assert_eq!(status, StatusCode::OK);
    let projects = polled["projects"].as_array().unwrap();
    assert_eq!(projects.len(), 1);
    assert_eq!(projects[0]["id"], project_id.to_string());
    assert_eq!(projects[0]["name"], "Errands");
    assert_eq!(projects[0]["seq"], project_cursor);
    assert_eq!(polled["project_cursor"], project_cursor);
}

#[sqlx::test]
async fn replaying_an_unchanged_project_across_two_pushes_does_not_move_the_project_cursor(
    pool: PgPool,
) {
    let device = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    let request = sync_request_v6(
        device,
        vec![project(project_id, device, "unchanged name")],
        vec![],
        vec![],
        vec![],
    );

    let (_, first) = post_sync(&pool, request.clone()).await;
    let first_cursor = first["project_cursor"].as_i64().unwrap();

    let (status, second) = post_sync(&pool, request).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(second["project_cursor"], first_cursor);

    let seq: i64 = sqlx::query_scalar("select seq from projects where id = $1")
        .bind(project_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(seq, first_cursor, "an unchanged replay must not reassign seq");
}

#[sqlx::test]
async fn a_section_round_trips_to_a_later_poll_with_a_lower_section_cursor(pool: PgPool) {
    let device_a = Uuid::new_v4();
    let device_b = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    let section_id = Uuid::new_v4();

    let (status, posted) = post_sync(
        &pool,
        sync_request_v6(
            device_a,
            vec![],
            vec![section(section_id, device_a, project_id, "Groceries")],
            vec![],
            vec![],
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let section_cursor = posted["section_cursor"].as_i64().unwrap();
    assert!(section_cursor > 0);

    let (status, polled) =
        post_sync(&pool, sync_request_v6(device_b, vec![], vec![], vec![], vec![])).await;
    assert_eq!(status, StatusCode::OK);
    let sections = polled["sections"].as_array().unwrap();
    assert_eq!(sections.len(), 1);
    assert_eq!(sections[0]["id"], section_id.to_string());
    assert_eq!(sections[0]["project_id"], project_id.to_string());
    assert_eq!(sections[0]["seq"], section_cursor);
}

/// A Section naming a Project this Server has no row for at all — the
/// identical unvalidated-cross-reference guarantee
/// `a_task_naming_an_unresolved_project_round_trips_with_the_dangling_id_intact`
/// proves for Tasks, applied to Sections (`SectionInput::project_id`'s own
/// doc comment).
#[sqlx::test]
async fn a_section_naming_an_unresolved_project_round_trips_with_the_dangling_id_intact(
    pool: PgPool,
) {
    let device = Uuid::new_v4();
    let section_id = Uuid::new_v4();
    let unresolved_project_id = Uuid::new_v4();

    let (status, _) = post_sync(
        &pool,
        sync_request_v6(
            device,
            vec![],
            vec![section(section_id, device, unresolved_project_id, "Groceries")],
            vec![],
            vec![],
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, polled) = post_sync(
        &pool,
        sync_request_v6(Uuid::new_v4(), vec![], vec![], vec![], vec![]),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let sections = polled["sections"].as_array().unwrap();
    let pulled = sections.iter().find(|s| s["id"] == section_id.to_string()).unwrap();
    assert_eq!(pulled["project_id"], unresolved_project_id.to_string());
}

#[sqlx::test]
async fn a_label_round_trips_to_a_later_poll_with_a_lower_label_cursor(pool: PgPool) {
    let device_a = Uuid::new_v4();
    let device_b = Uuid::new_v4();
    let label_id = Uuid::new_v4();

    let (status, posted) = post_sync(
        &pool,
        sync_request_v6(device_a, vec![], vec![], vec![label(label_id, device_a, "errand")], vec![]),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let label_cursor = posted["label_cursor"].as_i64().unwrap();
    assert!(label_cursor > 0);

    let (status, polled) =
        post_sync(&pool, sync_request_v6(device_b, vec![], vec![], vec![], vec![])).await;
    assert_eq!(status, StatusCode::OK);
    let labels = polled["labels"].as_array().unwrap();
    assert_eq!(labels.len(), 1);
    assert_eq!(labels[0]["id"], label_id.to_string());
    assert_eq!(labels[0]["name"], "errand");
    assert_eq!(labels[0]["seq"], label_cursor);
}

/// Delete is terminal (ADR 0028, applied a fifth time) — a tombstoned
/// Label can never be revived by a later push against the same id, the
/// identical guarantee `insert_tasks`'s own `deleted_at is null` guard
/// gives Tasks.
#[sqlx::test]
async fn a_deleted_label_cannot_be_revived_by_a_later_push(pool: PgPool) {
    let device = Uuid::new_v4();
    let label_id = Uuid::new_v4();

    post_sync(
        &pool,
        sync_request_v6(device, vec![], vec![], vec![label(label_id, device, "errand")], vec![]),
    )
    .await;

    let mut deleted = label(label_id, device, "");
    deleted["deleted_at"] = json!("2026-01-02T00:00:00Z");
    post_sync(&pool, sync_request_v6(device, vec![], vec![], vec![deleted], vec![])).await;

    // A stale push from a Device that hasn't heard about the delete yet,
    // trying to rename the (now-tombstoned) Label back to something live.
    let (status, _) = post_sync(
        &pool,
        sync_request_v6(
            device,
            vec![],
            vec![],
            vec![label(label_id, device, "revived?")],
            vec![],
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (name, deleted_at): (String, Option<chrono::DateTime<Utc>>) = sqlx::query_as(
        "select name, deleted_at from labels where id = $1",
    )
    .bind(label_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(name, "", "the tombstone's blanked name must survive the stale push");
    assert!(deleted_at.is_some(), "delete is terminal — a later push must not undo it");
}

#[sqlx::test]
async fn a_comment_round_trips_to_a_later_poll_with_a_lower_comment_cursor(pool: PgPool) {
    let device_a = Uuid::new_v4();
    let device_b = Uuid::new_v4();
    let task_id = Uuid::new_v4();
    let comment_id = Uuid::new_v4();

    let (status, posted) = post_sync(
        &pool,
        sync_request_v6(
            device_a,
            vec![],
            vec![],
            vec![],
            vec![comment(comment_id, device_a, task_id, "sounds good")],
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let comment_cursor = posted["comment_cursor"].as_i64().unwrap();
    assert!(comment_cursor > 0);

    let (status, polled) =
        post_sync(&pool, sync_request_v6(device_b, vec![], vec![], vec![], vec![])).await;
    assert_eq!(status, StatusCode::OK);
    let comments = polled["comments"].as_array().unwrap();
    assert_eq!(comments.len(), 1);
    assert_eq!(comments[0]["id"], comment_id.to_string());
    assert_eq!(comments[0]["task_id"], task_id.to_string());
    assert_eq!(comments[0]["text"], "sounds good");
    assert_eq!(comments[0]["seq"], comment_cursor);
}

/// The acceptance criterion issue #182 names explicitly, mirroring
/// `a_v4_client_syncs_entries_and_receives_no_tasks` one bump later: a
/// Device still on protocol 5 — built before Projects/Sections/Labels/
/// Comments existed, so its own request body has none of those eight keys
/// at all — keeps syncing Entries and Tasks exactly as before, and simply
/// never sees any of the four new streams, even though another Device has
/// pushed to every one of them. Built by hand, specifically without the
/// eight new keys, to model what a real v5 build's JSON actually looks
/// like rather than a v6 request that merely claims to be v5.
#[sqlx::test]
async fn a_v5_client_syncs_entries_and_tasks_and_receives_none_of_the_four_new_streams(
    pool: PgPool,
) {
    let device_v6 = Uuid::new_v4();
    let device_v5 = Uuid::new_v4();
    let entry_id = Uuid::new_v4();
    let task_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    let section_id = Uuid::new_v4();
    let label_id = Uuid::new_v4();
    let comment_id = Uuid::new_v4();

    // A v6 Device pushes to every new stream first, so there is something
    // a v5 Device could wrongly receive if the dual-version gate didn't
    // hold.
    post_sync(
        &pool,
        json!({
            "protocol_version": 6,
            "device_id": device_v6,
            "since_seq": 0,
            "entries": [],
            "since_task_seq": 0,
            "tasks": [task(task_id, device_v6, "buy milk")],
            "since_project_seq": 0,
            "projects": [project(project_id, device_v6, "Errands")],
            "since_section_seq": 0,
            "sections": [section(section_id, device_v6, project_id, "Groceries")],
            "since_label_seq": 0,
            "labels": [label(label_id, device_v6, "errand")],
            "since_comment_seq": 0,
            "comments": [comment(comment_id, device_v6, task_id, "sounds good")],
        }),
    )
    .await;

    let (status, response) = post_sync(
        &pool,
        json!({
            "protocol_version": 5,
            "device_id": device_v5,
            "since_seq": 0,
            "entries": [entry(entry_id, device_v5, "a v5 Device's own Entry")],
            "since_task_seq": 0,
            "tasks": [],
        }),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    let entries = response["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 1, "Entries must sync exactly as before protocol 6");
    assert_eq!(entries[0]["id"], entry_id.to_string());
    assert_eq!(
        response["tasks"].as_array().unwrap().len(),
        1,
        "Tasks must keep syncing exactly as they did under protocol 5"
    );
    for stream in ["projects", "sections", "labels", "comments"] {
        assert_eq!(
            response[stream].as_array().unwrap().len(),
            0,
            "a v5 Device must receive no {stream}, even though another Device pushed to it"
        );
    }
}

// Issue #184 / ADR 0056: Todo's own activity log, a seventh stream added
// inside protocol 6 with no version bump — see `server/src/sync.rs`'s own
// `PROTOCOL_VERSION` doc comment. `event` mirrors `comment` above field
// for field; every test below proves the properties that stream's own
// module comment argues for: a compacted-log round trip exactly like
// every other stream, but a replay guard that reduces to "insert if
// absent" (no `is distinct from` chain, no `seq` reassignment) because an
// Event is never edited or deleted once written.

fn event(id: Uuid, device_id: Uuid, task_id: Uuid, event_type: &str) -> Value {
    json!({
        "id": id,
        "device_id": device_id,
        "event_type": event_type,
        "object_type": "task",
        "object_id": task_id,
        "task_id": task_id,
        "project_id": Value::Null,
        "occurred_at": "2026-01-01T00:00:00Z",
        "extra": Value::Null,
    })
}

/// A protocol-6 `SyncRequest` carrying only the Event stream — every other
/// stream empty, mirroring `sync_request_v6`'s own shape.
fn sync_request_events(device_id: Uuid, since_event_seq: i64, events: Vec<Value>) -> Value {
    json!({
        "protocol_version": 6,
        "device_id": device_id,
        "since_seq": 0,
        "entries": [],
        "since_task_seq": 0,
        "tasks": [],
        "since_project_seq": 0,
        "projects": [],
        "since_section_seq": 0,
        "sections": [],
        "since_label_seq": 0,
        "labels": [],
        "since_comment_seq": 0,
        "comments": [],
        "since_event_seq": since_event_seq,
        "events": events,
    })
}

#[sqlx::test]
async fn an_event_round_trips_to_a_later_poll_with_a_lower_event_cursor(pool: PgPool) {
    let device_a = Uuid::new_v4();
    let device_b = Uuid::new_v4();
    let task_id = Uuid::new_v4();
    let event_id = Uuid::new_v4();

    let (status, posted) = post_sync(
        &pool,
        sync_request_events(device_a, 0, vec![event(event_id, device_a, task_id, "added")]),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let event_cursor = posted["event_cursor"].as_i64().unwrap();
    assert!(event_cursor > 0);

    let (status, polled) = post_sync(&pool, sync_request_events(device_b, 0, vec![])).await;
    assert_eq!(status, StatusCode::OK);
    let events = polled["events"].as_array().unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["id"], event_id.to_string());
    assert_eq!(events[0]["event_type"], "added");
    assert_eq!(events[0]["task_id"], task_id.to_string());
    assert_eq!(events[0]["seq"], event_cursor);
}

/// The occurred_at this test pushes is what a real client always sends —
/// the acting Device's own clock, never a server-assigned value — and
/// this test's whole point is that the Server stores it back unchanged:
/// nothing here recomputes or overwrites it with the moment the row was
/// inserted, unlike a Comment's `created_at`-vs-`seq` split doesn't even
/// need to make (ADR 0056's own Decision).
#[sqlx::test]
async fn occurred_at_is_stored_and_returned_exactly_as_the_device_sent_it(pool: PgPool) {
    let device = Uuid::new_v4();
    let task_id = Uuid::new_v4();
    let event_id = Uuid::new_v4();
    let offline_time = "2026-03-01T23:24:44Z";

    let mut pushed = event(event_id, device, task_id, "completed");
    pushed["occurred_at"] = json!(offline_time);

    let (status, response) =
        post_sync(&pool, sync_request_events(device, 0, vec![pushed])).await;

    assert_eq!(status, StatusCode::OK);
    let events = response["events"].as_array().unwrap();
    assert_eq!(
        events[0]["occurred_at"], offline_time,
        "occurred_at must survive exactly as sent — never rewritten to whenever the Server received it"
    );
}

/// The replay guard this stream's own module comment argues reduces to
/// "insert if absent": pushing the identical Event twice must not
/// reassign `seq` a second time, mirroring
/// `replaying_an_unchanged_project_across_two_pushes_does_not_move_the_project_cursor`
/// above.
#[sqlx::test]
async fn replaying_the_same_event_request_does_not_move_the_event_cursor(pool: PgPool) {
    let device = Uuid::new_v4();
    let task_id = Uuid::new_v4();
    let event_id = Uuid::new_v4();
    let request =
        sync_request_events(device, 0, vec![event(event_id, device, task_id, "added")]);

    let (_, first) = post_sync(&pool, request.clone()).await;
    let first_cursor = first["event_cursor"].as_i64().unwrap();

    let (status, second) = post_sync(&pool, request).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(second["event_cursor"], first_cursor);

    let seq: i64 = sqlx::query_scalar("select seq from events where id = $1")
        .bind(event_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(seq, first_cursor, "a replayed push must not reassign seq");
}

/// An Event is never rewritten once written (issue #184's own acceptance
/// criterion) — proved here by pushing a *different* payload under an
/// `id` this table already holds and asserting the original row survives
/// untouched, in contrast to `insert_tasks`/`insert_projects`/etc., which
/// would apply such a push as a real edit.
#[sqlx::test]
async fn a_second_push_under_the_same_id_never_rewrites_the_original_event(pool: PgPool) {
    let device = Uuid::new_v4();
    let task_id = Uuid::new_v4();
    let event_id = Uuid::new_v4();

    post_sync(
        &pool,
        sync_request_events(device, 0, vec![event(event_id, device, task_id, "added")]),
    )
    .await;

    let mut conflicting = event(event_id, device, task_id, "deleted");
    conflicting["occurred_at"] = json!("2026-06-01T00:00:00Z");
    let (status, _) = post_sync(&pool, sync_request_events(device, 0, vec![conflicting])).await;
    assert_eq!(status, StatusCode::OK);

    let (event_type, occurred_at): (String, chrono::DateTime<chrono::Utc>) = sqlx::query_as(
        "select event_type, occurred_at from events where id = $1",
    )
    .bind(event_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(event_type, "added", "the original Event must survive unchanged");
    assert_eq!(occurred_at.to_rfc3339(), "2026-01-01T00:00:00+00:00");
}

/// No `protocol_version` gate exists for this stream (see
/// `SyncResponse::events`'s own doc comment) — a request built by hand
/// without the `since_event_seq`/`events` keys at all, modelling a real
/// build that predates issue #184, still gets a populated `events` array
/// back when another Device has pushed to it. That's deliberately
/// tolerated, not a bug: an old build simply never reads a JSON key its
/// own `WireSyncResponse` type doesn't declare.
#[sqlx::test]
async fn a_pre_184_request_with_no_event_keys_at_all_still_receives_events_in_its_response(
    pool: PgPool,
) {
    let device_a = Uuid::new_v4();
    let device_b = Uuid::new_v4();
    let task_id = Uuid::new_v4();
    let event_id = Uuid::new_v4();

    post_sync(
        &pool,
        sync_request_events(device_a, 0, vec![event(event_id, device_a, task_id, "added")]),
    )
    .await;

    // A hand-built protocol-6 request with no `since_event_seq`/`events`
    // keys — exactly what a real pre-#184 v6 build's JSON looks like.
    let (status, response) = post_sync(
        &pool,
        json!({
            "protocol_version": 6,
            "device_id": device_b,
            "since_seq": 0,
            "entries": [],
            "since_task_seq": 0,
            "tasks": [],
            "since_project_seq": 0,
            "projects": [],
            "since_section_seq": 0,
            "sections": [],
            "since_label_seq": 0,
            "labels": [],
            "since_comment_seq": 0,
            "comments": [],
        }),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    let events = response["events"].as_array().unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["id"], event_id.to_string());
}
