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
            "protocol_version": 1,
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
            "protocol_version": 1,
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
        "protocol_version": 1,
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
            "protocol_version": 1,
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
