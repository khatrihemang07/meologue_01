pub mod openapi;
pub mod sync;

use axum::{Router, routing::post};
use sqlx::PgPool;

pub fn router(pool: PgPool) -> Router {
    Router::new()
        .route("/v1/sync", post(sync::sync_handler))
        .with_state(pool)
}
