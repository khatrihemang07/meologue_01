use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use anyhow::{Result, bail};
use async_trait::async_trait;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use meologue_server::embedding;
use meologue_server::llm::{ChatMessage, LlmClient};
use serde_json::{Value, json};
use sqlx::PgPool;
use tokio::sync::mpsc;
use tower::ServiceExt;
use uuid::Uuid;

// These tests only ever hit /v1/sync, never a static asset — any directory
// that exists is fine as the (otherwise unused) static_dir.
fn empty_static_dir() -> PathBuf {
    std::env::current_dir().unwrap()
}

// A short interval so tests observe the scan's recovery path in well under
// a second, instead of waiting on the real 30s production `SCAN_INTERVAL`.
const TEST_SCAN_INTERVAL: Duration = Duration::from_millis(20);
const WAIT_TIMEOUT: Duration = Duration::from_secs(5);

/// A fake `LlmClient` with no network dependency: `behavior` decides whether
/// `embed_document` succeeds with a deterministic 640-length vector or
/// always errors, and `call_count` lets a test assert exactly how many
/// times it was invoked (the attempt-cap test's whole point).
struct FakeLlmClient {
    behavior: FakeBehavior,
    call_count: AtomicUsize,
}

enum FakeBehavior {
    AlwaysSucceed,
    AlwaysFail,
}

impl FakeLlmClient {
    fn new(behavior: FakeBehavior) -> Self {
        Self {
            behavior,
            call_count: AtomicUsize::new(0),
        }
    }

    fn calls(&self) -> usize {
        self.call_count.load(Ordering::SeqCst)
    }
}

#[async_trait]
impl LlmClient for FakeLlmClient {
    async fn chat(&self, _messages: &[ChatMessage]) -> Result<String> {
        unimplemented!("chat is not exercised by ticket 3's tests")
    }

    async fn embed_document(&self, _text: &str) -> Result<Vec<f32>> {
        self.call_count.fetch_add(1, Ordering::SeqCst);
        match self.behavior {
            FakeBehavior::AlwaysSucceed => Ok(vec![0.5_f32; 640]),
            FakeBehavior::AlwaysFail => bail!("fake embedding client always errors"),
        }
    }

    async fn embed_query(&self, _text: &str) -> Result<Vec<f32>> {
        unimplemented!("query embeddings are not exercised by ticket 3's tests")
    }
}

fn entry(id: Uuid, device_id: Uuid, body: &str) -> Value {
    json!({
        "id": id,
        "device_id": device_id,
        "body": body,
        "created_at": "2026-01-01T00:00:00Z",
    })
}

async fn post_sync(pool: &PgPool, embed_tx: Option<mpsc::Sender<Uuid>>, body: Value) -> (StatusCode, Value) {
    let app = meologue_server::router_with_embedding(pool.clone(), empty_static_dir(), embed_tx);
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/sync")
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let json = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap()
    };
    (status, json)
}

async fn insert_entry_directly(pool: &PgPool, id: Uuid, device_id: Uuid, body: &str) {
    sqlx::query(
        "insert into entries (id, device_id, body, created_at) values ($1, $2, $3, now())",
    )
    .bind(id)
    .bind(device_id)
    .bind(body)
    .execute(pool)
    .await
    .unwrap();
}

async fn embedding_row(pool: &PgPool, id: Uuid) -> (bool, Option<String>) {
    sqlx::query_as::<_, (bool, Option<String>)>(
        "select embedding is not null, embedding_model from entries where id = $1",
    )
    .bind(id)
    .fetch_one(pool)
    .await
    .unwrap()
}

/// Polls until the Entry has an embedding, or panics after `WAIT_TIMEOUT` —
/// the worker runs concurrently with the test, so there's no single await
/// point that means "it's done."
async fn wait_for_embedding(pool: &PgPool, id: Uuid) -> String {
    let start = Instant::now();
    loop {
        let (has_embedding, model) = embedding_row(pool, id).await;
        if has_embedding {
            return model.expect("embedding and embedding_model are written together");
        }
        if start.elapsed() > WAIT_TIMEOUT {
            panic!("timed out waiting for entry {id} to be embedded");
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[sqlx::test]
async fn an_entry_synced_in_ends_up_with_an_embedding_and_a_model_name(pool: PgPool) {
    let client = Arc::new(FakeLlmClient::new(FakeBehavior::AlwaysSucceed));
    let (tx, rx) = mpsc::channel(16);
    let worker = tokio::spawn(embedding::run(
        pool.clone(),
        client.clone(),
        "fake-model-v1".to_string(),
        rx,
        TEST_SCAN_INTERVAL,
    ));

    let device = Uuid::new_v4();
    let entry_id = Uuid::new_v4();
    let (status, _) = post_sync(
        &pool,
        Some(tx),
        json!({
            "protocol_version": 2,
            "device_id": device,
            "since_seq": 0,
            "entries": [entry(entry_id, device, "an entry that gets embedded")],
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let model = wait_for_embedding(&pool, entry_id).await;
    assert_eq!(model, "fake-model-v1");

    worker.abort();
}

#[sqlx::test]
async fn sync_succeeds_even_when_the_embedding_client_always_errors(pool: PgPool) {
    let client = Arc::new(FakeLlmClient::new(FakeBehavior::AlwaysFail));
    let (tx, rx) = mpsc::channel(16);
    let worker = tokio::spawn(embedding::run(
        pool.clone(),
        client.clone(),
        "fake-model-v1".to_string(),
        rx,
        TEST_SCAN_INTERVAL,
    ));

    let device = Uuid::new_v4();
    let entry_id = Uuid::new_v4();
    let (status, body) = post_sync(
        &pool,
        Some(tx),
        json!({
            "protocol_version": 2,
            "device_id": device,
            "since_seq": 0,
            "entries": [entry(entry_id, device, "an entry the embedding client will refuse")],
        }),
    )
    .await;

    // The most important assertion in this ticket: a failing embedding
    // backend must never surface as a sync failure. `try_send` plus the
    // durable scan (ADR 0022) are what make Capture independent of
    // Reflection's dependencies.
    assert_eq!(status, StatusCode::OK);
    assert!(body["cursor"].as_i64().unwrap() > 0);

    // Give the worker a moment to actually try and fail, then confirm the
    // Entry is still unembedded rather than embedded-by-accident.
    tokio::time::sleep(TEST_SCAN_INTERVAL * 3).await;
    let (has_embedding, _) = embedding_row(&pool, entry_id).await;
    assert!(!has_embedding);
    assert!(client.calls() > 0, "the worker should have attempted at least once");

    worker.abort();
}

#[sqlx::test]
async fn the_scan_picks_up_an_entry_never_sent_through_the_channel(pool: PgPool) {
    let client = Arc::new(FakeLlmClient::new(FakeBehavior::AlwaysSucceed));
    // No sender is ever handed to this Entry's insert — it only ever reaches
    // the worker via the `embedding IS NULL` scan.
    let (_tx, rx) = mpsc::channel(16);
    let worker = tokio::spawn(embedding::run(
        pool.clone(),
        client.clone(),
        "fake-model-v1".to_string(),
        rx,
        TEST_SCAN_INTERVAL,
    ));

    let device = Uuid::new_v4();
    let entry_id = Uuid::new_v4();
    insert_entry_directly(&pool, entry_id, device, "seeded straight into postgres").await;

    let model = wait_for_embedding(&pool, entry_id).await;
    assert_eq!(model, "fake-model-v1");

    worker.abort();
}

#[sqlx::test]
async fn an_entry_that_fails_repeatedly_stops_being_retried_after_the_cap(pool: PgPool) {
    let client = Arc::new(FakeLlmClient::new(FakeBehavior::AlwaysFail));
    let (_tx, rx) = mpsc::channel(16);
    let worker = tokio::spawn(embedding::run(
        pool.clone(),
        client.clone(),
        "fake-model-v1".to_string(),
        rx,
        TEST_SCAN_INTERVAL,
    ));

    let device = Uuid::new_v4();
    let entry_id = Uuid::new_v4();
    insert_entry_directly(&pool, entry_id, device, "a poison entry").await;

    // The Entry stays unembedded forever (the fake always errors), so every
    // scan tick re-selects it — long enough for many more than
    // `MAX_ATTEMPTS` ticks to have fired if the cap weren't enforced.
    tokio::time::sleep(TEST_SCAN_INTERVAL * 25).await;

    assert_eq!(client.calls(), embedding::MAX_ATTEMPTS as usize);

    let (has_embedding, _) = embedding_row(&pool, entry_id).await;
    assert!(!has_embedding);

    worker.abort();
}
