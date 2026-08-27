//! The agent loop issue #93 pass 2 exists to build — ported from
//! `earendil-works/pi`'s `packages/agent/src/agent-loop.ts` (`runLoop`,
//! specifically), the same reference `types.rs` already named for the
//! message model this loop is written against. `chat::ChatClient` is the
//! seam: this module is handed one and never learns whether it's a genuine
//! tool-calling model or `prompted::PromptedToolClient`'s prompt-and-parse
//! stand-in — see `chat.rs`'s own doc comment.
//!
//! pi's inner loop condition is
//! `hasMoreToolCalls || pendingMessages.length > 0` — the second half
//! exists for pi's steering-message queue (a user typing a follow-up while
//! the agent is still working). Nothing in this codebase injects a message
//! mid-run that way, so this port keeps only the first half rather than
//! modeling a queue that can never hold anything.
//!
//! **Tool calls are read off `AssistantMessage::content`, never off
//! `stop_reason`** — pi's own `message.content.filter(c => c.type ===
//! "toolCall")`, reproduced here as a filter over `ContentBlock::ToolCall`.
//! `StopReason::ToolUse` is a derived convenience `prompted.rs` computes for
//! its own callers; this loop doesn't trust it as the *only* signal, the
//! same way pi doesn't trust `stopReason` alone.
//!
//! **No step budget.** pi ships none, and issue #93 is explicit that this
//! is deliberate, not an oversight: a Question that genuinely needs five
//! searches should get five, and nothing here decides in advance how many a
//! Question deserves. `LoopConfig::should_stop_after_turn` exists,
//! unused, so a cap can be layered on without touching `run` itself — pi's
//! own `shouldStopAfterTurn` hook, kept for the same reason it's kept
//! there: so the *next* ticket that wants one doesn't have to change this
//! loop's control flow to add it.
//!
//! **Tools execute sequentially**, not pi's parallel dispatch
//! (`executeToolCallsParallel`) — issue #93 calls this out directly: not
//! worth porting for cheap, SQL-backed tools like `entries_in_range`.
//!
//! **Every failure becomes a tool result, never an exception** — pi's own
//! rule (`prepareToolCall`'s `createErrorToolResult` on an unknown tool or
//! a validation failure), and this port's `run_one_tool_call` is deliberately
//! the *only* place a tool call can fail: an unknown name, the empty-name
//! parse-failure sentinel `types::ContentBlock::ToolCall` documents, or
//! `AgentTool::execute` returning `Err` all funnel through it into an
//! ordinary `is_error: true` result the model reads on its next turn.

use std::sync::Arc;

use serde_json::Value;
use uuid::Uuid;

use super::chat::{ChatClient, StreamEvent};
use super::run_log::RunLog;
use super::tools::AgentTool;
use super::types::{AssistantMessage, ContentBlock, Context, Message, StopReason};

/// One thing that happened during a `run` call, in the order it happened.
/// Not `types::Message` alone: a `Message::ToolResult` only ever carries the
/// compact, model-facing `content` half of what a tool returned
/// (`types::Message`'s own doc comment) — the structured `details` half,
/// and the Entry ids a tool call surfaced, have nowhere to live in the wire
/// message model, so `Step` is where they live instead. `reflect.rs` walks
/// a run's `Step`s to append every one into the Session entry tree
/// (`sessions::append_entry`) and to build `grounding_entry_ids`.
#[derive(Debug, Clone, PartialEq)]
pub enum Step {
    /// One full assistant reply, verbatim — prose, one or more tool calls,
    /// or both mixed together, exactly as `ChatClient::stream` produced it.
    Assistant(AssistantMessage),
    /// One tool call's result, addressed to the call that asked for it.
    ToolResult {
        tool_call_id: String,
        tool_name: String,
        /// The compact rendering — identical to what was sent back to the
        /// model as `Message::ToolResult::content`.
        content: String,
        is_error: bool,
        /// The structured half `tools::ToolOutcome::details` carried —
        /// never sent to the model, kept here for the Conversation to
        /// store and the interface to render.
        details: Value,
        /// Every Entry id this call surfaced (`tools::ToolOutcome::entry_ids`).
        entry_ids: Vec<Uuid>,
        /// Issue #108: the id this call's own `tool_started` operation-log
        /// record reserved (`run_log::RunLog::tool_started`) — minted
        /// *before* the tool actually ran, before its success or failure
        /// was known. `reflect.rs::build_tree_payloads` writes this exact
        /// id onto the `session_entries` row this step becomes, which is
        /// what makes a crash mid-run answerable later: does an entry with
        /// this id exist? A fresh `Uuid::new_v4()` when no `RunLog` was
        /// given at all (`run`/`run_with_events` called with `run_log:
        /// None`) — nothing about a `Step`'s own shape should depend on
        /// whether anything is watching.
        entry_id: Uuid,
    },
}

/// One piece of live progress `run_with_events` reports as a `run` call
/// makes it — issue #96's "the interface reports what it is doing ... as
/// the harness runs." Named for *when something happened* during the loop,
/// never for what an outbound wire frame for it looks like: `agent_loop`
/// stays exactly as wire-agnostic as `render_content_for_display`'s own doc
/// comment already insists the rest of this module is — turning one of
/// these into a Server-Sent Event (an `event:` name, a JSON `data:` payload)
/// is `reflect.rs`'s job, the one place that already owns every other
/// wire-shape decision `/v1/reflect` makes.
///
/// One `TurnStart`/`MessageStart`/`MessageEnd` triplet brackets every call
/// to `client.stream`, in that order, with zero or more `MessageUpdate`s in
/// between (`chat::StreamEvent::TextDelta`, forwarded verbatim — see that
/// variant's own doc comment for why nothing today ever produces one:
/// `prompted::PromptedToolClient` only ever sends a whole reply at once).
/// Every tool call that turn's reply contained follows as one
/// `ToolExecutionStart`/`ToolExecutionEnd` pair, in the same source order
/// `run`'s own loop already executes them in. This is exactly `Step`'s own
/// shape, split into a "starting" and "finished" half of each — `Step` is
/// what a finished `run` looked back on; this is the same events live, as
/// they happen, which is the only thing issue #96 adds that `Step` alone
/// could never give a caller watching in real time.
#[derive(Debug, Clone, PartialEq)]
pub enum LoopEvent {
    /// One loop turn is starting — `run`'s own `loop` body has just begun
    /// another iteration and is about to ask the model for a reply.
    TurnStart,
    /// The model has started producing this turn's reply.
    MessageStart,
    /// One chunk of this turn's reply text, in reply order — see this
    /// enum's own doc comment for why nothing wired into production emits
    /// one of these today.
    MessageUpdate { delta: String },
    /// This turn's reply is complete, whatever it turned out to contain —
    /// prose, one or more tool calls, or both mixed together. The same
    /// `AssistantMessage` `run`'s own `steps` records as this turn's
    /// `Step::Assistant`.
    MessageEnd { assistant: AssistantMessage },
    /// One tool call from this turn's reply is about to run — mirrors the
    /// fields `Step::ToolResult` itself carries, minus everything only the
    /// *finished* call can know.
    ToolExecutionStart {
        tool_call_id: String,
        tool_name: String,
        arguments: Value,
    },
    /// One tool call finished — the same fields `Step::ToolResult` records,
    /// reported the moment they're known rather than only once the whole
    /// run is over.
    ToolExecutionEnd {
        tool_call_id: String,
        tool_name: String,
        is_error: bool,
        details: Value,
        entry_ids: Vec<Uuid>,
    },
}

/// A live progress sink for `run_with_events` — pi's own `shouldStopAfterTurn`
/// hook (`ShouldStopAfterTurn`, just below) is the precedent this is
/// modeled on: a plain `Fn` reference rather than a trait object with its
/// own name and impls, since `reflect.rs` has exactly one thing to do with
/// each `LoopEvent` (translate it to an SSE frame and send it) and a
/// closure says that directly. Called synchronously, from inside `run`'s
/// own loop — never `.await`ed — which is what a caller gets to rely on:
/// `reflect.rs`'s own sink only ever calls `mpsc::UnboundedSender::send`,
/// itself synchronous and non-blocking (an unbounded channel never backs
/// up), so nothing here needs `async fn` machinery just to report progress.
pub type EventSink<'a> = dyn Fn(LoopEvent) + Send + Sync + 'a;

/// What a `run` call produced.
#[derive(Debug, Clone, PartialEq)]
pub struct LoopOutcome {
    /// Every `Step` this run produced, oldest first.
    pub steps: Vec<Step>,
    /// `Some(text)` — the final turn's prose — exactly when the loop ended
    /// because a reply held no tool call (pi's own definition of "done":
    /// `message.content.filter(toolCall).length === 0`). `None` on every
    /// other exit: a `stop_reason` of `Error`/`Aborted`, or a tool-call
    /// batch that hit unanimous `terminate` without the model ever having
    /// produced a tool-call-free reply — `terminate` stops the *loop*, not
    /// the Question, and there is no Answer text to hand back when it fires,
    /// since nothing the model wrote was ever un-tagged prose.
    pub answer: Option<String>,
    /// Set only when the loop stopped on `StopReason::Error` — the message
    /// `chat::ChatClient`'s never-`Err` contract carried it in
    /// (`AssistantMessage::error_message`).
    pub error: Option<String>,
}

/// pi's own `shouldStopAfterTurn` hook (`agent-loop.ts`), ported as a plain
/// function reference rather than a config struct's optional field since
/// `run` has no config struct otherwise. Called once per turn, after that
/// turn's tool results (if any) have already been recorded into `steps`, on
/// every turn — including one that would otherwise keep the loop going —
/// giving it the chance pi's own hook has to end a run the ordinary exit
/// points wouldn't have ended yet.
///
/// **Nothing in issue #93 pass 2 passes one of these.** `reflect.rs` always
/// passes `None`, and no step budget exists — the issue is explicit that
/// this is deliberate ("no step budget... a Question that genuinely needs
/// five searches should get five"). This parameter's whole purpose is
/// negative: it is what lets a *later* ticket add a cap — a step budget, a
/// wall-clock timeout, anything shaped like "stop after this turn" — by
/// passing a closure in here, without changing `run`'s own control flow to
/// make room for it.
pub type ShouldStopAfterTurn<'a> = dyn Fn(&[Step]) -> bool + Send + Sync + 'a;

/// Runs the loop to completion against `client`, starting from `messages`
/// (the Conversation so far, oldest first — prior Turns replayed plus the
/// new Question, already in `types::Message` form; building that sequence
/// is `reflect.rs`'s job, not this function's).
///
/// Exit points, in the order `run`'s own loop checks them each turn:
/// 1. `stop_reason` of `Error` or `Aborted` — stops immediately, `answer:
///    None`, whatever happened before this turn is still returned in
///    `steps` as a well-formed (if incomplete) transcript.
/// 2. No `ContentBlock::ToolCall` in the reply's `content` — the loop's
///    normal ending; that reply's text *is* the Answer.
/// 3. Every result in the tool-call batch just executed set `terminate:
///    true` (pi's unanimity rule, `shouldTerminateToolBatch`) — stops
///    early, `answer: None`.
/// 4. `should_stop_after_turn`, if given, returns `true` for the steps so
///    far — stops early, `answer: None`, same shape as 3. See
///    `ShouldStopAfterTurn`'s own doc comment: nothing exercises this exit
///    point yet.
///
/// Otherwise the loop continues: every tool call in the reply executes, in
/// order, and their results are appended to `messages` before the next
/// `stream` call.
///
/// `context_window` is issue #97's own addition: `Some(window)` runs
/// `compaction::transform_context` against `messages` at the top of every
/// turn, before it's cloned into that turn's `Context` — pi's own
/// pre-flight context-editing step, and the one place this loop knows
/// anything about token budgets at all (`compaction.rs` itself stays
/// ignorant of `run`'s control flow, and `run`'s control flow stays
/// ignorant of everything compaction does beyond "here are the messages to
/// send this turn"). `None` — every call site before this ticket, and every
/// test below that doesn't say otherwise — reproduces the exact behaviour
/// `run` always had: `transform_context` is never even reached, so nothing
/// already passing can observe this parameter existing at all.
pub async fn run(
    client: &dyn ChatClient,
    system_prompt: String,
    tools: &[Arc<dyn AgentTool>],
    messages: Vec<Message>,
    should_stop_after_turn: Option<&ShouldStopAfterTurn<'_>>,
    context_window: Option<u32>,
) -> LoopOutcome {
    run_inner(
        client,
        system_prompt,
        tools,
        messages,
        should_stop_after_turn,
        context_window,
        None,
        None,
    )
    .await
}

/// Same as `run`, but reports live progress through `events` as the loop
/// makes it (`LoopEvent`'s own doc comment covers what each one means and
/// when it fires) — issue #96, `reflect.rs`'s streaming `/v1/reflect`. A
/// second entry point rather than a new parameter on `run` itself, so every
/// existing call to `run` — every test in this module, and both call sites
/// in `reflect.rs` before issue #96 — keeps compiling and behaving exactly
/// as it did; the two share one implementation (`run_inner`) so there is
/// exactly one loop to keep correct, never two copies that can drift apart.
///
/// `run_log` (issue #108) is `run_inner`'s own optional operation-log port
/// (`run_log::RunLog`'s own doc comment covers what it writes and why) —
/// `None` reproduces exactly the behaviour this function always had, which
/// is what every test in this module that doesn't care about the log
/// passes. `reflect.rs` — the only production caller — always passes
/// `Some`.
pub async fn run_with_events(
    client: &dyn ChatClient,
    system_prompt: String,
    tools: &[Arc<dyn AgentTool>],
    messages: Vec<Message>,
    should_stop_after_turn: Option<&ShouldStopAfterTurn<'_>>,
    context_window: Option<u32>,
    events: &EventSink<'_>,
    run_log: Option<&dyn RunLog>,
) -> LoopOutcome {
    run_inner(
        client,
        system_prompt,
        tools,
        messages,
        should_stop_after_turn,
        context_window,
        Some(events),
        run_log,
    )
    .await
}

/// Sends `event` through `sink` when a caller actually asked for progress
/// (`run_with_events`) and is a no-op otherwise (`run`) — the one place
/// `run_inner`'s loop body has to know whether it's being watched at all,
/// so every `emit(events, ...)` call site below reads the same either way.
fn emit(sink: Option<&EventSink<'_>>, event: LoopEvent) {
    if let Some(sink) = sink {
        sink(event);
    }
}

async fn run_inner(
    client: &dyn ChatClient,
    system_prompt: String,
    tools: &[Arc<dyn AgentTool>],
    mut messages: Vec<Message>,
    should_stop_after_turn: Option<&ShouldStopAfterTurn<'_>>,
    context_window: Option<u32>,
    events: Option<&EventSink<'_>>,
    run_log: Option<&dyn RunLog>,
) -> LoopOutcome {
    let wire_tools = super::tools::to_wire_tools(tools);
    let mut steps = Vec::new();
    // Issue #108: a 0-based count of how many turns this run has already
    // asked the model for — `run_log::RunLog::step_attempt`'s own doc
    // comment on what it means. Incremented once per loop iteration,
    // regardless of whether `run_log` is `None` — the counter itself is
    // cheap to keep and this is the one place the loop knows which turn
    // it's on.
    let mut turn: u32 = 0;

    loop {
        if let Some(window) = context_window {
            messages = super::compaction::transform_context(client, window, messages).await;
        }

        let ctx = Context {
            system_prompt: system_prompt.clone(),
            messages: messages.clone(),
            tools: wire_tools.clone(),
        };

        if let Some(log) = run_log {
            log.step_attempt(turn).await;
        }
        turn += 1;

        emit(events, LoopEvent::TurnStart);
        emit(events, LoopEvent::MessageStart);

        // Drains `client.stream`'s events one at a time, rather than
        // `AssistantMessageStream::collect`'s all-at-once convenience,
        // purely so a `TextDelta` can be forwarded (`MessageUpdate`) the
        // moment it arrives instead of being discarded on the way to the
        // terminal `Done` — the live-progress half of issue #96.
        // `collect`'s own contract (exactly one `Done` before the sender
        // closes) is still what `expect` below relies on; this is the same
        // guarantee, read one event at a time instead of drained in bulk.
        let mut stream = client.stream(&ctx).await;
        let mut done: Option<AssistantMessage> = None;
        while let Some(event) = stream.next_event().await {
            match event {
                StreamEvent::TextDelta(delta) => {
                    emit(events, LoopEvent::MessageUpdate { delta });
                }
                StreamEvent::Done(message) => done = Some(message),
            }
        }
        let assistant =
            done.expect("a ChatClient must send exactly one Done event before closing its stream");
        emit(
            events,
            LoopEvent::MessageEnd {
                assistant: assistant.clone(),
            },
        );

        // Issue #108: only ever `Some` for a real measurement
        // (`types::Usage`'s own doc comment) — nothing scripted by a test
        // double that doesn't care about token accounting ever reaches
        // this.
        if let (Some(log), Some(usage)) = (run_log, assistant.usage) {
            log.usage(usage.input_tokens, usage.output_tokens).await;
        }

        messages.push(Message::Assistant(assistant.clone()));
        steps.push(Step::Assistant(assistant.clone()));

        if matches!(
            assistant.stop_reason,
            StopReason::Error | StopReason::Aborted
        ) {
            // Issue #108: `Error` and `Aborted` are different failures —
            // only a genuine cancellation is `abort_requested`. No
            // `ChatClient` wired into production today ever produces
            // `Aborted` (see `run_log::RunLog::abort_requested`'s own doc
            // comment), so this is unreached outside this module's own
            // tests until a cancellation path exists to trigger it.
            if matches!(assistant.stop_reason, StopReason::Aborted) {
                if let Some(log) = run_log {
                    log.abort_requested().await;
                }
            }
            return LoopOutcome {
                steps,
                answer: None,
                error: assistant.error_message,
            };
        }

        let tool_calls: Vec<&ContentBlock> = assistant
            .content
            .iter()
            .filter(|block| matches!(block, ContentBlock::ToolCall { .. }))
            .collect();

        if tool_calls.is_empty() {
            return LoopOutcome {
                steps,
                answer: Some(render_text(&assistant.content)),
                error: None,
            };
        }

        let mut all_terminate = true;
        for block in tool_calls {
            let ContentBlock::ToolCall {
                id,
                name,
                arguments,
            } = block
            else {
                unreachable!("filtered to ToolCall blocks above")
            };

            emit(
                events,
                LoopEvent::ToolExecutionStart {
                    tool_call_id: id.clone(),
                    tool_name: name.clone(),
                    arguments: arguments.clone(),
                },
            );

            // Issue #108: the identity this call's own `tool_result` entry
            // will carry is reserved *before* the tool actually runs — see
            // `run_log::RunLog::tool_started`'s own doc comment for why
            // that ordering, not just the write itself, is the point. No
            // `RunLog` at all (`run`, and every test in this module that
            // doesn't care about the operation log) mints a fresh id here
            // instead — a `Step`'s own shape never depends on whether
            // anything is watching.
            let entry_id = match run_log {
                Some(log) => log.tool_started(id, name, arguments).await,
                None => Uuid::new_v4(),
            };

            let outcome = run_one_tool_call(tools, name, arguments.clone()).await;
            all_terminate &= outcome.terminate;
            emit(
                events,
                LoopEvent::ToolExecutionEnd {
                    tool_call_id: id.clone(),
                    tool_name: name.clone(),
                    is_error: outcome.is_error,
                    details: outcome.details.clone(),
                    entry_ids: outcome.entry_ids.clone(),
                },
            );

            messages.push(Message::ToolResult {
                tool_call_id: id.clone(),
                tool_name: name.clone(),
                content: outcome.content.clone(),
                is_error: outcome.is_error,
            });
            steps.push(Step::ToolResult {
                tool_call_id: id.clone(),
                tool_name: name.clone(),
                content: outcome.content,
                is_error: outcome.is_error,
                details: outcome.details,
                entry_ids: outcome.entry_ids,
                entry_id,
            });
        }

        // pi's `shouldTerminateToolBatch`: `finalizedCalls.length > 0 &&
        // finalizedCalls.every(f => f.result.terminate === true)`. The
        // batch just executed is never empty here (`tool_calls.is_empty()`
        // already returned above), so the length check pi does is implicit.
        if all_terminate {
            return LoopOutcome {
                steps,
                answer: None,
                error: None,
            };
        }

        if should_stop_after_turn.is_some_and(|hook| hook(&steps)) {
            return LoopOutcome {
                steps,
                answer: None,
                error: None,
            };
        }
    }
}

/// One tool call's fully-resolved outcome, after every failure mode this
/// function is responsible for catching has already been turned into an
/// ordinary error result — what `run` actually needs to append to
/// `messages` and `steps`, whether the call succeeded or not.
struct ResolvedToolCall {
    content: String,
    is_error: bool,
    details: Value,
    entry_ids: Vec<Uuid>,
    terminate: bool,
}

/// Resolves one tool call to a `ResolvedToolCall`, never failing outright —
/// this is the one place in the loop issue #93's "every failure becomes a
/// tool result" rule is actually enforced. Three failure modes, all handled
/// the same way (an `is_error: true` result, `terminate: false`):
///
/// - `name` is the empty-string sentinel `types::ContentBlock::ToolCall`
///   documents — the wire layer parsed a `<tool_call>` tag but couldn't
///   make out which tool was being asked for at all. `arguments` still
///   carries whatever raw text the model wrote (as a JSON string), so the
///   error result can show the model exactly what it sent.
/// - `name` doesn't match any tool in `tools` — an ordinary unknown-tool
///   error, naming what *is* available so the model can self-correct.
/// - `tool.execute(arguments)` returns `Err` — the tool's own explanation
///   of why (bad arguments, a database error) becomes the result text
///   verbatim.
async fn run_one_tool_call(
    tools: &[Arc<dyn AgentTool>],
    name: &str,
    arguments: Value,
) -> ResolvedToolCall {
    if name.is_empty() {
        let raw = arguments.as_str().unwrap_or_default();
        return ResolvedToolCall {
            content: format!(
                "This tool call could not be understood — its \"name\" was missing or the \
                 call didn't parse (raw: {raw:?}). Re-issue it in the documented \
                 <tool_call>{{\"name\": ..., \"arguments\": {{...}}}}</tool_call> form."
            ),
            is_error: true,
            details: Value::Null,
            entry_ids: Vec::new(),
            terminate: false,
        };
    }

    let Some(tool) = tools.iter().find(|tool| tool.name() == name) else {
        return ResolvedToolCall {
            content: format!(
                "Unknown tool \"{name}\". Available tools: {}.",
                tool_names(tools)
            ),
            is_error: true,
            details: Value::Null,
            entry_ids: Vec::new(),
            terminate: false,
        };
    };

    match tool.execute(arguments).await {
        Ok(outcome) => ResolvedToolCall {
            content: outcome.content,
            is_error: false,
            details: outcome.details,
            entry_ids: outcome.entry_ids,
            terminate: outcome.terminate,
        },
        Err(message) => ResolvedToolCall {
            content: message,
            is_error: true,
            details: Value::Null,
            entry_ids: Vec::new(),
            terminate: false,
        },
    }
}

fn tool_names(tools: &[Arc<dyn AgentTool>]) -> String {
    if tools.is_empty() {
        return "(none configured)".to_string();
    }
    tools
        .iter()
        .map(|tool| tool.name())
        .collect::<Vec<_>>()
        .join(", ")
}

/// The text of a tool-call-free reply — pi's own definition of the Answer.
/// Joins every `ContentBlock::Text` in `content` (there is ordinarily
/// exactly one, since nothing splits plain text around a tag that was never
/// there — see `prompted::ToolCallScanner`) with a newline, so this is
/// still correct in the degenerate case of several adjacent `Text` blocks.
///
/// `pub(crate)`, not private: issue #97's `compaction::summarize` reads a
/// summarisation reply's prose back out the exact same way this loop reads
/// an ordinary Answer's — a compaction call is, from the model's point of
/// view, just another tool-call-free reply.
pub(crate) fn render_text(content: &[ContentBlock]) -> String {
    content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text(text) => Some(text.clone()),
            ContentBlock::ToolCall { .. } => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Replays a finished run's own `Step`s back into the `Message` form `run`
/// itself would have accumulated in its internal `messages` — the same
/// mapping `run`'s own loop already does turn by turn (each `messages.push`
/// sitting next to the `steps.push` that recorded the same event, above).
/// Factored out for issue #102: `reflect.rs`'s one corrective retry after an
/// empty final reply needs to hand a *finished* run's transcript to a fresh
/// `run` call as its starting `messages`, and this is that transcript,
/// without duplicating the mapping a second time. `Step::ToolResult`'s
/// `details`/`entry_ids` have no counterpart on the wire `Message::ToolResult`
/// — `Step`'s own doc comment explains why — so they're dropped here exactly
/// as `run` already drops them when it builds its own `messages`.
pub fn steps_to_messages(steps: &[Step]) -> Vec<Message> {
    steps
        .iter()
        .map(|step| match step {
            Step::Assistant(assistant) => Message::Assistant(assistant.clone()),
            Step::ToolResult {
                tool_call_id,
                tool_name,
                content,
                is_error,
                ..
            } => Message::ToolResult {
                tool_call_id: tool_call_id.clone(),
                tool_name: tool_name.clone(),
                content: content.clone(),
                is_error: *is_error,
            },
        })
        .collect()
}

/// A generic, wire-agnostic rendering of an assistant reply's content
/// blocks — for storing an `Assistant` `Step` in the Session entry tree
/// (`sessions::MessagePayload::Assistant::text`). Deliberately not
/// `prompted::render_assistant_content`: that function reproduces the
/// literal `<tool_call>` wire tag, which only means something to that one
/// `ChatClient` implementation talking back to the model. What's stored
/// here is meant to be read later by a human, or a future interface (issue
/// #95), not replayed to a model.
pub fn render_content_for_display(content: &[ContentBlock]) -> String {
    content
        .iter()
        .map(|block| match block {
            ContentBlock::Text(text) => text.clone(),
            ContentBlock::ToolCall {
                name, arguments, ..
            } => {
                if name.is_empty() {
                    format!("[an unparseable tool call: {arguments}]")
                } else {
                    format!("[called {name}({arguments})]")
                }
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use async_trait::async_trait;
    use serde_json::json;
    use tokio::sync::mpsc;

    use super::*;
    use crate::harness::chat::{AssistantMessageStream, StreamEvent};
    use crate::harness::tools::ToolOutcome;
    use crate::harness::types::Usage;

    /// A scripted `ChatClient`: a queue of canned `AssistantMessage`s
    /// (constructed directly, at the harness level — these tests exercise
    /// `run`'s own control flow, not `prompted::PromptedToolClient`'s wire
    /// parsing, which already has its own exhaustive tests) plus a recorded
    /// log of every `Context` it was handed, so a test can assert on what
    /// the loop actually sent — which tools were rendered, whether a prior
    /// tool result is present, whether prior turns were replayed.
    struct ScriptedChatClient {
        replies: Mutex<std::collections::VecDeque<AssistantMessage>>,
        contexts: Mutex<Vec<Context>>,
    }

    impl ScriptedChatClient {
        fn new(replies: Vec<AssistantMessage>) -> Self {
            Self {
                replies: Mutex::new(replies.into()),
                contexts: Mutex::new(Vec::new()),
            }
        }

        fn contexts(&self) -> Vec<Context> {
            self.contexts.lock().unwrap().clone()
        }
    }

    #[async_trait]
    impl ChatClient for ScriptedChatClient {
        async fn stream(&self, ctx: &Context) -> AssistantMessageStream {
            self.contexts.lock().unwrap().push(ctx.clone());
            let (tx, rx) = mpsc::unbounded_channel();
            let message = self
                .replies
                .lock()
                .unwrap()
                .pop_front()
                .expect("ScriptedChatClient's script ran out of replies");
            let _ = tx.send(StreamEvent::Done(message));
            AssistantMessageStream::new(rx)
        }
    }

    fn prose(text: &str) -> AssistantMessage {
        AssistantMessage {
            content: vec![ContentBlock::Text(text.to_string())],
            stop_reason: StopReason::Stop,
            error_message: None,
            usage: None,
        }
    }

    fn tool_call_block(id: &str, name: &str, arguments: Value) -> ContentBlock {
        ContentBlock::ToolCall {
            id: id.to_string(),
            name: name.to_string(),
            arguments,
        }
    }

    fn one_tool_call(id: &str, name: &str, arguments: Value) -> AssistantMessage {
        AssistantMessage {
            content: vec![tool_call_block(id, name, arguments)],
            stop_reason: StopReason::ToolUse,
            error_message: None,
            usage: None,
        }
    }

    struct EchoTool {
        name: &'static str,
        terminate: bool,
        fail: bool,
    }

    impl EchoTool {
        fn new(name: &'static str) -> Self {
            Self {
                name,
                terminate: false,
                fail: false,
            }
        }
        fn terminating(mut self) -> Self {
            self.terminate = true;
            self
        }
        fn failing(mut self) -> Self {
            self.fail = true;
            self
        }
    }

    #[async_trait]
    impl AgentTool for EchoTool {
        fn name(&self) -> &str {
            self.name
        }
        fn description(&self) -> &str {
            "echoes its arguments back"
        }
        fn parameters(&self) -> Value {
            json!({"type": "object"})
        }
        fn snippet(&self) -> &str {
            "echo — echoes its arguments back."
        }
        async fn execute(&self, arguments: Value) -> Result<ToolOutcome, String> {
            if self.fail {
                return Err("simulated tool failure".to_string());
            }
            Ok(ToolOutcome::new(format!("echoed {arguments}"))
                .with_entry_ids(vec![Uuid::nil()])
                .with_terminate(self.terminate))
        }
    }

    fn tool(t: EchoTool) -> Arc<dyn AgentTool> {
        Arc::new(t)
    }

    fn starting_messages() -> Vec<Message> {
        vec![Message::User("What did I write about running?".to_string())]
    }

    // -- exit points ---------------------------------------------------

    #[tokio::test]
    async fn prose_only_terminates_immediately() {
        let client = ScriptedChatClient::new(vec![prose("Nothing to report.")]);
        let outcome = run(&client, "sys".into(), &[], starting_messages(), None, None).await;

        assert_eq!(outcome.answer.as_deref(), Some("Nothing to report."));
        assert_eq!(outcome.error, None);
        assert_eq!(outcome.steps.len(), 1);
        assert_eq!(client.contexts().len(), 1);
    }

    #[tokio::test]
    async fn one_tool_call_then_prose() {
        let tools = vec![tool(EchoTool::new("echo"))];
        let client = ScriptedChatClient::new(vec![
            one_tool_call("call_0", "echo", json!({"x": 1})),
            prose("done"),
        ]);

        let outcome = run(
            &client,
            "sys".into(),
            &tools,
            starting_messages(),
            None,
            None,
        )
        .await;

        assert_eq!(outcome.answer.as_deref(), Some("done"));
        // assistant(tool call), tool result, assistant(prose)
        assert_eq!(outcome.steps.len(), 3);
        assert_eq!(client.contexts().len(), 2);
    }

    #[tokio::test]
    async fn three_tool_calls_then_prose_across_separate_turns() {
        let tools = vec![tool(EchoTool::new("echo"))];
        let client = ScriptedChatClient::new(vec![
            one_tool_call("call_0", "echo", json!({"n": 1})),
            one_tool_call("call_1", "echo", json!({"n": 2})),
            one_tool_call("call_2", "echo", json!({"n": 3})),
            prose("done"),
        ]);

        let outcome = run(
            &client,
            "sys".into(),
            &tools,
            starting_messages(),
            None,
            None,
        )
        .await;

        assert_eq!(outcome.answer.as_deref(), Some("done"));
        assert_eq!(
            client.contexts().len(),
            4,
            "the loop must decide for itself to call four turns"
        );
        let tool_result_ids: Vec<&str> = outcome
            .steps
            .iter()
            .filter_map(|s| match s {
                Step::ToolResult { tool_call_id, .. } => Some(tool_call_id.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(tool_result_ids, vec!["call_0", "call_1", "call_2"]);
    }

    #[tokio::test]
    async fn two_tool_calls_in_one_reply_both_execute_with_results_in_source_order() {
        let tools = vec![tool(EchoTool::new("echo"))];
        let reply = AssistantMessage {
            content: vec![
                tool_call_block("call_0", "echo", json!({"n": 1})),
                tool_call_block("call_1", "echo", json!({"n": 2})),
            ],
            stop_reason: StopReason::ToolUse,
            error_message: None,
            usage: None,
        };
        let client = ScriptedChatClient::new(vec![reply, prose("done")]);

        let outcome = run(
            &client,
            "sys".into(),
            &tools,
            starting_messages(),
            None,
            None,
        )
        .await;

        assert_eq!(client.contexts().len(), 2, "both calls resolve in one turn");
        let tool_result_ids: Vec<&str> = outcome
            .steps
            .iter()
            .filter_map(|s| match s {
                Step::ToolResult { tool_call_id, .. } => Some(tool_call_id.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(tool_result_ids, vec!["call_0", "call_1"]);
    }

    #[tokio::test]
    async fn terminate_on_one_of_two_results_does_not_stop_the_loop() {
        let tools: Vec<Arc<dyn AgentTool>> = vec![
            tool(EchoTool::new("a").terminating()),
            tool(EchoTool::new("b")),
        ];
        let reply = AssistantMessage {
            content: vec![
                tool_call_block("call_0", "a", json!({})),
                tool_call_block("call_1", "b", json!({})),
            ],
            stop_reason: StopReason::ToolUse,
            error_message: None,
            usage: None,
        };
        let client = ScriptedChatClient::new(vec![reply, prose("done")]);

        let outcome = run(
            &client,
            "sys".into(),
            &tools,
            starting_messages(),
            None,
            None,
        )
        .await;

        assert_eq!(
            outcome.answer.as_deref(),
            Some("done"),
            "unanimity is required — one terminating result out of two must not stop the loop"
        );
        assert_eq!(client.contexts().len(), 2);
    }

    #[tokio::test]
    async fn a_unanimously_terminating_batch_stops_the_loop_without_an_answer() {
        let tools = vec![tool(EchoTool::new("a").terminating())];
        let reply = one_tool_call("call_0", "a", json!({}));
        let client = ScriptedChatClient::new(vec![reply]);

        let outcome = run(
            &client,
            "sys".into(),
            &tools,
            starting_messages(),
            None,
            None,
        )
        .await;

        assert_eq!(outcome.answer, None);
        assert_eq!(outcome.error, None);
        assert_eq!(client.contexts().len(), 1);
    }

    /// `should_stop_after_turn` is unused by every other test in this
    /// module (all pass `None`, matching `reflect.rs`'s own production
    /// call) — this is the one test that actually exercises it, proving the
    /// hook is wired to `run`'s control flow rather than merely a parameter
    /// nothing reads.
    #[tokio::test]
    async fn should_stop_after_turn_can_end_the_loop_even_with_more_tool_calls_pending() {
        let tools = vec![tool(EchoTool::new("echo"))];
        let client = ScriptedChatClient::new(vec![one_tool_call("call_0", "echo", json!({}))]);
        let hook: &ShouldStopAfterTurn = &|steps: &[Step]| steps.len() >= 2;

        let outcome = run(
            &client,
            "sys".into(),
            &tools,
            starting_messages(),
            Some(hook),
            None,
        )
        .await;

        assert_eq!(outcome.answer, None);
        assert_eq!(outcome.error, None);
        // assistant(tool call) + tool result is exactly 2 steps — the hook
        // fires there and stops the loop before a third turn is ever asked
        // for, even though nothing else (no terminate, no error) would have
        // stopped it.
        assert_eq!(outcome.steps.len(), 2);
        assert_eq!(client.contexts().len(), 1);
    }

    #[tokio::test]
    async fn an_unknown_tool_name_becomes_an_error_result_the_next_turn_reads() {
        let client = ScriptedChatClient::new(vec![
            one_tool_call("call_0", "does_not_exist", json!({})),
            prose("done"),
        ]);

        let outcome = run(&client, "sys".into(), &[], starting_messages(), None, None).await;

        let Step::ToolResult {
            is_error,
            tool_name,
            content,
            ..
        } = &outcome.steps[1]
        else {
            panic!("expected a ToolResult step");
        };
        assert!(is_error);
        assert_eq!(tool_name, "does_not_exist");
        assert!(content.contains("Unknown tool"));

        // The next turn's Context must carry that error result forward.
        let second_context = &client.contexts()[1];
        assert!(matches!(
            second_context.messages.last(),
            Some(Message::ToolResult { is_error: true, .. })
        ));
        assert_eq!(outcome.answer.as_deref(), Some("done"));
    }

    #[tokio::test]
    async fn the_empty_name_sentinel_becomes_an_error_result_not_a_failed_question() {
        let malformed = AssistantMessage {
            content: vec![ContentBlock::ToolCall {
                id: "call_0".to_string(),
                name: String::new(),
                arguments: Value::String("garbled tag body".to_string()),
            }],
            stop_reason: StopReason::ToolUse,
            error_message: None,
            usage: None,
        };
        let client = ScriptedChatClient::new(vec![malformed, prose("done")]);

        let outcome = run(&client, "sys".into(), &[], starting_messages(), None, None).await;

        let Step::ToolResult {
            is_error, content, ..
        } = &outcome.steps[1]
        else {
            panic!("expected a ToolResult step");
        };
        assert!(is_error);
        assert!(content.contains("garbled tag body"));
        assert_eq!(outcome.answer.as_deref(), Some("done"));
    }

    #[tokio::test]
    async fn a_failing_tool_execution_becomes_an_error_result_not_a_panic() {
        let tools = vec![tool(EchoTool::new("boom").failing())];
        let client = ScriptedChatClient::new(vec![
            one_tool_call("call_0", "boom", json!({})),
            prose("done"),
        ]);

        let outcome = run(
            &client,
            "sys".into(),
            &tools,
            starting_messages(),
            None,
            None,
        )
        .await;

        let Step::ToolResult {
            is_error, content, ..
        } = &outcome.steps[1]
        else {
            panic!("expected a ToolResult step");
        };
        assert!(is_error);
        assert_eq!(content, "simulated tool failure");
    }

    #[tokio::test]
    async fn an_error_stop_reason_ends_the_loop_immediately_with_no_answer() {
        let errored = AssistantMessage {
            content: vec![],
            stop_reason: StopReason::Error,
            error_message: Some("connection reset".to_string()),
            usage: None,
        };
        let client = ScriptedChatClient::new(vec![errored]);

        let outcome = run(&client, "sys".into(), &[], starting_messages(), None, None).await;

        assert_eq!(outcome.answer, None);
        assert_eq!(outcome.error.as_deref(), Some("connection reset"));
        assert_eq!(outcome.steps.len(), 1);
    }

    #[tokio::test]
    async fn an_aborted_stop_reason_after_a_tool_call_leaves_a_well_formed_transcript() {
        let tools = vec![tool(EchoTool::new("echo"))];
        let aborted = AssistantMessage {
            content: vec![],
            stop_reason: StopReason::Aborted,
            error_message: None,
            usage: None,
        };
        let client =
            ScriptedChatClient::new(vec![one_tool_call("call_0", "echo", json!({})), aborted]);

        let outcome = run(
            &client,
            "sys".into(),
            &tools,
            starting_messages(),
            None,
            None,
        )
        .await;

        assert_eq!(outcome.answer, None);
        assert_eq!(outcome.error, None);
        // assistant(tool call), tool result, assistant(aborted) — every step
        // that actually happened is still there, in order, nothing dropped.
        assert_eq!(outcome.steps.len(), 3);
        assert!(matches!(outcome.steps[0], Step::Assistant(_)));
        assert!(matches!(outcome.steps[1], Step::ToolResult { .. }));
        assert!(matches!(
            outcome.steps[2],
            Step::Assistant(AssistantMessage {
                stop_reason: StopReason::Aborted,
                ..
            })
        ));
    }

    // -- what the loop sends --------------------------------------------

    #[tokio::test]
    async fn the_tools_and_prior_messages_reach_every_context() {
        let tools = vec![tool(EchoTool::new("echo"))];
        let client = ScriptedChatClient::new(vec![
            one_tool_call("call_0", "echo", json!({})),
            prose("done"),
        ]);
        let mut messages = starting_messages();
        messages.insert(0, Message::User("earlier question".to_string()));
        messages.insert(1, Message::Assistant(prose("earlier answer")));

        let _ = run(&client, "sys prompt".into(), &tools, messages, None, None).await;

        let contexts = client.contexts();
        assert_eq!(contexts.len(), 2);
        assert_eq!(contexts[0].tools.len(), 1);
        assert_eq!(contexts[0].tools[0].name, "echo");
        assert!(matches!(contexts[0].messages[0], Message::User(ref q) if q == "earlier question"));
        // The second context carries forward the tool result the first
        // turn produced.
        assert!(
            contexts[1]
                .messages
                .iter()
                .any(|m| matches!(m, Message::ToolResult { .. }))
        );
    }

    // -- render_content_for_display --------------------------------------

    #[test]
    fn render_content_for_display_renders_prose_and_tool_calls_readably() {
        let content = vec![
            ContentBlock::Text("Let me check.".to_string()),
            ContentBlock::ToolCall {
                id: "call_0".to_string(),
                name: "entries_in_range".to_string(),
                arguments: json!({"from": "2026-07-01", "to": "2026-07-31"}),
            },
        ];
        let rendered = render_content_for_display(&content);
        assert!(rendered.contains("Let me check."));
        assert!(rendered.contains("entries_in_range"));
        assert!(rendered.contains("2026-07-01"));
    }

    #[test]
    fn render_content_for_display_names_an_unparseable_call() {
        let content = vec![ContentBlock::ToolCall {
            id: "call_0".to_string(),
            name: String::new(),
            arguments: Value::String("garbled".to_string()),
        }];
        let rendered = render_content_for_display(&content);
        assert!(rendered.contains("unparseable"));
        assert!(rendered.contains("garbled"));
    }

    // -- steps_to_messages ------------------------------------------------

    #[test]
    fn steps_to_messages_reproduces_what_run_would_have_accumulated() {
        let steps = vec![
            Step::Assistant(one_tool_call("call_0", "echo", json!({"n": 1}))),
            Step::ToolResult {
                tool_call_id: "call_0".to_string(),
                tool_name: "echo".to_string(),
                content: "echoed {\"n\":1}".to_string(),
                is_error: false,
                details: Value::Null,
                entry_ids: vec![Uuid::nil()],
                entry_id: Uuid::new_v4(),
            },
            Step::Assistant(prose("")),
        ];

        let messages = steps_to_messages(&steps);

        assert_eq!(messages.len(), 3);
        assert!(matches!(messages[0], Message::Assistant(_)));
        assert!(matches!(
            messages[1],
            Message::ToolResult {
                is_error: false,
                ..
            }
        ));
        // `details`/`entry_ids` have no counterpart on `Message::ToolResult`
        // — only the four fields `run`'s own `messages.push` already
        // carries forward survive the trip.
        let Message::ToolResult {
            tool_call_id,
            tool_name,
            content,
            ..
        } = &messages[1]
        else {
            panic!("expected a ToolResult message");
        };
        assert_eq!(tool_call_id, "call_0");
        assert_eq!(tool_name, "echo");
        assert_eq!(content, "echoed {\"n\":1}");
        assert!(matches!(messages[2], Message::Assistant(_)));
    }

    // -- issue #96: run_with_events reports live progress ----------------

    /// A `ChatClient` whose one scripted reply arrives as several
    /// `TextDelta` chunks before the terminal `Done` — proving
    /// `run_with_events` forwards `StreamEvent::TextDelta` as
    /// `LoopEvent::MessageUpdate` is the "answer-token deltas ride the same
    /// stream" half of issue #96. `prompted::PromptedToolClient` — the only
    /// `ChatClient` actually wired into production — never produces one of
    /// these (its own doc comment explains why: the configured endpoint
    /// isn't streaming), so this fake is the only place that half of the
    /// contract is exercised at all; "nothing else differs" is exactly what
    /// the sequence test below, `run_with_events_reports_the_full_event_sequence_for_a_two_step_run`,
    /// proves for the non-streaming case.
    struct StreamingChatClient {
        deltas: Vec<&'static str>,
        done: AssistantMessage,
    }

    #[async_trait]
    impl ChatClient for StreamingChatClient {
        async fn stream(&self, _ctx: &Context) -> AssistantMessageStream {
            let (tx, rx) = mpsc::unbounded_channel();
            for delta in &self.deltas {
                let _ = tx.send(StreamEvent::TextDelta((*delta).to_string()));
            }
            let _ = tx.send(StreamEvent::Done(self.done.clone()));
            AssistantMessageStream::new(rx)
        }
    }

    /// Records every `LoopEvent` a sink receives, in order — the plain data
    /// double these tests assert against, standing in for `reflect.rs`'s
    /// real sink (which turns each one into an SSE frame instead of a
    /// `Vec` entry).
    fn recording_sink() -> (Arc<Mutex<Vec<LoopEvent>>>, Box<EventSink<'static>>) {
        let recorded = Arc::new(Mutex::new(Vec::new()));
        let recorded_for_sink = recorded.clone();
        let sink: Box<EventSink<'static>> = Box::new(move |event: LoopEvent| {
            recorded_for_sink.lock().unwrap().push(event);
        });
        (recorded, sink)
    }

    #[tokio::test]
    async fn run_with_events_forwards_text_deltas_as_message_updates_in_order() {
        let client = StreamingChatClient {
            deltas: vec!["You ", "wrote ", "about running."],
            done: prose("You wrote about running."),
        };
        let (recorded, sink) = recording_sink();

        let outcome = run_with_events(
            &client,
            "sys".into(),
            &[],
            starting_messages(),
            None,
            None,
            &sink,
            None,
        )
        .await;

        assert_eq!(outcome.answer.as_deref(), Some("You wrote about running."));
        let deltas: Vec<String> = recorded
            .lock()
            .unwrap()
            .iter()
            .filter_map(|event| match event {
                LoopEvent::MessageUpdate { delta } => Some(delta.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(deltas, vec!["You ", "wrote ", "about running."]);
    }

    /// `run` itself (no sink) must behave identically whether or not
    /// `run_with_events` exists at all — this is what actually proves
    /// `run_inner`'s refactor didn't change `run`'s own observable
    /// behaviour, on top of every pre-existing test above that already
    /// calls `run` and keeps passing unchanged.
    #[tokio::test]
    async fn run_without_a_sink_behaves_exactly_as_before() {
        let client = ScriptedChatClient::new(vec![prose("Nothing to report.")]);
        let outcome = run(&client, "sys".into(), &[], starting_messages(), None, None).await;
        assert_eq!(outcome.answer.as_deref(), Some("Nothing to report."));
    }

    /// The exact ordered event sequence a two-step Question produces
    /// (`reflect.rs`'s own SSE tests assert the same shape end to end, one
    /// layer up, through real HTTP `event:`/`data:` frames) — one tool call,
    /// then a prose Answer. Order matters here, not just presence: a
    /// `turn_start` must precede its own `message_start`/`message_end`, the
    /// tool events must fall strictly between the turn that requested them
    /// and the next `turn_start`, and there must be exactly two turns, not
    /// three or one.
    #[tokio::test]
    async fn run_with_events_reports_the_full_event_sequence_for_a_two_step_run() {
        let tools = vec![tool(EchoTool::new("echo"))];
        let client = ScriptedChatClient::new(vec![
            one_tool_call("call_0", "echo", json!({"n": 1})),
            prose("done"),
        ]);
        let (recorded, sink) = recording_sink();

        let outcome = run_with_events(
            &client,
            "sys".into(),
            &tools,
            starting_messages(),
            None,
            None,
            &sink,
            None,
        )
        .await;

        assert_eq!(outcome.answer.as_deref(), Some("done"));

        fn label(event: &LoopEvent) -> &'static str {
            match event {
                LoopEvent::TurnStart => "turn_start",
                LoopEvent::MessageStart => "message_start",
                LoopEvent::MessageUpdate { .. } => "message_update",
                LoopEvent::MessageEnd { .. } => "message_end",
                LoopEvent::ToolExecutionStart { .. } => "tool_execution_start",
                LoopEvent::ToolExecutionEnd { .. } => "tool_execution_end",
            }
        }
        let sequence: Vec<&'static str> = recorded.lock().unwrap().iter().map(label).collect();
        assert_eq!(
            sequence,
            vec![
                "turn_start",
                "message_start",
                "message_end",
                "tool_execution_start",
                "tool_execution_end",
                "turn_start",
                "message_start",
                "message_end",
            ]
        );
    }

    /// A tool event must carry what the interface needs to say what
    /// happened: which tool ran, the arguments it ran with, and — on the
    /// `ToolExecutionEnd` half — how many Entries came back. Proved here at
    /// the event-payload level (`reflect.rs`'s own tests prove the same
    /// thing survives translation into an SSE frame's JSON `data`).
    #[tokio::test]
    async fn a_tool_execution_event_pair_carries_the_tool_name_arguments_and_result() {
        let tools = vec![tool(EchoTool::new("echo"))];
        let client = ScriptedChatClient::new(vec![
            one_tool_call("call_0", "echo", json!({"query": "wedding"})),
            prose("done"),
        ]);
        let (recorded, sink) = recording_sink();

        let _ = run_with_events(
            &client,
            "sys".into(),
            &tools,
            starting_messages(),
            None,
            None,
            &sink,
            None,
        )
        .await;

        let recorded = recorded.lock().unwrap();
        let start = recorded
            .iter()
            .find(|event| matches!(event, LoopEvent::ToolExecutionStart { .. }))
            .expect("a ToolExecutionStart must have been reported");
        match start {
            LoopEvent::ToolExecutionStart {
                tool_name,
                arguments,
                ..
            } => {
                assert_eq!(tool_name, "echo");
                assert_eq!(arguments, &json!({"query": "wedding"}));
            }
            _ => unreachable!(),
        }

        let end = recorded
            .iter()
            .find(|event| matches!(event, LoopEvent::ToolExecutionEnd { .. }))
            .expect("a ToolExecutionEnd must have been reported");
        match end {
            LoopEvent::ToolExecutionEnd {
                tool_name,
                is_error,
                entry_ids,
                ..
            } => {
                assert_eq!(tool_name, "echo");
                assert!(!is_error);
                // EchoTool.execute always reports one Entry id
                // (`ToolOutcome::with_entry_ids(vec![Uuid::nil()])`) — this
                // is "how many Entries came back" for that call.
                assert_eq!(entry_ids.len(), 1);
            }
            _ => unreachable!(),
        }
    }

    // -- issue #97: compaction wired into the loop's own pre-flight ------

    /// Proves `context_window` is actually reached from `run`'s own loop,
    /// not just callable in isolation (`compaction.rs`'s own tests already
    /// cover the transform itself in detail — this is the wiring, not the
    /// logic). A tool result padded well past `compaction::KEEP_RECENT_TOKENS`
    /// forces `should_compact` to fire between the first tool-calling turn
    /// and the second — `ScriptedChatClient`'s script has to include the
    /// extra summarisation call in the middle for exactly that reason, and
    /// `client.contexts().len() == 3` (not 2) is what proves it actually
    /// happened rather than the run silently skipping it.
    #[tokio::test]
    async fn compaction_fires_mid_run_and_the_loop_still_produces_an_answer() {
        let tools = vec![tool(EchoTool::new("search"))];
        let huge_arg = json!({"found": "x".repeat(300_000)});
        let client = ScriptedChatClient::new(vec![
            one_tool_call("call_0", "search", huge_arg),
            prose("condensed: nothing but padding was found"), // the compaction's own summarisation reply
            prose("done"),
        ]);

        let outcome = run(
            &client,
            "sys".into(),
            &tools,
            starting_messages(),
            None,
            Some(40_000), // small enough that the padded tool result alone trips should_compact
        )
        .await;

        assert_eq!(outcome.answer.as_deref(), Some("done"));
        // The persisted record is untouched by compaction — every Step that
        // actually happened is still there, full-size padding included.
        // (this module's own doc comment, and compaction.rs's own doc
        // comment on "nothing already recorded is altered or removed.")
        assert_eq!(outcome.steps.len(), 3);

        let contexts = client.contexts();
        assert_eq!(
            contexts.len(),
            3,
            "turn 1, the compaction's own summarisation call, then turn 2 — three stream() calls, not two"
        );
        // The final turn's own Context is what compaction actually
        // protected: it must carry the summary marker, and must not still
        // be carrying the padded tool result verbatim.
        let final_ctx = &contexts[2];
        assert!(
            final_ctx
                .messages
                .iter()
                .any(|m| matches!(m, Message::User(t) if t.starts_with(crate::harness::compaction::SUMMARY_MARKER)))
        );
        assert!(
            !final_ctx
                .messages
                .iter()
                .any(|m| matches!(m, Message::ToolResult { content, .. } if content.len() > 1_000)),
            "the padded tool result must not still be present verbatim after compaction"
        );
    }

    #[tokio::test]
    async fn a_generous_context_window_never_triggers_compaction() {
        let tools = vec![tool(EchoTool::new("echo"))];
        let client = ScriptedChatClient::new(vec![
            one_tool_call("call_0", "echo", json!({"n": 1})),
            prose("done"),
        ]);

        let outcome = run(
            &client,
            "sys".into(),
            &tools,
            starting_messages(),
            None,
            Some(200_000),
        )
        .await;

        assert_eq!(outcome.answer.as_deref(), Some("done"));
        // Exactly the two calls the loop itself needed — no extra
        // summarisation call snuck in for a Conversation nowhere near the
        // trigger.
        assert_eq!(client.contexts().len(), 2);
    }

    // -- issue #108: the operation log's RunLog port ----------------------

    /// A `RunLog` spy — records every call it receives so a test can assert
    /// on what the loop actually reported, the same role `recording_sink`
    /// plays for `EventSink`. `tool_started` mints a fresh id per call, the
    /// same contract a real implementation (`reflect.rs`'s, over
    /// `sessions::append_record`) has to honour.
    #[derive(Default)]
    struct RecordingRunLog {
        step_attempts: Mutex<Vec<u32>>,
        tool_starts: Mutex<Vec<(String, String, Value, Uuid)>>,
        usages: Mutex<Vec<(u32, u32)>>,
        aborts: Mutex<u32>,
    }

    #[async_trait]
    impl RunLog for RecordingRunLog {
        async fn step_attempt(&self, turn: u32) {
            self.step_attempts.lock().unwrap().push(turn);
        }

        async fn tool_started(
            &self,
            tool_call_id: &str,
            tool_name: &str,
            arguments: &Value,
        ) -> Uuid {
            let id = Uuid::new_v4();
            self.tool_starts.lock().unwrap().push((
                tool_call_id.to_string(),
                tool_name.to_string(),
                arguments.clone(),
                id,
            ));
            id
        }

        async fn usage(&self, input_tokens: u32, output_tokens: u32) {
            self.usages
                .lock()
                .unwrap()
                .push((input_tokens, output_tokens));
        }

        async fn abort_requested(&self) {
            *self.aborts.lock().unwrap() += 1;
        }
    }

    /// The identity `RunLog::tool_started` reserves — before the tool call
    /// it names ever runs — must be exactly the id the resulting
    /// `Step::ToolResult::entry_id` carries. This is the property issue
    /// #108 actually cares about: it's what lets `sessions::append_entry`
    /// (via `reflect.rs::build_tree_payloads`) write the tool result under
    /// the same id the operation log already committed, so a crash between
    /// the two is answerable later — see `run_log::RunLog`'s own doc
    /// comment.
    #[tokio::test]
    async fn tool_started_reserves_the_id_its_own_tool_result_step_carries() {
        let tools = vec![tool(EchoTool::new("echo"))];
        let client = ScriptedChatClient::new(vec![
            one_tool_call("call_0", "echo", json!({"x": 1})),
            prose("done"),
        ]);
        let run_log = RecordingRunLog::default();
        let (_recorded, sink) = recording_sink();

        let outcome = run_with_events(
            &client,
            "sys".into(),
            &tools,
            starting_messages(),
            None,
            None,
            &sink,
            Some(&run_log),
        )
        .await;

        let Step::ToolResult { entry_id, .. } = &outcome.steps[1] else {
            panic!("expected a ToolResult step");
        };
        let starts = run_log.tool_starts.lock().unwrap();
        assert_eq!(starts.len(), 1, "exactly one tool call, one reservation");
        assert_eq!(starts[0].0, "call_0");
        assert_eq!(starts[0].1, "echo");
        assert_eq!(
            starts[0].3, *entry_id,
            "the id tool_started reserved must be the one the ToolResult step carries"
        );
    }

    /// One `step_attempt` per turn the loop actually asks the model for, in
    /// order — the same turns `client.contexts()` already counts, from the
    /// operation log's own point of view.
    #[tokio::test]
    async fn step_attempt_is_logged_once_per_turn_in_order() {
        let tools = vec![tool(EchoTool::new("echo"))];
        let client = ScriptedChatClient::new(vec![
            one_tool_call("call_0", "echo", json!({})),
            prose("done"),
        ]);
        let run_log = RecordingRunLog::default();
        let (_recorded, sink) = recording_sink();

        let _ = run_with_events(
            &client,
            "sys".into(),
            &tools,
            starting_messages(),
            None,
            None,
            &sink,
            Some(&run_log),
        )
        .await;

        assert_eq!(*run_log.step_attempts.lock().unwrap(), vec![0, 1]);
    }

    /// `abort_requested` fires exactly on `StopReason::Aborted` — not on an
    /// ordinary `Error`, which is a different failure the operation log
    /// tells apart (see `run_log::RunLog::abort_requested`'s own doc
    /// comment on why nothing wired into production reaches this today).
    #[tokio::test]
    async fn abort_requested_is_logged_only_for_an_aborted_stop_reason() {
        let aborted = AssistantMessage {
            content: vec![],
            stop_reason: StopReason::Aborted,
            error_message: None,
            usage: None,
        };
        let client = ScriptedChatClient::new(vec![aborted]);
        let run_log = RecordingRunLog::default();
        let (_recorded, sink) = recording_sink();

        let _ = run_with_events(
            &client,
            "sys".into(),
            &[],
            starting_messages(),
            None,
            None,
            &sink,
            Some(&run_log),
        )
        .await;

        assert_eq!(*run_log.aborts.lock().unwrap(), 1);
    }

    /// An ordinary chat failure (`StopReason::Error`) must never be
    /// misreported as an abort.
    #[tokio::test]
    async fn an_error_stop_reason_does_not_log_an_abort() {
        let errored = AssistantMessage {
            content: vec![],
            stop_reason: StopReason::Error,
            error_message: Some("connection reset".to_string()),
            usage: None,
        };
        let client = ScriptedChatClient::new(vec![errored]);
        let run_log = RecordingRunLog::default();
        let (_recorded, sink) = recording_sink();

        let _ = run_with_events(
            &client,
            "sys".into(),
            &[],
            starting_messages(),
            None,
            None,
            &sink,
            Some(&run_log),
        )
        .await;

        assert_eq!(*run_log.aborts.lock().unwrap(), 0);
    }

    /// Real token usage, when a turn's reply reports it, is logged — the
    /// same `input_tokens`/`output_tokens` `Usage` already carries.
    #[tokio::test]
    async fn usage_is_logged_when_the_reply_reports_it() {
        let with_usage = AssistantMessage {
            content: vec![ContentBlock::Text("done".to_string())],
            stop_reason: StopReason::Stop,
            error_message: None,
            usage: Some(Usage {
                input_tokens: 12,
                output_tokens: 34,
            }),
        };
        let client = ScriptedChatClient::new(vec![with_usage]);
        let run_log = RecordingRunLog::default();
        let (_recorded, sink) = recording_sink();

        let _ = run_with_events(
            &client,
            "sys".into(),
            &[],
            starting_messages(),
            None,
            None,
            &sink,
            Some(&run_log),
        )
        .await;

        assert_eq!(*run_log.usages.lock().unwrap(), vec![(12, 34)]);
    }

    /// `run_log: None` — every test above this one in this module — must
    /// still produce a well-formed `Step::ToolResult` with *some* id, never
    /// panic for lack of a `RunLog` to ask.
    #[tokio::test]
    async fn no_run_log_still_produces_a_tool_result_with_an_id() {
        let tools = vec![tool(EchoTool::new("echo"))];
        let client = ScriptedChatClient::new(vec![
            one_tool_call("call_0", "echo", json!({})),
            prose("done"),
        ]);

        let outcome = run(
            &client,
            "sys".into(),
            &tools,
            starting_messages(),
            None,
            None,
        )
        .await;

        let Step::ToolResult { entry_id, .. } = &outcome.steps[1] else {
            panic!("expected a ToolResult step");
        };
        assert_ne!(*entry_id, Uuid::nil());
    }
}
