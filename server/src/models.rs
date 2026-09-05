//! `GET /v1/models` — issue #96: proxies the configured chat wrapper's own
//! model list (`llm::list_models`) so a client can offer a per-Session model
//! choice. That choice is issue #98's own feature; this ticket only wires
//! the endpoint the wire work belongs to, reusing the fetch
//! `llm::resolve_context_window` already makes for the single configured
//! model (`llm::fetch_context_window`/`llm::get_json`) rather than writing a
//! second one — see `llm::ModelInfo`'s own doc comment for what each entry
//! carries and why.
//!
//! Gated on `ReflectState` being configured — the same on/off switch
//! `/v1/reflect` itself uses (`lib.rs::router_with_digests`, `reflect.is_some()`)
//! — and, since issue #201, on Reflection's runtime toggle as well, which
//! answers 503 rather than 404 because the two say different things (ADR 0062).
//! There is nothing for this endpoint to proxy without a configured chat
//! wrapper to ask, and reusing Reflection's own gate keeps "the route
//! exists" meaning the same thing it already means for the rest of
//! Reflection's surface, rather than introducing a third on/off switch next
//! to `reflect_config`/`digest_worker_config`.

use axum::{Json, extract::State, http::StatusCode};
use serde::Serialize;
use utoipa::ToSchema;

use crate::llm::{self, ModelInfo};
use crate::reflect::ReflectState;

#[derive(Debug, Serialize, ToSchema)]
pub struct ModelsResponse {
    /// The wrapper's own list, verbatim — empty, not an error or a missing
    /// field, when the wrapper cannot be reached (`llm::list_models`'s own
    /// doc comment covers every way that can happen). A client sees "no
    /// models offered" rather than a failed request.
    pub models: Vec<ModelInfo>,
}

#[utoipa::path(
    get,
    path = "/v1/models",
    responses(
        (status = 200, description = "The configured chat wrapper's own model list — \
            empty, not an error, when the wrapper cannot be reached", body = ModelsResponse),
        (status = 404, description = "Reflection (and so this route) is unconfigured"),
        (status = 503, description = "Reflection is configured but switched off right now \
            (ADR 0062) — distinct from the 404 above, which means this Server has no \
            Reflection at all"),
    )
)]
pub async fn models_handler(
    State(reflect): State<Option<ReflectState>>,
) -> Result<Json<ModelsResponse>, StatusCode> {
    // Only reachable if this state's absence somehow slipped past the
    // conditional route registration in `lib.rs` — see
    // `reflect::reflect_handler`'s own identical guard for why this is a
    // defensive fallback, not the mechanism a client is meant to observe.
    let Some(reflect) = reflect else {
        tracing::error!(
            "models_handler invoked with no ReflectState — route should not be registered"
        );
        return Err(StatusCode::NOT_FOUND);
    };

    // Issue #201: the route stays registered when Reflection is switched off
    // at runtime, so this is the live half of the same gate `reflect_handler`
    // applies. Offering a model list for a Reflection that will answer 503 is
    // an invitation to a request that cannot succeed — and the list is fetched
    // from the wrapper, which is exactly the work the toggle exists to stop.
    if !reflect.flags.reflect_enabled() {
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    }

    let models = llm::list_models(&reflect.chat_base_url, reflect.chat_api_key.as_deref()).await;
    Ok(Json(ModelsResponse { models }))
}
