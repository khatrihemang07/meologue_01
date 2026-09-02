//! `AgentTool` — what `agent_loop` executes, and what a `Tool` (the
//! `harness::types` shape rendered into a prompt or a real tool-call
//! request) is built from. Ported from pi's own `AgentTool`/`AgentToolResult`
//! (`packages/agent/src/types.ts`), with one addition pi doesn't need:
//! `snippet`/`guidelines`, pi's tools are described to the model entirely by
//! their JSON-Schema `description`, because pi always talks to a model with
//! genuine tool-calling. This harness cannot assume that (`prompted.rs`'s
//! whole reason for existing), so each tool also carries a natural-language
//! contribution to the *system prompt itself* — `render_tool_guidance`
//! assembles the active tool set's `snippet`s and `guidelines` into prose
//! `reflect.rs` prepends to its own persona instruction. This is deliberate,
//! not an oversight: issue #93 names it directly ("the system prompt is
//! rebuilt from the active tool set — so adding a tool adds its description
//! and removing it removes it"), because #94 and #95 both add tools and
//! neither should mean hand-editing a paragraph of prose in `reflect.rs`
//! every time.
//!
//! `entries_in_range` (`entries_in_range.rs`, issue #93) was the first
//! tool; issue #94 adds two more, both against journal content rather than
//! a date: `search_entries` (`search_entries.rs`) finds Entries by word,
//! and `similar_entries` (`similar_entries.rs`) finds them by meaning. The
//! issue is explicit that these stay two separate tools rather than one
//! merged one, because they fail on different kinds of Question and a
//! merged tool would hide exactly that difference — see each file's own
//! doc comment for what it wraps and why.
//!
//! All three render an Entry into a tool result the same way, through
//! `render_entry` below (issue #101) — previously each file carried its
//! own copy of the same `format!`, and because they were copies rather
//! than one function, all three carried the same date-boundary bug. See
//! `render_entry`'s own doc comment for what that bug was and why one
//! function fixes it everywhere at once.
//!
//! `read_digest` (`read_digest.rs`, issue #95) is the fourth tool, and the
//! first over a Digest rather than an Entry — see its own doc comment for
//! what that ticket was actually testing (whether a new *kind* of data
//! costs only a new `AgentTool` impl, or forces a change here or in
//! `agent_loop`) and what it found.
//!
//! `list_tasks` (`tasks.rs`, issue #175) is the fifth tool, and the first
//! over a Task (ADR 0047's second root noun) rather than an Entry or a
//! Digest — see ADR 0052 and that file's own doc comment for why this is
//! a tool, not a widening of ADR 0023's now-superseded fan-out.

pub mod entries_in_range;
pub mod read_digest;
pub mod search_entries;
pub mod similar_entries;
pub mod tasks;

use std::sync::Arc;

use async_trait::async_trait;
use chrono::{DateTime, Duration, Utc};
use serde_json::Value;
use uuid::Uuid;

pub use entries_in_range::EntriesInRangeTool;
pub use read_digest::ReadDigestTool;
pub use search_entries::SearchEntriesTool;
pub use similar_entries::SimilarEntriesTool;
pub use tasks::TasksTool;

use super::types::Tool;

/// Renders one Entry as `[local-date] body` — the single implementation
/// every harness tool calls to show the model an Entry, replacing three
/// copies of the same `format!` that used to live one per tool
/// (`entries_in_range.rs`, `search_entries.rs`, `similar_entries.rs`).
/// Because they were copies rather than one function, all three carried
/// the same bug (issue #101): `created_at` is stored, and was rendered,
/// in UTC, but a date range asked of `entries_in_range` is resolved
/// against the asking Device's *local* day
/// (`reflect::local_date_range_to_utc`, per ADR 0023, itself following ADR
/// 0016's rule that a local day is what a Device's own offset says it is,
/// never the UTC calendar date). The two disagreed at every local-day
/// boundary. Observed live at `utc_offset_minutes: 330` (IST): a Question
/// asking to compare July against August called
/// `entries_in_range({from: "2026-07-01", to: "2026-08-31"})`, and an
/// Entry stored as `created_at = 2026-06-30 19:45+00` — `2026-07-01
/// 01:15` in Asia/Kolkata, correctly inside the requested range — came
/// back labelled `[2026-06-30]`, a date outside the very range that had
/// just been asked for. The retrieval was right; only the label lied
/// about it, which is exactly the kind of thing that invites a model to
/// distrust a tool it should trust, or to quote the wrong date back to
/// the user.
///
/// **There are two different sources of "local" in this codebase, and
/// this function is only one of them — the two must not be conflated.**
/// Every harness tool acts on behalf of an asking Device, which supplies
/// its own `utc_offset_minutes` on every Question (ADR 0023); that is the
/// same value `reflect::local_date_range_to_utc` already uses to resolve
/// a range into UTC, so using it here too is what makes a rendered label
/// agree with the range that produced it. `digest.rs`'s Digest worker has
/// no Device in its loop at all (ADR 0027) — there is no request to read
/// an offset from — and instead reads the Server's own configured
/// `MEOLOGUE_TZ` via `period::server_timezone`, a full IANA `chrono_tz::Tz`
/// rather than a fixed offset, because a `Tz` (unlike a Device's
/// snapshot-in-time offset) knows how to account for a DST transition
/// across the Period it's bucketing. Handing this function an offset
/// derived from that `Tz`, or having the Digest worker call this instead
/// of converting through its own `Tz`, would erase the distinction ADR
/// 0027 draws between an explicit per-request Device offset and an
/// explicit process-wide operator setting — so `digest.rs` keeps its own
/// analogous renderer rather than sharing this one.
pub fn render_entry(created_at: DateTime<Utc>, body: &str, utc_offset_minutes: i32) -> String {
    let local = created_at + Duration::minutes(i64::from(utc_offset_minutes));
    format!(
        "[{}] {}",
        local.format("%Y-%m-%d"),
        indent_continuation_lines(body)
    )
}

/// Indents every line of `body` after the first by two spaces (issue
/// #151), so the `[YYYY-MM-DD] ` prefix this function and `digest.rs`'s
/// own `render_entry` each write stays the only thing that marks where
/// one Entry ends and the next begins. Plain Enter already inserts a
/// literal newline in the Composer, so a multi-line body is not
/// speculative: without this, two Entries on the same day, each spanning
/// several lines, run together into a block the model has no reliable
/// way to split back apart.
///
/// Shared by both `render_entry`s (this module's and `digest.rs`'s)
/// rather than duplicated a third time: unlike the timezone resolution
/// the two functions deliberately keep separate (this function's own doc
/// comment above explains why offset-vs-`Tz` must not be conflated),
/// indentation is pure string shaping with nothing Device- or
/// Server-specific about it, so one function serves both call sites.
///
/// A single-line body is returned byte-identical to `body` itself:
/// `split('\n')` on a string with no `\n` yields exactly one element, so
/// the loop that indents "every line but the first" never runs. A body
/// that is empty, all-newlines, or ends in a trailing newline is handled
/// the same way as any other multi-line body — every line after the
/// first gets the two-space prefix, including a blank one, so the
/// boundary rule has no silent exception. A CR before a `\n` (a CRLF
/// body) is left attached to the line it ends, since splitting only on
/// `\n` — never `\r\n` — keeps the inserted indent immediately after the
/// newline the model actually sees, exactly where it needs to be to mark
/// a new line's start regardless of which line-ending convention wrote
/// it.
pub(crate) fn indent_continuation_lines(body: &str) -> String {
    let mut lines = body.split('\n');
    let mut result = lines.next().unwrap_or("").to_string();
    for line in lines {
        result.push('\n');
        result.push_str("  ");
        result.push_str(line);
    }
    result
}

/// What running one tool call produced — pi's own `content`/`details` split
/// (`AgentToolResult`), issue #93's own words: "a compact rendering the
/// model reads, and structured detail the interface renders and the
/// Conversation stores, which the model never sees." `entry_ids` is this
/// codebase's own addition, not pi's: meologue's whole domain is journal
/// Entries, and `reflect.rs` needs to know which ones a tool call actually
/// surfaced regardless of which tool ran, to build `grounding_entry_ids` on
/// the wire response — carrying it as a first-class field here, rather than
/// asking `reflect.rs` to reach into each tool's own `details` shape, is
/// what keeps that collection generic across every future tool (#94, #95),
/// not just this one.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolOutcome {
    /// The compact, model-facing rendering — becomes
    /// `types::Message::ToolResult::content` verbatim.
    pub content: String,
    /// Structured detail for the interface and the Conversation — never
    /// sent to the model. `Value::Null` for a tool with nothing structured
    /// worth keeping.
    pub details: Value,
    /// Every Entry id this call surfaced, in the order they appeared in
    /// `content` — folded into `grounding_entry_ids` by whoever drives the
    /// loop (`reflect.rs`).
    pub entry_ids: Vec<Uuid>,
    /// pi's own early-termination hint (`AgentToolResult::terminate`): the
    /// loop only stops early when *every* result in a batch sets this true
    /// (`agent_loop`'s own doc comment) — no tool this ticket ships needs
    /// it, so it defaults to `false` via `ToolOutcome::new` and exists for
    /// a tool that will.
    pub terminate: bool,
}

impl ToolOutcome {
    /// A plain, successful result with nothing structured or terminating —
    /// what most tool calls, including `entries_in_range`'s, actually
    /// return. `.with_details(...)`, `.with_entry_ids(...)` and
    /// `.with_terminate(true)` layer the rest on when a tool needs them.
    pub fn new(content: impl Into<String>) -> Self {
        Self {
            content: content.into(),
            details: Value::Null,
            entry_ids: Vec::new(),
            terminate: false,
        }
    }

    pub fn with_details(mut self, details: Value) -> Self {
        self.details = details;
        self
    }

    pub fn with_entry_ids(mut self, entry_ids: Vec<Uuid>) -> Self {
        self.entry_ids = entry_ids;
        self
    }

    pub fn with_terminate(mut self, terminate: bool) -> Self {
        self.terminate = terminate;
        self
    }
}

/// One tool `agent_loop::run` can call. `execute` returns `Err(String)` for
/// a failure that's the tool's own to explain — bad arguments, a database
/// error — which `agent_loop` turns into an ordinary `is_error: true` tool
/// result the model reads and can correct from (issue #93: "every failure
/// ... becomes a result the model reads and corrects, never an error the
/// user sees"); it never panics for a reason `execute` itself could
/// anticipate.
#[async_trait]
pub trait AgentTool: Send + Sync {
    /// Must match the `name` a `<tool_call>` tag (or, on a real
    /// tool-calling endpoint, a genuine tool-call request) names to invoke
    /// this tool — this is also the identity `agent_loop::run` looks calls
    /// up by.
    fn name(&self) -> &str;
    /// The JSON-Schema-level description rendered into `Tool::description`
    /// — what a real tool-calling endpoint would show the model, and what
    /// `prompted::render_system_prompt` puts in its `<tools>` block today.
    fn description(&self) -> &str;
    /// A JSON Schema object describing the shape `execute`'s `arguments`
    /// must have.
    fn parameters(&self) -> Value;
    /// A one-line prompt contribution naming this tool and, briefly, what
    /// it's for — assembled by `render_tool_guidance` into the natural-
    /// language half of the system prompt, distinct from the raw JSON
    /// schema `description` above.
    fn snippet(&self) -> &str;
    /// Longer usage guidance beyond the one-line `snippet` — pagination
    /// conventions, when to call it again, anything a model needs to use
    /// this tool well that doesn't belong crammed into `snippet`. `None`
    /// for a tool that needs nothing more.
    fn guidelines(&self) -> Option<&str> {
        None
    }
    async fn execute(&self, arguments: Value) -> Result<ToolOutcome, String>;
}

/// Builds the `harness::types::Tool` list `harness::types::Context::tools`
/// carries, from the active `AgentTool` set — the JSON-Schema-level half of
/// what a tool contributes (name, description, parameters), as distinct
/// from the natural-language half `render_tool_guidance` below builds.
pub fn to_wire_tools(tools: &[Arc<dyn AgentTool>]) -> Vec<Tool> {
    tools
        .iter()
        .map(|tool| Tool {
            name: tool.name().to_string(),
            description: tool.description().to_string(),
            parameters: tool.parameters(),
        })
        .collect()
}

/// Assembles `base` (the caller's own persona instruction) with every
/// active tool's `snippet` and `guidelines`, one tool per bullet — the
/// natural-language prompt contribution issue #93 asks each tool to carry,
/// so that "adding a tool adds its description and removing it removes it"
/// holds for `reflect.rs`'s own system prompt exactly the way it already
/// holds for `prompted::render_system_prompt`'s `<tools>` block. A no-op
/// (returns `base` unchanged) when `tools` is empty, matching
/// `render_system_prompt`'s own "nothing to describe" behaviour.
pub fn render_tool_guidance(base: &str, tools: &[Arc<dyn AgentTool>]) -> String {
    if tools.is_empty() {
        return base.to_string();
    }

    let mut prompt = base.to_string();
    prompt.push_str("\n\n");
    for tool in tools {
        prompt.push_str("- ");
        prompt.push_str(tool.snippet());
        prompt.push('\n');
        if let Some(guidelines) = tool.guidelines() {
            prompt.push_str("  ");
            prompt.push_str(guidelines);
            prompt.push('\n');
        }
    }
    prompt.trim_end().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    fn at(y: i32, m: u32, d: u32, h: u32, min: u32) -> DateTime<Utc> {
        NaiveDate::from_ymd_opt(y, m, d)
            .unwrap()
            .and_hms_opt(h, min, 0)
            .unwrap()
            .and_utc()
    }

    /// At offset 0, the local date is just the UTC date — the "nothing
    /// changed for the common case" baseline the rest of these tests lean
    /// on.
    #[test]
    fn zero_offset_renders_the_utc_date_unchanged() {
        let rendered = render_entry(at(2026, 6, 30, 19, 45), "body", 0);
        assert_eq!(rendered, "[2026-06-30] body");
    }

    /// The exact case from issue #101's live report: `2026-06-30 19:45
    /// UTC` at `utc_offset_minutes: 330` (IST, east of UTC) is
    /// `2026-07-01 01:15` locally — already the next day. Rendering the
    /// UTC date here is the bug; rendering `2026-07-01` is the fix.
    #[test]
    fn east_of_utc_a_late_evening_entry_rolls_forward_to_the_next_local_day() {
        let rendered = render_entry(at(2026, 6, 30, 19, 45), "body", 330);
        assert_eq!(rendered, "[2026-07-01] body");
    }

    /// The direction issue #101 explicitly calls out as the one that gets
    /// forgotten: west of UTC, an early-morning UTC Entry is still
    /// *yesterday* locally. `2026-07-01 03:00 UTC` at offset `-480`
    /// (Pacific, UTC-8) is `2026-06-30 19:00` locally — a genuine day
    /// rollback, not just "no change" or "roll forward".
    #[test]
    fn west_of_utc_an_early_morning_entry_rolls_back_to_the_previous_local_day() {
        let rendered = render_entry(at(2026, 7, 1, 3, 0), "body", -480);
        assert_eq!(rendered, "[2026-06-30] body");
    }

    /// Issue #151's own byte-identical requirement: a single-line body
    /// must render exactly as it did before this ticket.
    #[test]
    fn a_single_line_body_renders_unchanged() {
        let rendered = render_entry(at(2026, 6, 30, 12, 0), "hello world", 0);
        assert_eq!(rendered, "[2026-06-30] hello world");
    }

    #[test]
    fn a_multi_line_body_has_continuation_lines_indented() {
        let rendered = render_entry(at(2026, 6, 30, 12, 0), "line one\nline two\nline three", 0);
        assert_eq!(rendered, "[2026-06-30] line one\n  line two\n  line three");
    }

    #[test]
    fn an_empty_body_renders_unchanged() {
        let rendered = render_entry(at(2026, 6, 30, 12, 0), "", 0);
        assert_eq!(rendered, "[2026-06-30] ");
    }

    #[test]
    fn a_body_of_only_newlines_indents_every_blank_continuation_line() {
        let rendered = render_entry(at(2026, 6, 30, 12, 0), "\n\n", 0);
        assert_eq!(rendered, "[2026-06-30] \n  \n  ");
    }

    #[test]
    fn a_trailing_newline_indents_the_trailing_blank_line_too() {
        let rendered = render_entry(at(2026, 6, 30, 12, 0), "first\nsecond\n", 0);
        assert_eq!(rendered, "[2026-06-30] first\n  second\n  ");
    }

    #[test]
    fn crlf_line_endings_keep_the_carriage_return_on_the_line_it_ends() {
        let rendered = render_entry(at(2026, 6, 30, 12, 0), "first\r\nsecond\r\n", 0);
        assert_eq!(rendered, "[2026-06-30] first\r\n  second\r\n  ");
    }

    /// The scenario the issue names directly: two multi-line Entries on
    /// the same day, rendered one after another the way a tool joins its
    /// results, must stay distinguishable — a reader can tell exactly
    /// where the second `[YYYY-MM-DD]` prefix starts.
    #[test]
    fn two_multi_line_entries_on_the_same_day_stay_distinguishable() {
        let first = render_entry(
            at(2026, 6, 30, 9, 0),
            "meeting notes\n- item one\n- item two",
            0,
        );
        let second = render_entry(
            at(2026, 6, 30, 21, 0),
            "evening reflection\nstill thinking about it",
            0,
        );
        let joined = format!("{first}\n\n{second}");
        assert_eq!(
            joined,
            "[2026-06-30] meeting notes\n  - item one\n  - item two\n\n\
             [2026-06-30] evening reflection\n  still thinking about it"
        );
        let entry_starts = joined
            .lines()
            .filter(|line| line.starts_with("[2026-06-30]"))
            .count();
        assert_eq!(entry_starts, 2);
    }

    struct FixedTool {
        name: &'static str,
        snippet: &'static str,
        guidelines: Option<&'static str>,
    }

    #[async_trait]
    impl AgentTool for FixedTool {
        fn name(&self) -> &str {
            self.name
        }
        fn description(&self) -> &str {
            "a fixed test tool"
        }
        fn parameters(&self) -> Value {
            serde_json::json!({"type": "object"})
        }
        fn snippet(&self) -> &str {
            self.snippet
        }
        fn guidelines(&self) -> Option<&str> {
            self.guidelines
        }
        async fn execute(&self, _arguments: Value) -> Result<ToolOutcome, String> {
            Ok(ToolOutcome::new("ok"))
        }
    }

    #[test]
    fn no_tools_leaves_the_base_prompt_unchanged() {
        assert_eq!(render_tool_guidance("Base.", &[]), "Base.");
    }

    #[test]
    fn a_tools_snippet_and_guidelines_are_appended() {
        let tools: Vec<Arc<dyn AgentTool>> = vec![Arc::new(FixedTool {
            name: "entries_in_range",
            snippet: "entries_in_range — finds Entries in a date range.",
            guidelines: Some("Paginated; call again with the named offset to continue."),
        })];
        let prompt = render_tool_guidance("Base.", &tools);
        assert!(prompt.starts_with("Base."));
        assert!(prompt.contains("entries_in_range — finds Entries in a date range."));
        assert!(prompt.contains("Paginated; call again with the named offset to continue."));
    }

    #[test]
    fn adding_a_tool_adds_its_snippet_and_removing_it_removes_it() {
        let tool: Arc<dyn AgentTool> = Arc::new(FixedTool {
            name: "a",
            snippet: "tool a's snippet",
            guidelines: None,
        });
        let with_tool = render_tool_guidance("Base.", std::slice::from_ref(&tool));
        let without_tool = render_tool_guidance("Base.", &[]);
        assert!(with_tool.contains("tool a's snippet"));
        assert!(!without_tool.contains("tool a's snippet"));
    }

    #[test]
    fn to_wire_tools_carries_name_description_and_parameters() {
        let tools: Vec<Arc<dyn AgentTool>> = vec![Arc::new(FixedTool {
            name: "a",
            snippet: "a",
            guidelines: None,
        })];
        let wire = to_wire_tools(&tools);
        assert_eq!(wire.len(), 1);
        assert_eq!(wire[0].name, "a");
        assert_eq!(wire[0].description, "a fixed test tool");
    }
}
