use std::path::PathBuf;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::json;
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

// These tests never touch static assets — any directory that exists is fine
// as the (otherwise unused) static_dir.
fn empty_static_dir() -> PathBuf {
    std::env::current_dir().unwrap()
}

async fn get_metrics(pool: &PgPool) -> String {
    let app = meologue_server::router(pool.clone(), empty_static_dir());
    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/v1/metrics")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    String::from_utf8(bytes.to_vec()).unwrap()
}

// The recorder is process-wide (installed once, reused across every router()
// built in this test binary — see src/metrics.rs), so other tests running
// concurrently in this same binary may add to the same counters. Summing
// every matching line and asserting a lower bound keeps this robust against
// that, rather than asserting an exact count.
fn summed_metric_value(rendered: &str, metric_name: &str) -> f64 {
    rendered
        .lines()
        .filter(|line| line.starts_with(metric_name))
        .filter_map(|line| line.rsplit(' ').next())
        .filter_map(|value| value.parse::<f64>().ok())
        .sum()
}

#[sqlx::test]
async fn a_request_is_counted_by_matched_route_and_status(pool: PgPool) {
    let app = meologue_server::router(pool.clone(), empty_static_dir());
    app.oneshot(
        Request::builder()
            .method("GET")
            .uri("/v1/health")
            .body(Body::empty())
            .unwrap(),
    )
    .await
    .unwrap();

    let rendered = get_metrics(&pool).await;
    assert!(rendered.contains("http_requests_total"));
    assert!(rendered.contains("path=\"/v1/health\""));
    assert!(rendered.contains("status=\"200\""));
}

#[sqlx::test]
async fn a_protocol_mismatch_is_logged_via_a_counter(pool: PgPool) {
    let app = meologue_server::router(pool.clone(), empty_static_dir());
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/sync")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "protocol_version": 999,
                        "device_id": Uuid::new_v4(),
                        "since_seq": 0,
                        "entries": [],
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UPGRADE_REQUIRED);

    let rendered = get_metrics(&pool).await;
    assert!(summed_metric_value(&rendered, "sync_protocol_mismatches_total") >= 1.0);
}

#[sqlx::test]
async fn a_sync_counts_entries_pushed_and_pulled(pool: PgPool) {
    let device = Uuid::new_v4();
    let entry_id = Uuid::new_v4();
    let app = meologue_server::router(pool.clone(), empty_static_dir());
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/sync")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "protocol_version": 4,
                        "device_id": device,
                        "since_seq": 0,
                        "entries": [{
                            "id": entry_id,
                            "device_id": device,
                            "body": "hello meologue",
                            "created_at": "2026-01-01T00:00:00Z",
                            // Issue #196: required on the wire now.
                            "updated_at": "2026-01-01T00:00:00Z",
                        }],
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let rendered = get_metrics(&pool).await;
    assert!(summed_metric_value(&rendered, "sync_entries_pushed_total") >= 1.0);
    assert!(summed_metric_value(&rendered, "sync_entries_pulled_total") >= 1.0);
}
