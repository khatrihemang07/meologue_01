//! `GET`/`PATCH /v1/config` (issue #200) — `src/settings.rs::resolve`'s own
//! unit tests already cover precedence, the lock and clear-means-fall-back
//! as a pure function against plain values; this file proves the same
//! things hold once a real `server_settings` row and the actual HTTP routes
//! are involved, plus the parts `resolve` alone can't reach: that a `PATCH`
//! actually persists, that `GET`/`PATCH` are reachable on a Server with no
//! Reflection/Digest configured at all (issue #200's own "the one route
//! that must exist on an unconfigured Server"), and that the embedding
//! backlog count is real.
//!
//! None of these tests ever sets a `MEOLOGUE_*` environment variable —
//! `llm.rs`'s own test module explains why: process environment is global,
//! mutable state that `cargo test`'s parallel threads would race over.
//! Every case below either asserts against a field whose stored value
//! settles the question regardless of what real environment happens to
//! hold (`Source::Stored` always wins over `Source::Env` when unlocked), or
//! asserts the weaker-but-still-load-bearing `!= Source::Stored` for a
//! cleared or locked field, which holds whether or not this machine
//! happens to have a chat endpoint configured in its own shell.

use std::path::PathBuf;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;

use meologue_server::settings::InstanceMode;

// Matches every other test file's own convention (tests/reflect.rs,
// tests/models.rs) — none of these routes serve a static asset, so any
// existing directory works as the otherwise-unused static_dir.
fn empty_static_dir() -> PathBuf {
    std::env::current_dir().unwrap()
}

async fn get_config(pool: &PgPool, locked: bool) -> (StatusCode, Value) {
    let app = meologue_server::router_with_settings(
        pool.clone(),
        empty_static_dir(),
        None,
        None,
        None,
        locked,
        InstanceMode::Production,
    );
    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/v1/config")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap())
}

async fn patch_config(pool: &PgPool, locked: bool, body: Value) -> (StatusCode, Value) {
    let app = meologue_server::router_with_settings(
        pool.clone(),
        empty_static_dir(),
        None,
        None,
        None,
        locked,
        InstanceMode::Production,
    );
    let response = app
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri("/v1/config")
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap())
}

// -- GET is reachable, unconditionally --------------------------------------

/// The acceptance criterion this pins: `/v1/config` is registered even on
/// the narrowest possible Server (no embedding channel, no Reflection, no
/// Digest) — "the one route that must exist on an unconfigured Server,
/// because it is how a Server becomes configured."
#[sqlx::test]
async fn get_config_is_reachable_on_a_completely_unconfigured_server(pool: PgPool) {
    let (status, body) = get_config(&pool, false).await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["locked"], false);
    assert_eq!(body["mode"], "production");
    // Nothing was ever stored, and this test never touched process
    // environment — a fresh row reads as every field Unset (or, if this
    // developer's own shell happens to export a MEOLOGUE_* variable, Env;
    // either way, never Stored).
    assert_ne!(body["chat_base_url"]["source"], "stored");
}

#[sqlx::test]
async fn a_fresh_server_reports_zero_unembedded_entries(pool: PgPool) {
    let (_, body) = get_config(&pool, false).await;

    assert_eq!(body["unembedded_entries"], 0);
}

// -- PATCH persists, and a stored value wins on the next GET ----------------

#[sqlx::test]
async fn a_patched_field_is_stored_and_read_back_as_stored(pool: PgPool) {
    let (status, body) = patch_config(&pool, false, json!({ "chat_base_url": "http://patched.invalid" })).await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["chat_base_url"]["value"], "http://patched.invalid");
    assert_eq!(body["chat_base_url"]["source"], "stored");

    // Round-trips through a fresh GET too — this proves the write actually
    // reached `server_settings`, not just that the PATCH handler echoed
    // back what it was given.
    let (_, body) = get_config(&pool, false).await;
    assert_eq!(body["chat_base_url"]["value"], "http://patched.invalid");
    assert_eq!(body["chat_base_url"]["source"], "stored");
}

#[sqlx::test]
async fn an_absent_field_in_the_patch_leaves_other_fields_untouched(pool: PgPool) {
    patch_config(&pool, false, json!({ "chat_base_url": "http://a.invalid", "chat_model": "m" })).await;

    // This second PATCH names only chat_model — chat_base_url must survive
    // it unchanged, proving "absent means untouched" rather than "absent
    // means clear".
    let (_, body) = patch_config(&pool, false, json!({ "chat_model": "m2" })).await;

    assert_eq!(body["chat_base_url"]["value"], "http://a.invalid");
    assert_eq!(body["chat_model"]["value"], "m2");
}

// -- Clearing falls back to the environment, not to "off" --------------------

#[sqlx::test]
async fn an_empty_string_clears_a_stored_field_to_not_stored(pool: PgPool) {
    patch_config(&pool, false, json!({ "chat_base_url": "http://a.invalid" })).await;

    let (status, body) = patch_config(&pool, false, json!({ "chat_base_url": "" })).await;

    assert_eq!(status, StatusCode::OK);
    // Cleared means "defer to the environment" (ADR 0060), not "off in some
    // third sense" — the load-bearing assertion is simply that this is no
    // longer Stored. Whether it lands on Env or Unset depends on whatever
    // this machine's own shell happens to export, which this test suite
    // deliberately never controls (see this file's own header comment).
    assert_ne!(body["chat_base_url"]["source"], "stored");
    assert_ne!(body["chat_base_url"]["value"], "http://a.invalid");
}

// -- MEOLOGUE_CONFIG_LOCK is enforced regardless of what is stored ----------

#[sqlx::test]
async fn a_locked_server_ignores_a_stored_value_on_get(pool: PgPool) {
    patch_config(&pool, false, json!({ "chat_base_url": "http://stored.invalid" })).await;

    // Read back through a *locked* router — same row, different lock state.
    let (status, body) = get_config(&pool, true).await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["locked"], true);
    assert_ne!(body["chat_base_url"]["source"], "stored");
    assert_ne!(body["chat_base_url"]["value"], "http://stored.invalid");
}

#[sqlx::test]
async fn a_patch_against_a_locked_server_still_writes_but_has_no_effect_while_locked(pool: PgPool) {
    // resolve()'s own doc comment: the lock is enforced inside resolution,
    // not at PATCH's call site — so a write while locked still lands in
    // the row (and takes effect the moment the lock is lifted), it just
    // doesn't show up as Stored while the lock holds.
    let (status, locked_body) =
        patch_config(&pool, true, json!({ "chat_base_url": "http://written-while-locked.invalid" })).await;
    assert_eq!(status, StatusCode::OK);
    assert_ne!(locked_body["chat_base_url"]["source"], "stored");

    let (_, unlocked_body) = get_config(&pool, false).await;
    assert_eq!(
        unlocked_body["chat_base_url"]["value"],
        "http://written-while-locked.invalid"
    );
    assert_eq!(unlocked_body["chat_base_url"]["source"], "stored");
}
