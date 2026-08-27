//! Issue #93, pass 1: the protocol layer for turning Reflection into a
//! tool-calling loop, and nothing past it. `types` fixes the message model
//! (modeled on `earendil-works/pi`'s `packages/ai/src/types.ts`, the shape
//! the issue names as its reference), `chat` is the seam pass 2's agent
//! loop is written against, and `prompted` is the one implementation of
//! that seam this ticket builds — the prompt-and-parse compromise the
//! configured chat endpoint forces (see `prompted`'s doc comment for why).
//!
//! Deliberately *not* here: the agent loop itself, any tool
//! (`entries_in_range` is the first, per the issue), and any change to
//! `reflect.rs`'s existing pipeline. Those are pass 2's — this module only
//! has to give pass 2 something that produces prose or tool calls without
//! ever revealing which mechanism produced them.

pub mod chat;
pub mod prompted;
pub mod types;
