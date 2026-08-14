use std::path::PathBuf;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use meologue_server::sync::PROTOCOL_VERSION;
use serde_json::Value;
use sqlx::PgPool;
use tower::ServiceExt;

// This test never hits /v1/sync, so any directory that exists is fine as the
// (otherwise unused) static_dir.
fn empty_static_dir() -> PathBuf {
    std::env::current_dir().unwrap()
}

// A pool that only ever parses its URL and never opens a connection — proves
// the handler answers without the database, rather than merely against a
// database that happens to be reachable in test (ticket 28).
fn unreachable_pool() -> PgPool {
    sqlx::postgres::PgPoolOptions::new()
        .connect_lazy("postgres://meologue:meologue@localhost:1/nonexistent")
        .unwrap()
}

async fn get_health(pool: &PgPool) -> (StatusCode, Value) {
    let app = meologue_server::router(pool.clone(), empty_static_dir());
    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/v1/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let json = serde_json::from_slice(&bytes).unwrap();
    (status, json)
}

#[tokio::test]
async fn it_answers_with_no_database_available() {
    let pool = unreachable_pool();

    let (status, body) = get_health(&pool).await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["protocol_version"], PROTOCOL_VERSION);
    assert!(body["service"].is_string());
}

#[tokio::test]
async fn it_never_rejects_on_protocol_version() {
    let pool = unreachable_pool();
    let app = meologue_server::router(pool, empty_static_dir());

    // Health has no request body to carry a claimed protocol_version at all —
    // its whole job is to let the caller learn the version and compare it
    // themselves, so there is nothing here that could gate on one.
    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/v1/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_ne!(response.status(), StatusCode::UPGRADE_REQUIRED);
    assert_eq!(response.status(), StatusCode::OK);
}
