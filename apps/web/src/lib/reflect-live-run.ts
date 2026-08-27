/**
 * Folds the live event stream `reflect-transport.ts` reports
 * (`ReflectStreamEvent`) into what `reflection-page.tsx` actually renders
 * while a Question is in flight — issue #96's "show the work": which tool
 * ran, what it was asked for, and how much came back, in order, plus the
 * Answer's own text arriving whole or word by word depending on whether
 * the Session's model streams (`ReflectStreamEvent.message_update`'s own
 * doc comment).
 *
 * Kept as a plain, pure reducer — `applyReflectEvent(state, event)` — and
 * not a hook, so the sequencing this ticket cares about ("steps appear in
 * order," "a multi-step Question shows each tool call") is testable
 * without rendering anything at all. `reflection-page.tsx` is the only
 * caller, and it does nothing more than fold events into this state with
 * `useState`/`useReducer`-shaped `setState` calls.
 */
import type { DigestGroundingSource } from "@/lib/conversation";
import type { ReflectStreamEvent } from "@/lib/reflect-transport";

/** One tool call this run has made, or is still making. */
export interface LiveStep {
  /** `tool_call_id` — how a later `tool_execution_end` is matched back to this step. */
  id: string;
  toolName: string;
  /** This call's own arguments, from `tool_execution_start` — kept so the finished label (`finishedLabel`) can still say what was searched once `tool_execution_end` arrives, which carries no `arguments` field of its own. */
  arguments: unknown;
  status: "running" | "done" | "error";
  /** What to show for this step right now — recomputed once its result arrives. */
  label: string;
}

export interface LiveRunState {
  steps: LiveStep[];
  /**
   * The Answer's own text, as far as it's arrived. Only ever set from a
   * turn whose `message_end` did *not* end in a tool call — a
   * `stop_reason: "tool_use"` turn's text is a preamble before the tool
   * runs, not the Answer, and is deliberately discarded rather than shown
   * (see `applyReflectEvent`'s own `message_end` case).
   */
  answer: string;
  /** Whether `answer` is the Answer's own text (possibly still growing) rather than empty because nothing has arrived yet. */
  answering: boolean;
  /** A model call is in flight with nothing new to show for it yet — the moment a bare "Thinking…" is still the honest, whole truth. */
  thinking: boolean;
  /** Set once a `read_digest` call surfaces a real Digest — carried onto the finished turn (`conversation.ts`'s `conversationTurnFromWire`) so `GroundingDisclosure` can say the Answer came from a Digest, not from Entries silently reporting none. */
  digestSource: DigestGroundingSource | undefined;
}

export const initialLiveRunState: LiveRunState = {
  steps: [],
  answer: "",
  answering: false,
  thinking: true,
  digestSource: undefined,
};

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Reads `read_digest`'s own `details` shape (`server/src/harness/tools/read_digest.rs`'s `source`/`period`/`period_start`/`period_end`) — `undefined` for "no Digest existed for that Period" (`details` is `null`) or anything malformed. */
function parseDigestSource(details: unknown): DigestGroundingSource | undefined {
  const record = asRecord(details);
  if (record.source !== "digest") {
    return undefined;
  }
  const period = asString(record.period);
  const periodStart = asString(record.period_start);
  const periodEnd = asString(record.period_end);
  if (period === undefined || periodStart === undefined || periodEnd === undefined) {
    return undefined;
  }
  return { period, periodStart, periodEnd };
}

/**
 * "1 Entry" / "20 Entries" — the domain's own plural, not a naive `+ "s"`.
 *
 * The generic helper this replaced rendered **"20 Entrys"** in a live step
 * label, caught by driving the real app rather than by any test: `Entry` is
 * a CONTEXT.md term whose plural is irregular, and every call site here
 * passed that one noun, so a general-purpose pluralizer was carrying no
 * weight and getting the only case it had wrong. The wording matches
 * `grounding-disclosure.tsx`'s summary label deliberately, so a running
 * step and the finished disclosure say the same word for the same thing.
 */
function entryCount(count: number): string {
  return `${count} ${count === 1 ? "Entry" : "Entries"}`;
}

/** What to show while a tool call is still running — named after what it's actually doing, per this ticket's own acceptance criterion. */
function runningLabel(toolName: string, args: unknown): string {
  const record = asRecord(args);
  switch (toolName) {
    case "entries_in_range": {
      const from = asString(record.from) ?? "?";
      const to = asString(record.to) ?? "?";
      return `Looking through Entries from ${from} to ${to}…`;
    }
    case "search_entries":
      return `Searching your Entries for "${asString(record.query) ?? ""}"…`;
    case "similar_entries":
      return `Searching your Entries by meaning for "${asString(record.query) ?? ""}"…`;
    case "read_digest": {
      const period = asString(record.period) ?? "";
      const date = asString(record.date) ?? "";
      return `Reading the ${period} Digest for ${date}…`;
    }
    default:
      return `Running ${toolName}…`;
  }
}

/** What to show once a tool call has finished — names what was searched and how much came back, this ticket's own words. */
function finishedLabel(
  toolName: string,
  args: unknown,
  event: Extract<ReflectStreamEvent, { type: "tool_execution_end" }>,
): string {
  if (event.isError) {
    return `${toolName} failed.`;
  }
  const record = asRecord(args);
  switch (toolName) {
    case "entries_in_range": {
      const from = asString(record.from) ?? "?";
      const to = asString(record.to) ?? "?";
      return `Looked through Entries from ${from} to ${to} — ${entryCount(event.entryCount)} found.`;
    }
    case "search_entries":
      return `Searched your Entries for "${asString(record.query) ?? ""}" — ${entryCount(event.entryCount)} found.`;
    case "similar_entries":
      return `Searched your Entries by meaning for "${asString(record.query) ?? ""}" — ${entryCount(event.entryCount)} found.`;
    case "read_digest": {
      const period = asString(record.period) ?? "";
      const date = asString(record.date) ?? "";
      const digestSource = parseDigestSource(event.details);
      return digestSource === undefined
        ? `No ${period} Digest has been written yet for ${date}.`
        : `Read the ${digestSource.period} Digest for ${digestSource.periodStart}${
            digestSource.periodStart === digestSource.periodEnd
              ? ""
              : ` to ${digestSource.periodEnd}`
          }.`;
    }
    default:
      return `${toolName} finished — ${entryCount(event.entryCount)} found.`;
  }
}

/**
 * Folds one `ReflectStreamEvent` into the running `LiveRunState` — see the
 * module comment. Never mutates `state`; returns a new value the same way
 * a `useState` updater is expected to, so callers can pass this straight
 * to `setState(prev => applyReflectEvent(prev, event))`.
 */
export function applyReflectEvent(state: LiveRunState, event: ReflectStreamEvent): LiveRunState {
  switch (event.type) {
    case "turn_start":
      return { ...state, thinking: true };

    case "message_start":
      return state;

    case "message_update":
      // Only ever meaningful on the turn that turns out to be the final
      // Answer (see `message_end`'s own case below) — a streaming model
      // can in principle emit deltas for a turn that ends in a tool call
      // too, but there's no way to tell which until `message_end`'s own
      // `stop_reason` arrives, so every delta is provisionally treated as
      // Answer text and corrected there if it wasn't.
      return { ...state, answer: state.answer + event.delta, answering: true, thinking: false };

    case "message_end":
      if (event.stopReason === "tool_use") {
        // This turn's text, if any, was a preamble before the tool call
        // that's about to run — not the Answer. Discarded, not shown.
        return { ...state, answer: "", answering: false };
      }
      return { ...state, answer: event.text, answering: true, thinking: false };

    case "tool_execution_start":
      return {
        ...state,
        thinking: false,
        steps: [
          ...state.steps,
          {
            id: event.toolCallId,
            toolName: event.toolName,
            arguments: event.arguments,
            status: "running",
            label: runningLabel(event.toolName, event.arguments),
          },
        ],
      };

    case "tool_execution_end": {
      const digestSource =
        event.toolName === "read_digest" ? parseDigestSource(event.details) : undefined;
      return {
        ...state,
        // Back to "thinking" until the next message_start/message_end —
        // the loop always calls the model again after a tool result.
        thinking: true,
        digestSource: digestSource ?? state.digestSource,
        steps: state.steps.map((step) =>
          step.id === event.toolCallId
            ? {
                ...step,
                status: event.isError ? "error" : "done",
                label: finishedLabel(step.toolName, step.arguments, event),
              }
            : step,
        ),
      };
    }
  }
}
