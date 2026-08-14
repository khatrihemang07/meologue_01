use utoipa::OpenApi;

use crate::health::HealthResponse;
use crate::sync::{EntryInput, EntryOutput, SyncRequest, SyncResponse};

#[derive(OpenApi)]
#[openapi(
    paths(crate::health::health_handler, crate::sync::sync_handler),
    components(schemas(HealthResponse, SyncRequest, SyncResponse, EntryInput, EntryOutput))
)]
struct ApiDoc;

pub fn spec() -> utoipa::openapi::OpenApi {
    ApiDoc::openapi()
}
