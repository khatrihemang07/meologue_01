//! The seam issue #93 is built around: pass 2's agent loop is handed a
//! `ChatClient` and must never learn whether it's talking to a model with
//! genuine tool-calling or to `prompted::PromptedToolClient`'s
//! prompt-and-parse stand-in for one. If the configured endpoint ever
//! grows real tool support, a new `ChatClient` plugs in here and nothing
//! above this trait changes — that replaceability is the entire reason
//! this module exists as a separate file from `prompted.rs` rather than a
//! trait defined alongside its one implementation.
//!
//! The one contract every implementation must honour, taken from
//! `earendil-works/pi`: **`stream` never returns `Err`.** A model or
//! request failure — a non-2xx, a timeout, a dropped connection — is
//! encoded *in* the stream as a terminal `AssistantMessage` with
//! `stop_reason: StopReason::Error` and `error_message` set, exactly like
//! any other way a reply can end. This is what keeps pass 2's loop's error
//! handling to one shape instead of two: it never needs a branch for "the
//! call itself failed" that looks different from "the model said
//! something the loop has to recover from."

use async_trait::async_trait;
use tokio::sync::mpsc;

use super::types::{AssistantMessage, Context};

/// One increment of a `ChatClient::stream` call. `Done` is always the last
/// event a stream produces, and the only one pass 2's loop strictly needs
/// — `TextDelta` exists for a future interface that wants to show the
/// model's reply as it's written, which this ticket does not build (issue
/// #93: "the Answer still comes back the way it does today; watching it
/// work comes later").
#[derive(Debug, Clone, PartialEq)]
pub enum StreamEvent {
    /// A chunk of plain-text content, in reply order. A
    /// `ContentBlock::ToolCall` is never delivered this way, split across
    /// events — it only ever appears whole, inside `Done`'s
    /// `AssistantMessage::content` — because nothing downstream has a use
    /// for a tool call's arguments half-written.
    TextDelta(String),
    /// The stream has finished, successfully or not (see this module's doc
    /// comment on the never-`Err` contract). Carries the complete reply.
    Done(AssistantMessage),
}

/// The stream a `ChatClient::stream` call returns. A thin wrapper over a
/// channel rather than `impl futures_core::Stream`: nothing else in this
/// crate depends on the `futures` crate, and a `recv`-shaped API is all
/// pass 2's loop needs — read events until `Done`.
pub struct AssistantMessageStream {
    events: mpsc::UnboundedReceiver<StreamEvent>,
}

impl AssistantMessageStream {
    /// Built from the receiving half of a channel — the sending half is
    /// held by whatever `ChatClient` produced this stream
    /// (`prompted::PromptedToolClient`, or any future implementation), and
    /// it sends into it as the underlying transport delivers chunks.
    pub fn new(events: mpsc::UnboundedReceiver<StreamEvent>) -> Self {
        Self { events }
    }

    /// The next event, or `None` once the channel is closed. A
    /// well-behaved `ChatClient` always sends exactly one `Done` before
    /// its sender is dropped, so seeing `None` without having first seen a
    /// `Done` is a bug in that `ChatClient`, not a case callers need to
    /// handle specially.
    pub async fn next_event(&mut self) -> Option<StreamEvent> {
        self.events.recv().await
    }

    /// Drains every event and returns just the terminal `AssistantMessage`
    /// — what pass 2's loop, and most tests, actually want when the
    /// intermediate `TextDelta`s aren't being shown to anything.
    pub async fn collect(mut self) -> AssistantMessage {
        let mut last: Option<AssistantMessage> = None;
        while let Some(event) = self.next_event().await {
            if let StreamEvent::Done(message) = event {
                last = Some(message);
            }
        }
        last.expect("a ChatClient must send exactly one Done event before closing its stream")
    }
}

/// The server's dependency on a tool-calling-capable chat model, expressed
/// as a trait for the same reason `llm::LlmClient` is: production code
/// holds `Arc<dyn ChatClient>`, pass 2's tests substitute a fake that
/// scripts a whole multi-step run and asserts on what the harness sent.
#[async_trait]
pub trait ChatClient: Send + Sync {
    /// Sends `ctx` to the model and returns a stream of its reply. Never
    /// returns — and no implementation may panic with — an error for a
    /// model or request failure; see this module's doc comment.
    async fn stream(&self, ctx: &Context) -> AssistantMessageStream;
}
