//! A Server holds settings of its own, stored in Postgres and layered over
//! the environment — see ADR 0060 for why the layering exists at all and
//! why a stored value wins over an environment one, and ADR 0061 for why
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
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use utoipa::ToSchema;

use crate::llm;
use crate::period;
use crate::reflect::ReflectState;
use crate::{ConfigLocked, DigestsEnabled, ServerMode};

// -- MEOLOGUE_MODE: an instance names itself --------------------------------

/// Which instance this process is — issue #200. This does **not** decide
/// precedence anywhere in `resolve` below; a Server names itself the same
/// way a person introduces themselves by name, with no authority granted
/// by the name itself. See ADR 0061 for why this is a separate fact from
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
    /// Issue #201's tri-state toggles, resolved the same `locked`-aware way
    /// as every field above — `None` (a locked Server, or nothing stored)
    /// means "unset," which `RuntimeFlags` and `HealthCapabilities` both
    /// read as "on, if otherwise configured." Unlike the seven fields
    /// above, there is no environment layer for a toggle to fall back to —
    /// nothing named `MEOLOGUE_REFLECT_ENABLED` exists — so `resolve_toggle`
    /// only ever has `stored` and `locked` to consult, never a `Source`.
    pub reflect_enabled: Option<bool>,
    pub digest_enabled: Option<bool>,
    pub embeddings_enabled: Option<bool>,
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
/// stored.** This is ADR 0060's deliberate departure from ADR 0011/0021's
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
        reflect_enabled: resolve_toggle(stored.reflect_enabled, locked),
        digest_enabled: resolve_toggle(stored.digest_enabled, locked),
        embeddings_enabled: resolve_toggle(stored.embeddings_enabled, locked),
    }
}

/// The toggle half of `resolve`'s own precedence rule, split out because a
/// toggle has no environment layer to fall back to — a locked Server simply
/// reads every toggle as unset, exactly as it reads every string field as
/// unset once nothing stored survives the lock.
fn resolve_toggle(stored: Option<bool>, locked: bool) -> Option<bool> {
    if locked { None } else { stored }
}

// -- Runtime feature flags: an in-memory cache of the stored toggles --------

/// Issue #201: whether Reflection, Digest and the embedding worker are
/// switched on right now — held **in memory**, seeded once at startup from
/// the stored row (`RuntimeFlags::seed`) and mutated only by a successful
/// config write (`RuntimeFlags::apply`, called from `patch_config_handler`).
/// The `server_settings` row stays the durable record; this is its
/// in-process cache, re-derived at boot and re-derived again on every
/// write — never read per-tick from Postgres, which is exactly what lets
/// the embedding and digest workers check a flag on every tick and every
/// sync hint without adding a database round trip to either.
///
/// `Clone` shares the same three atomics (each field is an `Arc`), not a
/// snapshot — `AppState::flags`, `ReflectState::flags` and the
/// `RuntimeFlags` handed to `embedding::run`/`digest::run` are all clones
/// of the one instance `main.rs` builds at startup, so a `PATCH` mutating
/// any one of them is visible everywhere else in the same process
/// immediately, with no channel or callback needed to propagate it.
#[derive(Debug, Clone)]
pub struct RuntimeFlags {
    reflect: Arc<AtomicBool>,
    digest: Arc<AtomicBool>,
    embeddings: Arc<AtomicBool>,
}

impl RuntimeFlags {
    /// Builds a fresh set of flags from a `resolve`d settings — `main.rs`
    /// calls this once, right after `settings::resolve`, using its
    /// `reflect_enabled`/`digest_enabled`/`embeddings_enabled` output
    /// (already `locked`-aware) rather than the raw `StoredSettings` row.
    pub fn seed(resolved: &ResolvedSettings) -> Self {
        Self {
            reflect: Arc::new(AtomicBool::new(enabled(resolved.reflect_enabled))),
            digest: Arc::new(AtomicBool::new(enabled(resolved.digest_enabled))),
            embeddings: Arc::new(AtomicBool::new(enabled(resolved.embeddings_enabled))),
        }
    }

    /// Every flag on — the default the narrower `router_with_settings`
    /// (and everything built on it) passes, the same way those
    /// constructors already default every other optional collaborator
    /// (`embed_tx: None`, `reflect: None`, ...) to whatever leaves existing
    /// behaviour unchanged. A test suite written before this ticket, and
    /// every production Server before a feature is ever switched off, must
    /// see every capability behave exactly as if this module didn't exist.
    pub fn all_on() -> Self {
        Self {
            reflect: Arc::new(AtomicBool::new(true)),
            digest: Arc::new(AtomicBool::new(true)),
            embeddings: Arc::new(AtomicBool::new(true)),
        }
    }

    /// Re-derives every flag from a freshly `resolve`d settings — called
    /// from `patch_config_handler` immediately after a write lands, so a
    /// toggle flip takes effect for the next embedding-worker tick, the
    /// next Digest sweep and the next `/v1/reflect` request with no
    /// restart. Takes the same `resolve`d shape `seed` does, not the raw
    /// `StoredSettings` row, so a `PATCH` made while locked re-derives to
    /// exactly what `seed` would have produced at boot under that same
    /// lock — see `resolve_toggle`'s own doc comment.
    pub fn apply(&self, resolved: &ResolvedSettings) {
        self.reflect.store(enabled(resolved.reflect_enabled), Ordering::Relaxed);
        self.digest.store(enabled(resolved.digest_enabled), Ordering::Relaxed);
        self.embeddings.store(enabled(resolved.embeddings_enabled), Ordering::Relaxed);
    }

    pub fn reflect_enabled(&self) -> bool {
        self.reflect.load(Ordering::Relaxed)
    }

    pub fn digest_enabled(&self) -> bool {
        self.digest.load(Ordering::Relaxed)
    }

    pub fn embeddings_enabled(&self) -> bool {
        self.embeddings.load(Ordering::Relaxed)
    }
}

/// `None` (unset) and `Some(true)` (explicitly on) both mean enabled; only
/// `Some(false)` means off. This is the one place "unset behaves like on"
/// actually turns into a plain bool a worker or handler can branch on.
fn enabled(toggle: Option<bool>) -> bool {
    toggle != Some(false)
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
    /// Issue #201's tri-state toggles. `TogglePatch`, not `Option<bool>` —
    /// a bare `Option<bool>` can express only two of the three states a
    /// `PATCH` needs to write (there is no JSON value that means "clear",
    /// distinct from both `true`/`false` and from the key being absent
    /// entirely) — see `TogglePatch`'s own doc comment for the wire shape
    /// this gives instead. `#[serde(default)]` gives the field-absent case
    /// its usual meaning here too: `None` is untouched.
    #[serde(default)]
    pub reflect_enabled: Option<TogglePatch>,
    #[serde(default)]
    pub digest_enabled: Option<TogglePatch>,
    #[serde(default)]
    pub embeddings_enabled: Option<TogglePatch>,
}

/// The wire value one tri-state toggle field of a `PATCH /v1/config` body
/// carries when the caller actually names it. Deliberately not
/// `Option<Option<bool>>` with a `null`-means-clear convention: that shape
/// only works via `serde_with`'s `double_option` (not a dependency this
/// crate otherwise needs) or a hand-rolled deserializer, for a JSON
/// contract ("send literal `null` to mean something other than absent")
/// that reads as a trick rather than a fact about the domain. A named
/// three-variant enum says the same thing in the wire schema itself — a
/// client reads `"unset" | "on" | "off"` directly off the generated
/// TypeScript type, rather than inferring a `null`-vs-absent convention
/// from a doc comment.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum TogglePatch {
    /// Clear this toggle back to `NULL` — "defer to whatever the resolved
    /// configuration would otherwise make available," matching every
    /// string field's own clear-to-`NULL` meaning (`normalize_written`).
    Unset,
    On,
    Off,
}

impl TogglePatch {
    fn to_stored(self) -> Option<bool> {
        match self {
            TogglePatch::Unset => None,
            TogglePatch::On => Some(true),
            TogglePatch::Off => Some(false),
        }
    }
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
    if let Some(toggle) = patch.reflect_enabled {
        current.reflect_enabled = toggle.to_stored();
    }
    if let Some(toggle) = patch.digest_enabled {
        current.digest_enabled = toggle.to_stored();
    }
    if let Some(toggle) = patch.embeddings_enabled {
        current.embeddings_enabled = toggle.to_stored();
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
    pub reflect: FeatureConfig,
    pub digest: FeatureConfig,
    pub embeddings: FeatureConfig,
}

/// One of the three tri-state toggles, reported from four different angles
/// — issue #201's own acceptance criterion is "reported with both what is
/// configured and what is effective," and a UI honestly rendering a
/// restart-required gap needs a fourth.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
pub struct FeatureConfig {
    /// The raw stored toggle, ignoring `locked` — `None` (unset), `Some(true)`
    /// (forced on) or `Some(false)` (forced off). What a `PATCH` changes,
    /// and what a Clear affordance targets; deliberately *not*
    /// `resolve`'s `locked`-aware value, because a UI rendering "what is
    /// stored" while locked should still show the truth of what a future
    /// unlock will pick back up, not `None` for every toggle regardless of
    /// what is actually in the row.
    pub stored: Option<bool>,
    /// Whether the **live, currently-resolved** chat/embed configuration
    /// (this same request's own `resolve` call, `locked`-aware) would let
    /// this feature run at all if its toggle were on — independent of the
    /// toggle itself. Reflection and Digest read `LlmConfig::reflect_config`/
    /// `digest_worker_config`; Embeddings reads `embed_worker_config`.
    pub configured: bool,
    /// Whether this Server's router or worker actually started this
    /// capability **at boot** — a frozen fact from the moment `main.rs`
    /// built this process's `Router`, read off exactly what decided route
    /// registration then (`AppState::reflect`/`digests_enabled`, and
    /// Reflection's own `embed_client` for Embeddings), never recomputed
    /// from the live configuration above. `configured && !boot_active` is
    /// "restart required" — a value just written that has nothing running
    /// yet to receive it.
    pub boot_active: bool,
    /// Whether this capability is doing real work **right now**:
    /// `boot_active && the in-memory RuntimeFlags say on`. This is exactly
    /// what `GET /v1/health`'s matching capability reports — the two are
    /// computed from the same `RuntimeFlags` instance for exactly that
    /// reason, so a UI reading both can never see them disagree.
    pub effective: bool,
}

fn feature_config(stored: Option<bool>, configured: bool, boot_active: bool, flag_enabled: bool) -> FeatureConfig {
    FeatureConfig {
        stored,
        configured,
        boot_active,
        effective: boot_active && flag_enabled,
    }
}

/// Reads process environment and calls `resolve` — the one place either of
/// those two things happens per request, shared by `build_response` (which
/// only needs the resolved *values*) and `patch_config_handler` (which also
/// hands this same resolution to `RuntimeFlags::apply`, so the toggles a
/// `PATCH` just wrote take effect against the identical precedence
/// `GET /v1/config` would report immediately afterward).
fn resolve_now(stored: &StoredSettings, locked: bool) -> ResolvedSettings {
    let env = llm::LlmConfig::from_env();
    let env_tz = env::var("MEOLOGUE_TZ").ok();
    resolve(&env, env_tz.as_deref(), stored, locked)
}

/// `boot_active` per feature — `AppState`'s own three facts about what
/// this process actually registered/spawned at startup, gathered into one
/// small struct so `get_config_handler`/`patch_config_handler` can extract
/// it in one line instead of three separate ones. Named for what it reads,
/// not built as its own `FromRef`: unlike `ConfigLocked`/`ServerMode`, this
/// is assembled from state `health::health_handler` already extracts on
/// its own terms (`Option<ReflectState>`, `DigestsEnabled`), so there is no
/// reason for a fourth `AppState` field to carry a fact the other two
/// already establish.
struct BootActive {
    reflect: bool,
    digest: bool,
    embeddings: bool,
}

impl BootActive {
    fn from_state(reflect: &Option<ReflectState>, digests_enabled: bool) -> Self {
        Self {
            reflect: reflect.is_some(),
            digest: digests_enabled,
            // Mirrors `health::health_handler`'s own `embeddings` reasoning
            // exactly: Reflection's own embed client is what actually
            // resolved at boot (`LlmConfig::reflect_config`), so that is
            // the ground truth for whether the embedding worker's
            // capability is live in this process, not a second,
            // independently-derived fact that could drift from the first.
            embeddings: reflect.as_ref().is_some_and(|state| state.embed_client.is_some()),
        }
    }
}

fn build_response(
    stored: &StoredSettings,
    locked: bool,
    mode: InstanceMode,
    unembedded_entries: i64,
    boot: &BootActive,
    flags: &RuntimeFlags,
) -> ConfigResponse {
    let resolved = resolve_now(stored, locked);
    let live = resolved.llm_config();
    ConfigResponse {
        mode,
        locked,
        unembedded_entries,
        chat_base_url: resolved.chat_base_url.clone(),
        chat_model: resolved.chat_model.clone(),
        chat_api_key: resolved.chat_api_key.clone(),
        embed_base_url: resolved.embed_base_url.clone(),
        embed_model: resolved.embed_model.clone(),
        embed_api_key: resolved.embed_api_key.clone(),
        tz: resolved.tz.clone(),
        reflect: feature_config(
            stored.reflect_enabled,
            live.reflect_config().is_some(),
            boot.reflect,
            flags.reflect_enabled(),
        ),
        digest: feature_config(
            stored.digest_enabled,
            live.digest_worker_config().is_some(),
            boot.digest,
            flags.digest_enabled(),
        ),
        embeddings: feature_config(
            stored.embeddings_enabled,
            live.embed_worker_config().is_some(),
            boot.embeddings,
            flags.embeddings_enabled(),
        ),
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
/// ability to check what is actually set — see ADR 0060's own Decision
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
    State(reflect): State<Option<ReflectState>>,
    State(DigestsEnabled(digests_enabled)): State<DigestsEnabled>,
    State(flags): State<RuntimeFlags>,
) -> Result<Json<ConfigResponse>, StatusCode> {
    let stored = load_stored(&pool).await.map_err(|err| {
        tracing::error!(error = ?err, "failed to load stored settings");
        StatusCode::INTERNAL_SERVER_ERROR
    })?;
    let unembedded_entries = count_unembedded(&pool).await.map_err(|err| {
        tracing::error!(error = ?err, "failed to count unembedded entries");
        StatusCode::INTERNAL_SERVER_ERROR
    })?;
    let boot = BootActive::from_state(&reflect, digests_enabled);
    Ok(Json(build_response(
        &stored,
        locked,
        mode,
        unembedded_entries,
        &boot,
        &flags,
    )))
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
    State(reflect): State<Option<ReflectState>>,
    State(DigestsEnabled(digests_enabled)): State<DigestsEnabled>,
    State(flags): State<RuntimeFlags>,
    Json(patch): Json<ConfigPatch>,
) -> Result<Json<ConfigResponse>, StatusCode> {
    let stored = apply_patch(&pool, &patch).await.map_err(|err| {
        tracing::error!(error = ?err, "failed to write stored settings");
        StatusCode::INTERNAL_SERVER_ERROR
    })?;
    // Issue #201: the toggles this write just landed take effect
    // immediately, without a restart — `flags` shares its three atomics
    // with `AppState`, `ReflectState` and both background workers
    // (`RuntimeFlags`'s own doc comment), so this one `apply` call is what
    // every one of them sees on their very next check.
    flags.apply(&resolve_now(&stored, locked));
    let unembedded_entries = count_unembedded(&pool).await.map_err(|err| {
        tracing::error!(error = ?err, "failed to count unembedded entries");
        StatusCode::INTERNAL_SERVER_ERROR
    })?;
    let boot = BootActive::from_state(&reflect, digests_enabled);
    Ok(Json(build_response(
        &stored,
        locked,
        mode,
        unembedded_entries,
        &boot,
        &flags,
    )))
}

#[cfg(test)]
mod tests {
    use super::{
        InstanceMode, ResolvedField, RuntimeFlags, Source, StoredSettings, parse_mode, resolve,
    };
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
        // ADR 0060's whole point: a stored NULL means "defer to the
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

    // -- resolve's toggle half (issue #201) -----------------------------------

    fn stored_reflect_enabled(value: Option<bool>) -> StoredSettings {
        StoredSettings {
            reflect_enabled: value,
            ..StoredSettings::default()
        }
    }

    #[test]
    fn an_unset_toggle_resolves_to_none_meaning_defer_to_configuration() {
        let resolved = resolve(&env(None), None, &stored_reflect_enabled(None), false);
        assert_eq!(resolved.reflect_enabled, None);
    }

    #[test]
    fn a_stored_toggle_survives_resolution_when_unlocked() {
        let on = resolve(&env(None), None, &stored_reflect_enabled(Some(true)), false);
        let off = resolve(&env(None), None, &stored_reflect_enabled(Some(false)), false);
        assert_eq!(on.reflect_enabled, Some(true));
        assert_eq!(off.reflect_enabled, Some(false));
    }

    #[test]
    fn a_locked_server_reads_every_toggle_as_unset_regardless_of_what_is_stored() {
        // Mirrors `a_locked_server_ignores_a_stored_value_even_when_one_exists`
        // above, for the toggle half: a toggle has no environment layer to
        // fall back to, so `locked` collapsing it to `None` (not to
        // `Some(false)`) is what keeps a locked Server's toggles reading as
        // "on if otherwise configured" — the same default an unset toggle
        // already has — rather than silently forcing every feature off.
        let resolved = resolve(&env(None), None, &stored_reflect_enabled(Some(false)), true);
        assert_eq!(resolved.reflect_enabled, None);
    }

    // -- RuntimeFlags (issue #201) --------------------------------------------

    #[test]
    fn all_on_reports_every_flag_enabled() {
        let flags = RuntimeFlags::all_on();
        assert!(flags.reflect_enabled());
        assert!(flags.digest_enabled());
        assert!(flags.embeddings_enabled());
    }

    #[test]
    fn seed_reads_an_explicit_off_as_disabled() {
        let mut resolved = resolve(&env(None), None, &StoredSettings::default(), false);
        resolved.reflect_enabled = Some(false);
        resolved.digest_enabled = Some(true);
        resolved.embeddings_enabled = None;

        let flags = RuntimeFlags::seed(&resolved);

        assert!(!flags.reflect_enabled(), "Some(false) must disable");
        assert!(flags.digest_enabled(), "Some(true) must enable");
        assert!(flags.embeddings_enabled(), "None must default to enabled");
    }

    #[test]
    fn apply_mutates_the_same_flags_a_prior_clone_still_holds() {
        // The property `RuntimeFlags::apply`'s own doc comment promises:
        // every clone shares the same atomics, so a write through one
        // handle is visible through every other handle taken before it —
        // exactly what lets `AppState`, `ReflectState` and both workers
        // observe a `PATCH` with no restart and no channel between them.
        let flags = RuntimeFlags::all_on();
        let held_elsewhere = flags.clone();
        assert!(held_elsewhere.reflect_enabled());

        let mut resolved = resolve(&env(None), None, &StoredSettings::default(), false);
        resolved.reflect_enabled = Some(false);
        flags.apply(&resolved);

        assert!(!held_elsewhere.reflect_enabled());
    }
}
