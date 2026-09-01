use axum::Json;
use axum::extract::State;
use serde::Serialize;
use utoipa::ToSchema;

use crate::sync::PROTOCOL_VERSION;
use crate::{DigestsEnabled, reflect::ReflectState};

/// Identifies this process as a meologue Server to a Device that only knows an
/// address, not what's listening on it.
const SERVICE_MARKER: &str = "meologue-server";

/// Which Server-backed features this Server can actually serve right now,
/// derived from the same configuration `main.rs` already used to decide
/// whether `/v1/reflect`, `/v1/digests/*` and the embedding worker exist at
/// all (issue #133). Reported alongside `HealthResponse` rather than left
/// for a Device to infer from probing each route in turn: a Device that only
/// asked "does `/v1/reflect` 404" would still show a working-looking
/// Reflect row on a Server that has the route but no model behind it, since
/// `router_with_digests` only ever gates *registration*, not per-request
/// configuration checks.
///
/// - `reflect` mirrors `reflect.is_some()` — the exact condition
///   `router_with_digests` gates `/v1/reflect`, `/v1/sessions*` and
///   `/v1/models` on.
/// - `digest` mirrors `digests_enabled` — the exact bool `main.rs` computes
///   from `LlmConfig::digest_worker_config().is_some()` and
///   `router_with_digests` gates `/v1/digests/*` on.
/// - `embeddings` reports whether Reflection's own embed client resolved
///   (`ReflectState::embed_client`). Issue #130: `reflect_config()` now
///   needs chat alone and hands back `None` for the embed half when no
///   embed config is resolvable, so a chat-only Server still reports
///   `reflect: true` while `embeddings: false` — exactly the Server on
///   which `reflect.rs`'s tool loop quietly omits `similar_entries`.
/// - `todo` — issue #172 / ADR 0051 — is **unconditionally `true`**, not
///   read off any `LlmConfig`. Task Sync has no model behind it and no
///   configuration that can disable it: any Server that answers
///   `/v1/health` at all is one that runs `sync_handler` and speaks
///   `PROTOCOL_VERSION` 5 (or the transitional 4), so it always accepts
///   Tasks the moment it accepts Entries. This is deliberately unlike the
///   three capabilities above, all of which name a real "maybe not" —
///   `todo` names a "yes, structurally." It is reported anyway, rather
///   than left off `HealthCapabilities` entirely, because it exists for a
///   *different* reader than `chat-list.tsx`'s lock check
///   (`apps/web/src/components/chat-list.tsx`'s own header comment: Todo's
///   row is never locked by this field, since Todo works fully offline
///   like Composer): issue #175's Digest and Reflection coverage of Tasks
///   is what actually consults it, to tell "this Server has never heard of
///   Tasks" (an old build, protocol 4 behaviour) apart from "this Server
///   has Tasks but nothing configured to talk about them," which no other
///   field here can distinguish.
#[derive(Debug, Clone, Copy, Serialize, ToSchema)]
pub struct HealthCapabilities {
    pub reflect: bool,
    pub digest: bool,
    pub embeddings: bool,
    pub todo: bool,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct HealthResponse {
    pub service: String,
    pub protocol_version: i32,
    /// `Option`, not a bare `HealthCapabilities`, so the field is optional
    /// on the wire (utoipa marks an `Option` field `required: false` in the
    /// generated schema, which `openapi-typescript` turns into
    /// `capabilities?: ...` for `packages/core`). This Server always
    /// populates it — the `None` case exists only so an older Server that
    /// predates this field keeps producing a `HealthResponse` a current
    /// Device can still parse, reading the missing field as "unknown"
    /// rather than a schema mismatch (`server-check.ts`).
    pub capabilities: Option<HealthCapabilities>,
}

/// Answers whether an address is actually a meologue Server, which protocol
/// it speaks, and — since issue #133 — which Server-backed features it can
/// actually serve, all without touching the database, so a Server whose
/// Postgres is down still identifies itself. Unlike `/v1/sync`, this never
/// rejects on protocol version: its whole job is letting the caller compare
/// versions themselves. See ADR 0010.
///
/// Reads `Option<ReflectState>` and `DigestsEnabled` off `AppState` (via
/// their own `FromRef` impls in `lib.rs`) rather than the whole `AppState`
/// — the same one-extractor-per-need shape `sync::sync_handler` and
/// `reflect::reflect_handler` already use, and precisely what keeps this
/// handler from ever touching `PgPool` and staying DB-free.
#[utoipa::path(
    get,
    path = "/v1/health",
    responses(
        (status = 200, description = "This address is a meologue Server speaking protocol_version, with its Destination capabilities", body = HealthResponse),
    )
)]
pub async fn health_handler(
    State(reflect): State<Option<ReflectState>>,
    State(DigestsEnabled(digest)): State<DigestsEnabled>,
) -> Json<HealthResponse> {
    let capabilities = HealthCapabilities {
        reflect: reflect.is_some(),
        digest,
        embeddings: reflect.as_ref().is_some_and(|state| state.embed_client.is_some()),
        // See HealthCapabilities::todo's own doc comment for why this is a
        // bare `true` rather than reading anything off `LlmConfig`.
        todo: true,
    };

    Json(HealthResponse {
        service: SERVICE_MARKER.to_string(),
        protocol_version: PROTOCOL_VERSION,
        capabilities: Some(capabilities),
    })
}
