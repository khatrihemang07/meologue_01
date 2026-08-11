use utoipa::OpenApi;

use crate::sync::{EntryInput, EntryOutput, SyncRequest, SyncResponse};

#[derive(OpenApi)]
#[openapi(
    paths(crate::sync::sync_handler),
    components(schemas(SyncRequest, SyncResponse, EntryInput, EntryOutput))
)]
struct ApiDoc;

pub fn spec() -> utoipa::openapi::OpenApi {
    ApiDoc::openapi()
}
