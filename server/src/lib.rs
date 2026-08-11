pub mod openapi;
pub mod sync;

use std::path::Path;

use axum::{Router, routing::post};
use sqlx::PgPool;
use tower_http::services::{ServeDir, ServeFile};

/// Serves `/v1/sync` plus the built web app out of `static_dir`, falling
/// back to its `index.html` app shell for any other path — one process, one
/// port, one URL, so a phone on the same network can just open an address
/// (ticket 11).
pub fn router(pool: PgPool, static_dir: impl AsRef<Path>) -> Router {
    let static_dir = static_dir.as_ref();
    let index_html = static_dir.join("index.html");
    let app_shell = ServeDir::new(static_dir).fallback(ServeFile::new(index_html));

    Router::new()
        .route("/v1/sync", post(sync::sync_handler))
        .with_state(pool)
        .fallback_service(app_shell)
}
