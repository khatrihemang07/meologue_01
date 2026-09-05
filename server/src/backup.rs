//! Server backup and restore over `pg_dump`/`pg_restore` shelled out on the
//! host, not `docker exec` (issue #198) — see `backup_handler` and
//! `restore_handler` below for the full reasoning, including the
//! deliberate lack of authentication on `restore_handler`.

use std::process::Stdio;

use axum::Json;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use sqlx::PgPool;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use utoipa::ToSchema;

use crate::{ConfiguredEmbedModel, DatabaseUrl};

/// Every way a backup or restore can fail, each carrying enough to explain
/// itself rather than surfacing as an opaque 500 — the acceptance
/// criterion this ticket names explicitly ("missing database tooling
/// produces a clear, actionable error"). `IntoResponse` below turns every
/// variant into a 500 with a JSON `{"error": "..."}` body naming exactly
/// what to install or what went wrong; there is no 4xx variant because
/// nothing about these two requests can be malformed by the caller in a
/// way that isn't already just "the tooling failed" (the request body for
/// `POST /v1/restore` is opaque bytes handed straight to `pg_restore`,
/// which is the thing that judges whether they're a valid dump).
#[derive(Debug)]
pub enum BackupError {
    /// `tool` (`"pg_dump"` or `"pg_restore"`) isn't on `PATH` at all, or
    /// its `--version` output couldn't be parsed. `server_major` is this
    /// Server's own Postgres major version (from `server_major_version`),
    /// named in the error so the reader knows exactly which version to
    /// install rather than guessing from `docker-compose.yml`.
    ToolMissing { tool: &'static str, server_major: i32 },
    /// `tool` was found, but its major version is older than the server's.
    /// pg_dump/pg_restore can only speak to a Postgres server whose major
    /// version is the same or older than the tool's own — never newer —
    /// so an older client here fails at dump/restore time, not at
    /// connection time, which is exactly the "opaque failure" this
    /// ticket's acceptance criterion asks not to leave in place.
    ToolOutdated { tool: &'static str, found: i32, required: i32 },
    /// `tool` ran, but exited non-zero — its stderr is the most useful
    /// thing this handler can report back.
    ProcessFailed { tool: &'static str, stderr: String },
    /// A query against `pool` itself failed — either the version check's
    /// own `select current_setting(...)`, or (`restore_handler` only) the
    /// mismatch count run after `pg_restore` already succeeded.
    Database(sqlx::Error),
    /// Spawning or writing to a child process failed at the OS level —
    /// distinct from `ToolMissing`, which is specifically "not on PATH";
    /// this is everything else `std::io::Error` can mean (e.g. a pipe
    /// closed early).
    Io(std::io::Error),
}

impl IntoResponse for BackupError {
    fn into_response(self) -> Response {
        let message = match &self {
            BackupError::ToolMissing { tool, server_major } => format!(
                "{tool} was not found on this Server's PATH. Install PostgreSQL {server_major} \
                 client tools — e.g. `brew install postgresql@{server_major}` on macOS, or \
                 `apt-get install postgresql-client-{server_major}` on Debian/Ubuntu — so backup \
                 and restore can shell out to {tool}. See server/README.md."
            ),
            BackupError::ToolOutdated { tool, found, required } => format!(
                "{tool} {found} is older than this Server's PostgreSQL {required}. {tool} must be \
                 the same major version as the server, or newer — install PostgreSQL {required} \
                 client tools and try again. See server/README.md."
            ),
            BackupError::ProcessFailed { tool, stderr } => {
                format!("{tool} failed: {}", stderr.trim())
            }
            BackupError::Database(err) => format!("database error: {err}"),
            BackupError::Io(err) => format!("failed to run the database tool: {err}"),
        };
        tracing::error!(error = %message, "backup/restore request failed");
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": message })),
        )
            .into_response()
    }
}

/// This Server's own Postgres major version, read from the live connection
/// rather than assumed from `docker-compose.yml` — a Sandbox instance, a
/// remote host, or a future Postgres upgrade all answer this the same way
/// a hardcoded constant never could. `server_version_num` is documented by
/// Postgres as `major * 10000 + minor` from Postgres 10 onward (e.g.
/// `180006` for 18.6), so integer-dividing by `10000` gives the major
/// version alone.
async fn server_major_version(pool: &PgPool) -> sqlx::Result<i32> {
    let version_num: String = sqlx::query_scalar("select current_setting('server_version_num')")
        .fetch_one(pool)
        .await?;
    Ok(version_num.parse::<i32>().unwrap_or(0) / 10_000)
}

/// Pulls the leading major-version integer out of a `pg_dump`/`pg_restore`
/// `--version` line, e.g. `"pg_dump (PostgreSQL) 18.6 (Homebrew)"` or
/// `"pg_restore (PostgreSQL) 18beta1"` both yield `Some(18)`. Postgres's own
/// version string format is stable enough (major version is always the
/// first whitespace-separated token starting with an ASCII digit) that a
/// small manual scan is simpler than pulling in a regex dependency for one
/// call site.
fn parse_major_version(version_output: &str) -> Option<i32> {
    version_output.split_whitespace().find_map(|token| {
        let digits: String = token.chars().take_while(char::is_ascii_digit).collect();
        (!digits.is_empty()).then(|| digits.parse().ok()).flatten()
    })
}

/// Confirms `tool` (`"pg_dump"` or `"pg_restore"`) is installed and is at
/// least this Server's own Postgres major version, before either handler
/// spends any effort on an actual dump/restore — see `BackupError`'s two
/// tool-related variants for why this check exists at all rather than
/// letting a missing or outdated binary fail as a bare non-zero exit.
async fn ensure_tool_compatible(tool: &'static str, pool: &PgPool) -> Result<(), BackupError> {
    let server_major = server_major_version(pool).await.map_err(BackupError::Database)?;

    let output = Command::new(tool).arg("--version").output().await;
    let found_major = match output {
        Ok(output) if output.status.success() => {
            parse_major_version(&String::from_utf8_lossy(&output.stdout))
        }
        _ => None,
    };

    match found_major {
        None => Err(BackupError::ToolMissing { tool, server_major }),
        Some(found) if found < server_major => Err(BackupError::ToolOutdated {
            tool,
            found,
            required: server_major,
        }),
        Some(_) => Ok(()),
    }
}

/// `POST /v1/restore`'s response: how many `entries` rows carry an
/// `embedding_model` different from the one this Server is configured
/// with, right after the dump that was just applied landed. `entries` gets
/// its `embedding_model` in the same `UPDATE` that writes `embedding`
/// (`embedding::store_embedding`), so this is a pure read of what the
/// restored dump actually contained — no separate metadata field for "what
/// model produced these embeddings" exists or is needed (see
/// `count_mismatched_embeddings`'s own doc comment).
#[derive(Debug, Serialize, ToSchema)]
pub struct RestoreReport {
    pub mismatched_embedding_count: i64,
}

/// `POST /v1/restore/rebuild-embeddings`'s response — how many rows this
/// call actually nulled out, so a client that calls it can say "N Entries
/// queued for re-embedding" rather than a bare acknowledgement.
#[derive(Debug, Serialize, ToSchema)]
pub struct RebuildReport {
    pub rebuilt_count: i64,
}

/// Counts `entries` rows whose `embedding_model` names a model other than
/// `configured_model` — the exact comparison `docs/adr/0022`'s per-row
/// `embedding_model` column exists to make possible, so this ticket adds
/// no new metadata, only a query over what already exists. A row with no
/// embedding at all (`embedding_model is null` — never embedded, or
/// already queued) is not a mismatch; it's simply not embedded yet, which
/// is the background worker's ordinary job, not a Restore concern.
///
/// `embedding_model is distinct from $1` (rather than `<>`) is what makes
/// this correct when `configured_model` is `None` (no embedding model
/// configured on this Server at all): SQL's `<>` against a bound `NULL`
/// would silently match nothing, while `IS DISTINCT FROM` treats "some
/// model" as distinct from "no model configured" — every embedded row
/// counts as a mismatch in that case, which is the right answer: none of
/// them could have been produced by a model this Server can even name.
pub(crate) async fn count_mismatched_embeddings(
    pool: &PgPool,
    configured_model: Option<&str>,
) -> sqlx::Result<i64> {
    sqlx::query_scalar(
        "select count(*) from entries \
         where embedding_model is not null and embedding_model is distinct from $1",
    )
    .bind(configured_model)
    .fetch_one(pool)
    .await
}

/// The "rebuild" action from this ticket's design: nulls `embedding` (never
/// `embedding_model` — the worker overwrites both together the moment it
/// re-embeds a row, see `embedding::store_embedding`) for exactly the rows
/// `count_mismatched_embeddings` counted, using the identical `IS DISTINCT
/// FROM` comparison so the two can never disagree about which rows
/// qualify. Setting `embedding = null` is the entire mechanism — ADR
/// 0022's background worker already scans for `embedding is null` every
/// `SCAN_INTERVAL` and refills it; this deliberately does not call an
/// embedding client itself, so there remains exactly one code path
/// (`embedding::embed_one`) that ever writes an embedding.
pub(crate) async fn rebuild_mismatched_embeddings(
    pool: &PgPool,
    configured_model: Option<&str>,
) -> sqlx::Result<i64> {
    let result = sqlx::query(
        "update entries set embedding = null \
         where embedding_model is not null and embedding_model is distinct from $1",
    )
    .bind(configured_model)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() as i64)
}

/// Streams this Server's entire Postgres database — Entries, Tasks,
/// Sessions, Digests, and every `entries.embedding` (`vector(640)`,
/// `server/migrations/0002_add_entry_embeddings.sql`) among them — as a
/// single `pg_dump` custom-format archive. Shells out to `pg_dump` against
/// `AppState::database_url` (never `docker exec`, per this module's own
/// header comment) so this works identically for a local container, a
/// Sandbox instance on a different port, or a remote/managed Postgres this
/// Server merely has a connection string for.
///
/// `--format=custom` (rather than plain SQL) is what `restore_handler`
/// expects on the other end — `pg_restore` needs its own archive format to
/// support `--clean --if-exists`, and it compresses the embeddings, which
/// otherwise dominate the dump's size.
#[utoipa::path(
    get,
    path = "/v1/backup",
    responses(
        (status = 200, description = "A pg_dump custom-format archive of the whole database", content_type = "application/octet-stream", body = Vec<u8>),
        (status = 500, description = "pg_dump is missing, too old, or failed"),
    )
)]
pub async fn backup_handler(
    State(pool): State<PgPool>,
    State(DatabaseUrl(database_url)): State<DatabaseUrl>,
) -> Result<Response, BackupError> {
    ensure_tool_compatible("pg_dump", &pool).await?;

    let output = Command::new("pg_dump")
        .arg("--format=custom")
        .arg("--no-owner")
        .arg("--no-privileges")
        .arg("--dbname")
        .arg(&database_url)
        .output()
        .await
        .map_err(BackupError::Io)?;

    if !output.status.success() {
        return Err(BackupError::ProcessFailed {
            tool: "pg_dump",
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        });
    }

    Ok((
        [
            (header::CONTENT_TYPE, "application/octet-stream".to_string()),
            (
                header::CONTENT_DISPOSITION,
                "attachment; filename=\"meologue-server-backup.dump\"".to_string(),
            ),
        ],
        output.stdout,
    )
        .into_response())
}

/// Wipes this Server's database and replaces it with a `pg_dump` archive —
/// **deliberately unauthenticated**, exactly like every other `/v1` route
/// (ADR 0003: trust is network-level, not per-request). This is stated
/// plainly here because it is the sharpest edge that decision has: a
/// request to this path from anywhere the network lets it reach is a
/// wipe-and-replace of every Entry, Task, Session and Digest this Server
/// holds, with no confirmation, no credential, and no undo — its entire
/// perimeter is the network itself (ADR 0017's Tailscale Serve, never
/// Funnel). That was decided with this exposure understood, not
/// overlooked: adding auth here alone, while every read stays open per
/// ADR 0003, would protect the one route that already has an off-network
/// safeguard (nobody untrusted can reach it at all) while leaving every
/// Entry readable to the same untrusted caller regardless. If ADR 0003
/// itself is ever revisited, this handler is revisited with it — not
/// before.
///
/// Applies via `pg_restore --clean --if-exists`, which drops each object
/// the archive describes before recreating it (`--if-exists` so a
/// not-yet-created object — a fresh database — doesn't fail the drop) —
/// this is the "wipe" half; "replace" is `pg_restore` recreating every
/// table, index and row from the archive that follows. Reports how many
/// restored rows carry an `embedding_model` different from what this
/// Server is configured with (`count_mismatched_embeddings`) so the caller
/// can decide whether to rebuild them (`POST /v1/restore/rebuild-embeddings`)
/// or leave them — see `RestoreReport`.
#[utoipa::path(
    post,
    path = "/v1/restore",
    request_body(content_type = "application/octet-stream", description = "A pg_dump custom-format archive, as produced by GET /v1/backup"),
    responses(
        (status = 200, description = "Restore applied; reports the embedding-model mismatch count", body = RestoreReport),
        (status = 500, description = "pg_restore is missing, too old, or the archive failed to apply"),
    )
)]
pub async fn restore_handler(
    State(pool): State<PgPool>,
    State(DatabaseUrl(database_url)): State<DatabaseUrl>,
    State(ConfiguredEmbedModel(embed_model)): State<ConfiguredEmbedModel>,
    body: Bytes,
) -> Result<Json<RestoreReport>, BackupError> {
    ensure_tool_compatible("pg_restore", &pool).await?;

    let mut child = Command::new("pg_restore")
        .arg("--clean")
        .arg("--if-exists")
        .arg("--no-owner")
        .arg("--no-privileges")
        .arg("--dbname")
        .arg(&database_url)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(BackupError::Io)?;

    // Written and dropped before `wait_with_output` — `pg_restore` reads
    // its archive from stdin and only starts producing a final exit status
    // once that pipe closes (EOF), so holding `stdin` open past this point
    // would deadlock waiting for a process that's itself waiting on us.
    let mut stdin = child.stdin.take().expect("stdin was piped above");
    stdin.write_all(&body).await.map_err(BackupError::Io)?;
    drop(stdin);

    let output = child.wait_with_output().await.map_err(BackupError::Io)?;
    if !output.status.success() {
        return Err(BackupError::ProcessFailed {
            tool: "pg_restore",
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        });
    }

    let mismatched_embedding_count = count_mismatched_embeddings(&pool, embed_model.as_deref())
        .await
        .map_err(BackupError::Database)?;

    Ok(Json(RestoreReport {
        mismatched_embedding_count,
    }))
}

/// The "rebuild" action offered alongside `RestoreReport` — never called
/// automatically, only when a caller chooses it over "leave". Nulls
/// `embedding` for every row `count_mismatched_embeddings` would still
/// count, so the background worker (ADR 0022) picks them back up on its
/// own schedule; see `rebuild_mismatched_embeddings`'s own doc comment for
/// why this writes no embedding itself.
#[utoipa::path(
    post,
    path = "/v1/restore/rebuild-embeddings",
    responses(
        (status = 200, description = "Mismatched rows' embeddings were cleared for the background worker to refill", body = RebuildReport),
        (status = 500, description = "The database query failed"),
    )
)]
pub async fn rebuild_mismatched_embeddings_handler(
    State(pool): State<PgPool>,
    State(ConfiguredEmbedModel(embed_model)): State<ConfiguredEmbedModel>,
) -> Result<Json<RebuildReport>, BackupError> {
    let rebuilt_count = rebuild_mismatched_embeddings(&pool, embed_model.as_deref())
        .await
        .map_err(BackupError::Database)?;

    Ok(Json(RebuildReport { rebuilt_count }))
}
