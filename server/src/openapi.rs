use utoipa::OpenApi;

use crate::health::HealthResponse;
use crate::reflect::{ReflectRequest, ReflectResponse};
use crate::sessions::{SessionResponse, SessionRow, SessionTurnRow};
use crate::sync::{EntryInput, EntryOutput, SyncRequest, SyncResponse};

#[derive(OpenApi)]
#[openapi(
    paths(
        crate::health::health_handler,
        crate::sync::sync_handler,
        crate::reflect::reflect_handler,
        crate::sessions::get_session_handler,
        crate::sessions::list_sessions_handler,
        crate::sessions::delete_session_handler,
    ),
    components(schemas(
        HealthResponse,
        SyncRequest,
        SyncResponse,
        EntryInput,
        EntryOutput,
        ReflectRequest,
        ReflectResponse,
        SessionResponse,
        SessionTurnRow,
        SessionRow,
    ))
)]
struct ApiDoc;

pub fn spec() -> utoipa::openapi::OpenApi {
    ApiDoc::openapi()
}
