//! Issue #97: the pre-flight step `agent_loop::run` takes before every turn
//! to keep a Conversation inside the model's context window, ported from
//! `earendil-works/pi`'s own context-editing pass. The design is settled by
//! the issue, not invented here — this file is the implementation of it,
//! not a redesign:
//!
//! - **Trigger**: compact when `estimate_tokens(messages) > context_window -
//!   RESERVE_TOKENS`.
//! - **Token accounting is provider-usage-anchored**, the way pi does it:
//!   the last `AssistantMessage::usage` seen on the transcript is trusted as
//!   the true token count up to that point, and only the messages *after*
//!   it are estimated at chars/4. `harness::types::Usage`'s own doc comment
//!   covers the wiring: `llm::OpenAiCompatibleClient::chat` reads a real
//!   `{prompt_tokens, completion_tokens}` off the configured endpoint's own
//!   response (`llm::parse_usage`), and `prompted::PromptedToolClient::stream`
//!   is what turns that into the `Usage` an `AssistantMessage` carries — so
//!   `estimate_tokens` below anchors on a genuine measurement whenever the
//!   endpoint reported one for the transcript's most recent turn.
//!   **Absent stays absent, never zero**: `llm::parse_usage` already turns a
//!   missing, all-zero, or malformed `usage` field into `None` rather than
//!   `Some(Usage { 0, 0 })`, so this module never has to re-guard against a
//!   real 0 anchor silently disabling compaction (`Usage`'s own doc comment
//!   spells this contract out). Every estimate with no anchor at all — a
//!   Conversation's first turn, or an endpoint that never reports usage —
//!   falls through to `FIXED_OVERHEAD_TOKENS` plus chars/4 — see that
//!   constant's own doc comment for where the 17k came from and why it
//!   matters that the fallback floors there rather than at zero.
//! - **The cut point never splits a tool call from its result.** A
//!   `Message::ToolResult` with no `Message::Assistant` tool call in front
//!   of it is a malformed Conversation the model will reject — see
//!   `is_valid_cut_point`.
//! - **The summary is appended, never replacing anything.** `transform_context`
//!   takes `messages` by value and returns a new `Vec`; nothing already in
//!   the input is mutated, and everything this function drops is still
//!   sitting, unaltered, in whatever built that `Vec` in the first place —
//!   `agent_loop::run`'s own `steps` accumulator, which this module never
//!   touches at all (see `agent_loop.rs`'s own doc comment on where this is
//!   called from).
//! - **Compacting twice does not compound.** A summary this module wrote is
//!   recognisable on a later pass (`SUMMARY_MARKER`), and once recognised it
//!   is pinned — excluded from what a second compaction is even allowed to
//!   drop or feed back through the model (`leading_pinned_count`). This is
//!   deliberately not pi's iterative summary update (re-running the model
//!   over an already-compacted region to fold it into a tighter one, which
//!   issue #97 explicitly named out of scope): a second compaction leaves
//!   the first summary message exactly as it was and appends a second one
//!   after it, the same "appended, never replacing" rule applied to the
//!   summary itself. See this module's tests for why this is enough to
//!   satisfy "does not compound or lose the first summary" without building
//!   the iterative machinery pi has — and `agent_loop.rs`'s doc comment for
//!   the one place this note and the "skip iterative update" scope note
//!   turned out **not** to be in tension, once "iterative update" is read
//!   precisely as "re-summarize an existing summary," which pinning avoids
//!   by construction rather than by coincidence.
//!
//! **What this module does not do**: decide *whether* a run needs
//! compacting from outside the loop, or persist anything about a
//! compaction into a Session's entry tree. `transform_context` is called by
//! `agent_loop::run` on the same `messages: Vec<Message>` it sends to the
//! model each turn — a purely in-memory transform of what's *about to be
//! sent*, never of what already happened. The Session's own tree-level
//! compaction (`sessions::EntryType::Compaction`,
//! `sessions::project_from_last_compaction` — already built and tested by
//! issue #91, precisely so this ticket would not have to write it a second
//! time) is a different, safe-by-construction case this ticket also
//! implements, in `reflect.rs::run_reflect_loop` — see that function's own
//! doc comment for why it has to live there rather than here: a compaction
//! written *inside* one Turn's own step chain would sever that Turn's own
//! leading `User` entry from the tree `sessions::entries_to_turns` walks,
//! silently erasing the very Turn that triggered it from every future
//! read. Between Turns, where `run_reflect_loop` writes one, that entry
//! sits cleanly at a Turn boundary and no such risk exists.

use super::agent_loop::render_text;
use super::chat::ChatClient;
use super::types::{Context, Message, Usage};

/// pi's own reserve: how much of the context window is kept empty rather
/// than filled all the way to the model's own limit, so the *next* turn
/// (the reply that follows whatever compaction just made room for) always
/// has somewhere to write.
pub const RESERVE_TOKENS: u32 = 16_384;

/// pi's own keep-recent target: how much of the *tail* of a Conversation a
/// compaction tries to leave intact, verbatim, after it fires. Not a hard
/// cap — `find_cut_point` never returns a point that would split a tool
/// call from its result even if honouring that split would keep the tail
/// under this many tokens — just the size a cut point search prefers.
pub const KEEP_RECENT_TOKENS: u32 = 20_000;

/// The conservative context window `reflect.rs` falls back to when the
/// configured chat model's own list entry doesn't say — issue #97's own
/// framing of "conservative": summarising earlier than strictly necessary
/// beats a Question failing outright because the real window turned out to
/// be smaller than assumed. 32,000 is deliberately on the small side of
/// what a real local endpoint offers today (`localAIWrapper`'s Claude and
/// Codex-backed Models are configured with six-figure windows — see that
/// repo's `models.json`) rather than an average of them: a wrong-but-small
/// guess only costs an extra summarisation call, a wrong-but-large one
/// risks the Question this whole ticket exists to stop failing.
pub const DEFAULT_CONTEXT_WINDOW: u32 = 32_000;

/// The floor `estimate_tokens` uses whenever no `Usage` anchor exists yet —
/// a Conversation's first turn, always, since nothing has answered yet to
/// carry one; any later turn only if the configured endpoint's response
/// omitted `usage` entirely (`llm::parse_usage` returns `None` for that
/// case, never a real anchor with a small or zero value — see `Usage`'s own
/// doc comment). Measured directly against the configured endpoint
/// (`localAIWrapper` fronting `codex-terra`) during issue #93's own
/// prototype: a real call's reported
/// `usage.prompt_tokens` came back around 17,000 *before any Grounding was
/// added at all* — `localAIWrapper`'s ADR 0002 accounts for most of it
/// (~13.8k tokens of backend-CLI harness overhead injected into the
/// underlying model's own system prompt, which neither this Server's
/// `system_prompt` nor its `messages` ever see or control), the remainder
/// being this Server's own tool descriptions and protocol instruction
/// (`prompted::render_system_prompt`). Nothing in `Message` or `Context`
/// carries that overhead as data — it only shows up in a real call's
/// `usage` — so a chars/4 estimate over `messages` alone would silently
/// under-count a short Conversation as cheap when a real call already
/// costs most of a small model's entire reserve. Flooring here instead is
/// exactly the "conservative... summarises earlier than strictly
/// necessary" rule applied to the estimator itself, and it is *why*
/// compaction fires sooner than counting only `messages`' own characters
/// would suggest — see the trigger-arithmetic tests below for the
/// consequence against a small `context_window`.
pub const FIXED_OVERHEAD_TOKENS: u32 = 17_000;

/// A crude but conservative chars-per-token ratio, used only for the part
/// of a Conversation a real `Usage` hasn't anchored yet. 4 is the commonly
/// cited average for English prose; this estimator does not need to be
/// exact, only to never *under*-count badly enough to blow through
/// `context_window` before the trigger fires — see `should_compact`.
const CHARS_PER_TOKEN: usize = 4;

/// Marks a `Message::User` this module synthesised as a prior compaction's
/// summary, so a later compaction pass can recognise and pin it
/// (`leading_pinned_count`) instead of trying to summarise a summary.
/// `Message::User` rather than a new `Message` variant or a new `Context`
/// field: `types::Message` is the wire-protocol shape every `ChatClient`
/// (today, only `prompted::PromptedToolClient`) already knows how to render
/// — adding a variant would mean teaching that renderer, and any future
/// `ChatClient`, a fourth message kind for a concept the model itself never
/// needs to tell apart from an ordinary turn. A recognisable prefix on
/// ordinary text is the same trick `prompted.rs` already uses to carry
/// tool-call/tool-result structure over a wire with no room for it (see
/// that module's own doc comment) — this is that same compromise, applied
/// once more, not a new one.
pub(crate) const SUMMARY_MARKER: &str =
    "[Earlier parts of this Conversation were summarised to save space]\n\n";

/// What a Conversation-so-far is condensed with, when `transform_context`
/// actually fires. Appended as the *last* message of whatever's being
/// dropped (see `summarize`) — everything before it is the real transcript,
/// and this is the one instruction telling the model to stop continuing
/// that transcript and describe it instead.
const SUMMARIZE_INSTRUCTION: &str = "Summarize everything above concisely, in plain prose. \
Keep anything a later turn might still need: names, dates, specific facts, and what was already \
found or ruled out. Do not continue the conversation or answer any question in it — only \
describe what happened.";

/// The estimated token cost of `messages`, provider-usage-anchored the way
/// this module's own doc comment describes: finds the *last*
/// `Message::Assistant` carrying a `Usage`, trusts `input_tokens +
/// output_tokens` as the true cost up to and including that message, and
/// estimates only what comes after it at chars/4. No anchor at all (today,
/// always the case — see `FIXED_OVERHEAD_TOKENS`'s doc comment) estimates
/// the whole slice at chars/4, floored at `FIXED_OVERHEAD_TOKENS`.
pub fn estimate_tokens(messages: &[Message]) -> u32 {
    match last_usage_anchor(messages) {
        Some((anchor_index, usage)) => {
            let anchored = usage.input_tokens + usage.output_tokens;
            anchored + chars_estimate(&messages[anchor_index + 1..])
        }
        None => FIXED_OVERHEAD_TOKENS.max(chars_estimate(messages)),
    }
}

/// The index and `Usage` of the last `Message::Assistant` in `messages`
/// that actually carries one, or `None` if nothing in the slice ever did.
/// Trusts any `Some(Usage)` it finds at face value, with no zero-check of
/// its own — `Usage`'s own doc comment is the contract this relies on: a
/// real `Some` is never `Usage { 0, 0 }`, because `llm::parse_usage`
/// already turned that case into `None` before it ever became part of an
/// `AssistantMessage`.
fn last_usage_anchor(messages: &[Message]) -> Option<(usize, Usage)> {
    messages
        .iter()
        .enumerate()
        .rev()
        .find_map(|(index, message)| match message {
            Message::Assistant(assistant) => assistant.usage.map(|usage| (index, usage)),
            _ => None,
        })
}

/// chars/4 over every message in `messages`, counting only the text a real
/// call would actually send: `Message::User`'s text, `Message::ToolResult`'s
/// `content`, and every `ContentBlock::Text`/`ContentBlock::ToolCall`
/// (rendered the same way `agent_loop::render_content_for_display` does,
/// since that rendering — not the parsed `arguments` `Value` alone — is a
/// reasonable proxy for what the wire actually carries for a tool call).
fn chars_estimate(messages: &[Message]) -> u32 {
    let chars: usize = messages
        .iter()
        .map(|message| match message {
            Message::User(text) => text.len(),
            Message::ToolResult { content, .. } => content.len(),
            Message::Assistant(assistant) => {
                super::agent_loop::render_content_for_display(&assistant.content).len()
            }
        })
        .sum();
    (chars / CHARS_PER_TOKEN) as u32
}

/// The trigger issue #97 names: compact once the estimated cost of
/// `messages` would leave less than `RESERVE_TOKENS` of `context_window`
/// free for the reply that follows.
pub fn should_compact(messages: &[Message], context_window: u32) -> bool {
    estimate_tokens(messages) > context_window.saturating_sub(RESERVE_TOKENS)
}

/// `true` for a `Message::User` this module wrote as a previous
/// compaction's summary (`SUMMARY_MARKER`'s own doc comment).
fn is_summary_marker(message: &Message) -> bool {
    matches!(message, Message::User(text) if text.starts_with(SUMMARY_MARKER))
}

/// How many messages at the *start* of `messages` are prior summaries this
/// module wrote — `0` the first time a Conversation is ever compacted.
/// Every index below this count is off-limits to `find_cut_point`: a
/// second compaction must never drop, or feed back through the model, a
/// summary a first compaction already produced (this module's own doc
/// comment on why that's what keeps two compactions from compounding).
fn leading_pinned_count(messages: &[Message]) -> usize {
    messages
        .iter()
        .take_while(|message| is_summary_marker(message))
        .count()
}

/// `true` when `idx` is a safe place to start keeping messages from —
/// equivalently, a safe place to stop dropping them. The one rule issue #97
/// calls non-negotiable: **never leave a `Message::ToolResult` with no
/// `Message::Assistant` tool call in front of it.** `agent_loop::run` only
/// ever pushes a `ToolResult` immediately after the `Assistant` message
/// that requested it (`agent_loop.rs`'s own loop body), so the two are
/// always adjacent — which makes the rule exactly this simple to check:
/// `messages[idx]` itself must not be a `ToolResult`. `idx == messages.len()`
/// (an empty kept suffix) is trivially valid by the same logic — there is
/// nothing there to be a dangling `ToolResult`.
fn is_valid_cut_point(messages: &[Message], idx: usize) -> bool {
    !matches!(messages.get(idx), Some(Message::ToolResult { .. }))
}

/// Finds where to cut `messages` so that the kept suffix (`messages[cut..]`)
/// is a valid, self-contained Conversation tail — every `ToolResult` in it
/// answered by an `Assistant` tool call also in it — while keeping as much
/// of it as fits in `keep_recent_tokens`, by `chars_estimate`'s plain
/// content-length accounting (not `estimate_tokens`'s own — `keep_recent_tokens`
/// is a budget on how much *conversation* to retain, and `estimate_tokens`'s
/// `FIXED_OVERHEAD_TOKENS` floor is a fact about the next real call, not
/// about how much of this cut suffix there is; folding it in here would
/// make even an empty kept suffix look like it costs 17,000 tokens).
/// Searches smallest `idx` first — the point that keeps the *most* — so the
/// first valid, in-budget boundary found is exactly the one this function
/// wants. Never returns an index inside `leading_pinned_count(messages)` —
/// seeing this module's own prior summary is never up for being dropped a
/// second time.
///
/// Always terminates with a real answer: `idx == messages.len()` (keep
/// nothing) is trivially valid (there is no `messages[len]` to be a bare
/// `ToolResult`) and trivially in budget (an empty suffix costs nothing by
/// `chars_estimate`), so the search can never run off the end of `messages`
/// without having already returned.
pub fn find_cut_point(messages: &[Message], keep_recent_tokens: u32) -> usize {
    let floor = leading_pinned_count(messages);
    (floor..=messages.len())
        .find(|&idx| {
            is_valid_cut_point(messages, idx)
                && chars_estimate(&messages[idx..]) <= keep_recent_tokens
        })
        .unwrap_or(messages.len())
}

/// `agent_loop::run`'s pre-flight hook (this module's own doc comment): if
/// `messages` is already within `context_window`'s budget, returns it
/// unchanged — no client call, no allocation beyond what was already there.
/// Otherwise finds a cut point (`find_cut_point`, budgeted at
/// `KEEP_RECENT_TOKENS`), asks `client` to summarise everything from the
/// last pinned summary (if any) up to that cut point, and returns `[..every
/// pinned prior summary, the new summary, ...the kept suffix]`.
///
/// A `should_compact` trigger with nothing actually droppable — `cut_point`
/// lands at or before `leading_pinned_count(messages)`, meaning every
/// message that isn't already a pinned summary is already inside the kept
/// suffix — is a no-op: there is nothing to summarise, and calling the
/// model to "summarise" an empty slice would be a wasted call for no
/// smaller a Conversation. This is the real-world shape `FIXED_OVERHEAD_TOKENS`
/// causes for a small enough `context_window`: `should_compact` can be
/// `true` from the very first turn (the fixed floor alone already exceeds a
/// tiny window's reserve), and the right response to that is not to
/// pointlessly cut a one-message Conversation down to itself.
pub async fn transform_context(
    client: &dyn ChatClient,
    context_window: u32,
    messages: Vec<Message>,
) -> Vec<Message> {
    if !should_compact(&messages, context_window) {
        return messages;
    }

    let pinned = leading_pinned_count(&messages);
    let cut = find_cut_point(&messages, KEEP_RECENT_TOKENS).max(pinned);
    if cut <= pinned {
        return messages;
    }

    let summary = summarize(client, &messages[pinned..cut]).await;

    let mut result = Vec::with_capacity(pinned + 1 + (messages.len() - cut));
    result.extend(messages[..pinned].iter().cloned());
    result.push(Message::User(format!("{SUMMARY_MARKER}{summary}")));
    result.extend(messages[cut..].iter().cloned());
    result
}

/// Asks `client` to condense `to_summarize` into plain prose. `to_summarize`
/// is replayed to the model as an ordinary Conversation (it is always a
/// valid one — `find_cut_point`'s own contract, and `leading_pinned_count`
/// keeping a pinned summary's own start message out of this slice), with
/// `SUMMARIZE_INSTRUCTION` appended as one final `Message::User` asking the
/// model to describe what it just read rather than continue it. A fresh
/// `Context` — no tools — since a summarisation call is not itself a turn
/// in the Conversation it's summarising; nothing about tool-calling
/// protocol belongs in its system prompt.
async fn summarize(client: &dyn ChatClient, to_summarize: &[Message]) -> String {
    let mut messages = to_summarize.to_vec();
    messages.push(Message::User(SUMMARIZE_INSTRUCTION.to_string()));
    let ctx = Context {
        system_prompt: "You summarise conversations. Be concise and factual.".to_string(),
        messages,
        tools: Vec::new(),
    };
    let reply = client.stream(&ctx).await.collect().await;
    render_text(&reply.content)
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use async_trait::async_trait;
    use serde_json::json;
    use tokio::sync::mpsc;

    use super::*;
    use crate::harness::chat::{AssistantMessageStream, StreamEvent};
    use crate::harness::types::{AssistantMessage, ContentBlock, StopReason};

    fn user(text: &str) -> Message {
        Message::User(text.to_string())
    }

    fn assistant_prose(text: &str) -> Message {
        Message::Assistant(AssistantMessage {
            content: vec![ContentBlock::Text(text.to_string())],
            stop_reason: StopReason::Stop,
            error_message: None,
            usage: None,
        })
    }

    fn assistant_tool_call(id: &str, name: &str) -> Message {
        Message::Assistant(AssistantMessage {
            content: vec![ContentBlock::ToolCall {
                id: id.to_string(),
                name: name.to_string(),
                arguments: json!({}),
            }],
            stop_reason: StopReason::ToolUse,
            error_message: None,
            usage: None,
        })
    }

    fn tool_result(id: &str, content: &str) -> Message {
        Message::ToolResult {
            tool_call_id: id.to_string(),
            tool_name: "search".to_string(),
            content: content.to_string(),
            is_error: false,
        }
    }

    fn padded(chars: usize) -> String {
        "x".repeat(chars)
    }

    // -- estimate_tokens ---------------------------------------------------

    #[test]
    fn estimate_tokens_falls_back_to_fixed_overhead_when_content_is_tiny() {
        let messages = vec![user("hi")];
        // "hi" alone is a couple of tokens by chars/4 — the fixed floor
        // dominates, exactly as this module's own doc comment on
        // `FIXED_OVERHEAD_TOKENS` says it must.
        assert_eq!(estimate_tokens(&messages), FIXED_OVERHEAD_TOKENS);
    }

    #[test]
    fn estimate_tokens_uses_chars_over_fixed_overhead_once_content_is_large() {
        let messages = vec![user(&padded(100_000))];
        let expected = (100_000 / CHARS_PER_TOKEN) as u32;
        assert!(expected > FIXED_OVERHEAD_TOKENS);
        assert_eq!(estimate_tokens(&messages), expected);
    }

    #[test]
    fn estimate_tokens_anchors_on_the_last_reported_usage_and_estimates_only_the_tail() {
        let anchored = AssistantMessage {
            content: vec![ContentBlock::Text("ok".to_string())],
            stop_reason: StopReason::Stop,
            error_message: None,
            usage: Some(Usage {
                input_tokens: 12_000,
                output_tokens: 300,
            }),
        };
        let messages = vec![
            user("earlier, unanchored text that must be ignored"),
            Message::Assistant(anchored),
            user(&padded(40)), // 10 tokens by chars/4
        ];

        // 12_000 + 300 (the anchor) + 10 (the tail after it) — the
        // unanchored text *before* the anchor must not be counted at all,
        // since the anchor already reports the true cost up to itself.
        assert_eq!(estimate_tokens(&messages), 12_310);
    }

    /// Issue #97's own explicit requirement: "missing or zero usage must
    /// not be treated as '0 tokens used.'" No message in this transcript
    /// ever carries a `Usage` at all — the ordinary shape for an endpoint
    /// that never reports one, or a Conversation's first turn before
    /// anything has answered yet — and the result must still land at
    /// `estimate_tokens`'s real floor, not anywhere near 0.
    #[test]
    fn estimate_tokens_with_no_usage_anywhere_does_not_read_as_zero() {
        let messages = vec![
            user("What did I write about running?"),
            assistant_prose("A little, last week."),
            user("And the wedding?"),
        ];
        let estimate = estimate_tokens(&messages);
        assert!(
            estimate >= FIXED_OVERHEAD_TOKENS,
            "absent usage must fall back to the estimate, never read as free: got {estimate}"
        );
    }

    /// A stale anchor: the last real measurement sits several turns back,
    /// with real tool-calling activity — not just one short reply — between
    /// it and the end of the transcript. `estimate_tokens` must still
    /// estimate only that tail at chars/4, not silently widen the anchor's
    /// reach to the whole transcript once more than one message follows it.
    #[test]
    fn estimate_tokens_a_stale_anchor_estimates_only_several_later_messages_not_the_whole_transcript()
     {
        let anchored = AssistantMessage {
            content: vec![ContentBlock::Text("ok".to_string())],
            stop_reason: StopReason::Stop,
            error_message: None,
            usage: Some(Usage {
                input_tokens: 8_000,
                output_tokens: 120,
            }),
        };
        let messages = vec![
            user(&padded(400_000)), // huge, but strictly before the anchor — must be ignored
            Message::Assistant(anchored),
            assistant_tool_call("call_0", "search_entries"),
            tool_result("call_0", &padded(80)), // 20 tokens
            assistant_prose("Found it."),       // ~2 tokens
            user(&padded(40)),                  // 10 tokens
        ];

        // 8_000 + 120 (the anchor) + the four messages after it — the
        // 400,000-char message before the anchor must contribute nothing,
        // and every message after the anchor, not just the first, must be
        // counted.
        let tail_tokens = chars_estimate(&messages[2..]);
        assert_eq!(estimate_tokens(&messages), 8_120 + tail_tokens);
        // A sanity floor on the test fixture itself: if this were 0 the
        // assertion above would trivially pass without actually exercising
        // "several later messages."
        assert!(tail_tokens > 0);
    }

    // -- should_compact / trigger arithmetic --------------------------------

    #[test]
    fn should_compact_fires_once_the_estimate_exceeds_window_minus_reserve() {
        // A tiny, mostly-empty Conversation still costs FIXED_OVERHEAD_TOKENS
        // (17_000) by this module's own floor. A window whose reserve-adjusted
        // budget sits just below that must already trigger...
        let just_under = FIXED_OVERHEAD_TOKENS + RESERVE_TOKENS - 1;
        assert!(should_compact(&[user("hi")], just_under));

        // ...and one whose budget sits exactly at (or above) it must not,
        // proving this is a genuine boundary, not "always on" for a small
        // window.
        let exactly_enough = FIXED_OVERHEAD_TOKENS + RESERVE_TOKENS;
        assert!(!should_compact(&[user("hi")], exactly_enough));
    }

    #[test]
    fn should_compact_stays_false_for_a_generously_sized_window() {
        // Matches the realistic case: a configured model with a six-figure
        // context window (`DEFAULT_CONTEXT_WINDOW`'s own doc comment names
        // `localAIWrapper`'s actual Models) comfortably absorbs the fixed
        // overhead plus a modest real Conversation.
        let messages = vec![
            user("What did I write about running?"),
            assistant_prose("A little."),
        ];
        assert!(!should_compact(&messages, 200_000));
    }

    #[test]
    fn should_compact_fires_for_the_conservative_fallback_window() {
        // `DEFAULT_CONTEXT_WINDOW` is deliberately small — this is the
        // "conservative... summarises earlier than strictly necessary"
        // consequence made concrete: even a short Conversation is already
        // over budget against the fallback the moment any real content
        // accumulates.
        let messages = vec![user(&padded(40_000))];
        assert!(should_compact(&messages, DEFAULT_CONTEXT_WINDOW));
    }

    // -- find_cut_point / the cut-point rule ---------------------------------

    /// The test that matters most (issue #97's own framing): proves the
    /// naive approach — cut wherever the trailing N tokens' worth of
    /// messages ends, with no regard for message shape — would split a
    /// tool call from its result, and that `find_cut_point` does not.
    ///
    /// The transcript: a big tool call/result pair, immediately followed by
    /// one small `Assistant` reply. A naive cut aimed at keeping only the
    /// smallest possible budget (walking back from the end until the
    /// *token* budget is satisfied, ignoring message boundaries entirely)
    /// would stop *inside* the padded `ToolResult`, at a byte offset that —
    /// translated back to whole messages — lands squarely on the
    /// `ToolResult` itself, dropping the `Assistant` tool call that asked
    /// for it. `find_cut_point` must instead back up to a boundary that
    /// keeps the pair together.
    #[test]
    fn find_cut_point_never_separates_a_tool_call_from_its_result() {
        let messages = vec![
            user("What did I write about the wedding?"),
            assistant_tool_call("call_0", "search_entries"),
            tool_result("call_0", &padded(4_000)), // ~1_000 tokens — the bulk of this transcript
            assistant_prose("Done."),
        ];

        // The naive approach this test exists to rule out: keep only the
        // trailing `keep_recent_tokens` worth of *characters*, measured
        // from the very end of the whole rendered transcript, with no
        // notion of a message boundary at all.
        let keep_recent_tokens = 50; // small enough that only "Done." plus a
        // sliver of the tool result would naively survive
        let rendered: String = messages
            .iter()
            .map(|m| match m {
                Message::User(t) => t.clone(),
                Message::Assistant(a) => {
                    super::super::agent_loop::render_content_for_display(&a.content)
                }
                Message::ToolResult { content, .. } => content.clone(),
            })
            .collect();
        let naive_cut_chars = rendered.len() - (keep_recent_tokens as usize * CHARS_PER_TOKEN);
        // The naive byte offset falls inside the padded tool result, not on
        // a message boundary at all — demonstrating the naive approach has
        // no way to even land on `messages[2]` (the `ToolResult`) cleanly,
        // let alone avoid it. The type-aware search below must reject that
        // whole message, not just refuse an in-message split it was never
        // going to consider in the first place.
        assert!(naive_cut_chars > 0 && naive_cut_chars < rendered.len());

        let cut = find_cut_point(&messages, keep_recent_tokens);

        // The only two valid boundaries in this transcript are index 0
        // (before anything) and index 3 (`assistant_prose("Done.")`) — index
        // 2 (the `ToolResult`) is exactly the invalid cut the naive
        // approach above would produce.
        assert_ne!(cut, 2, "must never cut at a bare ToolResult");
        assert!(matches!(messages.get(cut), Some(Message::Assistant(_)) | None) || cut == 0);
        // With this budget the tool result alone still exceeds it, so the
        // fallback rule applies: the rightmost valid boundary, which is
        // right before the final prose reply.
        assert_eq!(cut, 3);
    }

    #[test]
    fn find_cut_point_keeps_as_much_as_fits_the_budget() {
        let messages = vec![
            user(&padded(4)),            // ~1 token
            assistant_prose(&padded(4)), // ~1 token
            user(&padded(4)),            // ~1 token
            assistant_prose(&padded(4)), // ~1 token
        ];
        // Budget large enough to keep the last two messages but not all four
        // — the smallest `idx` (most kept) that still fits is 2, not 3.
        let cut = find_cut_point(&messages, 2);
        assert_eq!(cut, 2);
    }

    #[test]
    fn find_cut_point_never_returns_an_index_inside_a_pinned_summary() {
        let messages = vec![
            Message::User(format!("{SUMMARY_MARKER}a prior summary")),
            user("a follow-up question"),
            assistant_prose("a follow-up answer"),
        ];
        // Even with a budget of 0 (nothing at all should fit), the pinned
        // summary at index 0 must never be treated as droppable.
        let cut = find_cut_point(&messages, 0);
        assert!(cut >= 1, "a pinned summary must never be cut away");
    }

    // -- transform_context ---------------------------------------------------

    /// A `ChatClient` double whose only job is to answer a summarisation
    /// call with a fixed reply — this module's own equivalent of
    /// `agent_loop`'s `ScriptedChatClient`, kept local and single-purpose
    /// rather than shared, since every test here needs exactly the same
    /// "always reply with this text" behaviour and nothing scripted.
    struct StubSummaryClient {
        replies: Mutex<Vec<String>>,
        contexts: Mutex<Vec<Context>>,
    }

    impl StubSummaryClient {
        fn new(replies: Vec<&str>) -> Self {
            Self {
                replies: Mutex::new(replies.into_iter().rev().map(String::from).collect()),
                contexts: Mutex::new(Vec::new()),
            }
        }

        fn contexts(&self) -> Vec<Context> {
            self.contexts.lock().unwrap().clone()
        }
    }

    #[async_trait]
    impl ChatClient for StubSummaryClient {
        async fn stream(&self, ctx: &Context) -> AssistantMessageStream {
            self.contexts.lock().unwrap().push(ctx.clone());
            let (tx, rx) = mpsc::unbounded_channel();
            let text = self
                .replies
                .lock()
                .unwrap()
                .pop()
                .expect("StubSummaryClient ran out of replies");
            let message = AssistantMessage {
                content: vec![ContentBlock::Text(text)],
                stop_reason: StopReason::Stop,
                error_message: None,
                usage: None,
            };
            let _ = tx.send(StreamEvent::Done(message));
            AssistantMessageStream::new(rx)
        }
    }

    #[tokio::test]
    async fn transform_context_is_a_no_op_under_the_trigger() {
        let client = StubSummaryClient::new(vec![]);
        let messages = vec![user("hello")];
        let result = transform_context(&client, 200_000, messages.clone()).await;
        assert_eq!(result, messages);
        assert!(
            client.contexts().is_empty(),
            "must not call the model when nothing needs compacting"
        );
    }

    #[tokio::test]
    async fn transform_context_summarises_the_dropped_prefix_and_keeps_the_recent_suffix() {
        let client = StubSummaryClient::new(vec!["condensed summary"]);
        let messages = vec![
            user(&padded(90_000)), // well over KEEP_RECENT_TOKENS on its own
            assistant_prose("kept reply"),
        ];

        let result = transform_context(&client, DEFAULT_CONTEXT_WINDOW, messages).await;

        assert_eq!(result.len(), 2);
        let Message::User(summary_text) = &result[0] else {
            panic!("expected the compaction summary as the first message");
        };
        assert!(summary_text.starts_with(SUMMARY_MARKER));
        assert!(summary_text.contains("condensed summary"));
        assert_eq!(result[1], assistant_prose("kept reply"));

        // The summarisation call itself must ask the model to describe the
        // dropped material, not continue the conversation.
        let sent = &client.contexts()[0];
        assert!(sent.tools.is_empty());
        assert!(
            sent.messages
                .last()
                .is_some_and(|m| matches!(m, Message::User(t) if t == SUMMARIZE_INSTRUCTION))
        );
    }

    #[tokio::test]
    async fn compacting_twice_preserves_the_first_summary_without_recompounding() {
        let client = StubSummaryClient::new(vec!["first summary", "second summary"]);

        let first_pass = vec![user(&padded(90_000)), assistant_prose("reply one")];
        let after_first = transform_context(&client, DEFAULT_CONTEXT_WINDOW, first_pass).await;
        assert_eq!(after_first.len(), 2);

        // Grow the Conversation again past the same small window, on top of
        // the already-compacted result.
        let mut second_pass = after_first.clone();
        second_pass.push(user(&padded(90_000)));
        second_pass.push(assistant_prose("reply two"));

        let after_second = transform_context(&client, DEFAULT_CONTEXT_WINDOW, second_pass).await;

        // The first summary is still there, byte for byte, as the very
        // first message — never re-summarised, never dropped.
        assert_eq!(after_second[0], after_first[0]);
        // A second summary now follows it, distinct from the first.
        let Message::User(second_summary) = &after_second[1] else {
            panic!("expected a second compaction summary");
        };
        assert!(second_summary.starts_with(SUMMARY_MARKER));
        assert!(second_summary.contains("second summary"));
        assert_ne!(&after_second[1], &after_first[0]);

        // The model was never asked to summarise the first summary's own
        // text — only the material between it and the new cut point.
        let second_call_ctx = &client.contexts()[1];
        assert!(
            second_call_ctx.messages.iter().all(
                |m| !matches!(m, Message::User(t) if t == &after_first[0].clone().into_text())
            ),
        );
    }

    /// Small helper so the assertion above reads naturally — `Message` has
    /// no public accessor for a `User`'s text today, and adding one purely
    /// for a test isn't worth widening the type for.
    trait IntoText {
        fn into_text(self) -> String;
    }
    impl IntoText for Message {
        fn into_text(self) -> String {
            match self {
                Message::User(text) => text,
                _ => panic!("not a User message"),
            }
        }
    }
}
