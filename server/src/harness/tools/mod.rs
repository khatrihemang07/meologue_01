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

pub mod entries_in_range;
pub mod search_entries;
pub mod similar_entries;

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value;
use uuid::Uuid;

pub use entries_in_range::EntriesInRangeTool;
pub use search_entries::SearchEntriesTool;
pub use similar_entries::SimilarEntriesTool;

use super::types::Tool;

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
