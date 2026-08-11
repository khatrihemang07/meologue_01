use std::fs;
use std::path::PathBuf;

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

fn make_static_dir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("meologue-static-test-{}", Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("index.html"), "<html>app shell</html>").unwrap();
    fs::write(dir.join("app.js"), "console.log('hi')").unwrap();
    dir
}

async fn get(app: Router, path: &str) -> (StatusCode, String) {
    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(path)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, String::from_utf8(bytes.to_vec()).unwrap())
}

#[sqlx::test]
async fn a_real_asset_is_served_directly(pool: PgPool) {
    let dir = make_static_dir();
    let app = meologue_server::router(pool, &dir);

    let (status, body) = get(app, "/app.js").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, "console.log('hi')");

    fs::remove_dir_all(&dir).ok();
}

#[sqlx::test]
async fn an_unknown_path_falls_back_to_the_app_shell(pool: PgPool) {
    let dir = make_static_dir();
    let app = meologue_server::router(pool, &dir);

    // A client-side route (e.g. deep-linked or refreshed) has no matching
    // file on disk — the SPA fallback is what lets that still load the app.
    let (status, body) = get(app, "/history/whatever-client-route").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, "<html>app shell</html>");

    fs::remove_dir_all(&dir).ok();
}

#[sqlx::test]
async fn the_sync_route_takes_priority_over_static_serving(pool: PgPool) {
    let dir = make_static_dir();
    let app = meologue_server::router(pool, &dir);

    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/v1/sync")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    // /v1/sync only registers POST — a matched path with the wrong method is
    // a 405 from that route, not a fall-through to the app shell.
    assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);

    fs::remove_dir_all(&dir).ok();
}
