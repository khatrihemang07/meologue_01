use utoipa::OpenApi;

use crate::health::HealthResponse;
use crate::reflect::{PriorTurn, ReflectRequest, ReflectResponse};
use crate::sync::{EntryInput, EntryOutput, SyncRequest, SyncResponse};

#[derive(OpenApi)]
#[openapi(
    paths(
        crate::health::health_handler,
        crate::sync::sync_handler,
        crate::reflect::reflect_handler,
    ),
    components(schemas(
        HealthResponse,
        SyncRequest,
        SyncResponse,
        EntryInput,
        EntryOutput,
        ReflectRequest,
        ReflectResponse,
        PriorTurn,
    ))
)]
struct ApiDoc;

pub fn spec() -> utoipa::openapi::OpenApi {
    ApiDoc::openapi()
}
