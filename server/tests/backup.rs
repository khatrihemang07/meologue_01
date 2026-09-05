//! Integration tests for issue #198's `GET /v1/backup`, `POST /v1/restore`
//! and `POST /v1/restore/rebuild-embeddings`, following `sync.rs`'s
//! `#[sqlx::test]` conventions. These genuinely shell out to `pg_dump` and
//! `pg_restore` on the host — there is no fake or in-process substitute for
//! either, since the whole point of `server/src/backup.rs` is delegating to
//! the real tools. Every test here is skipped with a clear message, rather
//! than failing, when either binary isn't on `PATH` — see `require_pg_tools`.

use std::path::PathBuf;
use std::process::Stdio;

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::Value;
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

// These tests never serve a static asset — any directory that exists is
// fine as the (otherwise unused) static_dir, matching every other test
// file's own `empty_static_dir`.
fn empty_static_dir() -> PathBuf {
    std::env::current_dir().unwrap()
}

/// `true` iff both `pg_dump` and `pg_restore` are on `PATH` — checked once
/// per test rather than assumed, so a host missing either produces a
/// visible "skipped" line instead of every test in this file failing with
/// a confusing `BackupError::ToolMissing` 500. See this module's own doc
/// comment: server/README.md#backup-and-restore names what to install.
fn pg_tools_available() -> bool {
    fn on_path(tool: &str) -> bool {
        std::process::Command::new(tool)
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }
    on_path("pg_dump") && on_path("pg_restore")
}

/// Skips the calling test with a clear, visible reason when `pg_dump`/
/// `pg_restore` aren't installed on this host, rather than letting every
/// test in this file fail with the same opaque cause. Returns `true` when
/// the caller should return early.
macro_rules! skip_without_pg_tools {
    () => {
        if !pg_tools_available() {
            eprintln!(
                "SKIPPED: pg_dump/pg_restore not found on PATH — install PostgreSQL client \
                 tools to run server/tests/backup.rs (see server/README.md#backup-and-restore)"
            );
            return;
        }
    };
}

/// Reconstructs the connection URL for `pool`'s own database — for
/// `#[sqlx::test]`, a throwaway `_sqlx_test_*` database, not the one named
/// in the ambient `DATABASE_URL`. `pg_dump`/`pg_restore` need a real URL,
/// and `sqlx::PgConnectOptions` never hands a parsed password back out
/// (`get_password` doesn't exist), so this reuses everything up to the
/// last `/` in `DATABASE_URL` — host, port, credentials — and swaps in
/// `pool`'s actual database name via `connect_options().get_database()`.
/// This mirrors exactly what `AppState::database_url` holds in production:
/// the one connection string the server was started with.
fn test_database_url(pool: &PgPool) -> String {
    let base = std::env::var("DATABASE_URL").expect(
        "DATABASE_URL must be set to run server/tests/backup.rs — see server/README.md#testing",
    );
    let (prefix, _) = base
        .rsplit_once('/')
        .expect("DATABASE_URL must name a database, e.g. postgres://user:pass@host:port/db");
    let db_name = pool
        .connect_options()
        .get_database()
        .expect("pool is connected to a database")
        .to_string();
    format!("{prefix}/{db_name}")
}

fn app(pool: &PgPool, embed_model: Option<&str>) -> Router {
    meologue_server::router_with_backup(
        pool.clone(),
        empty_static_dir(),
        None,
        None,
        None,
        test_database_url(pool),
        embed_model.map(str::to_string),
    )
}

async fn get(app: Router, uri: &str) -> (StatusCode, Vec<u8>) {
    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(uri)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, bytes.to_vec())
}

async fn post_bytes(app: Router, uri: &str, body: Vec<u8>) -> (StatusCode, Value) {
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(uri)
                .header("content-type", "application/octet-stream")
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let json = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    (status, json)
}

async fn post_empty(app: Router, uri: &str) -> (StatusCode, Value) {
    post_bytes(app, uri, Vec::new()).await
}

/// A valid pgvector text literal of the fixed `vector(640)` width
/// (`server/migrations/0002_add_entry_embeddings.sql`) — every element is
/// `value`, which is enough to make two embeddings distinguishable without
/// needing anything realistic.
fn vector_literal(value: f32) -> String {
    let mut out = String::from("[");
    for i in 0..640 {
        if i > 0 {
            out.push(',');
        }
        out.push_str(&value.to_string());
    }
    out.push(']');
    out
}

async fn insert_entry(
    pool: &PgPool,
    id: Uuid,
    device_id: Uuid,
    body: &str,
    embedding_model: Option<&str>,
) {
    sqlx::query(
        "insert into entries (id, device_id, body, created_at, embedding, embedding_model) \
         values ($1, $2, $3, now(), case when $4::text is null then null else $5::vector end, $4)",
    )
    .bind(id)
    .bind(device_id)
    .bind(body)
    .bind(embedding_model)
    .bind(embedding_model.map(|_| vector_literal(0.5)))
    .execute(pool)
    .await
    .unwrap();
}

async fn insert_task(pool: &PgPool, id: Uuid, device_id: Uuid, content: &str) {
    sqlx::query(
        "insert into tasks (id, device_id, content, order_key, day_order, created_at) \
         values ($1, $2, $3, 'a0', 'a0', now())",
    )
    .bind(id)
    .bind(device_id)
    .bind(content)
    .execute(pool)
    .await
    .unwrap();
}

async fn entry_ids(pool: &PgPool) -> Vec<Uuid> {
    sqlx::query_scalar("select id from entries order by seq")
        .fetch_all(pool)
        .await
        .unwrap()
}

async fn task_ids(pool: &PgPool) -> Vec<Uuid> {
    sqlx::query_scalar("select id from tasks order by seq")
        .fetch_all(pool)
        .await
        .unwrap()
}

async fn embedding_is_null(pool: &PgPool, id: Uuid) -> bool {
    sqlx::query_scalar("select embedding is null from entries where id = $1")
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap()
}

#[sqlx::test]
async fn a_backup_of_a_populated_database_is_a_non_empty_pg_dump_archive(pool: PgPool) {
    skip_without_pg_tools!();

    insert_entry(&pool, Uuid::new_v4(), Uuid::new_v4(), "hello", None).await;

    let (status, bytes) = get(app(&pool, None), "/v1/backup").await;

    assert_eq!(status, StatusCode::OK);
    assert!(
        !bytes.is_empty(),
        "a dump of a populated database must not be empty"
    );
    // "PGDMP" is pg_dump's custom-format magic number — a cheap, specific
    // check that this is really a pg_dump archive, not just "some bytes".
    assert_eq!(&bytes[0..5], b"PGDMP");
}

/// The round-trip acceptance criterion — "back up, drop the database,
/// restore — Entries, Tasks, Sessions and Digests all survive" — proven
/// the way that matters most: restoring an earlier backup must genuinely
/// wipe-and-replace, not merely leave existing rows alone. `entry_b`/
/// `task_b` are inserted *after* the backup is taken, so their survival
/// past the restore would mean `--clean` never ran and this was a no-op.
///
/// This same restore also exercises the embedding-model mismatch count:
/// `entry_a` carries a different `embedding_model` than the Server is
/// configured with here, and `configured_model` was never itself in the
/// backup — only `entries.embedding_model`, per-row, was — so a correct
/// count is exactly 1, read straight off what `pg_restore` just applied.
#[sqlx::test]
async fn a_restore_wipes_and_replaces_and_reports_the_embedding_mismatch_count(pool: PgPool) {
    skip_without_pg_tools!();

    let device_id = Uuid::new_v4();
    let entry_a = Uuid::new_v4();
    let entry_matching = Uuid::new_v4();
    let task_a = Uuid::new_v4();

    insert_entry(
        &pool,
        entry_a,
        device_id,
        "from before the backup",
        Some("old-model"),
    )
    .await;
    insert_entry(
        &pool,
        entry_matching,
        device_id,
        "already on the right model",
        Some("new-model"),
    )
    .await;
    insert_task(&pool, task_a, device_id, "a task from before the backup").await;

    let (backup_status, dump) = get(app(&pool, Some("new-model")), "/v1/backup").await;
    assert_eq!(backup_status, StatusCode::OK);

    // Drift after the backup was taken — must not survive the restore.
    let entry_b = Uuid::new_v4();
    let task_b = Uuid::new_v4();
    insert_entry(&pool, entry_b, device_id, "inserted after the backup", None).await;
    insert_task(&pool, task_b, device_id, "inserted after the backup").await;

    let (restore_status, restore_body) =
        post_bytes(app(&pool, Some("new-model")), "/v1/restore", dump).await;

    assert_eq!(
        restore_status,
        StatusCode::OK,
        "restore failed: {restore_body:?}"
    );
    assert_eq!(restore_body["mismatched_embedding_count"], 1);

    let restored_entries = entry_ids(&pool).await;
    assert!(
        restored_entries.contains(&entry_a),
        "entry_a must survive the restore"
    );
    assert!(
        restored_entries.contains(&entry_matching),
        "entry_matching must survive the restore"
    );
    assert!(
        !restored_entries.contains(&entry_b),
        "entry_b post-dates the backup and must not survive"
    );

    let restored_tasks = task_ids(&pool).await;
    assert!(
        restored_tasks.contains(&task_a),
        "task_a must survive the restore"
    );
    assert!(
        !restored_tasks.contains(&task_b),
        "task_b post-dates the backup and must not survive"
    );
}

/// "Choosing rebuild clears those embeddings ... choosing leave keeps them
/// untouched" — proven directly against `POST /v1/restore/rebuild-embeddings`,
/// independent of a restore ever happening: the endpoint nulls exactly the
/// rows whose `embedding_model` differs from the configured one, and
/// leaves every other row's `embedding` exactly as it was.
#[sqlx::test]
async fn rebuild_nulls_exactly_the_mismatched_rows_and_leaves_others_alone(pool: PgPool) {
    let device_id = Uuid::new_v4();
    let mismatched = Uuid::new_v4();
    let matching = Uuid::new_v4();
    let never_embedded = Uuid::new_v4();

    insert_entry(&pool, mismatched, device_id, "old model", Some("old-model")).await;
    insert_entry(
        &pool,
        matching,
        device_id,
        "current model",
        Some("new-model"),
    )
    .await;
    insert_entry(&pool, never_embedded, device_id, "not embedded yet", None).await;

    let (status, body) = post_empty(
        app(&pool, Some("new-model")),
        "/v1/restore/rebuild-embeddings",
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["rebuilt_count"], 1);

    assert!(
        embedding_is_null(&pool, mismatched).await,
        "the mismatched row must be nulled"
    );
    assert!(
        !embedding_is_null(&pool, matching).await,
        "the matching row must be untouched"
    );
    assert!(
        embedding_is_null(&pool, never_embedded).await,
        "a never-embedded row was already null and stays null"
    );
}

/// A Server with no embedding model configured at all still reports a
/// meaningful mismatch count: `count_mismatched_embeddings`'s own doc
/// comment argues every embedded row is a mismatch in that case, since
/// none of them could have come from a model this Server can even name.
#[sqlx::test]
async fn with_no_embedding_model_configured_every_embedded_row_counts_as_mismatched(pool: PgPool) {
    skip_without_pg_tools!();

    let device_id = Uuid::new_v4();
    insert_entry(
        &pool,
        Uuid::new_v4(),
        device_id,
        "embedded under some model",
        Some("some-model"),
    )
    .await;
    insert_entry(&pool, Uuid::new_v4(), device_id, "never embedded", None).await;

    let (backup_status, dump) = get(app(&pool, None), "/v1/backup").await;
    assert_eq!(backup_status, StatusCode::OK);

    let (restore_status, restore_body) = post_bytes(app(&pool, None), "/v1/restore", dump).await;

    assert_eq!(
        restore_status,
        StatusCode::OK,
        "restore failed: {restore_body:?}"
    );
    assert_eq!(restore_body["mismatched_embedding_count"], 1);
}
