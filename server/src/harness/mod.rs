//! Issue #93: turning Reflection into a tool-calling loop. Pass 1 built the
//! protocol layer — `types` fixes the message model (modeled on
//! `earendil-works/pi`'s `packages/ai/src/types.ts`, the shape the issue
//! names as its reference), `chat` is the seam the loop is written against,
//! and `prompted` is the prompt-and-parse compromise the configured chat
//! endpoint forces (see `prompted`'s doc comment for why).
//!
//! Pass 2 builds everything above that seam: `tools` is the `AgentTool`
//! trait and the first tool (`entries_in_range`), and `agent_loop` is the
//! loop itself — ported from pi's `packages/agent/src/agent-loop.ts`, the
//! same reference `types` already named. `reflect.rs` is what actually
//! wires the loop into `/v1/reflect`; nothing here knows about HTTP,
//! Sessions, or Postgres.

pub mod agent_loop;
pub mod chat;
pub mod compaction;
pub mod prompted;
pub mod run_log;
pub mod tools;
pub mod types;
