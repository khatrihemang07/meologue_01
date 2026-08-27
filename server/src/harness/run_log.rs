//! A narrow, async port for the operation log (`session_records`, migration
//! `0006`) that `agent_loop::run_inner` writes through as it runs — issue
//! #108, which finishes what issue #91 only ever built the storage for
//! (`sessions.rs`'s `RecordKind` doc comment used to read "No production
//! caller writes any record yet"). This module names nothing from HTTP,
//! Sessions, or Postgres — `harness/mod.rs`'s own doc comment is explicit
//! that boundary must hold — so an actual `RunLog` is `reflect.rs`'s job,
//! built over a `PgPool` and a resolved `session_id`, the same seam
//! `chat::ChatClient` already draws between the loop and whatever endpoint
//! actually answers it.
//!
//! `EventSink` (`agent_loop.rs`) is a *sync*, never-awaited callback by
//! contract. This is deliberately a second, separate, async parameter
//! rather than a widening of that one, so `EventSink`'s existing contract —
//! and every caller that relies on it — is untouched.
//!
//! **Why `tool_started` returns a `Uuid`.** Issue #91's whole payoff for
//! this table is that a record's own `id` is minted *before* the work it
//! describes starts, so a crash mid-run leaves an answerable question: "did
//! this tool's result ever land?" — checked by whether a `session_entries`
//! row with that *same* id exists (migration `0006`'s own comment on
//! `session_records`). So `tool_started` doesn't just log that a tool
//! started; it reserves the identity the tool's eventual `tool_result`
//! entry will carry, and hands it back so `agent_loop::run_inner` can carry
//! it through `Step::ToolResult::entry_id` all the way to
//! `reflect.rs::build_tree_payloads`, which is what makes
//! `sessions::append_entry` write that exact id instead of minting a fresh
//! one.
//!
//! **A real ordering consequence, not a bug.** A record commits the moment
//! the loop reaches it — its own short transaction, through
//! `sessions::allocate_seq` + `sessions::append_record` — while every entry
//! for the same Turn only commits at the very end, in one transaction, once
//! the loop has actually produced an Answer
//! (`sessions::record_turn_from_steps`). Both draw from the same `seq`
//! counter (`sessions::allocate_seq`'s own doc comment), so within one Turn
//! every record this trait wrote sorts *before* every entry that Turn ends
//! up with, regardless of which one the loop logically produced first — a
//! `tool_started` record's `seq` is always lower than the `session_entries`
//! row it reserved the id for, even though the two describe the same
//! moment. A reducer replaying "what happened, in `seq` order" has to know
//! this, not be surprised by it.
//!
//! An implementation is free to fail silently (log the error and move on)
//! rather than propagate one out of these methods: this table is an audit
//! trail, not something the loop's own control flow depends on (issue #91:
//! "written and readable ... nothing resumes from it yet") — a database
//! hiccup writing a record must never be what fails an otherwise-healthy
//! Question.

use serde_json::Value;
use uuid::Uuid;

/// See this module's own doc comment for what each method corresponds to
/// on `session_records` and why `tool_started` alone returns an id.
#[async_trait::async_trait]
pub trait RunLog: Send + Sync {
    /// One loop turn (one call to the model) is about to be attempted.
    /// `turn` is a 0-based count of how many turns this run has already
    /// asked for. Recorded as `sessions::RecordKind::StepAttempt`.
    async fn step_attempt(&self, turn: u32);

    /// One tool call is about to run. Mints and returns the `Uuid` its
    /// eventual `tool_result` entry will carry — see this module's own doc
    /// comment. Must be called, and awaited, *before* the tool call it
    /// names actually executes. Recorded as
    /// `sessions::RecordKind::ToolStarted`.
    async fn tool_started(&self, tool_call_id: &str, tool_name: &str, arguments: &Value) -> Uuid;

    /// Token accounting a completed turn's reply reported, when it did —
    /// `harness::types::Usage` is only ever `Some` for a real measurement
    /// (see that type's own doc comment), never a placeholder zero.
    /// Recorded as `sessions::RecordKind::Usage`.
    async fn usage(&self, input_tokens: u32, output_tokens: u32);

    /// The run ended because the caller cancelled it
    /// (`harness::types::StopReason::Aborted`). Recorded as
    /// `sessions::RecordKind::AbortRequested`. No `ChatClient` wired into
    /// production today ever produces this stop reason — see
    /// `agent_loop.rs`'s own test for the one place it's exercised — so
    /// this is unreached in practice until a cancellation path exists to
    /// trigger it.
    async fn abort_requested(&self);
}
