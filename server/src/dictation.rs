//! `POST /v1/dictations` and `GET /v1/dictations/{id}` (issue #455 / ADR
//! 0091): a transparent proxy to the OpenWhispr gateway, which the Server
//! reaches with a token the Device never sees.
//!
//! The Server adds nothing to the gateway's contract. The multipart body is
//! streamed through unchanged (Content-Type with its boundary included),
//! `?wait=1` is passed on, and the gateway's status and JSON body come back
//! as they are. Three failures belong to the Server and get their own
//! bodies: dictation not configured or toggled off, the gateway not
//! answering, and the gateway refusing the Server's token.
//!
//! Which gateway and which token come from `RuntimeFlags::dictation_gateway`
//! — resolved settings held in memory — so a request costs no database
//! round trip and a `PATCH /v1/config` takes effect on the next one.

use std::sync::OnceLock;
use std::time::Duration;

use axum::{Json, RequestExt};
use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use serde_json::json;
use utoipa::ToSchema;

use crate::settings::{DictationGateway, RuntimeFlags};

/// Audio uploads can be large; axum's default of about 2 MB would refuse
/// anything but a few seconds of speech. Matches the gateway's own limit.
pub const MAX_UPLOAD_BYTES: usize = 50 * 1024 * 1024;

/// `wait=1` holds the gateway up to 25 s, and an upload can be slow.
const GATEWAY_TIMEOUT: Duration = Duration::from_secs(120);

pub fn upload_body_limit() -> DefaultBodyLimit {
    DefaultBodyLimit::max(MAX_UPLOAD_BYTES)
}

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(GATEWAY_TIMEOUT)
            .build()
            .expect("reqwest client builds")
    })
}

/// `POST /v1/dictations`'s multipart body, for the schema only.
#[derive(ToSchema)]
pub struct DictationUpload {
    /// The recorded audio.
    #[schema(value_type = String, format = Binary)]
    #[allow(dead_code)]
    audio: Vec<u8>,
    /// Optional language hint.
    #[allow(dead_code)]
    language: Option<String>,
}

/// The gateway's job shape, passed through unchanged.
#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DictationJob {
    pub id: String,
    /// `queued`, `processing`, `done` or `failed`.
    pub status: String,
    pub text: Option<String>,
    pub raw_text: Option<String>,
    pub warning: Option<String>,
    pub error: Option<String>,
}

/// `{"error": "..."}` — the Server's own errors and the gateway's.
#[derive(Serialize, ToSchema)]
pub struct DictationError {
    pub error: String,
}

#[derive(Deserialize)]
pub struct CreateQuery {
    wait: Option<String>,
}

fn error(status: StatusCode, code: &str) -> Response {
    (status, Json(json!({ "error": code }))).into_response()
}

fn unavailable() -> Response {
    error(StatusCode::SERVICE_UNAVAILABLE, "dictation_unavailable")
}

fn gateway_url(gateway: &DictationGateway, segments: &[&str]) -> Option<reqwest::Url> {
    let mut url = reqwest::Url::parse(&gateway.base_url).ok()?;
    url.path_segments_mut()
        .ok()?
        .pop_if_empty()
        .extend(segments);
    Some(url)
}

/// Sends `request` with the Server's token and maps the outcome. Anything
/// the gateway answers with, other than its 401, goes back verbatim.
async fn forward(gateway: &DictationGateway, request: reqwest::RequestBuilder) -> Response {
    let token = gateway.token.as_deref().unwrap_or_default();
    let upstream = match request.bearer_auth(token).send().await {
        Ok(response) => response,
        Err(err) => {
            tracing::warn!(error = %err, "dictation gateway unreachable");
            return error(StatusCode::BAD_GATEWAY, "gateway_unreachable");
        }
    };
    if upstream.status() == reqwest::StatusCode::UNAUTHORIZED {
        tracing::warn!("dictation gateway rejected the configured token");
        return error(StatusCode::BAD_GATEWAY, "gateway_rejected_token");
    }
    let status = StatusCode::from_u16(upstream.status().as_u16())
        .unwrap_or(StatusCode::BAD_GATEWAY);
    let content_type = upstream.headers().get(header::CONTENT_TYPE).cloned();
    let bytes = match upstream.bytes().await {
        Ok(bytes) => bytes,
        Err(err) => {
            tracing::warn!(error = %err, "dictation gateway response was cut short");
            return error(StatusCode::BAD_GATEWAY, "gateway_unreachable");
        }
    };
    let mut response = (status, bytes).into_response();
    if let Some(value) = content_type {
        response.headers_mut().insert(header::CONTENT_TYPE, value);
    }
    response
}

#[utoipa::path(
    post,
    path = "/v1/dictations",
    params(("wait" = Option<String>, Query, description = "`1` holds the response until the job finishes (up to 25 s)")),
    request_body(content = DictationUpload, content_type = "multipart/form-data"),
    responses(
        (status = 200, description = "Transcribed (wait=1)", body = DictationJob),
        (status = 202, description = "Accepted; poll GET /v1/dictations/{id}", body = DictationJob),
        (status = 400, description = "The gateway rejected the upload", body = DictationError),
        (status = 413, description = "Upload too large", body = DictationError),
        (status = 500, description = "The job failed (wait=1)", body = DictationJob),
        (status = 502, description = "gateway_unreachable or gateway_rejected_token", body = DictationError),
        (status = 503, description = "dictation_unavailable: no token configured, or switched off", body = DictationError),
    )
)]
pub async fn create_dictation_handler(
    State(flags): State<RuntimeFlags>,
    Query(query): Query<CreateQuery>,
    request: axum::extract::Request,
) -> Response {
    let Some(gateway) = flags.dictation_gateway() else {
        return unavailable();
    };
    // `with_limited_body` is what makes `DefaultBodyLimit` bind a streamed
    // body (a bare `Body` extractor ignores it). A declared oversize is
    // answered 413 up front; an undeclared one (chunked) is cut off mid
    // stream and surfaces as the gateway call failing.
    let request = request.with_limited_body();
    let (parts, body) = request.into_parts();
    let headers = parts.headers;
    let declared = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<usize>().ok());
    if declared.is_some_and(|n| n > MAX_UPLOAD_BYTES) {
        return error(StatusCode::PAYLOAD_TOO_LARGE, "payload_too_large");
    }
    let Some(mut url) = gateway_url(&gateway, &["v1", "dictations"]) else {
        return error(StatusCode::BAD_GATEWAY, "gateway_unreachable");
    };
    if query.wait.as_deref() == Some("1") {
        url.query_pairs_mut().append_pair("wait", "1");
    }
    let mut request = client().post(url);
    for name in [header::CONTENT_TYPE, header::CONTENT_LENGTH] {
        if let Some(value) = headers.get(&name) {
            request = request.header(name, HeaderValue::clone(value));
        }
    }
    let request = request.body(reqwest::Body::wrap_stream(Body::new(body).into_data_stream()));
    forward(&gateway, request).await
}

#[utoipa::path(
    get,
    path = "/v1/dictations/{id}",
    params(("id" = String, Path, description = "The job id from POST /v1/dictations")),
    responses(
        (status = 200, description = "The job", body = DictationJob),
        (status = 404, description = "No such job", body = DictationError),
        (status = 502, description = "gateway_unreachable or gateway_rejected_token", body = DictationError),
        (status = 503, description = "dictation_unavailable: no token configured, or switched off", body = DictationError),
    )
)]
pub async fn get_dictation_handler(
    State(flags): State<RuntimeFlags>,
    Path(id): Path<String>,
) -> Response {
    let Some(gateway) = flags.dictation_gateway() else {
        return unavailable();
    };
    let Some(url) = gateway_url(&gateway, &["v1", "dictations", &id]) else {
        return error(StatusCode::BAD_GATEWAY, "gateway_unreachable");
    };
    forward(&gateway, client().get(url)).await
}
