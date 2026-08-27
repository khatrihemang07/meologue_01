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

use super::chat::ChatClient;
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
    },
}

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
    mut messages: Vec<Message>,
    should_stop_after_turn: Option<&ShouldStopAfterTurn<'_>>,
    context_window: Option<u32>,
) -> LoopOutcome {
    let wire_tools = super::tools::to_wire_tools(tools);
    let mut steps = Vec::new();

    loop {
        if let Some(window) = context_window {
            messages = super::compaction::transform_context(client, window, messages).await;
        }

        let ctx = Context {
            system_prompt: system_prompt.clone(),
            messages: messages.clone(),
            tools: wire_tools.clone(),
        };

        let assistant = client.stream(&ctx).await.collect().await;
        messages.push(Message::Assistant(assistant.clone()));
        steps.push(Step::Assistant(assistant.clone()));

        if matches!(
            assistant.stop_reason,
            StopReason::Error | StopReason::Aborted
        ) {
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

            let outcome = run_one_tool_call(tools, name, arguments.clone()).await;
            all_terminate &= outcome.terminate;

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
}
