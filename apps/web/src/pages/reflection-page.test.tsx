import type { Entry } from "@meologue/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes, useLocation } from "react-router";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as entryDayModule from "@/lib/entry-day";
import { readLastSessionId, writeLastSessionId } from "@/lib/last-session";
import { useSettingsStore } from "@/lib/settings";
import type { EntryStoreOutletContext } from "@/pages/entry-store-layout";
import { ReflectionPage } from "./reflection-page";

// ReflectionPage reads the Entry store via useEntryStore() (useOutletContext)
// and passes it down to GroundingDisclosure for every rendered turn (the
// page/component layering fix: pages own data access, components take
// props), so this page needs the same EntryStoreLayout stand-in
// composer-page.test.tsx already uses — a bare Outlet supplying a context
// of the test's choosing, in place of the real store-opening machinery.
// Defaults to no local Entries; individual tests override this to exercise
// GroundingDisclosure's lookup.
const defaultEntryStoreContext: EntryStoreOutletContext = {
  entries: [],
  sendEntry: vi.fn(),
  editEntry: vi.fn(),
  removeEntry: vi.fn(),
  search: vi.fn(async () => []),
  getEntries: vi.fn(async () => []),
  pagination: { hasMore: false, fetching: false, fetchMore: vi.fn() },
  disabled: false,
};

// Surfaces the MemoryRouter's current path so a test can assert a Session
// id landed in the URL (ADR 0025 — the URL is the only state) without
// reaching into the router's own internals.
function LocationProbe() {
  const location = useLocation();
  return <p data-testid="location-path">{location.pathname}</p>;
}

// Wrapped in a QueryClientProvider (fresh per render) because the
// Conversation now comes from a TanStack Query query of GET
// /v1/sessions/:id, not an in-memory store (ADR 0025). Both routes are
// registered — `/reflect` for a fresh Session,
// `/reflect/:sessionId` for an open one — mirroring App.tsx.
function renderReflectionPage(
  initialPath = "/reflect",
  context: EntryStoreOutletContext = defaultEntryStoreContext,
) {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <LocationProbe />
        <Routes>
          <Route element={<Outlet context={context} />}>
            <Route path="/reflect" element={<ReflectionPage />} />
            <Route path="/reflect/:sessionId" element={<ReflectionPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function askQuestionField() {
  return screen.getByPlaceholderText("Ask a Question about your History");
}

function askButton() {
  return screen.getByRole("button", { name: "Ask" });
}

function entry(overrides: Partial<Entry>): Entry {
  return {
    id: "1",
    deviceId: "device-a",
    body: "hello",
    createdAt: "now",
    seq: 1,
    syncedAt: "now",
    deletedAt: null,
    ...overrides,
  };
}

function ask(question: string) {
  fireEvent.change(askQuestionField(), { target: { value: question } });
  fireEvent.click(askButton());
}

/** One SSE frame — `event: <name>\ndata: <json>\n\n` — matching what `server/src/reflect.rs`'s `sse_event` actually puts on the wire. */
function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** A streamed `fetch` `Response`-alike for `/v1/reflect` — `events` in order, each `[eventName, data]`. */
function reflectStream(events: Array<[string, unknown]>) {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const [event, data] of events) {
        controller.enqueue(encoder.encode(sseFrame(event, data)));
      }
      controller.close();
    },
  });
  return { ok: true, status: 200, body };
}

/** The common case: a single `agent_end {"status": "ok", ...}` frame, no intermediate steps — every test that only cares about the final Answer uses this. */
function reflectAnswer(response: Record<string, unknown>) {
  return reflectStream([["agent_end", { status: "ok", ...response }]]);
}

/**
 * A `fetch` stub that branches on the request URL, the same shape both
 * `/v1/reflect` (POST, via reflectTransport) and `/v1/sessions/:id` (GET,
 * via sessionsTransport) go through. A test that doesn't care what a
 * background Session refetch returns can omit `session` entirely — the GET
 * then hangs forever, which is exactly what proves a rendered turn came
 * from the optimistic cache write and not from that refetch resolving.
 *
 * Issue #98: `GET /v1/models` (this page's own picker query, fired on every
 * mount) always resolves to an empty list here — no test in this file
 * exercises the picker itself (`question-composer.test.tsx` does, in
 * isolation), so every existing assertion here keeps seeing exactly the
 * no-picker behaviour it always did, and a fixed empty response (rather
 * than the catch-all hang below) is what keeps that query from staying
 * pending — and TanStack Query retrying it — for the rest of a test's run.
 */
function stubFetch(options: {
  reflect: (init: RequestInit | undefined) => Record<string, unknown>;
  session?: (sessionId: string) => unknown;
  /** Issue #98: what `GET /v1/models` reports — empty by default, matching every test written before this ticket. */
  models?: Array<{ id: string; streaming: boolean; context_window: number | null }>;
}) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/v1/reflect")) {
      return reflectAnswer(options.reflect(init));
    }
    if (url.endsWith("/v1/models")) {
      return { ok: true, status: 200, json: async () => ({ models: options.models ?? [] }) };
    }
    const sessionId = url.match(/\/v1\/sessions\/(.+)$/)?.[1];
    const { session } = options;
    if (sessionId !== undefined && session) {
      return { ok: true, status: 200, json: async () => session(sessionId) };
    }
    return new Promise(() => {});
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function wireSession(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "session-1",
    title: "A Conversation",
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
    turns: [],
    ...overrides,
  };
}

describe("ReflectionPage", () => {
  beforeEach(() => {
    localStorage.clear();
    // Issue #80's remembered-Session backup (`last-session.ts`) lives in
    // sessionStorage, not localStorage — cleared here too so one test's
    // successful ask (which now writes to it) can't make a later test's
    // bare `/reflect` mount silently resume into the wrong Session.
    sessionStorage.clear();
    useSettingsStore.setState({ theme: "system", serverUrl: "" });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  // Issue #75: History is gone and Settings is now a fourth Nav
  // destination rather than a separate app-bar action.
  it("renders persistent nav links to Composer, Reflect, Digest and Settings", () => {
    renderReflectionPage();

    expect(screen.getByRole("link", { name: "Composer" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "Reflect" })).toHaveAttribute("href", "/reflect");
    expect(screen.getByRole("link", { name: "Digest" })).toHaveAttribute("href", "/digest");
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings");
  });

  // Ticket 54's acceptance criteria, extended to the third destination:
  // the current destination is visibly indicated.
  it("marks Reflect as the current destination in the persistent nav", () => {
    renderReflectionPage();

    expect(screen.getByRole("link", { name: "Reflect" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Composer" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: "Digest" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: "Settings" })).not.toHaveAttribute("aria-current");
  });

  // Ticket 62: Sessions is an app-bar action, not a fifth NavLink — it's
  // one level below the four Nav destinations (Composer, Reflect, Digest,
  // Settings), unchanged by issue #75 moving Settings from an app-bar
  // action into one of those four itself (see nav.tsx's own comment on
  // SessionsLink).
  it("shows a Sessions affordance in the app bar, linking to /reflect/list", () => {
    renderReflectionPage();

    expect(screen.getByRole("link", { name: "Sessions" })).toHaveAttribute("href", "/reflect/list");
  });

  it("shows a hint that Reflection needs a Server URL when Sync is off, with no Question field", () => {
    renderReflectionPage();

    expect(screen.getByText(/sync is off/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /add a server url/i })).toHaveAttribute(
      "href",
      "/settings",
    );
    expect(screen.queryByText(/ask a question about your history/i)).not.toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText("Ask a Question about your History"),
    ).not.toBeInTheDocument();
  });

  it("shows an empty-Conversation invitation and a Question field once Sync is on", () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");

    renderReflectionPage();

    expect(screen.queryByText(/sync is off/i)).not.toBeInTheDocument();
    expect(screen.getByText(/ask a question about your history/i)).toBeInTheDocument();
    expect(askQuestionField()).toBeInTheDocument();
  });

  it("shows a live in-flight indicator while a Question is being answered, then renders the Answer", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    let enqueueTurnStart!: () => void;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        enqueueTurnStart = () => controller.enqueue(encoder.encode(sseFrame("turn_start", {})));
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.endsWith("/v1/reflect")) {
          return Promise.resolve({ ok: true, status: 200, body });
        }
        // GET /v1/sessions/:id — hangs; irrelevant to this test.
        return new Promise(() => {});
      }),
    );

    renderReflectionPage();
    ask("How has my knee been?");
    enqueueTurnStart();

    expect(await screen.findByText("How has my knee been?")).toBeInTheDocument();
    expect(await screen.findByText("Thinking…")).toBeInTheDocument();
    // No turn renders until the Answer actually comes back — an in-flight
    // Question isn't a Conversation turn yet.
    expect(screen.queryByText(/it's improved since february/i)).not.toBeInTheDocument();
  });

  it("navigates to the new Session's URL after asking with no Session, with replace so Back doesn't return to an empty /reflect", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    stubFetch({
      reflect: () => ({
        answer: "It's improved since February.",
        grounding_entry_ids: [],
        session_id: "session-abc",
        title: "How has my knee been?",
      }),
    });

    renderReflectionPage();
    expect(screen.getByTestId("location-path")).toHaveTextContent("/reflect");

    ask("How has my knee been?");

    await screen.findByText("It's improved since February.");
    expect(screen.getByTestId("location-path")).toHaveTextContent("/reflect/session-abc");
  });

  it("appends the newly-answered turn to the query cache immediately, without waiting for a refetch", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    // No `session` handler: the GET this navigation triggers hangs forever,
    // so the Answer can only be on screen because it was written straight
    // into the cache, not because a refetch resolved.
    stubFetch({
      reflect: () => ({
        answer: "It's improved since February.",
        grounding_entry_ids: [],
        session_id: "session-abc",
        title: "How has my knee been?",
      }),
    });

    renderReflectionPage();
    ask("How has my knee been?");

    expect(await screen.findByText("It's improved since February.")).toBeInTheDocument();
  });

  it("restores a Conversation from the Server on mount when the URL carries a sessionId", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    const fetchMock = stubFetch({
      reflect: () => {
        throw new Error("this test never asks a Question");
      },
      session: (sessionId) =>
        wireSession({
          id: sessionId,
          title: "How has my knee been?",
          turns: [
            {
              question: "How has my knee been?",
              answer: "It's improved since February.",
              grounding_entry_ids: ["entry-1"],
              created_at: "2026-08-01T00:00:05Z",
            },
          ],
        }),
    });

    renderReflectionPage("/reflect/session-existing");

    expect(await screen.findByText("How has my knee been?")).toBeInTheDocument();
    expect(await screen.findByText("It's improved since February.")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://phone.example:41207/v1/sessions/session-existing",
    );
  });

  // Issue #99's carry-over from #96 pass 2, verified as a live-Sandbox
  // regression before this ticket fixed it: a Turn answered from a
  // `read_digest` tool call correctly showed "Answered from the month
  // Digest for ..." while the browser session that asked was still open,
  // but reloading the same Session — this test's own shape, a restore on
  // mount rather than an optimistic cache write — read back "Grounded in
  // N Entries" instead, misattributing the Answer to whatever *other* tool
  // calls in that Turn's run happened to surface Entries. The fix was
  // entirely server-side (`GET /v1/sessions/:id` now derives
  // `digest_source` from the tree — `SessionTurnRow::digest_source`'s own
  // doc comment, server/src/sessions.rs), so this test only needs to stub
  // that field on the wire and confirm the client still renders it
  // correctly with no live event stream involved at all.
  it("still says a restored Turn was answered from a Digest, not from the Entries its run also touched", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    stubFetch({
      reflect: () => {
        throw new Error("this test never asks a Question");
      },
      session: (sessionId) =>
        wireSession({
          id: sessionId,
          title: "How did the flat move go?",
          turns: [
            {
              question: "And what about the month before?",
              answer: "The month before was quieter — mostly settling in.",
              // The same shape #96 pass 2's own regression report named:
              // other tool calls in this Turn's run surfaced real Entry
              // ids, which must not be what the disclosure attributes the
              // Answer to once `digest_source` is present.
              grounding_entry_ids: ["entry-1", "entry-2"],
              tool_called: true,
              model: "codex-terra",
              digest_source: {
                period: "month",
                period_start: "2026-07-01",
                period_end: "2026-07-31",
              },
              created_at: "2026-08-01T00:00:05Z",
            },
          ],
        }),
    });

    renderReflectionPage("/reflect/session-existing");

    expect(
      await screen.findByText("The month before was quieter — mostly settling in."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Answered from the month Digest for 2026-07-01 to 2026-07-31."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^Grounded/)).not.toBeInTheDocument();
  });

  it("renders a plain not-found message for an unknown sessionId, rather than a blank page or a crash", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })),
    );

    renderReflectionPage("/reflect/session-missing");

    expect(await screen.findByText(/this conversation could not be found/i)).toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText("Ask a Question about your History"),
    ).not.toBeInTheDocument();
  });

  it("sends the Session id on a follow-up Question, with no whole-Conversation field in the request body", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    const fetchMock = stubFetch({
      reflect: () => ({
        answer: "Yes, in March.",
        grounding_entry_ids: [],
        session_id: "session-knee",
        title: "How has my knee been this year?",
      }),
      session: (sessionId) =>
        wireSession({
          id: sessionId,
          turns: [
            {
              question: "How has my knee been this year?",
              answer: "Yes, in March.",
              grounding_entry_ids: [],
              created_at: "2026-08-01T00:00:00Z",
            },
          ],
        }),
    });

    renderReflectionPage();

    ask("How has my knee been this year?");
    await screen.findByText("Yes, in March.");

    ask("Did it start with physical therapy?");
    await waitFor(() => {
      const reflectCalls = fetchMock.mock.calls.filter(([url]) =>
        (url as string).endsWith("/v1/reflect"),
      );
      expect(reflectCalls).toHaveLength(2);
    });

    const reflectCalls = fetchMock.mock.calls.filter(([url]) =>
      (url as string).endsWith("/v1/reflect"),
    );
    const firstRequestBody = JSON.parse((reflectCalls[0]?.[1] as RequestInit)?.body as string);
    expect(firstRequestBody.session_id).toBeNull();
    expect(firstRequestBody).not.toHaveProperty("prior_turns");

    const secondRequestBody = JSON.parse((reflectCalls[1]?.[1] as RequestInit)?.body as string);
    expect(secondRequestBody.session_id).toBe("session-knee");
    expect(secondRequestBody.question).toBe("Did it start with physical therapy?");
    expect(secondRequestBody).not.toHaveProperty("prior_turns");
  });

  it("posts this Device's UTC offset alongside the Question, for the server's extraction call to resolve dates against (ADR 0023, ADR 0016's precedent)", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    vi.spyOn(entryDayModule, "deviceUtcOffsetMinutes").mockReturnValue(330); // IST
    const fetchMock = stubFetch({
      reflect: () => ({
        answer: "It went well.",
        grounding_entry_ids: [],
        session_id: "session-tz",
        title: "What did I write yesterday?",
      }),
    });

    renderReflectionPage();
    ask("What did I write yesterday?");

    // Issue #98: `stubFetch` has no branch for `GET /v1/models` (this page's
    // own picker query), which falls through to its catch-all hang — so
    // that call, if it's raced in ahead of the ask, must not be mistaken
    // for the `/v1/reflect` POST this test actually cares about. Filtering
    // by URL, rather than indexing `mock.calls[0]` positionally, is what
    // keeps this test's own outcome independent of how many other requests
    // this page happens to make on mount.
    let reflectCalls: (typeof fetchMock.mock.calls)[number][] = [];
    await waitFor(() => {
      reflectCalls = fetchMock.mock.calls.filter(([url]) =>
        (url as string).endsWith("/v1/reflect"),
      );
      expect(reflectCalls).toHaveLength(1);
    });
    const requestInit = reflectCalls[0]?.[1] as RequestInit;
    const requestBody = JSON.parse(requestInit?.body as string);
    expect(requestBody.utc_offset_minutes).toBe(330);
  });

  // -- issue #98: a Conversation chooses its own model ---------------------

  it("offers the models GET /v1/models reports in the composer's own picker", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    stubFetch({
      reflect: () => ({ answer: "unused", grounding_entry_ids: [] }),
      models: [
        { id: "codex-terra", streaming: false, context_window: 272000 },
        { id: "claude-sonnet", streaming: true, context_window: 200000 },
      ],
    });

    renderReflectionPage();

    const picker = await screen.findByLabelText("Model");
    const options = Array.from(picker.querySelectorAll("option")).map(
      (option) => option.textContent,
    );
    expect(options).toEqual(["Server default", "codex-terra", "claude-sonnet"]);
  });

  it("renders no picker at all when the Server offers no models — the default case, unchanged", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    stubFetch({ reflect: () => ({ answer: "unused", grounding_entry_ids: [] }) });

    renderReflectionPage();

    await screen.findByPlaceholderText("Ask a Question about your History");
    expect(screen.queryByLabelText("Model")).not.toBeInTheDocument();
  });

  it("sends the chosen model on the wire when the picker is changed, and shows nothing chosen by default", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    const fetchMock = stubFetch({
      reflect: () => ({
        answer: "An answer from claude-sonnet.",
        grounding_entry_ids: [],
        session_id: "session-model",
        title: "What did I write about?",
        model: "claude-sonnet",
      }),
      models: [
        { id: "codex-terra", streaming: false, context_window: 272000 },
        { id: "claude-sonnet", streaming: true, context_window: 200000 },
      ],
    });

    renderReflectionPage();
    const picker = await screen.findByLabelText("Model");
    fireEvent.change(picker, { target: { value: "claude-sonnet" } });

    ask("What did I write about?");
    await screen.findByText("An answer from claude-sonnet.");

    const reflectCalls = fetchMock.mock.calls.filter(([url]) =>
      (url as string).endsWith("/v1/reflect"),
    );
    const requestBody = JSON.parse((reflectCalls[0]?.[1] as RequestInit)?.body as string);
    expect(requestBody.model).toBe("claude-sonnet");
  });

  it("reads back each turn attributed to the model that actually produced it", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    stubFetch({
      reflect: () => ({ answer: "unused", grounding_entry_ids: [] }),
      session: (sessionId) =>
        wireSession({
          id: sessionId,
          turns: [
            {
              question: "How has my knee been?",
              answer: "It's improved since February.",
              grounding_entry_ids: [],
              tool_called: true,
              model: "codex-terra",
              created_at: "2026-08-01T00:00:00Z",
            },
            {
              question: "And after physical therapy?",
              answer: "Even better.",
              grounding_entry_ids: [],
              tool_called: true,
              model: "claude-sonnet",
              created_at: "2026-08-01T00:00:05Z",
            },
          ],
        }),
    });

    renderReflectionPage("/reflect/session-existing");

    expect(await screen.findByText("It's improved since February.")).toBeInTheDocument();
    expect(screen.getByText("codex-terra")).toBeInTheDocument();
    expect(screen.getByText("claude-sonnet")).toBeInTheDocument();
  });

  it("shows a distinct hint when the Server 404s (doesn't support Reflection yet), starting no Session", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })),
    );

    renderReflectionPage();
    ask("Anything?");

    expect(await screen.findByText(/doesn't support reflection yet/i)).toBeInTheDocument();
    expect(screen.getByTestId("location-path")).toHaveTextContent("/reflect");
  });

  it("shows a distinct hint when the Device's protocol_version is stale (426), the same as a 404", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 426, json: async () => ({}) })),
    );

    renderReflectionPage();
    ask("Anything?");

    expect(await screen.findByText(/doesn't support reflection yet/i)).toBeInTheDocument();
  });

  it("shows an error toast on a network failure, starting no Session", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const errorToast = vi.spyOn(toast, "error");

    renderReflectionPage();
    ask("Anything?");

    await waitFor(() => expect(errorToast).toHaveBeenCalled());
    expect(screen.getByTestId("location-path")).toHaveTextContent("/reflect");
  });

  // Issue #96's subtlest change: a failed run is now agent_end
  // {"status": "error"} on a 200 response, not a 500 — the stream itself
  // succeeded; the run inside it didn't. It must still render as a
  // failure and restore the Question, exactly like any other failure —
  // and issue #102 guarantees the server persisted nothing for this run,
  // so no Turn must appear for it either.
  it("treats agent_end {status: error} as a failure — restores the Question, shows no Turn, starts no Session", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/v1/reflect")) {
          return reflectStream([
            ["agent_end", { status: "error", error: "the chat endpoint failed" }],
          ]);
        }
        return new Promise(() => {});
      }),
    );
    const errorToast = vi.spyOn(toast, "error");

    renderReflectionPage();
    ask("How did the flat move go?");

    await waitFor(() => expect(errorToast).toHaveBeenCalled());
    expect(askQuestionField()).toHaveValue("How did the flat move go?");
    // No Turn ever rendered for this run — issue #102's guarantee (nothing
    // was persisted) means there's nothing to show, only the Question back
    // in the composer's own input (a <textarea>, asserted above), never as
    // a rendered <p> bubble in the thread the way a real Turn's
    // AskedQuestion would show it.
    expect(
      screen.queryByText("How did the flat move go?", { selector: "p" }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("location-path")).toHaveTextContent("/reflect");
  });

  // A Question is the user's own words and, unlike an Entry, was never
  // written down anywhere else — so a failure must not swallow it. Found on
  // a real device: the chat backend was down, the Question disappeared, and
  // all that was left was a toast that faded.
  it("puts a Question back in the composer when it fails, rather than losing it", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    vi.spyOn(toast, "error");

    renderReflectionPage();
    ask("How did the flat move go?");

    await waitFor(() => expect(askQuestionField()).toHaveValue("How did the flat move go?"));
  });

  it("restores a Question that fails twice in a row", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    vi.spyOn(toast, "error");

    renderReflectionPage();
    ask("Anything?");
    await waitFor(() => expect(askQuestionField()).toHaveValue("Anything?"));

    // Re-asking the identical text must restore it again — which is why the
    // restore is keyed on a changing signal and not on the text.
    fireEvent.click(askButton());
    await waitFor(() => expect(askQuestionField()).toHaveValue("Anything?"));
  });

  it("does not restore anything after a Question succeeds", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    stubFetch({
      reflect: () => ({
        answer: "It went well.",
        grounding_entry_ids: [],
        session_id: "session-move",
        title: "How did the flat move go?",
      }),
    });

    renderReflectionPage();
    ask("How did the flat move go?");

    expect(await screen.findByText("It went well.")).toBeInTheDocument();
    expect(askQuestionField()).toHaveValue("");
  });

  // Ticket 6 (ADR 0024): an explicit note per turn, independent of the
  // Answer's own wording, so the user can tell a real Answer from a
  // confident wrong one without trusting how the model phrased itself.
  it("shows no note when the tools returned at least one Entry", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    stubFetch({
      reflect: () => ({
        answer: "It's improved since February.",
        grounding_entry_ids: ["entry-1"],
        session_id: "session-note-1",
        title: "How has my knee been?",
      }),
    });

    renderReflectionPage();
    ask("How has my knee been?");

    expect(await screen.findByText("It's improved since February.")).toBeInTheDocument();
    expect(screen.queryByText(/nothing in your history matched/i)).not.toBeInTheDocument();
  });

  it("shows an ungrounded note when a tool ran and genuinely found nothing", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    stubFetch({
      reflect: () => ({
        answer: "I couldn't find anything about that.",
        grounding_entry_ids: [],
        // Issue #103: explicit, not this fixture's usual omission — this
        // test is specifically about the "a tool ran and found nothing"
        // outcome, distinct from `tool_called: false` below, which is a
        // different situation with its own caption now.
        tool_called: true,
        session_id: "session-note-3",
        title: "Anything about scuba diving?",
      }),
    });

    renderReflectionPage();
    ask("Anything about scuba diving?");

    expect(await screen.findByText("I couldn't find anything about that.")).toBeInTheDocument();
    const note = screen.getByText(/nothing in your history matched this question/i);
    expect(note).toBeInTheDocument();
    expect(note.textContent).not.toMatch(/without checking/i);
  });

  // Carry-over #2 recorded on issue #99, confirmed live on the Sandbox:
  // since issue #92 removed MIN_SIMILARITY, `similar_entries` returns its
  // top-k for *every* Question, including one about a topic absent from
  // the journal — so a non-empty `grounding_entry_ids` under an Answer
  // that plainly says nothing was found is now the *common* shape, not an
  // edge case. Before this fix, the disclosure still read "Grounded in N
  // Entries" here — an on-screen contradiction directly beneath an Answer
  // saying the opposite, because `groundingOutcome`/`summaryLabel` treated
  // "the tools returned Entries" as "the Answer is grounded in them," a
  // verdict the Server cannot make under the loop (this ticket's own
  // module doc comment on `server/src/reflect.rs`). The fix is wording,
  // not data: the disclosure must say what the list honestly is — Entries
  // the tools returned — never that the Answer is grounded in them.
  it("does not claim the Answer is grounded in Entries the tools returned but the model said it found nothing in", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    stubFetch({
      reflect: () => ({
        answer:
          "I couldn't find a journal entry about a football match, so I can't tell what you thought of it.",
        grounding_entry_ids: Array.from({ length: 10 }, (_, i) => `entry-${i}`),
        tool_called: true,
        session_id: "session-absent-topic",
        title: "What did I think of the football match?",
      }),
    });

    renderReflectionPage();
    ask("What did I think of the football match?");

    expect(
      await screen.findByText(
        "I couldn't find a journal entry about a football match, so I can't tell what you thought of it.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^Grounded in/)).not.toBeInTheDocument();
    expect(screen.getByText("10 Entries returned")).toBeInTheDocument();
  });

  // Issue #103: the case that used to be indistinguishable from the one
  // just above — before `tool_called` existed on the wire, a run that
  // never looked and a run that looked and found nothing both rendered the
  // exact same "Nothing in your History matched this Question." caption.
  // This is the live bug's own report, replayed as a client test: a
  // confident denial of access must not read like an ordinary empty
  // search.
  it("shows a distinct note when the run never called a tool at all", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    stubFetch({
      reflect: () => ({
        answer: "I can't access any journal entries from here.",
        grounding_entry_ids: [],
        tool_called: false,
        session_id: "session-note-4",
        title: "How is my knee doing?",
      }),
    });

    renderReflectionPage();
    ask("How is my knee doing?");

    expect(
      await screen.findByText("I can't access any journal entries from here."),
    ).toBeInTheDocument();
    const note = screen.getByText(/answered without checking your history/i);
    expect(note).toBeInTheDocument();
    // Must not be findable via the "nothingFound" caption's own wording —
    // the two outcomes render different sentences now, not the same one
    // with an extra word.
    expect(screen.queryByText(/nothing in your history matched this question/i)).toBeNull();
  });

  // Ticket 7: the disclosure beneath each turn is the only way to tell a
  // confident wrong Answer from a right one by eye — its label must show
  // what the tools actually returned, not just render *something*. ADR
  // 0025's acceptance criteria requires this to keep working on a restored
  // turn too, including the "hasn't reached this Device yet" placeholder —
  // this Entry is present locally, so the ordinary label path is what's
  // under test here.
  it("shows a Grounding disclosure labelled 'Grounded' for a grounded turn", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    stubFetch({
      reflect: () => ({
        answer: "It's improved since February.",
        grounding_entry_ids: ["entry-1"],
        session_id: "session-disclosure-1",
        title: "How has my knee been?",
      }),
    });

    renderReflectionPage("/reflect", {
      ...defaultEntryStoreContext,
      getEntries: vi.fn(async () => [entry({ id: "entry-1", body: "Knee felt better today" })]),
    });
    ask("How has my knee been?");

    expect(await screen.findByText("It's improved since February.")).toBeInTheDocument();
    expect(screen.getByText("1 Entry returned")).toBeInTheDocument();
  });

  // Issue #96: steps appear live, in order, as the harness reports them —
  // and a multi-step Question (several tool calls before the Answer) shows
  // each one, not just the last.
  describe("live steps", () => {
    // Regression, #96: the step label pluralized with a naive `+ "s"`, so a
    // real run rendered "20 Entrys". Every test above this one happened to
    // use a count of 1 — the single value where a naive pluralizer and the
    // correct one agree — which is exactly why 502 passing tests did not
    // catch it, and why this asserts a count greater than one on purpose.
    // Found by driving the real app, not by a test.
    it("says Entries, not Entrys, when a tool call returns more than one", async () => {
      useSettingsStore.getState().setServerUrl("https://phone.example:41207");
      let push!: (event: [string, unknown]) => void;
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          push = (event) => controller.enqueue(encoder.encode(sseFrame(event[0], event[1])));
        },
      });
      vi.stubGlobal(
        "fetch",
        vi.fn((url: string) => {
          if (url.endsWith("/v1/reflect")) {
            return Promise.resolve({ ok: true, status: 200, body });
          }
          return new Promise(() => {});
        }),
      );

      renderReflectionPage();
      ask("How did the flat move go?");

      push(["turn_start", {}]);
      push(["message_start", {}]);
      push(["message_end", { text: "", stop_reason: "tool_use" }]);
      push([
        "tool_execution_start",
        {
          tool_call_id: "call-1",
          tool_name: "similar_entries",
          arguments: { query: "moving flat" },
        },
      ]);
      push([
        "tool_execution_end",
        {
          tool_call_id: "call-1",
          tool_name: "similar_entries",
          is_error: false,
          details: {},
          entry_ids: ["entry-1", "entry-2"],
          entry_count: 20,
        },
      ]);

      await screen.findByText(
        'Searched your Entries by meaning for "moving flat" — 20 Entries found.',
      );
    });

    it("shows each of a multi-step Question's tool calls, in order, then the Answer", async () => {
      useSettingsStore.getState().setServerUrl("https://phone.example:41207");
      let push!: (event: [string, unknown]) => void;
      let close!: () => void;
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          push = (event) => controller.enqueue(encoder.encode(sseFrame(event[0], event[1])));
          close = () => controller.close();
        },
      });
      vi.stubGlobal(
        "fetch",
        vi.fn((url: string) => {
          if (url.endsWith("/v1/reflect")) {
            return Promise.resolve({ ok: true, status: 200, body });
          }
          return new Promise(() => {});
        }),
      );

      renderReflectionPage();
      ask("How does this knee compare to last year?");

      // First loop turn: the model calls search_entries.
      push(["turn_start", {}]);
      push(["message_start", {}]);
      push(["message_end", { text: "", stop_reason: "tool_use" }]);
      push([
        "tool_execution_start",
        { tool_call_id: "call-1", tool_name: "search_entries", arguments: { query: "knee" } },
      ]);
      await screen.findByText('Searching your Entries for "knee"…');
      push([
        "tool_execution_end",
        {
          tool_call_id: "call-1",
          tool_name: "search_entries",
          is_error: false,
          details: {},
          entry_ids: ["entry-1"],
          entry_count: 1,
        },
      ]);
      await screen.findByText('Searched your Entries for "knee" — 1 Entry found.');

      // Second loop turn: the model calls entries_in_range too.
      push(["turn_start", {}]);
      push(["message_start", {}]);
      push(["message_end", { text: "", stop_reason: "tool_use" }]);
      push([
        "tool_execution_start",
        {
          tool_call_id: "call-2",
          tool_name: "entries_in_range",
          arguments: { from: "2025-08-01", to: "2025-08-31" },
        },
      ]);
      await screen.findByText("Looking through Entries from 2025-08-01 to 2025-08-31…");
      push([
        "tool_execution_end",
        {
          tool_call_id: "call-2",
          tool_name: "entries_in_range",
          is_error: false,
          details: {},
          entry_ids: ["entry-2"],
          entry_count: 1,
        },
      ]);
      await screen.findByText(
        "Looked through Entries from 2025-08-01 to 2025-08-31 — 1 Entry found.",
      );

      // Both finished steps are still on screen together, in the order
      // they happened — not just the most recent one.
      expect(
        screen.getByText('Searched your Entries for "knee" — 1 Entry found.'),
      ).toBeInTheDocument();
      expect(
        screen.getByText("Looked through Entries from 2025-08-01 to 2025-08-31 — 1 Entry found."),
      ).toBeInTheDocument();

      // Third loop turn: the final Answer.
      push(["turn_start", {}]);
      push(["message_start", {}]);
      push(["message_end", { text: "It's improved since last year.", stop_reason: "stop" }]);
      push([
        "agent_end",
        {
          status: "ok",
          session_id: "session-multi",
          title: "How does this knee compare to last year?",
          answer: "It's improved since last year.",
          grounding_entry_ids: ["entry-1", "entry-2"],
        },
      ]);
      close();

      expect(await screen.findByText("It's improved since last year.")).toBeInTheDocument();
    });

    it("shows the streamed Answer growing from message_update deltas before agent_end arrives", async () => {
      useSettingsStore.getState().setServerUrl("https://phone.example:41207");
      let push!: (event: [string, unknown]) => void;
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          push = (event) => controller.enqueue(encoder.encode(sseFrame(event[0], event[1])));
        },
      });
      vi.stubGlobal(
        "fetch",
        vi.fn((url: string) => {
          if (url.endsWith("/v1/reflect")) {
            return Promise.resolve({ ok: true, status: 200, body });
          }
          return new Promise(() => {});
        }),
      );

      renderReflectionPage();
      ask("How has my knee been?");

      push(["turn_start", {}]);
      push(["message_start", {}]);
      push(["message_update", { delta: "It's " }]);
      push(["message_update", { delta: "improved." }]);

      expect(await screen.findByText("It's improved.")).toBeInTheDocument();
    });

    // Accessibility (issue #96's own acceptance criterion): steps are
    // announced to assistive technology, but the streamed Answer must not
    // be narrated character by character — the two need different
    // aria-live treatment, not the same region.
    it("marks the steps list aria-live, but the streaming Answer carries no aria-live at all", async () => {
      useSettingsStore.getState().setServerUrl("https://phone.example:41207");
      let push!: (event: [string, unknown]) => void;
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          push = (event) => controller.enqueue(encoder.encode(sseFrame(event[0], event[1])));
        },
      });
      vi.stubGlobal(
        "fetch",
        vi.fn((url: string) => {
          if (url.endsWith("/v1/reflect")) {
            return Promise.resolve({ ok: true, status: 200, body });
          }
          return new Promise(() => {});
        }),
      );

      renderReflectionPage();
      ask("How has my knee been?");
      push(["turn_start", {}]);

      const thinking = await screen.findByText("Thinking…");
      const stepsRegion = thinking.closest("ul");
      expect(stepsRegion).not.toBeNull();
      expect(stepsRegion).toHaveAttribute("aria-live", "polite");

      push(["message_start", {}]);
      push(["message_update", { delta: "It's " }]);
      push(["message_update", { delta: "improved." }]);

      const answerParagraph = await screen.findByText("It's improved.");
      expect(answerParagraph).not.toHaveAttribute("aria-live");
      // Nor does any ancestor up to the steps region's own parent — the
      // Answer paragraph is a plain, non-live sibling of the steps list,
      // not nested inside its live region.
      expect(answerParagraph.closest("[aria-live]")).toBeNull();
    });
  });

  // Issue #80: leaving Reflect for Composer and coming back must land on
  // the same Conversation, not a blank one — the defect this ticket fixes.
  // "Navigating away" is modelled by unmounting this render entirely
  // (Composer lives in a different route, so it always fully unmounts
  // Reflect) and mounting a fresh one at a bare `/reflect`, the same shape
  // the persistent Nav's plain `to="/reflect"` link produces.
  it("resumes the same Conversation after navigating away and back to a bare /reflect", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    stubFetch({
      reflect: () => ({
        answer: "It's improved since February.",
        grounding_entry_ids: [],
        session_id: "session-abc",
        title: "How has my knee been?",
      }),
      session: (sessionId) =>
        wireSession({
          id: sessionId,
          title: "How has my knee been?",
          turns: [
            {
              question: "How has my knee been?",
              answer: "It's improved since February.",
              grounding_entry_ids: [],
              created_at: "2026-08-01T00:00:05Z",
            },
          ],
        }),
    });

    const { unmount } = renderReflectionPage();
    ask("How has my knee been?");
    await screen.findByText("It's improved since February.");
    expect(screen.getByTestId("location-path")).toHaveTextContent("/reflect/session-abc");
    unmount();

    renderReflectionPage("/reflect");

    expect(await screen.findByText("How has my knee been?")).toBeInTheDocument();
    expect(await screen.findByText("It's improved since February.")).toBeInTheDocument();
    expect(screen.getByTestId("location-path")).toHaveTextContent("/reflect/session-abc");
  });

  // A reload is a fresh mount at the *explicit* URL the reload kept
  // (unlike the Nav's bare `/reflect` link) — ADR 0025's "the URL is the
  // only state" must still hold: the remembered id is a fallback for a
  // bare `/reflect`, never an override of an id already in the URL.
  it("still restores the Conversation on a reload of /reflect/<id>, even with a different Session remembered", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    writeLastSessionId("session-other");
    const fetchMock = stubFetch({
      reflect: () => {
        throw new Error("this test never asks a Question");
      },
      session: (sessionId) =>
        wireSession({
          id: sessionId,
          title: "Explicit Session",
          turns: [
            {
              question: "Explicit Question",
              answer: "Explicit Answer",
              grounding_entry_ids: [],
              created_at: "2026-08-01T00:00:00Z",
            },
          ],
        }),
    });

    renderReflectionPage("/reflect/session-explicit");

    expect(await screen.findByText("Explicit Question")).toBeInTheDocument();
    expect(screen.getByTestId("location-path")).toHaveTextContent("/reflect/session-explicit");
    // The remembered id is never even fetched — the URL's own id wins outright.
    expect(fetchMock.mock.calls.some(([url]) => (url as string).includes("session-other"))).toBe(
      false,
    );
  });

  it("New Session starts an empty Conversation, and the resume does not immediately undo it", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    stubFetch({
      reflect: () => ({
        answer: "It's improved since February.",
        grounding_entry_ids: [],
        session_id: "session-abc",
        title: "How has my knee been?",
      }),
      session: (sessionId) =>
        wireSession({
          id: sessionId,
          turns: [
            {
              question: "How has my knee been?",
              answer: "It's improved since February.",
              grounding_entry_ids: [],
              created_at: "2026-08-01T00:00:05Z",
            },
          ],
        }),
    });

    renderReflectionPage();
    ask("How has my knee been?");
    await screen.findByText("It's improved since February.");
    expect(screen.getByTestId("location-path")).toHaveTextContent("/reflect/session-abc");

    fireEvent.click(screen.getByRole("link", { name: "New Session" }));

    expect(await screen.findByText(/ask a question about your history/i)).toBeInTheDocument();
    expect(screen.getByTestId("location-path")).toHaveTextContent("/reflect");
    expect(screen.queryByText("How has my knee been?")).not.toBeInTheDocument();

    // Give the resume effect a chance to run — it must not bounce this
    // deliberate bare /reflect back to the Session just left.
    await waitFor(() => {
      expect(screen.getByTestId("location-path")).toHaveTextContent("/reflect");
    });
    expect(screen.getByText(/ask a question about your history/i)).toBeInTheDocument();
  });

  it("silently starts a fresh, empty Reflection when the remembered Session was deleted elsewhere, without looping", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    writeLastSessionId("session-gone");
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/v1/sessions/session-gone")) {
        return { ok: false, status: 404, json: async () => ({}) };
      }
      // Anything else (a second fetch of the same id, a reflect call) is
      // not expected in this test — hanging makes an unwanted extra call
      // show up as a stuck `findByText` rather than passing accidentally.
      return new Promise(() => {});
    });
    vi.stubGlobal("fetch", fetchMock);

    renderReflectionPage("/reflect");

    expect(await screen.findByText(/ask a question about your history/i)).toBeInTheDocument();
    expect(screen.getByTestId("location-path")).toHaveTextContent("/reflect");
    expect(screen.queryByText(/could not be found/i)).not.toBeInTheDocument();
    expect(readLastSessionId()).toBeNull();

    // Exactly one fetch for the dead Session — clearing the memory before
    // redirecting is what stops this looping back into the same 404.
    expect(
      fetchMock.mock.calls.filter(([url]) => (url as string).endsWith("/v1/sessions/session-gone")),
    ).toHaveLength(1);
  });

  it("shows a plain not-found message (not the silent fresh-Reflection path) for a dead Session that wasn't the remembered one", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    writeLastSessionId("session-remembered");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })),
    );

    renderReflectionPage("/reflect/session-missing");

    expect(await screen.findByText(/this conversation could not be found/i)).toBeInTheDocument();
    // The memory is untouched — this 404 was for a different id entirely.
    expect(readLastSessionId()).toBe("session-remembered");
  });

  it("keeps Reflection working when sessionStorage throws", async () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(window, "sessionStorage");
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      get() {
        throw new Error("storage disabled");
      },
    });

    try {
      useSettingsStore.getState().setServerUrl("https://phone.example:41207");
      stubFetch({
        reflect: () => ({
          answer: "It's improved since February.",
          grounding_entry_ids: [],
          session_id: "session-abc",
          title: "How has my knee been?",
        }),
      });

      renderReflectionPage();
      ask("How has my knee been?");

      expect(await screen.findByText("It's improved since February.")).toBeInTheDocument();
      expect(screen.getByTestId("location-path")).toHaveTextContent("/reflect/session-abc");
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(window, "sessionStorage", originalDescriptor);
      }
    }
  });
});
