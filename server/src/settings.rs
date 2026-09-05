//! A Server holds settings of its own, stored in Postgres and layered over
//! the environment — see ADR 0059 for why the layering exists at all and
//! why a stored value wins over an environment one, and ADR 0062 for why
//! naming an instance (`MEOLOGUE_MODE`) is a separate, unrelated fact from
//! locking one (`MEOLOGUE_CONFIG_LOCK`). CONTEXT.md's Server entry is the
//! domain concept this module gives a settings store to; ADR 0008 already
//! gave a Device the same kind of thing, held entirely client-side in
//! `localStorage` — this is that decision's counterpart on the other end of
//! Sync, and it makes the opposite storage choice for the opposite reason:
//! a Device's settings must survive independently of any one Server, so
//! ADR 0008 keeps them local; a Server's settings describe the one process
//! serving every Device, so they belong in the one database that process
//! already owns.
//!
//! Three things live here, deliberately kept in one module because they are
//! one idea seen from three angles: what is actually stored
//! (`StoredSettings`, `load_stored`, `apply_patch`), how a stored row and
//! the environment combine into one answer (`resolve` — the pure function
//! issue #200's own acceptance criteria ask to be unit-tested with neither
//! a database nor process env), and the wire shape a Device reads and
//! writes through (`ConfigResponse`, `ConfigPatch`, and the two handlers
//! `lib.rs` registers unconditionally as `GET`/`PATCH /v1/config`).

use std::env;

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use utoipa::ToSchema;

use crate::llm;
use crate::period;
use crate::{ConfigLocked, ServerMode};

// -- MEOLOGUE_MODE: an instance names itself --------------------------------

/// Which instance this process is — issue #200. This does **not** decide
/// precedence anywhere in `resolve` below; a Server names itself the same
/// way a person introduces themselves by name, with no authority granted
/// by the name itself. See ADR 0062 for why this is a separate fact from
/// `MEOLOGUE_CONFIG_LOCK` (`config_locked` below) even though the scripts
/// that set the two often set them together.
///
/// Read once at startup (`instance_mode`) and threaded through `AppState`
/// the same way `period::server_timezone()`'s result is read once and
/// threaded through as `DigestState::tz` — a value this cheap to compute
/// still gets computed exactly once, because a Server's own identity must
/// not depend on when in its lifetime something happens to ask.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum InstanceMode {
    Production,
    Sandbox,
}

impl InstanceMode {
    pub fn as_str(self) -> &'static str {
        match self {
            InstanceMode::Production => "production",
            InstanceMode::Sandbox => "sandbox",
        }
    }
}

/// Reads `MEOLOGUE_MODE` from the environment and resolves it to an
/// `InstanceMode`. See `parse_mode` for the actual parsing and fallback
/// rule — kept separate the same way `period::server_timezone` is kept
/// separate from `period::parse_timezone`, so the parsing half stays a pure
/// function a test can call directly without touching process environment.
pub fn instance_mode() -> InstanceMode {
    parse_mode(env::var("MEOLOGUE_MODE").ok().as_deref())
}

/// Resolves an optional `MEOLOGUE_MODE` value to an `InstanceMode`. `None`
/// or an empty string defaults to `Production` — the instance a plain
/// `cargo run` with nothing configured produces, so the common case names
/// itself correctly with nothing set. A value that is neither
/// `"production"` nor `"sandbox"` warns and *also* falls back to
/// `Production`, matching how `period::parse_timezone` treats an
/// unparseable `MEOLOGUE_TZ`: a misconfigured value should degrade a
/// banner and a UI label, never refuse to start.
pub fn parse_mode(value: Option<&str>) -> InstanceMode {
    match value {
        None | Some("") => InstanceMode::Production,
        Some("production") => InstanceMode::Production,
        Some("sandbox") => InstanceMode::Sandbox,
        Some(other) => {
            tracing::warn!(
                value = other,
                "MEOLOGUE_MODE is neither \"production\" nor \"sandbox\"; falling back to production"
            );
            InstanceMode::Production
        }
    }
}

// -- MEOLOGUE_CONFIG_LOCK: refusing stored settings entirely ----------------

/// Reads `MEOLOGUE_CONFIG_LOCK` from the environment. Presence, not
/// truthiness, is what locks a Server — mirroring `LlmConfig::from_env`'s
/// own `var()` helper, any non-empty value counts and an empty or unset one
/// does not — because the scripts that set this
/// (`scripts/e2e-server.sh`, `scripts/e2e-server-b.sh`) set it to a fixed
/// marker for a human reader to find, not a boolean string a caller is
/// expected to parse both ways.
pub fn config_locked() -> bool {
    env::var("MEOLOGUE_CONFIG_LOCK")
        .ok()
        .is_some_and(|value| !value.is_empty())
}

// -- What is actually stored -------------------------------------------------

/// The single settings row, exactly as stored —
/// `migrations/0018_create_server_settings.sql`'s shape. `NULL` in any
/// column means the same thing everywhere in this struct: nothing is
/// stored for that field, so `resolve` falls back to the environment.
/// `Default` gives the row a freshly-created Server has never written to:
/// every field absent, which `resolve` reads exactly like a row that
/// exists but holds `NULL` in every column — the two are indistinguishable
/// on purpose, so `load_stored` needs no separate "no row yet" branch.
#[derive(Debug, Clone, Default, PartialEq, sqlx::FromRow)]
pub struct StoredSettings {
    pub chat_base_url: Option<String>,
    pub chat_model: Option<String>,
    pub chat_api_key: Option<String>,
    pub embed_base_url: Option<String>,
    pub embed_model: Option<String>,
    pub embed_api_key: Option<String>,
    pub tz: Option<String>,
    /// Issue #201's tri-state feature toggles — stored here from this
    /// ticket onward (the migration's own doc comment explains why one
    /// migration carries both) even though `resolve` and `ConfigResponse`
    /// don't read or report them until that ticket gives them behaviour.
    /// `apply_patch`'s upsert already carries them through unchanged on
    /// every write this ticket makes, so nothing here needs to change again
    /// once a `PATCH` that actually sets one exists.
    pub reflect_enabled: Option<bool>,
    pub digest_enabled: Option<bool>,
    pub embeddings_enabled: Option<bool>,
}

/// Loads the one settings row, or `StoredSettings::default()` (every field
/// unset) if this Server has never written to it — a freshly migrated
/// database has no row at all, and that must read exactly like a row that
/// exists with every column `NULL`, not like an error.
pub async fn load_stored(pool: &PgPool) -> sqlx::Result<StoredSettings> {
    let row = sqlx::query_as::<_, StoredSettings>(
        "select chat_base_url, chat_model, chat_api_key, embed_base_url, embed_model, \
         embed_api_key, tz, reflect_enabled, digest_enabled, embeddings_enabled \
         from server_settings where id = 1",
    )
    .fetch_optional(pool)
    .await?;
    Ok(row.unwrap_or_default())
}

// -- Precedence: a pure function over plain values ---------------------------

/// Where one resolved field's value actually came from — the load-bearing
/// half of `GET /v1/config`'s contract (issue #200's own acceptance
/// criterion). Without this, a Device cannot tell a value it can Clear
/// (`Stored`) from one it can only override (`Env`), and cannot honestly
/// label a "(from environment)" hint.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum Source {
    /// This Server's settings row holds a value for this field, and (per
    /// `resolve`'s own doc comment) the Server is not locked.
    Stored,
    /// Nothing is stored — or the Server is locked, which `resolve` treats
    /// identically to nothing being stored — so this value came from
    /// process environment instead.
    Env,
    /// Neither a stored value nor an environment variable resolved this
    /// field. Exactly the state that already means "this feature is off"
    /// per ADR 0021/0011 — `resolve` does not invent a third meaning for a
    /// field with nothing behind it at all.
    Unset,
}

/// One field's resolved value, paired with where it came from.
#[derive(Debug, Clone, PartialEq, Serialize, ToSchema)]
pub struct ResolvedField {
    pub value: Option<String>,
    pub source: Source,
}

fn resolve_field(stored: Option<&String>, env: Option<&String>, locked: bool) -> ResolvedField {
    if !locked && let Some(value) = stored {
        return ResolvedField {
            value: Some(value.clone()),
            source: Source::Stored,
        };
    }
    match env {
        Some(value) => ResolvedField {
            value: Some(value.clone()),
            source: Source::Env,
        },
        None => ResolvedField {
            value: None,
            source: Source::Unset,
        },
    }
}

/// `resolve`'s output — one `ResolvedField` per overridable string/timezone
/// setting. `GET /v1/config` reports this (via `ConfigResponse`) more or
/// less verbatim; `llm_config`/`timezone` below turn it back into the plain
/// values `main.rs` actually builds clients and workers from.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedSettings {
    pub chat_base_url: ResolvedField,
    pub chat_model: ResolvedField,
    pub chat_api_key: ResolvedField,
    pub embed_base_url: ResolvedField,
    pub embed_model: ResolvedField,
    pub embed_api_key: ResolvedField,
    pub tz: ResolvedField,
}

impl ResolvedSettings {
    /// The effective `LlmConfig` — what `main.rs` hands to
    /// `embed_worker_config`/`reflect_config`/`digest_worker_config`/
    /// `resolve_context_window` in place of the raw `LlmConfig::from_env()`
    /// it used before this ticket. Strips the `source` tag `resolve`'s own
    /// output carries; a worker or route-registration decision only ever
    /// needs the value.
    pub fn llm_config(&self) -> llm::LlmConfig {
        llm::LlmConfig {
            chat_base_url: self.chat_base_url.value.clone(),
            chat_model: self.chat_model.value.clone(),
            chat_api_key: self.chat_api_key.value.clone(),
            embed_base_url: self.embed_base_url.value.clone(),
            embed_model: self.embed_model.value.clone(),
            embed_api_key: self.embed_api_key.value.clone(),
        }
    }

    /// The effective timezone — `period::parse_timezone` applied to this
    /// resolution's own `tz` field, rather than a second, independent read
    /// of `MEOLOGUE_TZ`. `main.rs` uses this in place of
    /// `period::server_timezone()` from this ticket onward.
    pub fn timezone(&self) -> Tz {
        period::parse_timezone(self.tz.value.as_deref())
    }
}

/// Overlays a stored settings row on top of an already-resolved environment
/// layer. Pure by design — issue #200's own acceptance criterion: it reads
/// no environment and touches no database, every input arrives as a
/// parameter, so it is unit-testable with plain values and nothing else.
/// It deliberately does not call `LlmConfig::from_env()` itself: the caller
/// (`main.rs`, and this module's own HTTP handlers) has already built one
/// for its own reasons, and building a second here would be two readers of
/// the same six variables that could drift apart.
///
/// **A stored value wins, and the environment seeds when nothing is
/// stored.** This is ADR 0059's deliberate departure from ADR 0011/0021's
/// "empty means off": clearing a field here means "fall back to the
/// environment," not "off" — `Source::Unset` is what "off" actually looks
/// like, and it is only reached when *neither* layer has a value.
///
/// **`locked` is enforced here, not at any call site that uses this
/// function's output.** A locked Server behaves as if its settings row
/// were entirely empty — every field falls through to the environment (or
/// to `Unset`) regardless of what is actually stored. Doing this inside
/// `resolve` rather than before calling it is what `MEOLOGUE_CONFIG_LOCK`'s
/// own acceptance criterion asks for: what `GET /v1/config` reports as
/// locked and read-only, and what the Server actually runs with, are read
/// off the same function call and cannot disagree.
pub fn resolve(
    env: &llm::LlmConfig,
    env_tz: Option<&str>,
    stored: &StoredSettings,
    locked: bool,
) -> ResolvedSettings {
    let env_tz = env_tz.filter(|value| !value.is_empty()).map(str::to_string);

    ResolvedSettings {
        chat_base_url: resolve_field(stored.chat_base_url.as_ref(), env.chat_base_url.as_ref(), locked),
        chat_model: resolve_field(stored.chat_model.as_ref(), env.chat_model.as_ref(), locked),
        chat_api_key: resolve_field(stored.chat_api_key.as_ref(), env.chat_api_key.as_ref(), locked),
        embed_base_url: resolve_field(
            stored.embed_base_url.as_ref(),
            env.embed_base_url.as_ref(),
            locked,
        ),
        embed_model: resolve_field(stored.embed_model.as_ref(), env.embed_model.as_ref(), locked),
        embed_api_key: resolve_field(stored.embed_api_key.as_ref(), env.embed_api_key.as_ref(), locked),
        tz: resolve_field(stored.tz.as_ref(), env_tz.as_ref(), locked),
    }
}

// -- Writing: PATCH /v1/config's body and its effect on the stored row ------

/// `PATCH /v1/config`'s request body. Every field is `Option<String>` with
/// `#[serde(default)]`, which gives three distinct wire states without
/// needing a nested `Option<Option<_>>`: the key absent from the JSON body
/// deserializes to `None` (untouched — `apply_patch` leaves that column
/// exactly as it was), the key present with an empty string deserializes to
/// `Some(String::new())` (clear to `NULL` — `apply_patch` normalises this),
/// and the key present with any other string becomes the new stored value.
/// This mirrors the read side's own "empty means unset" convention
/// (`LlmConfig::from_env`'s `var()` helper) rather than inventing a second
/// one for writes.
#[derive(Debug, Deserialize, ToSchema)]
pub struct ConfigPatch {
    #[serde(default)]
    pub chat_base_url: Option<String>,
    #[serde(default)]
    pub chat_model: Option<String>,
    #[serde(default)]
    pub chat_api_key: Option<String>,
    #[serde(default)]
    pub embed_base_url: Option<String>,
    #[serde(default)]
    pub embed_model: Option<String>,
    #[serde(default)]
    pub embed_api_key: Option<String>,
    #[serde(default)]
    pub tz: Option<String>,
}

/// `""` becomes `None` (clear to `NULL`); any other string is stored as-is.
/// `apply_patch` only ever calls this for a field the patch actually named
/// — a `None` patch value (field absent from the JSON body) never reaches
/// this function at all, because that case means "leave the column alone,"
/// not "write something."
fn normalize_written(value: &str) -> Option<String> {
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

/// Applies one `ConfigPatch` to the stored row and returns the row as it
/// now stands. Implemented as read-merge-write rather than a partial SQL
/// `UPDATE`: the "absent means untouched" rule already has to be decided
/// somewhere, there is no SQL value that means "leave this column alone"
/// the way `NULL` means "set it to nothing," and deciding it once in Rust
/// on a `StoredSettings` already in hand is simpler than half-building the
/// same branch into a dynamic `UPDATE` statement.
pub async fn apply_patch(pool: &PgPool, patch: &ConfigPatch) -> sqlx::Result<StoredSettings> {
    let mut current = load_stored(pool).await?;

    if let Some(value) = &patch.chat_base_url {
        current.chat_base_url = normalize_written(value);
    }
    if let Some(value) = &patch.chat_model {
        current.chat_model = normalize_written(value);
    }
    if let Some(value) = &patch.chat_api_key {
        current.chat_api_key = normalize_written(value);
    }
    if let Some(value) = &patch.embed_base_url {
        current.embed_base_url = normalize_written(value);
    }
    if let Some(value) = &patch.embed_model {
        current.embed_model = normalize_written(value);
    }
    if let Some(value) = &patch.embed_api_key {
        current.embed_api_key = normalize_written(value);
    }
    if let Some(value) = &patch.tz {
        current.tz = normalize_written(value);
    }

    upsert(pool, &current).await?;
    Ok(current)
}

async fn upsert(pool: &PgPool, settings: &StoredSettings) -> sqlx::Result<()> {
    sqlx::query(
        "insert into server_settings \
           (id, chat_base_url, chat_model, chat_api_key, embed_base_url, embed_model, \
            embed_api_key, tz, reflect_enabled, digest_enabled, embeddings_enabled) \
         values (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10) \
         on conflict (id) do update set \
           chat_base_url = excluded.chat_base_url, \
           chat_model = excluded.chat_model, \
           chat_api_key = excluded.chat_api_key, \
           embed_base_url = excluded.embed_base_url, \
           embed_model = excluded.embed_model, \
           embed_api_key = excluded.embed_api_key, \
           tz = excluded.tz, \
           reflect_enabled = excluded.reflect_enabled, \
           digest_enabled = excluded.digest_enabled, \
           embeddings_enabled = excluded.embeddings_enabled",
    )
    .bind(&settings.chat_base_url)
    .bind(&settings.chat_model)
    .bind(&settings.chat_api_key)
    .bind(&settings.embed_base_url)
    .bind(&settings.embed_model)
    .bind(&settings.embed_api_key)
    .bind(&settings.tz)
    .bind(settings.reflect_enabled)
    .bind(settings.digest_enabled)
    .bind(settings.embeddings_enabled)
    .execute(pool)
    .await?;
    Ok(())
}

/// The count `GET /v1/config` reports as "Entries not yet embedded" — the
/// exact predicate the embedding worker's own scan uses
/// (`embedding::select_unembedded`), served by the partial index this
/// ticket's migration adds specifically to match it
/// (`entries_unembedded_active`) rather than one that merely implies it.
pub async fn count_unembedded(pool: &PgPool) -> sqlx::Result<i64> {
    sqlx::query_scalar(
        "select count(*) from entries where embedding is null and deleted_at is null",
    )
    .fetch_one(pool)
    .await
}

// -- The wire shape: GET/PATCH /v1/config ------------------------------------

/// `GET /v1/config`'s response, and what `PATCH /v1/config` echoes back
/// once its write lands — the same shape either way, since a client asking
/// "what changed" is answered by the same report as a client asking "what
/// is it right now."
#[derive(Debug, Serialize, ToSchema)]
pub struct ConfigResponse {
    pub mode: InstanceMode,
    pub locked: bool,
    /// `select count(*) from entries where embedding is null and deleted_at
    /// is null` — see `count_unembedded`. Reported here rather than left
    /// for a Device to ask the embedding worker directly (there is no such
    /// route, and there should not be one just for this): Settings is
    /// where a reader already comes to ask "what is this Server doing,"
    /// and a backlog count answers "is embedding still catching up" without
    /// a second endpoint.
    pub unembedded_entries: i64,
    pub chat_base_url: ResolvedField,
    pub chat_model: ResolvedField,
    pub chat_api_key: ResolvedField,
    pub embed_base_url: ResolvedField,
    pub embed_model: ResolvedField,
    pub embed_api_key: ResolvedField,
    pub tz: ResolvedField,
}

fn build_response(
    stored: &StoredSettings,
    locked: bool,
    mode: InstanceMode,
    unembedded_entries: i64,
) -> ConfigResponse {
    let env = llm::LlmConfig::from_env();
    let env_tz = env::var("MEOLOGUE_TZ").ok();
    let resolved = resolve(&env, env_tz.as_deref(), stored, locked);
    ConfigResponse {
        mode,
        locked,
        unembedded_entries,
        chat_base_url: resolved.chat_base_url,
        chat_model: resolved.chat_model,
        chat_api_key: resolved.chat_api_key,
        embed_base_url: resolved.embed_base_url,
        embed_model: resolved.embed_model,
        embed_api_key: resolved.embed_api_key,
        tz: resolved.tz,
    }
}

/// Reports this Server's settings: value and source per overridable field,
/// the instance's own `MEOLOGUE_MODE`, whether it is locked, and the Entry
/// embedding backlog. Registered unconditionally in `lib.rs`, before the
/// `/v1/{*rest}` catch-all and with no gate of its own — this is the one
/// route that must exist on an unconfigured Server, because it is how a
/// Server *becomes* configured (issue #200's own framing).
///
/// **API keys are returned in full, not write-only.** Per ADR 0003 the
/// Server has no authentication at all, and it already warns at startup
/// that anything able to open a TCP connection to it can read and write
/// every Entry. Withholding a key that a reachable caller can already read
/// straight out of the process environment buys nothing and costs the
/// ability to check what is actually set — see ADR 0059's own Decision
/// section for the fuller version of this argument. Don't "fix" this.
#[utoipa::path(
    get,
    path = "/v1/config",
    responses(
        (status = 200, description = "This Server's settings — value and source per field, instance mode, lock state, and the Entry embedding backlog", body = ConfigResponse),
    )
)]
pub async fn get_config_handler(
    State(pool): State<PgPool>,
    State(ConfigLocked(locked)): State<ConfigLocked>,
    State(ServerMode(mode)): State<ServerMode>,
) -> Result<Json<ConfigResponse>, StatusCode> {
    let stored = load_stored(&pool).await.map_err(|err| {
        tracing::error!(error = ?err, "failed to load stored settings");
        StatusCode::INTERNAL_SERVER_ERROR
    })?;
    let unembedded_entries = count_unembedded(&pool).await.map_err(|err| {
        tracing::error!(error = ?err, "failed to count unembedded entries");
        StatusCode::INTERNAL_SERVER_ERROR
    })?;
    Ok(Json(build_response(&stored, locked, mode, unembedded_entries)))
}

/// Applies a `ConfigPatch` and reports the settings row exactly as
/// `GET /v1/config` would immediately afterward. Writes unconditionally,
/// even while `locked` — `resolve`'s own doc comment is why: enforcing the
/// lock here as well would be enforcing it at a second call site, the
/// exact duplication issue #200's acceptance criteria ask this design to
/// avoid. A write made while locked is simply inert until the lock is
/// lifted, at which point it takes effect with no need to resubmit it.
#[utoipa::path(
    patch,
    path = "/v1/config",
    request_body = ConfigPatch,
    responses(
        (status = 200, description = "The settings row as it now stands, in the same shape GET /v1/config reports", body = ConfigResponse),
    )
)]
pub async fn patch_config_handler(
    State(pool): State<PgPool>,
    State(ConfigLocked(locked)): State<ConfigLocked>,
    State(ServerMode(mode)): State<ServerMode>,
    Json(patch): Json<ConfigPatch>,
) -> Result<Json<ConfigResponse>, StatusCode> {
    let stored = apply_patch(&pool, &patch).await.map_err(|err| {
        tracing::error!(error = ?err, "failed to write stored settings");
        StatusCode::INTERNAL_SERVER_ERROR
    })?;
    let unembedded_entries = count_unembedded(&pool).await.map_err(|err| {
        tracing::error!(error = ?err, "failed to count unembedded entries");
        StatusCode::INTERNAL_SERVER_ERROR
    })?;
    Ok(Json(build_response(&stored, locked, mode, unembedded_entries)))
}

#[cfg(test)]
mod tests {
    use super::{InstanceMode, ResolvedField, Source, StoredSettings, parse_mode, resolve};
    use crate::llm::LlmConfig;

    // -- resolve (issue #200's own TDD seam) ---------------------------------
    //
    // Every case here is built from plain struct literals, the same
    // "no LlmConfig::from_env, no process environment" discipline
    // llm.rs's own `reflect_config` tests already use for the same reason:
    // process environment is global mutable state `cargo test`'s parallel
    // threads would race over.

    fn env(chat_base_url: Option<&str>) -> LlmConfig {
        LlmConfig {
            chat_base_url: chat_base_url.map(str::to_string),
            chat_model: None,
            chat_api_key: None,
            embed_base_url: None,
            embed_model: None,
            embed_api_key: None,
        }
    }

    fn stored_chat_base_url(value: Option<&str>) -> StoredSettings {
        StoredSettings {
            chat_base_url: value.map(str::to_string),
            ..StoredSettings::default()
        }
    }

    #[test]
    fn a_stored_value_wins_over_the_environment() {
        let resolved = resolve(
            &env(Some("http://env.invalid")),
            None,
            &stored_chat_base_url(Some("http://stored.invalid")),
            false,
        );

        assert_eq!(
            resolved.chat_base_url,
            ResolvedField {
                value: Some("http://stored.invalid".to_string()),
                source: Source::Stored,
            }
        );
    }

    #[test]
    fn the_environment_seeds_when_nothing_is_stored() {
        let resolved = resolve(
            &env(Some("http://env.invalid")),
            None,
            &stored_chat_base_url(None),
            false,
        );

        assert_eq!(
            resolved.chat_base_url,
            ResolvedField {
                value: Some("http://env.invalid".to_string()),
                source: Source::Env,
            }
        );
    }

    #[test]
    fn unset_in_both_layers_is_unset_not_off_in_some_third_sense() {
        let resolved = resolve(&env(None), None, &stored_chat_base_url(None), false);

        assert_eq!(
            resolved.chat_base_url,
            ResolvedField {
                value: None,
                source: Source::Unset,
            }
        );
    }

    #[test]
    fn clearing_a_stored_field_falls_back_to_the_environment_not_off() {
        // ADR 0059's whole point: a stored NULL means "defer to the
        // environment," never "force this feature off" the way ADR
        // 0011/0021 already use an unset value elsewhere. A Server with a
        // configured environment and a *cleared* stored value must resolve
        // exactly like one that was never stored at all.
        let cleared = resolve(
            &env(Some("http://env.invalid")),
            None,
            &stored_chat_base_url(None),
            false,
        );
        let never_stored = resolve(&env(Some("http://env.invalid")), None, &StoredSettings::default(), false);

        assert_eq!(cleared.chat_base_url, never_stored.chat_base_url);
        assert_eq!(cleared.chat_base_url.source, Source::Env);
    }

    #[test]
    fn a_locked_server_ignores_a_stored_value_even_when_one_exists() {
        let resolved = resolve(
            &env(Some("http://env.invalid")),
            None,
            &stored_chat_base_url(Some("http://stored.invalid")),
            true,
        );

        assert_eq!(
            resolved.chat_base_url,
            ResolvedField {
                value: Some("http://env.invalid".to_string()),
                source: Source::Env,
            }
        );
    }

    #[test]
    fn a_locked_server_with_nothing_in_the_environment_is_unset_not_stored() {
        let resolved = resolve(
            &env(None),
            None,
            &stored_chat_base_url(Some("http://stored.invalid")),
            true,
        );

        assert_eq!(
            resolved.chat_base_url,
            ResolvedField {
                value: None,
                source: Source::Unset,
            }
        );
    }

    #[test]
    fn an_empty_env_timezone_is_treated_as_unset_matching_llmconfigs_own_convention() {
        // `LlmConfig::from_env`'s own `var()` helper filters out an empty
        // string before it ever reaches a field — `resolve` applies the
        // same filter to `env_tz`, since dotenvy can hand back `Ok("")` for
        // a variable present in `.env` with no value (server/.env.example
        // ships several exactly this way).
        let resolved = resolve(&env(None), Some(""), &StoredSettings::default(), false);

        assert_eq!(
            resolved.tz,
            ResolvedField {
                value: None,
                source: Source::Unset,
            }
        );
    }

    // -- MEOLOGUE_MODE ---------------------------------------------------------

    #[test]
    fn mode_defaults_to_production_when_unset() {
        assert_eq!(parse_mode(None), InstanceMode::Production);
        assert_eq!(parse_mode(Some("")), InstanceMode::Production);
    }

    #[test]
    fn mode_recognises_both_named_values() {
        assert_eq!(parse_mode(Some("production")), InstanceMode::Production);
        assert_eq!(parse_mode(Some("sandbox")), InstanceMode::Sandbox);
    }

    #[test]
    fn an_unrecognised_mode_warns_and_falls_back_to_production() {
        assert_eq!(parse_mode(Some("staging")), InstanceMode::Production);
    }
}
