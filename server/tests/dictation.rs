//! `POST /v1/dictations` and `GET /v1/dictations/{id}` (issue #455 / ADR
//! 0091) against a tiny fake gateway bound to a local port, plus
//! `capabilities.dictation` on `/v1/health` and the dictation fields of
//! `/v1/config`. No test sets a process environment variable (see
//! `tests/settings.rs`): the gateway address and token come in as stored
//! settings, which win over whatever this machine's environment holds.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, Request, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;

use meologue_server::llm::LlmConfig;
use meologue_server::settings::{
    DictationEnv, InstanceMode, RuntimeFlags, StoredSettings, resolve,
};

const TOKEN: &str = "gateway-secret";
const BOUNDARY: &str = "XBOUNDARYX";

#[derive(Clone, Copy)]
enum Behaviour {
    Done,
    Accepted,
    Failed,
}

#[derive(Default, Debug, Clone)]
struct Seen {
    authorization: Option<String>,
    content_type: Option<String>,
    wait: Option<String>,
    body_len: usize,
}

#[derive(Clone)]
struct Fake {
    behaviour: Behaviour,
    seen: Arc<Mutex<Vec<Seen>>>,
}

async fn fake_post(
    State(fake): State<Fake>,
    Query(query): Query<std::collections::HashMap<String, String>>,
    headers: HeaderMap,
    body: Bytes,
) -> axum::response::Response {
    let header = |name: &str| headers.get(name).map(|v| v.to_str().unwrap().to_string());
    let authorization = header("authorization");
    fake.seen.lock().unwrap().push(Seen {
        authorization: authorization.clone(),
        content_type: header("content-type"),
        wait: query.get("wait").cloned(),
        body_len: body.len(),
    });
    if authorization.as_deref() != Some(&format!("Bearer {TOKEN}")) {
        return (StatusCode::UNAUTHORIZED, axum::Json(json!({"error": "unauthorized"})))
            .into_response();
    }
    match fake.behaviour {
        Behaviour::Done => (
            StatusCode::OK,
            axum::Json(json!({"id": "j1", "status": "done", "text": "hello", "rawText": "hello", "warning": "w"})),
        ),
        Behaviour::Accepted => (
            StatusCode::ACCEPTED,
            axum::Json(json!({"id": "j2", "status": "queued"})),
        ),
        Behaviour::Failed => (
            StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(json!({"id": "j3", "status": "failed", "error": "boom"})),
        ),
    }
    .into_response()
}

async fn fake_get(headers: HeaderMap, Path(id): Path<String>) -> axum::response::Response {
    if headers.get("authorization").and_then(|v| v.to_str().ok())
        != Some(&format!("Bearer {TOKEN}"))
    {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if id == "missing" {
        return (StatusCode::NOT_FOUND, axum::Json(json!({"error": "not_found"}))).into_response();
    }
    (StatusCode::OK, axum::Json(json!({"id": id, "status": "done", "text": "later"}))).into_response()
}

/// Binds a fake gateway on an ephemeral loopback port; returns its base URL
/// and the log of what it was sent.
async fn spawn_gateway(behaviour: Behaviour) -> (String, Arc<Mutex<Vec<Seen>>>) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let app = Router::new()
        .route("/v1/dictations", post(fake_post))
        .route("/v1/dictations/{id}", get(fake_get))
        .layer(axum::extract::DefaultBodyLimit::disable())
        .with_state(Fake { behaviour, seen: seen.clone() });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{addr}"), seen)
}

fn llm_none() -> LlmConfig {
    LlmConfig {
        chat_base_url: None,
        chat_model: None,
        chat_api_key: None,
        embed_base_url: None,
        embed_model: None,
        embed_api_key: None,
    }
}

fn flags(stored: StoredSettings) -> RuntimeFlags {
    RuntimeFlags::seed(&resolve(&llm_none(), None, &DictationEnv::default(), &stored, false))
}

fn stored(url: &str, token: Option<&str>, enabled: Option<bool>) -> StoredSettings {
    StoredSettings {
        dictation_base_url: Some(url.to_string()),
        dictation_token: token.map(str::to_string),
        dictation_enabled: enabled,
        ..StoredSettings::default()
    }
}

fn app(pool: &PgPool, flags: RuntimeFlags) -> Router {
    meologue_server::router_with_flags(
        pool.clone(),
        PathBuf::from("."),
        None,
        None,
        None,
        false,
        InstanceMode::Production,
        flags,
    )
}

fn multipart(audio_len: usize) -> Vec<u8> {
    let mut body = format!(
        "--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"audio\"; filename=\"a.webm\"\r\nContent-Type: audio/webm\r\n\r\n"
    )
    .into_bytes();
    body.extend(std::iter::repeat_n(7u8, audio_len));
    body.extend(format!("\r\n--{BOUNDARY}--\r\n").into_bytes());
    body
}

async fn send(app: Router, request: Request<Body>) -> (StatusCode, Value) {
    let response = app.oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

fn upload(uri: &str, audio_len: usize) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri(uri)
        .header("content-type", format!("multipart/form-data; boundary={BOUNDARY}"))
        .body(Body::from(multipart(audio_len)))
        .unwrap()
}

#[sqlx::test]
async fn a_done_job_passes_through_with_token_boundary_and_wait(pool: PgPool) {
    let (url, seen) = spawn_gateway(Behaviour::Done).await;
    let router = app(&pool, flags(stored(&url, Some(TOKEN), None)));

    let (status, body) = send(router, upload("/v1/dictations?wait=1", 100)).await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["text"], "hello");
    assert_eq!(body["rawText"], "hello");
    assert_eq!(body["warning"], "w");
    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].authorization.as_deref(), Some("Bearer gateway-secret"));
    assert_eq!(
        seen[0].content_type.as_deref(),
        Some(format!("multipart/form-data; boundary={BOUNDARY}").as_str())
    );
    assert_eq!(seen[0].wait.as_deref(), Some("1"));
    assert_eq!(seen[0].body_len, multipart(100).len());
}

#[sqlx::test]
async fn an_accepted_job_passes_through_without_wait(pool: PgPool) {
    let (url, seen) = spawn_gateway(Behaviour::Accepted).await;
    let router = app(&pool, flags(stored(&url, Some(TOKEN), None)));

    let (status, body) = send(router, upload("/v1/dictations", 10)).await;

    assert_eq!(status, StatusCode::ACCEPTED);
    assert_eq!(body, json!({"id": "j2", "status": "queued"}));
    assert_eq!(seen.lock().unwrap()[0].wait, None);
}

#[sqlx::test]
async fn a_failed_job_keeps_the_gateways_500_and_body(pool: PgPool) {
    let (url, _) = spawn_gateway(Behaviour::Failed).await;
    let router = app(&pool, flags(stored(&url, Some(TOKEN), None)));

    let (status, body) = send(router, upload("/v1/dictations?wait=1", 10)).await;

    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(body, json!({"id": "j3", "status": "failed", "error": "boom"}));
}

#[sqlx::test]
async fn polling_a_job_passes_through_including_404(pool: PgPool) {
    let (url, _) = spawn_gateway(Behaviour::Done).await;
    let get_job = |id: &str| {
        Request::builder().uri(format!("/v1/dictations/{id}")).body(Body::empty()).unwrap()
    };

    let (status, body) =
        send(app(&pool, flags(stored(&url, Some(TOKEN), None))), get_job("abc")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["id"], "abc");
    assert_eq!(body["text"], "later");

    let (status, body) =
        send(app(&pool, flags(stored(&url, Some(TOKEN), None))), get_job("missing")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body, json!({"error": "not_found"}));
}

#[sqlx::test]
async fn a_gateway_401_becomes_502_rejected_token(pool: PgPool) {
    let (url, _) = spawn_gateway(Behaviour::Done).await;
    let router = app(&pool, flags(stored(&url, Some("wrong-token"), None)));

    let (status, body) = send(router, upload("/v1/dictations", 10)).await;

    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert_eq!(body, json!({"error": "gateway_rejected_token"}));
}

#[sqlx::test]
async fn a_refused_connection_becomes_502_unreachable(pool: PgPool) {
    // Bind then drop, so the port is free and nothing is listening on it.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    let router = app(&pool, flags(stored(&url, Some(TOKEN), None)));

    let (status, body) = send(router.clone(), upload("/v1/dictations", 10)).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert_eq!(body, json!({"error": "gateway_unreachable"}));

    let (status, body) = send(
        router,
        Request::builder().uri("/v1/dictations/abc").body(Body::empty()).unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert_eq!(body, json!({"error": "gateway_unreachable"}));
}

#[sqlx::test]
async fn no_token_is_503_unavailable_and_never_calls_the_gateway(pool: PgPool) {
    let (url, seen) = spawn_gateway(Behaviour::Done).await;
    let router = app(&pool, flags(stored(&url, None, None)));

    let (status, body) = send(router.clone(), upload("/v1/dictations", 10)).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body, json!({"error": "dictation_unavailable"}));

    let (status, _) = send(
        router,
        Request::builder().uri("/v1/dictations/abc").body(Body::empty()).unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert!(seen.lock().unwrap().is_empty());
}

#[sqlx::test]
async fn the_toggle_off_is_503_even_with_a_token(pool: PgPool) {
    let (url, seen) = spawn_gateway(Behaviour::Done).await;
    let router = app(&pool, flags(stored(&url, Some(TOKEN), Some(false))));

    let (status, body) = send(router, upload("/v1/dictations", 10)).await;

    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body, json!({"error": "dictation_unavailable"}));
    assert!(seen.lock().unwrap().is_empty());
}

#[sqlx::test]
async fn an_upload_over_2mb_and_under_50mb_is_accepted(pool: PgPool) {
    let (url, seen) = spawn_gateway(Behaviour::Done).await;
    let router = app(&pool, flags(stored(&url, Some(TOKEN), None)));

    let (status, _) = send(router, upload("/v1/dictations", 5 * 1024 * 1024)).await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(seen.lock().unwrap()[0].body_len, multipart(5 * 1024 * 1024).len());
}

#[sqlx::test]
async fn an_upload_over_50mb_is_refused_by_the_server(pool: PgPool) {
    let (url, seen) = spawn_gateway(Behaviour::Done).await;
    let router = app(&pool, flags(stored(&url, Some(TOKEN), None)));
    let body = multipart(51 * 1024 * 1024);

    // A declared length is refused before anything is forwarded.
    let mut declared = upload("/v1/dictations", 0);
    *declared.body_mut() = Body::from(body.clone());
    declared
        .headers_mut()
        .insert("content-length", body.len().to_string().parse().unwrap());
    let (status, body_json) = send(router.clone(), declared).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(body_json, json!({"error": "payload_too_large"}));

    // An undeclared one (no Content-Length) is cut off mid-stream: never a 200.
    let mut chunked = upload("/v1/dictations", 0);
    *chunked.body_mut() = Body::from_stream(futures_stream(body));
    let (status, _) = send(router, chunked).await;
    assert_ne!(status, StatusCode::OK);
    assert!(
        seen.lock().unwrap().iter().all(|s| s.body_len < 51 * 1024 * 1024),
        "the gateway must not receive the whole oversize body"
    );
}

fn futures_stream(
    body: Vec<u8>,
) -> impl tokio_stream::Stream<Item = Result<Bytes, std::convert::Infallible>> {
    let chunks: Vec<_> = body
        .chunks(64 * 1024)
        .map(|c| Ok(Bytes::copy_from_slice(c)))
        .collect();
    tokio_stream::iter(chunks)
}

// -- /v1/health ----------------------------------------------------------------

async fn health_dictation(pool: &PgPool, flags: RuntimeFlags) -> Value {
    let (status, body) = send(
        app(pool, flags),
        Request::builder().uri("/v1/health").body(Body::empty()).unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    body["capabilities"]["dictation"].clone()
}

#[sqlx::test]
async fn health_reports_dictation_only_when_configured_and_not_off(pool: PgPool) {
    let u = "http://127.0.0.1:1";
    assert_eq!(health_dictation(&pool, RuntimeFlags::all_on()).await, json!(false));
    assert_eq!(health_dictation(&pool, flags(stored(u, None, None))).await, json!(false));
    assert_eq!(health_dictation(&pool, flags(stored(u, Some("t"), None))).await, json!(true));
    assert_eq!(health_dictation(&pool, flags(stored(u, Some("t"), Some(true)))).await, json!(true));
    assert_eq!(health_dictation(&pool, flags(stored(u, Some("t"), Some(false)))).await, json!(false));
    // On cannot conjure a token.
    assert_eq!(health_dictation(&pool, flags(stored(u, None, Some(true)))).await, json!(false));
}

// -- /v1/config ----------------------------------------------------------------

async fn config(pool: &PgPool, flags: RuntimeFlags, method: &str, body: Option<Value>) -> Value {
    let request = Request::builder()
        .method(method)
        .uri("/v1/config")
        .header("content-type", "application/json")
        .body(body.map_or_else(Body::empty, |b| Body::from(b.to_string())))
        .unwrap();
    let (status, body) = send(app(pool, flags), request).await;
    assert_eq!(status, StatusCode::OK);
    body
}

#[sqlx::test]
async fn patching_the_token_turns_dictation_on_live_and_never_echoes_it(pool: PgPool) {
    let flags = RuntimeFlags::all_on();
    let after = config(
        &pool,
        flags.clone(),
        "PATCH",
        Some(json!({"dictation_token": "s3cret-value", "dictation_base_url": "http://gw.invalid:9"})),
    )
    .await;

    assert_eq!(after["dictation_token"], json!({"configured": true, "source": "stored"}));
    assert_eq!(after["dictation_base_url"], json!({"value": "http://gw.invalid:9", "source": "stored"}));
    assert_eq!(after["dictation"]["stored"], Value::Null);
    assert_eq!(after["dictation"]["configured"], true);
    assert_eq!(after["dictation"]["effective"], true);
    assert!(!after.to_string().contains("s3cret-value"), "the token must never be echoed");
    assert!(flags.dictation_available(), "a PATCH applies without a restart");

    let got = config(&pool, flags.clone(), "GET", None).await;
    assert!(!got.to_string().contains("s3cret-value"));
    assert_eq!(got["dictation_token"]["source"], "stored");

    let off = config(&pool, flags.clone(), "PATCH", Some(json!({"dictation_enabled": "off"}))).await;
    assert_eq!(off["dictation"]["stored"], false);
    assert_eq!(off["dictation"]["effective"], false);
    assert!(!flags.dictation_available());

    let cleared = config(
        &pool,
        flags.clone(),
        "PATCH",
        Some(json!({"dictation_enabled": "unset", "dictation_token": "", "dictation_base_url": ""})),
    )
    .await;
    assert_ne!(cleared["dictation_token"]["source"], "stored");
    assert_ne!(cleared["dictation_base_url"]["source"], "stored");
}
