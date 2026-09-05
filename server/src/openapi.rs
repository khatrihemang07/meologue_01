use utoipa::OpenApi;

use crate::digest::{Digest, DigestResponse};
use crate::health::{HealthCapabilities, HealthResponse};
use crate::llm::ModelInfo;
use crate::models::ModelsResponse;
use crate::reflect::{ReflectRequest, ReflectResponse};
use crate::sessions::{SessionResponse, SessionRow, SessionTurnRow};
use crate::settings::{ConfigPatch, ConfigResponse, InstanceMode, ResolvedField, Source};
use crate::sync::{
    CommentInput, CommentOutput, EntryInput, EntryOutput, EventInput, EventOutput, LabelInput,
    LabelOutput, ProjectInput, ProjectOutput, SectionInput, SectionOutput, SyncRequest,
    SyncResponse, TaskInput, TaskOutput,
};

#[derive(OpenApi)]
#[openapi(
    paths(
        crate::health::health_handler,
        crate::sync::sync_handler,
        crate::reflect::reflect_handler,
        crate::sessions::get_session_handler,
        crate::sessions::list_sessions_handler,
        crate::sessions::delete_session_handler,
        crate::digest::latest_digest_handler,
        crate::digest::digest_at_handler,
        crate::digest::regenerate_digest_handler,
        crate::models::models_handler,
        crate::settings::get_config_handler,
        crate::settings::patch_config_handler,
    ),
    components(schemas(
        HealthResponse,
        HealthCapabilities,
        SyncRequest,
        SyncResponse,
        EntryInput,
        EntryOutput,
        TaskInput,
        TaskOutput,
        ProjectInput,
        ProjectOutput,
        SectionInput,
        SectionOutput,
        LabelInput,
        LabelOutput,
        CommentInput,
        CommentOutput,
        EventInput,
        EventOutput,
        ReflectRequest,
        ReflectResponse,
        SessionResponse,
        SessionTurnRow,
        SessionRow,
        DigestResponse,
        Digest,
        ModelsResponse,
        ModelInfo,
        ConfigResponse,
        ConfigPatch,
        ResolvedField,
        Source,
        InstanceMode,
    ))
)]
struct ApiDoc;

pub fn spec() -> utoipa::openapi::OpenApi {
    ApiDoc::openapi()
}
