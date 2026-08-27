import type { WireReflectRequest } from "@meologue/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "@/lib/settings";
import { type ReflectStreamEvent, reflectTransport } from "./reflect-transport";

const request: WireReflectRequest = {
  protocol_version: 1,
  question: "How has my knee been this year?",
  session_id: null,
};

/**
 * Builds a fake `fetch` `Response`-alike whose `.body` is a real
 * `ReadableStream<Uint8Array>` — the same shape the browser hands
 * `reflectTransport`. `chunks` are fed to the reader in order, one
 * `reader.read()` resolution per array element, so a test controls exactly
 * where a real network read would have split the bytes — including mid
 * `data:` line, and mid frame-separator.
 */
function streamedResponse(
  chunks: string[],
  options: { status?: number; ok?: boolean } = {},
): { ok: boolean; status: number; body: ReadableStream<Uint8Array> } {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return { ok: options.ok ?? true, status: options.status ?? 200, body };
}

/** One SSE frame: `event: <name>\ndata: <json>\n\n` — matching `server/tests/reflect.rs`'s own `parse_sse_events` counterpart exactly. */
function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function agentEndOk(overrides: Partial<Record<string, unknown>> = {}) {
  return frame("agent_end", {
    status: "ok",
    session_id: "session-1",
    title: "How has my knee been this year?",
    answer: "Your knee has improved since February.",
    grounding_entry_ids: ["entry-1"],
    grounded: true,
    fallback_used: false,
    ...overrides,
  });
}

describe("reflectTransport", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    useSettingsStore.setState({ serverUrl: "" });
  });

  it("posts the request to the stored Server URL's /v1/reflect", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    const fetchMock = vi.fn(async () => streamedResponse([agentEndOk()]));
    vi.stubGlobal("fetch", fetchMock);

    const result = await reflectTransport(request);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://phone.example:41207/v1/reflect",
      expect.objectContaining({ method: "POST", body: JSON.stringify(request) }),
    );
    expect(result).toEqual({
      ok: true,
      response: {
        session_id: "session-1",
        title: "How has my knee been this year?",
        answer: "Your knee has improved since February.",
        grounding_entry_ids: ["entry-1"],
        grounded: true,
        fallback_used: false,
      },
    });
  });

  it("reports every frame in order via onEvent, before the terminal agent_end resolves the promise", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        streamedResponse([
          frame("turn_start", {}),
          frame("message_start", {}),
          frame("message_end", { text: "", stop_reason: "tool_use" }),
          frame("tool_execution_start", {
            tool_call_id: "call-1",
            tool_name: "search_entries",
            arguments: { query: "knee" },
          }),
          frame("tool_execution_end", {
            tool_call_id: "call-1",
            tool_name: "search_entries",
            is_error: false,
            details: { query: "knee", entries: [] },
            entry_ids: ["entry-1"],
            entry_count: 1,
          }),
          frame("turn_start", {}),
          frame("message_start", {}),
          frame("message_end", { text: "Your knee has improved.", stop_reason: "stop" }),
          agentEndOk({ answer: "Your knee has improved." }),
        ]),
      ),
    );

    const events: ReflectStreamEvent[] = [];
    const result = await reflectTransport(request, { onEvent: (event) => events.push(event) });

    expect(result.ok).toBe(true);
    expect(events.map((event) => event.type)).toEqual([
      "turn_start",
      "message_start",
      "message_end",
      "tool_execution_start",
      "tool_execution_end",
      "turn_start",
      "message_start",
      "message_end",
    ]);
    const toolEnd = events[4];
    expect(toolEnd).toMatchObject({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "search_entries",
      isError: false,
      entryIds: ["entry-1"],
      entryCount: 1,
    });
  });

  // The case that breaks a naive "decode the chunk, split on \n\n"
  // implementation: a single SSE frame's bytes split across two separate
  // `reader.read()` resolutions, mid `data:` line.
  it("parses a frame whose data: line is split across two reads", async () => {
    const whole = frame("message_end", {
      text: "Your knee has improved since February.",
      stop_reason: "stop",
    });
    const splitPoint = whole.indexOf("improved");
    const firstChunk = whole.slice(0, splitPoint);
    const secondChunk = whole.slice(splitPoint);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => streamedResponse([firstChunk, secondChunk, agentEndOk()])),
    );

    const events: ReflectStreamEvent[] = [];
    await reflectTransport(request, { onEvent: (event) => events.push(event) });

    expect(events).toEqual([
      { type: "message_end", text: "Your knee has improved since February.", stopReason: "stop" },
    ]);
  });

  // The frame separator itself (the blank line between two frames) can
  // just as easily fall on a chunk boundary as anywhere inside one frame.
  it("parses two frames whose \\n\\n separator is split across two reads", async () => {
    const first = frame("turn_start", {});
    const second = frame("message_start", {});
    const combined = first + second;
    const splitPoint = first.length - 1; // inside first's own trailing \n\n
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        streamedResponse([combined.slice(0, splitPoint), combined.slice(splitPoint), agentEndOk()]),
      ),
    );

    const events: ReflectStreamEvent[] = [];
    await reflectTransport(request, { onEvent: (event) => events.push(event) });

    expect(events.map((event) => event.type)).toEqual(["turn_start", "message_start"]);
  });

  it("reports an agent_end carrying status: error as a distinct agent-error reason, not unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        streamedResponse([
          frame("turn_start", {}),
          frame("agent_end", { status: "error", error: "the chat endpoint returned a 500" }),
        ]),
      ),
    );

    const events: ReflectStreamEvent[] = [];
    const result = await reflectTransport(request, { onEvent: (event) => events.push(event) });

    expect(result).toEqual({
      ok: false,
      reason: "agent-error",
      error: "the chat endpoint returned a 500",
    });
    // The failure event itself was still reported before the terminal frame.
    expect(events.map((event) => event.type)).toEqual(["turn_start"]);
  });

  it("reports a stream that closes with no agent_end at all as unreachable, not a hang or a throw", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => streamedResponse([frame("turn_start", {}), frame("message_start", {})])),
    );

    const result = await reflectTransport(request);

    expect(result).toEqual({ ok: false, reason: "unreachable" });
  });

  // A real `fetch`'s body reads reject once `init.signal` aborts — this
  // stand-in reproduces exactly that (a `reader.read()` that never
  // resolves on its own, only rejects when the signal fires) with a hand-
  // rolled reader instead of a real `ReadableStream`, so the assertions
  // below can pin down precisely what `reflectTransport`'s own read loop
  // does with that rejection: resolve `unreachable`, call `reader.cancel`,
  // and report no further events.
  it("aborts the in-flight stream and resolves gracefully when the caller's signal fires", async () => {
    const controller = new AbortController();
    let rejectRead: ((reason: unknown) => void) | null = null;
    const cancel = vi.fn(async () => undefined);
    const fakeBody = {
      getReader: () => ({
        read: () =>
          new Promise((_resolve, reject) => {
            rejectRead = reject;
          }),
        cancel,
      }),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        init?.signal?.addEventListener("abort", () => {
          rejectRead?.(new DOMException("This operation was aborted", "AbortError"));
        });
        return Promise.resolve({ ok: true, status: 200, body: fakeBody });
      }),
    );

    const events: ReflectStreamEvent[] = [];
    const resultPromise = reflectTransport(request, {
      signal: controller.signal,
      onEvent: (event) => events.push(event),
    });

    // `reflectTransport` reaches its first `reader.read()` call only after
    // a few of its own `await`s (`serverRequest`'s fetch, then this
    // function's own) — wait for that to actually happen before aborting,
    // rather than assuming a fixed number of microtask ticks.
    await vi.waitFor(() => {
      if (rejectRead === null) {
        throw new Error("reader.read() has not been called yet");
      }
    });
    controller.abort();
    const result = await resultPromise;

    expect(result).toEqual({ ok: false, reason: "unreachable" });
    expect(cancel).toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("reports a 404 as 'not-supported' — this Server predates Reflection", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404, body: null })),
    );

    const result = await reflectTransport(request);

    expect(result).toEqual({ ok: false, reason: "not-supported" });
  });

  it("reports a 426 as 'not-supported' — this Device's protocol_version is stale", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 426, body: null })),
    );

    const result = await reflectTransport(request);

    expect(result).toEqual({ ok: false, reason: "not-supported" });
  });

  it("reports a non-404/426 failure status as 'unreachable', without throwing", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, body: null })),
    );

    const result = await reflectTransport(request);

    expect(result).toEqual({ ok: false, reason: "unreachable" });
  });

  it("reports a network failure (a thrown fetch) as 'unreachable', without throwing", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    const result = await reflectTransport(request);

    expect(result).toEqual({ ok: false, reason: "unreachable" });
  });

  it("re-reads the stored URL on every call, without re-importing the module", async () => {
    const fetchMock = vi.fn(async () => streamedResponse([agentEndOk()]));
    vi.stubGlobal("fetch", fetchMock);

    useSettingsStore.getState().setServerUrl("https://first.example");
    await reflectTransport(request);

    useSettingsStore.getState().setServerUrl("https://second.example");
    await reflectTransport(request);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://first.example/v1/reflect",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://second.example/v1/reflect",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
