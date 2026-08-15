use std::sync::OnceLock;
use std::time::Instant;

use axum::extract::MatchedPath;
use axum::http::{StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use metrics_exporter_prometheus::{PrometheusBuilder, PrometheusHandle};

/// A single process-wide recorder. `router()` can be called many times in the
/// same process (once per test), but a `metrics::Recorder` can only be
/// installed globally once — so later calls just reuse the first one instead
/// of panicking on a second install.
///
/// `router()` calls this eagerly (rather than only from `metrics_handler`)
/// so the recorder is installed before the first request ever reaches
/// `track_metrics` — otherwise that request's `metrics::counter!` calls
/// would hit the crate's default no-op recorder and be lost.
pub fn handle() -> PrometheusHandle {
    static HANDLE: OnceLock<PrometheusHandle> = OnceLock::new();
    HANDLE
        .get_or_init(|| {
            let recorder = PrometheusBuilder::new().build_recorder();
            let handle = recorder.handle();
            metrics::set_global_recorder(recorder)
                .expect("a metrics recorder is already installed");
            handle
        })
        .clone()
}

/// Renders every metric recorded so far in Prometheus text-exposition format.
/// Unauthenticated, like the rest of `/v1` — trust here is network-level
/// (ADR 0003).
///
/// Unlike `health_handler`/`sync_handler`, this isn't `#[utoipa::path]`-annotated
/// or in `openapi::ApiDoc`: ADR 0004's wire contract is the JSON shape clients
/// consume, and Prometheus text-exposition is neither JSON nor client-consumed.
pub async fn metrics_handler() -> Response {
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "text/plain; version=0.0.4")],
        handle().render(),
    )
        .into_response()
}

/// Records a request count and latency histogram for every request, labelled
/// by the route pattern it matched (falling back to the raw path for the
/// static-file fallback, which has no route pattern) — see ticket 34.
pub async fn track_metrics(request: axum::extract::Request, next: Next) -> Response {
    let method = request.method().to_string();
    let path = request
        .extensions()
        .get::<MatchedPath>()
        .map(|matched| matched.as_str().to_owned())
        .unwrap_or_else(|| request.uri().path().to_owned());

    let start = Instant::now();
    let response = next.run(request).await;
    let latency = start.elapsed().as_secs_f64();
    let status = response.status().as_u16().to_string();

    metrics::counter!(
        "http_requests_total",
        "method" => method.clone(),
        "path" => path.clone(),
        "status" => status.clone(),
    )
    .increment(1);
    metrics::histogram!(
        "http_request_duration_seconds",
        "method" => method,
        "path" => path,
        "status" => status,
    )
    .record(latency);

    response
}
