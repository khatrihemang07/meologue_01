import type { WireReflectRequest, WireReflectResponse } from "@meologue/core";
import { serverRequest } from "@/lib/server-request";

/**
 * Issue #96: `/v1/reflect` answers over `text/event-stream` now — pi's own
 * event vocabulary (`step_start`, `message_start`/`message_update`/
 * `message_end`, `tool_execution_start`/`tool_execution_end`), emitted as
 * `server/src/harness/agent_loop.rs`'s loop actually makes progress — so
 * this is what a caller receives live, in order, as `onEvent` callbacks,
 * while the run is still going. `agent_end` is not one of these: it's the
 * terminal frame every run ends with (`server/src/reflect.rs`'s own doc
 * comment), and this module consumes it itself to produce the `Promise`'s
 * resolved `ReflectResult` rather than handing it to `onEvent` too — a
 * caller that wants "the run is over" already gets that from the `Promise`
 * settling, so surfacing the same fact twice would just be two places that
 * could disagree about it.
 *
 * `message_update`'s `delta` only ever arrives when the underlying
 * `ChatClient` streams (`reflect.rs`'s own doc comment: the configured
 * `codex-terra` never does, so a caller only sees this on a `claude-*`
 * model). Nothing here special-cases that — a caller that ignores
 * `message_update` and waits for `message_end` gets the same final text
 * either way; this module doesn't need to know which kind of model it's
 * talking to.
 */
export type ReflectStreamEvent =
  | { type: "step_start" }
  | { type: "message_start" }
  | { type: "message_update"; delta: string }
  | { type: "message_end"; text: string; stopReason: string }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; arguments: unknown }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      isError: boolean;
      details: unknown;
      entryIds: string[];
      entryCount: number;
    };

export interface ReflectStreamHandlers {
  /** Called once per non-`agent_end` frame, in the order the stream delivered them. */
  onEvent?: (event: ReflectStreamEvent) => void;
  /**
   * Aborts the underlying fetch and its stream read when the caller no
   * longer wants this run — the page's own unmount cleanup passes this so
   * navigating away mid-Answer doesn't leave a connection (or, worse, a
   * `setState` on an unmounted component) hanging around.
   */
  signal?: AbortSignal;
}

/**
 * Mirrors `sync-transport.ts`'s shape, but Reflection has two failure modes
 * Sync doesn't. A Server that's up and speaking the protocol but predates
 * this route, or that has since moved past this Device's own protocol
 * version, both 404/426 before the stream ever opens (`reflect_handler`'s
 * own doc comment: both are decided *before* it commits to a 200) — the one
 * case the caller needs to tell apart from every other failure, so it's a
 * discriminated union rather than a thrown Error, same as before. Issue
 * #96 adds a third: the stream itself can open and still end in failure
 * (`agent_end {"status": "error"}`, or — a case the server's own contract
 * says should never happen, but a broken connection doesn't ask permission
 * — the stream simply closing with no `agent_end` at all). Both count as
 * "unreachable" is too coarse a lie (the Server *was* reached; the run
 * itself failed), so `agent-error` carries whatever the server said went
 * wrong.
 */
export type ReflectResult =
  | { ok: true; response: WireReflectResponse }
  | { ok: false; reason: "not-supported" }
  | { ok: false; reason: "unreachable" }
  | { ok: false; reason: "agent-error"; error: string }
  // Issue #131: the one failure that isn't a failure at all — the
  // caller's own `signal` firing, which today only happens because
  // `reflection-page.tsx` cancels the fetch on unmount (leaving the
  // screen mid-Question). Folding this into `"unreachable"` used to
  // report the reader's own navigation as a Server outage: the toast
  // fired even though nothing was actually wrong, because this function
  // had no way to tell a deliberate abort apart from a genuine dropped
  // connection once both landed in the same bare `catch` below.
  // `reflection-page.tsx`'s failure branch treats this reason as
  // silent — no toast, no restored Question — there is nothing here to
  // tell the reader that isn't already obvious from having left the
  // screen.
  | { ok: false; reason: "aborted" };

/** One parsed `event:`/`data:` SSE frame — not yet interpreted into a `ReflectStreamEvent`. */
interface RawFrame {
  event: string;
  data: unknown;
}

/**
 * Incrementally splits an SSE byte stream into frames, one `reader.read()`
 * chunk at a time. The naive approach — decode the whole chunk and split on
 * `"\n\n"` — breaks the moment a frame boundary doesn't land on a chunk
 * boundary, which real network reads never guarantee: a `data:` line (this
 * app's payloads can run past a single TCP segment once a tool result's
 * `details` carries a page of Entries) can arrive split across two reads
 * exactly as easily as the blank line between two frames can. This class
 * carries whatever's left over between calls to `push`, so a frame is only
 * ever handed back once a full `"\n\n"` terminator for it has actually
 * arrived.
 */
class SseFrameParser {
  private buffer = "";

  /** Feeds one more decoded chunk in, returning every complete frame it now completes. */
  push(chunk: string): RawFrame[] {
    this.buffer += chunk;
    const frames: RawFrame[] = [];
    let boundary = this.buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const raw = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      const frame = parseFrame(raw);
      if (frame !== null) {
        frames.push(frame);
      }
      boundary = this.buffer.indexOf("\n\n");
    }
    return frames;
  }
}

/**
 * Parses one already-delimited frame's `event:`/`data:` lines. `null` for
 * a frame with no `event:`/`data:` pair at all — axum's own keep-alive
 * comment ping (`Sse::keep_alive`, `server/src/reflect.rs`) — or one whose
 * `data:` line isn't valid JSON, which this module has no honest way to
 * turn into a `ReflectStreamEvent` and so drops rather than crashing the
 * whole run over one malformed frame.
 */
function parseFrame(raw: string): RawFrame | null {
  let event: string | null = null;
  let data: string | null = null;
  for (const rawLine of raw.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      data = line.slice("data:".length).trim();
    }
  }
  if (event === null || data === null) {
    return null;
  }
  try {
    return { event, data: JSON.parse(data) };
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/** Translates one raw `event:`/`data:` frame into the typed event `onEvent` receives, or `null` for `agent_end` (handled by the caller) or anything this client doesn't recognise. */
function toStreamEvent(frame: RawFrame): ReflectStreamEvent | null {
  const data = asRecord(frame.data);
  switch (frame.event) {
    case "step_start":
      return { type: "step_start" };
    case "message_start":
      return { type: "message_start" };
    case "message_update":
      return { type: "message_update", delta: typeof data.delta === "string" ? data.delta : "" };
    case "message_end":
      return {
        type: "message_end",
        text: typeof data.text === "string" ? data.text : "",
        stopReason: typeof data.stop_reason === "string" ? data.stop_reason : "",
      };
    case "tool_execution_start":
      return {
        type: "tool_execution_start",
        toolCallId: typeof data.tool_call_id === "string" ? data.tool_call_id : "",
        toolName: typeof data.tool_name === "string" ? data.tool_name : "",
        arguments: data.arguments,
      };
    case "tool_execution_end":
      return {
        type: "tool_execution_end",
        toolCallId: typeof data.tool_call_id === "string" ? data.tool_call_id : "",
        toolName: typeof data.tool_name === "string" ? data.tool_name : "",
        isError: data.is_error === true,
        details: data.details,
        entryIds: asStringArray(data.entry_ids),
        entryCount: typeof data.entry_count === "number" ? data.entry_count : 0,
      };
    default:
      // Anything this client doesn't know about yet — a future event a
      // newer server sends to an older client — is silently ignored rather
      // than crashing the run, the same forward-compatibility posture
      // `parseFrame` already takes for a keep-alive ping.
      return null;
  }
}

/** Interprets the terminal `agent_end` frame's own `data` into a `ReflectResult`. */
function interpretAgentEnd(data: unknown): ReflectResult {
  const record = asRecord(data);
  if (record.status === "error") {
    return {
      ok: false,
      reason: "agent-error",
      error: typeof record.error === "string" ? record.error : "Reflection failed with no message.",
    };
  }
  // `status: "ok"` — everything else on this frame is `ReflectResponse`,
  // flattened onto `agent_end` rather than nested under its own key
  // (`run_reflect_stream`'s own doc comment) — dropping just the
  // discriminant field hands back exactly that shape.
  const { status: _status, ...response } = record;
  return { ok: true, response: response as WireReflectResponse };
}

export async function reflectTransport(
  request: WireReflectRequest,
  handlers: ReflectStreamHandlers = {},
): Promise<ReflectResult> {
  const { onEvent, signal } = handlers;
  const response = await serverRequest("/v1/reflect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
    signal,
  });

  if (response === null) {
    // `serverRequest` returns `null` for both a genuine network failure and
    // this call's own `signal` firing before the fetch ever got a response
    // (`server-request.ts`'s own doc comment) — the same ambiguity the read
    // loop's `catch` below resolves the same way, by checking `signal` back
    // out. A caller that aborted this early has nothing to be told beyond
    // "this run is over, uneventfully" — see `ReflectResult`'s own doc
    // comment on `"aborted"`.
    return { ok: false, reason: signal?.aborted === true ? "aborted" : "unreachable" };
  }
  // A stale `protocol_version` (426) and Reflection being unconfigured, or
  // this Server predating the route entirely (404), are both decided
  // before the stream ever opens (`reflect_handler`'s own doc comment) —
  // the one distinction this caller needs ("upgrade the Device" vs. every
  // other failure) is the same for both, so both map to the same reason
  // the page already renders a message for.
  if (response.status === 404 || response.status === 426) {
    return { ok: false, reason: "not-supported" };
  }
  if (!response.ok || response.body === null) {
    return { ok: false, reason: "unreachable" };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseFrameParser();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const chunk = decoder.decode(value, { stream: true });
      for (const frame of parser.push(chunk)) {
        if (frame.event === "agent_end") {
          return interpretAgentEnd(frame.data);
        }
        const event = toStreamEvent(frame);
        if (event !== null) {
          onEvent?.(event);
        }
      }
    }
  } catch (error) {
    // Covers both an ordinary network failure mid-stream and this call's
    // own `signal` firing — `reader.read()` rejects with `AbortError` the
    // same way a dropped connection rejects with a network error, and a
    // caller that aborted because it unmounted has nothing useful to do
    // with either outcome beyond "this run is over, uneventfully."
    //
    // A deliberate abort (`signal.aborted`) is the one case that isn't
    // worth logging: every genuine failure here used to vanish into this
    // same bare `catch`, so nothing short of instrumenting the reader by
    // hand (over CDP, on a real device) could ever show *why* a run
    // failed. Logging unconditionally would have buried that signal in
    // noise from the routine unmount-abort this function already expects
    // (the doc comment above), so only the unexpected case — a real
    // error, not this call's own signal firing — reaches the console.
    //
    // Issue #131: the same check now also decides *what this returns*, not
    // just whether it logs. Before this ticket both branches returned
    // `"unreachable"` — the one thing `reflectTransport` knew for certain
    // (the abort was deliberate) was thrown away right here, which is what
    // let `reflection-page.tsx` report the reader's own navigation as a
    // Server outage (issue #131's own report). See `ReflectResult`'s own
    // doc comment on `"aborted"`.
    if (signal?.aborted === true) {
      return { ok: false, reason: "aborted" };
    }
    console.error("reflectTransport: stream read failed", error);
    return { ok: false, reason: "unreachable" };
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Already closed, or cancelling after an abort throws its own — either way there is nothing left to release.
    }
  }

  // The stream closed without ever sending `agent_end`. `run_reflect_stream`
  // (server/src/reflect.rs) guarantees every run ends with exactly one —
  // "never a hang and never a bare dropped connection" is that function's
  // own doc comment — so reaching here means the connection broke, not
  // that the server chose to end the run this way. Reported the same as
  // any other broken connection, not as a distinct case the caller has to
  // handle separately. Logged for the same reason the read loop's own
  // `catch` above logs: this is the Server's contract being broken, not a
  // caller-initiated abort (an abort rejects `reader.read()` and is caught
  // above instead of ever reaching this line), so it is always worth
  // knowing about.
  console.error("reflectTransport: stream closed without an agent_end frame");
  return { ok: false, reason: "unreachable" };
}
