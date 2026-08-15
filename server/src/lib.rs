pub mod health;
pub mod metrics;
pub mod openapi;
pub mod sync;

use std::path::Path;
use std::time::Duration;

use axum::{
    Router,
    http::{Request, Response},
    routing::{get, post},
};
use sqlx::PgPool;
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;
use tracing::field;

/// Serves `/v1/sync` plus the built web app out of `static_dir`, falling
/// back to its `index.html` app shell for any other path — one process, one
/// port, one URL, so a phone on the same network can just open an address
/// (ticket 11).
///
/// CORS is wide open rather than restricted to a known origin: ADR 0003
/// already trusts any Device that can reach the server at all, so an origin
/// check would gate nothing a reachable attacker doesn't already have
/// (ticket 13).
pub fn router(pool: PgPool, static_dir: impl AsRef<Path>) -> Router {
    // Installs the global metrics recorder (if not already installed) before
    // any request can reach `track_metrics` — see src/metrics.rs.
    metrics::handle();

    let static_dir = static_dir.as_ref();
    let index_html = static_dir.join("index.html");
    let app_shell = ServeDir::new(static_dir).fallback(ServeFile::new(index_html));

    // A span per request, closed (and so printed under `RUST_LOG=info`) with its
    // status and latency filled in. `/v1/sync` additionally records the
    // requesting Device's id once it's parsed the body — see ticket 34.
    let trace_layer = TraceLayer::new_for_http()
        .make_span_with(|request: &Request<axum::body::Body>| {
            tracing::info_span!(
                "request",
                method = %request.method(),
                path = %request.uri().path(),
                status = field::Empty,
                latency_ms = field::Empty,
                device_id = field::Empty,
            )
        })
        .on_response(
            |response: &Response<axum::body::Body>, latency: Duration, span: &tracing::Span| {
                span.record("status", response.status().as_u16());
                span.record("latency_ms", latency.as_millis() as u64);
            },
        )
        // A 5xx is still recorded on the span above via on_response; the
        // handler that produced it (e.g. sync_handler) already logs its own
        // error with context, so the default on_failure hook is silenced
        // rather than duplicating that as a second, contextless line.
        .on_failure(());

    Router::new()
        .route("/v1/health", get(health::health_handler))
        .route("/v1/sync", post(sync::sync_handler))
        .route("/v1/metrics", get(metrics::metrics_handler))
        .with_state(pool)
        .fallback_service(app_shell)
        .layer(axum::middleware::from_fn(metrics::track_metrics))
        .layer(trace_layer)
        .layer(CorsLayer::permissive())
}
