use std::fs;
use std::path::PathBuf;

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use http_body_util::BodyExt;
use sqlx::PgPool;
use tower::ServiceExt;

mod common;

fn make_static_dir() -> PathBuf {
    let dir = common::make_static_dir("static-serving");
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

async fn cache_control(app: Router, path: &str) -> Option<String> {
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
    response
        .headers()
        .get(header::CACHE_CONTROL)
        .map(|value| value.to_str().unwrap().to_owned())
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

#[sqlx::test]
async fn the_metrics_route_takes_priority_over_static_serving(pool: PgPool) {
    let dir = make_static_dir();
    let app = meologue_server::router(pool, &dir);

    let (status, body) = get(app, "/v1/metrics").await;

    // Falling through to the app shell would return the "<html>..." fixture
    // from make_static_dir instead of Prometheus text.
    assert_eq!(status, StatusCode::OK);
    assert!(!body.contains("<html>"));

    fs::remove_dir_all(&dir).ok();
}

// A heuristically-cached app shell is what strands a Device on a dead
// version of the app once a service worker exists, with no recovery short
// of clearing site data — no-cache forces revalidation on every load
// (ticket 44).
#[sqlx::test]
async fn the_app_shell_is_marked_no_cache(pool: PgPool) {
    let dir = make_static_dir();
    let app = meologue_server::router(pool, &dir);

    assert_eq!(
        cache_control(app, "/index.html").await.as_deref(),
        Some("no-cache")
    );

    fs::remove_dir_all(&dir).ok();
}

// The SPA fallback serves the exact same app shell content for any path
// that isn't a real file on disk, so it needs the same no-cache treatment
// as a direct request for index.html.
#[sqlx::test]
async fn the_spa_fallback_is_marked_no_cache(pool: PgPool) {
    let dir = make_static_dir();
    let app = meologue_server::router(pool, &dir);

    assert_eq!(
        cache_control(app, "/history/whatever-client-route")
            .await
            .as_deref(),
        Some("no-cache")
    );

    fs::remove_dir_all(&dir).ok();
}

// Vite names a hashed asset's file after its own contents, so unlike the app
// shell it can be cached for a year and marked immutable — its URL only
// ever changes alongside what it points to.
#[sqlx::test]
async fn a_hashed_asset_is_marked_immutable(pool: PgPool) {
    let dir = make_static_dir();
    fs::create_dir_all(dir.join("assets")).unwrap();
    fs::write(dir.join("assets/index-abc123.js"), "console.log('hashed')").unwrap();
    let app = meologue_server::router(pool, &dir);

    assert_eq!(
        cache_control(app, "/assets/index-abc123.js")
            .await
            .as_deref(),
        Some("public, max-age=31536000, immutable")
    );

    fs::remove_dir_all(&dir).ok();
}

// The Cache-Control policy is scoped to the static-file fallback service, so
// it must not leak onto /v1/* — those routes carry whatever headers their
// own handlers set, which today is none.
#[sqlx::test]
async fn the_api_routes_have_no_cache_control_header(pool: PgPool) {
    let dir = make_static_dir();
    let app = meologue_server::router(pool, &dir);

    assert_eq!(cache_control(app, "/v1/health").await, None);

    fs::remove_dir_all(&dir).ok();
}
