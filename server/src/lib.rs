pub mod backup;
pub mod digest;
pub mod embedding;
pub mod harness;
pub mod health;
pub mod llm;
pub mod metrics;
pub mod models;
pub mod openapi;
pub mod period;
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
    /// Digest's server-side dependencies (`digest::DigestState`) — `Some`
    /// exactly when chat is configured for the Digest worker
    /// (`llm::LlmConfig::digest_worker_config`), the same condition that
    /// used to be carried here as a bare `bool` alone. Issue #132 / ADR
    /// 0039's `regenerate_digest_handler` needs the actual chat client and
    /// `Tz`, not just a yes/no — mirrors `Option<ReflectState>` just above
    /// exactly, including why a whole `Option<T>` beats a second
    /// independent bool: `digests_enabled` below is now *derived* from
    /// `digest.is_some()` inside `router_with_digests` rather than passed
    /// in as its own parameter, so there is exactly one place that knows
    /// whether Digests are on, not two that could drift apart.
    pub digest: Option<digest::DigestState>,
    /// Whether `/v1/digests/*` is registered on this Router — always equal
    /// to `digest.is_some()` (see that field's own doc comment for why
    /// this is derived, not a second independent switch). Kept as its own
    /// field, rather than computed on every read, so
    /// `health::health_handler` (issue #133) can report a `digest`
    /// capability without reaching into `Option<DigestState>` for a bool
    /// it doesn't otherwise need.
    pub digests_enabled: bool,
    /// Issue #198: the exact `DATABASE_URL` `main.rs` connected `pool`
    /// with — kept alongside `pool` rather than re-derived from it, because
    /// `sqlx::PgConnectOptions` never hands the password back out once
    /// parsed. `backup::backup_handler`/`restore_handler` shell out to
    /// `pg_dump`/`pg_restore` against this same connection string (never
    /// `docker exec`), so a Sandbox instance, a remote host or a renamed
    /// container all work identically — see `backup.rs`'s module comment.
    pub database_url: String,
    /// Issue #198: the embedding model this Server is configured with
    /// (`llm::LlmConfig::embed_model`), independent of whether the
    /// embedding worker actually resolved a client for it — this is the
    /// name `backup::restore_handler` compares every `entries.embedding_model`
    /// against to report how many rows a Restore brought in from a
    /// different model. `None` when no embedding model is configured at
    /// all, in which case every non-null `embedding_model` counts as a
    /// mismatch (see `backup::count_mismatched_embeddings`).
    pub embed_model: Option<String>,
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

impl FromRef<AppState> for Option<digest::DigestState> {
    fn from_ref(state: &AppState) -> Self {
        state.digest.clone()
    }
}

/// A newtype around `AppState::digests_enabled`'s `bool`, rather than a bare
/// `impl FromRef<AppState> for bool` — `AppState` has exactly one `bool`
/// field today, but a plain `bool` extractor gives every future one the
/// same ambiguous claim on it. Mirrors `Option<Sender<Uuid>>` and
/// `Option<ReflectState>` just above: one small `FromRef` per thing a
/// handler might need out of the shared state.
#[derive(Debug, Clone, Copy)]
pub struct DigestsEnabled(pub bool);

impl FromRef<AppState> for DigestsEnabled {
    fn from_ref(state: &AppState) -> Self {
        DigestsEnabled(state.digests_enabled)
    }
}

/// A newtype around `AppState::database_url`, for the same reason
/// `DigestsEnabled` wraps its `bool` rather than letting handlers extract a
/// bare `String` — `AppState` has exactly one `String` field today, but a
/// plain `impl FromRef<AppState> for String` would give every future one
/// the same ambiguous claim on it.
#[derive(Debug, Clone)]
pub struct DatabaseUrl(pub String);

impl FromRef<AppState> for DatabaseUrl {
    fn from_ref(state: &AppState) -> Self {
        DatabaseUrl(state.database_url.clone())
    }
}

/// A newtype around `AppState::embed_model`, mirroring `DatabaseUrl` just
/// above for the same reason — `Option<String>` is exactly as ambiguous a
/// extractor target as a bare `String` would be.
#[derive(Debug, Clone)]
pub struct ConfiguredEmbedModel(pub Option<String>);

impl FromRef<AppState> for ConfiguredEmbedModel {
    fn from_ref(state: &AppState) -> Self {
        ConfiguredEmbedModel(state.embed_model.clone())
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
/// needs. Delegates to `router_with_digests` with `digest: None`, so
/// `/v1/digests/*` doesn't exist — every caller written against this
/// signature before issue #70 (several test files) keeps compiling and
/// keeps getting a server with no Digest routes, exactly as before.
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
    router_with_digests(pool, static_dir, embed_tx, reflect, None)
}

/// The widest router constructor — everything `router_with_reflection`
/// wires, plus the three Digest routes (issue #70's two reads, issue #132's
/// regenerate) gated on `digest.is_some()` rather than on
/// `reflect.is_some()`. Reflection and Digest are gated on the same chat
/// config today (`llm::LlmConfig::digest_worker_config` and, since issue
/// #130, `reflect_config` both require chat alone and nothing else), but
/// they remain two separate switches rather than one: a Digest and a
/// Reflection are different features that happen to share a dependency,
/// not one feature with two names, and `main.rs` builds `digest` from the
/// Digest worker's own startup outcome rather than piggybacking on
/// `reflect`'s. `main.rs` calls this directly, passing the same
/// `DigestState` it hands `digest::run`; `router_with_reflection` is the
/// narrower, `digest: None` convenience the rest of the test suite is
/// written against.
///
/// `digest: Option<digest::DigestState>`, not a bare `bool`
/// (issue #132 / ADR 0039) — `regenerate_digest_handler` needs the actual
/// chat client and `Tz` to make its own inline chat call, not just a
/// yes/no. `digests_enabled` is derived from `digest.is_some()` right
/// below, once, so `AppState`'s own bool field (which `health_handler`
/// reads) can never disagree with whether these routes are actually
/// registered.
pub fn router_with_digests(
    pool: PgPool,
    static_dir: impl AsRef<Path>,
    embed_tx: Option<Sender<Uuid>>,
    reflect: Option<ReflectState>,
    digest: Option<digest::DigestState>,
) -> Router {
    // Issue #198's two new fields have no "off" state to default to the
    // way `reflect`/`digest` do — `/v1/backup` and `/v1/restore` are always
    // registered, unconditionally, below. An empty `database_url` and a
    // `None` `embed_model` are harmless defaults for every caller of this
    // narrower constructor: none of the existing test files that call it
    // directly ever exercise `/v1/backup` or `/v1/restore`, and the one
    // that does (`server/tests/backup.rs`) calls `router_with_backup`
    // instead, exactly the way `router_with_reflection`'s callers that
    // needed Digests moved to `router_with_digests`.
    router_with_backup(pool, static_dir, embed_tx, reflect, digest, String::new(), None)
}

/// The widest router constructor — everything `router_with_digests` wires,
/// plus `/v1/backup`, `/v1/restore` and `/v1/restore/rebuild-embeddings`
/// (issue #198), registered unconditionally rather than gated on any
/// `Option` the way Reflection and Digest are: backing up and restoring
/// Postgres needs nothing but the database connection every Server already
/// has, so there is no "unconfigured" state for these routes to 404 under.
/// `main.rs` calls this directly, the same way it calls
/// `router_with_digests` today; `router_with_digests` becomes the narrower,
/// `database_url: String::new(), embed_model: None` convenience the rest
/// of the test suite is written against.
pub fn router_with_backup(
    pool: PgPool,
    static_dir: impl AsRef<Path>,
    embed_tx: Option<Sender<Uuid>>,
    reflect: Option<ReflectState>,
    digest: Option<digest::DigestState>,
    database_url: String,
    embed_model: Option<String>,
) -> Router {
    let digests_enabled = digest.is_some();
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
        .route("/v1/metrics", get(metrics::metrics_handler))
        // Issue #198 — see this function's own doc comment for why these
        // three are unconditional rather than gated like Reflection/Digest.
        .route("/v1/backup", get(backup::backup_handler))
        .route("/v1/restore", post(backup::restore_handler))
        .route(
            "/v1/restore/rebuild-embeddings",
            post(backup::rebuild_mismatched_embeddings_handler),
        );

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
            )
            // Issue #96: `GET /v1/models` proxies the configured chat
            // wrapper's own model list. Gated on the same `reflect.is_some()`
            // check as everything else in this block, for the same reason
            // `models.rs`'s own doc comment gives — there is nothing for it
            // to proxy without a configured chat wrapper to ask.
            .route("/v1/models", get(models::models_handler));
    }
    if digests_enabled {
        // Gated separately from the `reflect.is_some()` block above —
        // Digests need only a chat client (`LlmConfig::digest_worker_config`),
        // not the embed client Reflection additionally requires (see
        // `router_with_digests`'s doc comment). A Server with Digests
        // disabled never had its worker running, so nothing has ever been
        // written for `digest::latest_digest_handler` or
        // `digest::digest_at_handler` to find — these routes must 404
        // exactly like an older Server that never had them, the same
        // reasoning `v1_not_found`'s doc comment gives for `/v1/reflect`.
        //
        // `regenerate_digest_handler` (issue #132 / ADR 0039) is
        // registered alongside the two reads, under the same gate — a
        // Server that never ran the Digest worker has no chat client to
        // spend on a regenerate request either, so there is nothing this
        // route could do that a 404 doesn't already say more simply.
        api_router = api_router
            .route("/v1/digests/{period}", get(digest::latest_digest_handler))
            .route(
                "/v1/digests/{period}/{date}",
                get(digest::digest_at_handler),
            )
            .route(
                "/v1/digests/{period}/{date}/regenerate",
                post(digest::regenerate_digest_handler),
            );
    }
    // Always registered, whether or not Reflection is configured: this is
    // what makes an unmatched `/v1/*` path — including `/v1/reflect` and
    // `/v1/sessions/*` when `reflect` above is `None` — a genuine 404
    // instead of the SPA fallback below. See `v1_not_found`'s own doc
    // comment.
    api_router = api_router.route("/v1/{*rest}", any(v1_not_found));

    api_router
        .with_state(AppState {
            pool,
            embed_tx,
            reflect,
            digest,
            digests_enabled,
            database_url,
            embed_model,
        })
        .fallback_service(app_shell)
        .layer(axum::middleware::from_fn(metrics::track_metrics))
        .layer(trace_layer)
        .layer(CorsLayer::permissive())
}
