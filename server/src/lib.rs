pub mod embedding;
pub mod health;
pub mod llm;
pub mod metrics;
pub mod openapi;
pub mod reflect;
pub mod sessions;
pub mod sync;

use std::path::Path;
use std::time::Duration;

use axum::{
    Router,
    extract::FromRef,
    http::{HeaderValue, Request, Response, StatusCode, header},
    middleware::Next,
    routing::{any, get, post},
};
use sqlx::PgPool;
use tokio::sync::mpsc::Sender;
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;
use tracing::field;
use uuid::Uuid;

use crate::reflect::ReflectState;

/// The router's shared state. `PgPool`, `Option<Sender<Uuid>>` and
/// `Option<ReflectState>` each get their own `FromRef` impl below, so every
/// existing handler that extracts `State<PgPool>` keeps compiling unchanged
/// — only `sync_handler` also extracts the sender (ADR 0022), and only
/// `reflect::reflect_handler` also extracts the Reflection state (ticket 4).
#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    pub embed_tx: Option<Sender<Uuid>>,
    pub reflect: Option<ReflectState>,
}

impl FromRef<AppState> for PgPool {
    fn from_ref(state: &AppState) -> Self {
        state.pool.clone()
    }
}

impl FromRef<AppState> for Option<Sender<Uuid>> {
    fn from_ref(state: &AppState) -> Self {
        state.embed_tx.clone()
    }
}

impl FromRef<AppState> for Option<ReflectState> {
    fn from_ref(state: &AppState) -> Self {
        state.reflect.clone()
    }
}

/// Answers every otherwise-unmatched path under `/v1/` with a real 404,
/// instead of letting it fall through to the SPA app shell below. Without
/// this, an unregistered API path (any typo, or `/v1/reflect` on a server
/// with no chat model configured) would resolve as "no route matched" and
/// hit `.fallback_service(app_shell)`, which happily returns 200 with
/// `index.html` — see `static_serving.rs`'s
/// `an_unknown_path_falls_back_to_the_app_shell` for why that fallback
/// exists at all (client-side routes have no file on disk). That's exactly
/// right for a route like `/history/whatever`, and exactly wrong for an API
/// path: ticket 4 needs an unconfigured server's `/v1/reflect` to 404 for
/// real, which is what lets a client tell "this Server predates Reflection"
/// apart from every other failure. Registered as `/v1/{*rest}` — matchit
/// (axum's router) always prefers a more specific literal route
/// (`/v1/health`, `/v1/sync`, `/v1/metrics`, and `/v1/reflect` when
/// registered) over this wildcard, so a real endpoint's own routing and
/// method-mismatch behaviour (`the_sync_route_takes_priority_over_static_serving`,
/// a 405 not a fallthrough) is unaffected — this only ever catches a `/v1/`
/// path nothing else claimed.
async fn v1_not_found() -> StatusCode {
    StatusCode::NOT_FOUND
}

/// Sets `Cache-Control` on everything the static file service serves, chosen
/// by path rather than a single blanket value (ticket 44):
///
/// - `/assets/**` is Vite's content-hashed build output — a file's name
///   changes whenever its contents do, so it can be cached for a year and
///   marked `immutable`.
/// - Everything else — `index.html`, the SPA fallback that serves it for any
///   unmatched path, and (from ticket 45) the service worker family
///   (`sw.js`, `registerSW.js`, `manifest.webmanifest`) — gets `no-cache`:
///   revalidate on every request rather than guess a freshness lifetime.
///   `tower-http`'s fs services already set `last-modified`, so that
///   revalidation is a cheap 304. Without this, browsers fall back to
///   heuristic caching, which is how a Device gets pinned to a dead app
///   shell or service worker with no recovery short of clearing site data.
///
/// `workbox-<hash>.js` (also emitted by ticket 45) is itself content-hashed
/// like `/assets/**`, but it lives at the output root rather than under
/// `/assets/`, so it's called out by name rather than caught by the prefix
/// check. It's grouped with the immutable bucket, not the no-cache one: it's
/// never fetched by URL directly, only `importScripts()`-ed by `sw.js`,
/// which is itself always revalidated — so `sw.js` always names the
/// workbox file that matches what it currently expects, and caching that
/// file forever under its hashed name is exactly as safe as `/assets/**`.
async fn set_static_cache_control(
    request: axum::extract::Request,
    next: Next,
) -> Response<axum::body::Body> {
    let path = request.uri().path().to_owned();
    let mut response = next.run(request).await;

    let is_immutable =
        path.starts_with("/assets/") || (path.starts_with("/workbox-") && path.ends_with(".js"));
    let value = if is_immutable {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static(value));

    response
}

/// Serves `/v1/sync` plus the built web app out of `static_dir`, falling
/// back to its `index.html` app shell for any other path — one process, one
/// port, one URL, so a phone on the same network can just open an address
/// (ticket 11). Static responses (the app shell and its build output) carry
/// the `Cache-Control` policy described on `set_static_cache_control`
/// (ticket 44); `/v1/*` is untouched — that layer wraps only the static
/// fallback, not the whole router.
///
/// CORS is wide open rather than restricted to a known origin: ADR 0003
/// already trusts any Device that can reach the server at all, so an origin
/// check would gate nothing a reachable attacker doesn't already have
/// (ticket 13).
///
/// Delegates to `router_with_embedding` with no sender — every existing
/// caller (several test files, plus any future one written against this
/// signature) keeps working exactly as it does today, with the embedding
/// worker simply not hinted about newly-inserted Entries. That's a
/// degradation, not a break: the `embedding IS NULL` scan (ADR 0022) still
/// picks those Entries up on its own within `SCAN_INTERVAL`.
pub fn router(pool: PgPool, static_dir: impl AsRef<Path>) -> Router {
    router_with_embedding(pool, static_dir, None)
}

/// Same as `router`, but also wires an optional channel the sync handler
/// uses to hint the embedding worker about Entries it just inserted.
/// Delegates to `router_with_reflection` with no Reflection state, so
/// `/v1/reflect` doesn't exist — the existing test suite (written before
/// ticket 4) keeps compiling and keeps getting a server with no Reflection
/// route, exactly as before.
pub fn router_with_embedding(
    pool: PgPool,
    static_dir: impl AsRef<Path>,
    embed_tx: Option<Sender<Uuid>>,
) -> Router {
    router_with_reflection(pool, static_dir, embed_tx, None)
}

/// Same as `router_with_embedding`, but also wires the Reflection state
/// (`llm::LlmConfig::reflect_config`) that `reflect::reflect_handler`
/// needs. This is what `main.rs` calls; the two functions above are
/// convenience wrappers the existing test suite depends on.
///
/// `reflect`'s presence, not any request-time check, is what decides
/// whether `/v1/reflect` is even registered on this `Router` — see ticket
/// 4's requirement that an unconfigured server 404s exactly like an older
/// server that never had the route, and `v1_not_found`'s doc comment for
/// why that requires more than simply omitting the route.
pub fn router_with_reflection(
    pool: PgPool,
    static_dir: impl AsRef<Path>,
    embed_tx: Option<Sender<Uuid>>,
    reflect: Option<ReflectState>,
) -> Router {
    // Installs the global metrics recorder (if not already installed) before
    // any request can reach `track_metrics` — see src/metrics.rs.
    metrics::handle();

    let static_dir = static_dir.as_ref();
    let index_html = static_dir.join("index.html");
    // A nested Router (rather than a bare `.fallback_service()`) so the
    // Cache-Control layer below applies only to static-file responses —
    // `.layer()` on the outer Router would wrap `/v1/*` too (ticket 44).
    let app_shell = Router::new()
        .fallback_service(ServeDir::new(static_dir).fallback(ServeFile::new(index_html)))
        .layer(axum::middleware::from_fn(set_static_cache_control));

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

    let mut api_router = Router::new()
        .route("/v1/health", get(health::health_handler))
        .route("/v1/sync", post(sync::sync_handler))
        .route("/v1/metrics", get(metrics::metrics_handler));

    if reflect.is_some() {
        // `/v1/sessions/{id}` and `/v1/sessions` are gated on the same
        // `reflect.is_some()` check as `/v1/reflect`, even though neither
        // `sessions::get_session_handler`, `sessions::list_sessions_handler`
        // nor `sessions::delete_session_handler` ever touches `ReflectState`
        // — a Server with no Session to fetch, list or delete (Reflection
        // unconfigured, so nothing ever created one) must 404 exactly like
        // an older Server that never had the route, the same reasoning
        // `v1_not_found`'s doc comment gives for `/v1/reflect` itself.
        // `DELETE` is chained onto the same `/v1/sessions/{id}` route as
        // `GET` (issue #63) rather than a second `.route()` call — axum
        // dispatches by method on one matched path either way, and this
        // keeps the two verbs that share a path next to each other instead
        // of duplicating the path string.
        api_router = api_router
            .route("/v1/reflect", post(reflect::reflect_handler))
            .route("/v1/sessions", get(sessions::list_sessions_handler))
            .route(
                "/v1/sessions/{id}",
                get(sessions::get_session_handler).delete(sessions::delete_session_handler),
            );
    }
    // Always registered, whether or not Reflection is configured: this is
    // what makes an unmatched `/v1/*` path — including `/v1/reflect` and
    // `/v1/sessions/*` when `reflect` above is `None` — a genuine 404
    // instead of the SPA fallback below. See `v1_not_found`'s own doc
    // comment.
    api_router = api_router.route("/v1/{*rest}", any(v1_not_found));

    api_router
        .with_state(AppState { pool, embed_tx, reflect })
        .fallback_service(app_shell)
        .layer(axum::middleware::from_fn(metrics::track_metrics))
        .layer(trace_layer)
        .layer(CorsLayer::permissive())
}
