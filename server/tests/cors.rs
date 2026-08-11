use std::fs;

use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use sqlx::PgPool;
use tower::ServiceExt;

mod common;
use common::make_static_dir;

// A packaged Device (Capacitor, Tauri) has no origin in common with the
// server, so a cross-origin request must succeed rather than be blocked by
// the browser's CORS check (ticket 13).
#[sqlx::test]
async fn a_cross_origin_preflight_is_allowed(pool: PgPool) {
    let dir = make_static_dir("cors");
    let app = meologue_server::router(pool, &dir);

    let response = app
        .oneshot(
            Request::builder()
                .method("OPTIONS")
                .uri("/v1/sync")
                .header(header::ORIGIN, "tauri://localhost")
                .header(header::ACCESS_CONTROL_REQUEST_METHOD, "POST")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert!(
        response
            .headers()
            .contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN)
    );

    fs::remove_dir_all(&dir).ok();
}

#[sqlx::test]
async fn a_cross_origin_get_is_allowed_for_any_origin(pool: PgPool) {
    let dir = make_static_dir("cors");
    let app = meologue_server::router(pool, &dir);

    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/")
                .header(header::ORIGIN, "http://localhost")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(
        response
            .headers()
            .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
            .unwrap(),
        "*",
    );

    fs::remove_dir_all(&dir).ok();
}
