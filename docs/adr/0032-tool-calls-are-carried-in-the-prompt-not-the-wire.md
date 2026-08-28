# 0032: Tool calls are carried in the prompt, not on the wire

## Status

Accepted. Built alongside [0031](0031-reflection-is-a-loop-over-tools.md) as its lowest layer —
`0031`'s loop is written against `harness::chat::ChatClient` and never learns which of this ADR's
two implementations it's actually talking to. Extends [0021](0021-the-server-calls-an-openai-compatible-llm.md),
which already established that every `LlmClient` call goes through an endpoint accepting only
`model`, `messages`, `stream`, `reasoning_effort` — this ADR is the direct consequence of that
constraint once Reflection needed tool calls at all.

## Context

`0031` requires a model to be able to ask for a tool, read the result, and ask again. The
configured chat endpoint (`localAIWrapper`, in front of `codex-terra` and `claude-*` alike)
reports `"tools": false` for every model `GET /v1/models` lists, and hard-rejects a request
carrying a `tools` field with a 400. This is not a gap that happened to exist while a feature was
being built; `localAIWrapper`'s own founding ADR states it as a deliberate "targeted harness
strip," and adding tool support there was ruled out by decision, not merely unbuilt yet.

`earendil-works/pi`, the reference this whole redesign ports from, offers no design for this case:
its own model catalog build step *excludes* any model whose `tool_call` capability isn't `true`
(`if (m.tool_call !== true) continue;`). pi assumes a genuine tool channel exists wherever it
runs. Meologue's configured endpoint is exactly the case pi doesn't handle, so the tool channel
here had to be built rather than ported.

## Decision

**The tool channel is built at the lowest layer, `harness/prompted.rs`, so that everything above
`harness::chat::ChatClient` is protocol-agnostic and never learns the model it's talking to has no
native tool-calling.** `PromptedToolClient` wraps an ordinary `llm::LlmClient` (today, always
`OpenAiCompatibleClient`) and does two things: renders every `Tool`'s JSON Schema into the system
prompt inside a `<tools>` block, and parses `<tool_call>` tags back out of the reply into
`ContentBlock::ToolCall`. Above this file, the model *appears* to do native tool calls — `0031`'s
loop reads `AssistantMessage::content` and applies pi's stopping rule (no `ToolCall` in the
content means done) exactly as it would against a genuine tool-calling model. This is the whole
trick, and it is deliberately structured so a future genuine tool channel (`chat.rs` reserves the
seam as `NativeToolClient`, unbuilt) could be swapped in later without anything above `ChatClient`
noticing the difference.

**The wire format**, confirmed working against the configured model (`codex-terra`) by issue #93's
own prototype before this ADR's code was written:

```
<tool_call>{"name": "entries_in_range", "arguments": {"from": "2026-07-01", "to": "2026-07-31"}}</tool_call>
```

Several `<tool_call>` tags may appear in one reply, and the model does this unprompted — it is not
merely permitted by the protocol, it is observed behaviour (`0031`'s knee-comparison example).
Prose with no tag at all is how the model signals it is finished; `PROTOCOL_INSTRUCTION` (the
literal last sentence of the system prompt, after the `<tools>` block — see below) states this
explicitly, and `ToolCallScanner` is what makes "no `ToolCall` in `content`" actually true when it
happens.

**`ToolCallScanner` is a three-state machine over deltas** (`Text`, `MaybeTag`, `InToolCall`),
verified against every byte-boundary split of its input rather than a handful of hand-picked
cases. `codex-terra` cannot stream, so today a reply arrives whole and the scanner sees it in one
`feed` call; `claude-*` models do stream (issue #98), and the scanner has to be correct for a
`<tool_call>` tag split at any byte offset — `<`, `<t`, `<to`, … `<tool_call` — before that ever
happened in production, not discovered after. A `<` that turns out not to start a real tag
(`MaybeTag` breaking on a character that doesn't match) rejoins plain text rather than being
silently dropped, and the breaking character is reprocessed in case it starts a genuinely new tag
of its own.

**The protocol instruction is repeated last, after the `<tools>` block and any replayed
Conversation** — `render_system_prompt` appends `PROTOCOL_INSTRUCTION` after everything else,
always. This is [0026](0026-the-extraction-call-sees-the-conversation.md)'s ordering rule applied
to a new place: the thing most load-bearing for the model to follow correctly is the last thing it
reads before it starts writing, not buried ahead of a Conversation that can grow arbitrarily long.
`PROTOCOL_INSTRUCTION`'s own final sentence — issue #103's addition — is a direct instance of
leaning on this ordering: a model that answered "I can't access any journal entries from here"
without ever calling a tool, on a Server where the tools were present and working, is fixed partly
by `reflect::LOOP_SYSTEM_INSTRUCTION` stating the domain rule earlier and partly by repeating a
generic version of it in the position proven to read most reliably.

**Malformed calls do not throw; they become a correctable tool result.** An unparseable
`<tool_call>` tag becomes a `ContentBlock::ToolCall` with an empty name — a sentinel, not an
error — which `0031`'s loop turns into an ordinary `is_error: true` tool result the model reads
and can correct from on its next turn. Nothing in this module ever returns `Err` for a model
failure: that is `chat::ChatClient`'s own stream contract (pi's own `StreamFn`), which is what
keeps the loop's error handling to exactly one shape regardless of whether the failure was a
network error, a malformed tag, or an unrecognised tool name.

**Tool results re-enter the Conversation as `user` messages wrapped in `<tool_result
name="...">`, because there is no `tool` role available on this wire.** This is pi-faithful, not a
workaround invented for this constraint: pi's own `convertToLlm` renders `bashExecution` and
`compactionSummary` results into synthetic `user` messages with `<summary>` wrappers for the same
reason — a chat completions API's fixed `system`/`user`/`assistant` role set has nowhere else to
put a result that isn't the user speaking, and pi already solved this problem for other content
kinds the same way.

**An Entry body is arbitrary user text and must not be able to forge a tool call into its own
transcript — this is the injection defence issue #93 calls non-optional.** `render_tool_result`
escapes every `<` in a tool result's content to `&lt;` before it reaches the model. Without this,
an Entry whose body happened to contain the literal text `<tool_call>{...}</tool_call>` — written
innocently, or adversarially — could be echoed back by a tool (`entries_in_range` and friends quote
Entry bodies verbatim into their results), and if the model later quoted or summarised that text
in its own reply, `ToolCallScanner` would parse the Entry's own words as a call the Server actually
executes. Escaping just `<` is sufficient because the scanner only ever recognises the two tags by
that literal substring, and the escape is one-directional: nothing in this module ever decodes
`&lt;` back to `<`, so there is no way to smuggle a real tag back in by nesting the entity. There is
a test for exactly this forged-tag case, and it is called out explicitly (in both the code's own
comments and issue #93's commit message) as one that must not be deleted.

## Alternatives considered

- **Add tool support to `localAIWrapper`.** Rejected outright, and not this project's decision to
  make — the wrapper's own founding ADR states the "tools": false posture is deliberate scope, not
  an oversight, and issue #93's plan states plainly that this will not change.
- **Structured output (`response_format: json_schema`) instead of a prompt-and-parse tag.**
  Rejected for the same reason [0023](0023-reflection-is-a-fixed-three-source-fan-out.md) and
  [0024](0024-the-answering-call-judges-its-own-grounding.md) already rejected it for extraction
  and the verdict marker: the endpoint accepts only `model`, `messages`, `stream`,
  `reasoning_effort` — no `response_format` field exists to ask for.
- **Restrict the loop to only `claude-*` models, which could plausibly support a different
  integration path, and drop `codex-terra`.** Rejected: `codex-terra` is the configured default
  (`0021`), and the prompt-and-parse channel works identically well against it in the prototype
  that justified building the loop at all — there is no reason to narrow model choice to work
  around a constraint this design already solves generally.
- **Parse tool calls with a regex or a hand-rolled string search over the whole buffered reply,
  rather than an incremental scanner.** Considered, but rejected once streaming models
  (`claude-*`, issue #98) entered scope: a whole-reply parse only works when the whole reply is
  available before parsing starts, which is true for `codex-terra` today but not for a model that
  streams token-sized chunks. The incremental scanner is correct for both cases from the start,
  rather than needing a second implementation later.

## Consequences

**Nothing above `harness::chat::ChatClient` can distinguish a model with genuine tool-calling from
one being coaxed through prompt-and-parse**, which is the entire point, but it also means any
future genuine tool channel has to reproduce `PromptedToolClient`'s exact externally-visible
contract (`ContentBlock::ToolCall` populated correctly, `StopReason::ToolUse` computed
consistently) rather than being free to shape its own.

**Robustness here carries more weight than it would with a real tool channel**, because nothing
enforces that the model's reply actually took the shape it was asked for — a real tool-calling API
would reject a malformed call before the application ever saw it; this one has no such gate.
`ToolCallScanner`, the JSON-repair pass it feeds into, and the empty-name-sentinel path exist
specifically because they are the only defence this design has, and they are exercised
adversarially (every byte-boundary tag split, a `<` inside a JSON string value, a `<` in prose that
never becomes a tag, markdown-fence and backtick noise, an unterminated tag at end of stream) rather
than only against happy-path input.

**A model that ignores the wire format entirely degrades to an ordinary prose reply**, which
`0031`'s loop reads as "no tool call, therefore done" — the same outcome as a model that
legitimately finished. This is an accepted ambiguity: the loop cannot tell "the model chose not to
use a tool" from "the model tried to use the wire format and failed so badly the scanner found
nothing at all," and issue #103's zero-tool-calls guard is what catches the user-visible half of
that failure mode (a confident answer that never looked), not this module.
