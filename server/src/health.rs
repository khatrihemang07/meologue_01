use axum::Json;
use serde::Serialize;
use utoipa::ToSchema;

use crate::sync::PROTOCOL_VERSION;

/// Identifies this process as a meologue Server to a Device that only knows an
/// address, not what's listening on it.
const SERVICE_MARKER: &str = "meologue-server";

#[derive(Debug, Serialize, ToSchema)]
pub struct HealthResponse {
    pub service: String,
    pub protocol_version: i32,
}

/// Answers whether an address is actually a meologue Server, and which
/// protocol it speaks — without touching the database, so a Server whose
/// Postgres is down still identifies itself. Unlike `/v1/sync`, this never
/// rejects on protocol version: its whole job is letting the caller compare
/// versions themselves. See ADR 0010.
#[utoipa::path(
    get,
    path = "/v1/health",
    responses(
        (status = 200, description = "This address is a meologue Server speaking protocol_version", body = HealthResponse),
    )
)]
pub async fn health_handler() -> Json<HealthResponse> {
    Json(HealthResponse {
        service: SERVICE_MARKER.to_string(),
        protocol_version: PROTOCOL_VERSION,
    })
}
