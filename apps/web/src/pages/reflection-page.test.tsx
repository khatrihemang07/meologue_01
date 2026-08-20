import type { Entry } from "@meologue/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes, useLocation } from "react-router";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as entryDayModule from "@/lib/entry-day";
import { useSettingsStore } from "@/lib/settings";
import type { EntryStoreOutletContext } from "@/pages/entry-store-layout";
import { ReflectionPage } from "./reflection-page";

// ReflectionPage reads the Entry store via useEntryStore() (useOutletContext)
// and passes it down to GroundingDisclosure for every rendered turn (the
// page/component layering fix: pages own data access, components take
// props), so this page needs the same EntryStoreLayout stand-in
// composer-page.test.tsx and history-page.test.tsx already use — a bare
// Outlet supplying a context of the test's choosing, in place of the real
// store-opening machinery. Defaults to no local Entries; individual tests
// override this to exercise GroundingDisclosure's lookup.
const defaultEntryStoreContext: EntryStoreOutletContext = {
  entries: [],
  sendEntry: vi.fn(),
  search: vi.fn(async () => []),
  disabled: false,
};

// Surfaces the MemoryRouter's current path so a test can assert a Session
// id landed in the URL (ADR 0025 — the URL is the only state) without
// reaching into the router's own internals.
function LocationProbe() {
  const location = useLocation();
  return <p data-testid="location-path">{location.pathname}</p>;
}

// Wrapped in a QueryClientProvider (fresh per render, same as
// history-page.test.tsx) because the Conversation now comes from a
// TanStack Query query of GET /v1/sessions/:id, not an in-memory store
// (ADR 0025). Both routes are registered — `/reflect` for a fresh Session,
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
    ...overrides,
  };
}

function ask(question: string) {
  fireEvent.change(askQuestionField(), { target: { value: question } });
  fireEvent.click(askButton());
}

/**
 * A `fetch` stub that branches on the request URL, the same shape both
 * `/v1/reflect` (POST, via reflectTransport) and `/v1/sessions/:id` (GET,
 * via sessionsTransport) go through. A test that doesn't care what a
 * background Session refetch returns can omit `session` entirely — the GET
 * then hangs forever, which is exactly what proves a rendered turn came
 * from the optimistic cache write and not from that refetch resolving.
 */
function stubFetch(options: {
  reflect: (init: RequestInit | undefined) => unknown;
  session?: (sessionId: string) => unknown;
}) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/v1/reflect")) {
      return { ok: true, status: 200, json: async () => options.reflect(init) };
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
    useSettingsStore.setState({ theme: "system", serverUrl: "" });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders persistent nav links to Composer, History and Reflect, plus a Settings action", () => {
    renderReflectionPage();

    expect(screen.getByRole("link", { name: "Composer" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "History" })).toHaveAttribute("href", "/history");
    expect(screen.getByRole("link", { name: "Reflect" })).toHaveAttribute("href", "/reflect");
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings");
  });

  // Ticket 54's acceptance criteria, extended to the third destination:
  // the current destination is visibly indicated.
  it("marks Reflect as the current destination in the persistent nav", () => {
    renderReflectionPage();

    expect(screen.getByRole("link", { name: "Reflect" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Composer" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: "History" })).not.toHaveAttribute("aria-current");
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

  it("shows a staged in-flight indicator while a Question is being answered, then renders the Answer", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    let resolveReflectFetch!: (value: unknown) => void;
    const reflectFetchPromise = new Promise((resolve) => {
      resolveReflectFetch = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.endsWith("/v1/reflect")) {
          return reflectFetchPromise;
        }
        // GET /v1/sessions/:id — hangs; irrelevant to this test.
        return new Promise(() => {});
      }),
    );

    renderReflectionPage();
    ask("How has my knee been?");

    expect(await screen.findByText("How has my knee been?")).toBeInTheDocument();
    expect(screen.getByText(/searching your entries/i)).toBeInTheDocument();
    // No turn renders until the Answer actually comes back — an in-flight
    // Question isn't a Conversation turn yet.
    expect(screen.queryByText(/it's improved since february/i)).not.toBeInTheDocument();

    resolveReflectFetch({
      ok: true,
      status: 200,
      json: async () => ({
        answer: "It's improved since February.",
        grounding_entry_ids: ["entry-1"],
        grounded: true,
        fallback_used: false,
        session_id: "session-new",
        title: "How has my knee been?",
      }),
    });

    expect(await screen.findByText("It's improved since February.")).toBeInTheDocument();
    expect(screen.queryByText(/searching your entries/i)).not.toBeInTheDocument();
  });

  it("navigates to the new Session's URL after asking with no Session, with replace so Back doesn't return to an empty /reflect", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    stubFetch({
      reflect: () => ({
        answer: "It's improved since February.",
        grounding_entry_ids: [],
        grounded: true,
        fallback_used: false,
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
        grounded: true,
        fallback_used: false,
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
              grounded: true,
              fallback_used: false,
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
        grounded: true,
        fallback_used: false,
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
              grounded: true,
              fallback_used: false,
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
        grounded: true,
        fallback_used: false,
        session_id: "session-tz",
        title: "What did I write yesterday?",
      }),
    });

    renderReflectionPage();
    ask("What did I write yesterday?");

    await waitFor(() => {
      const reflectCalls = fetchMock.mock.calls.filter(([url]) =>
        (url as string).endsWith("/v1/reflect"),
      );
      expect(reflectCalls).toHaveLength(1);
    });
    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const requestBody = JSON.parse(requestInit?.body as string);
    expect(requestBody.utc_offset_minutes).toBe(330);
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
        grounded: true,
        fallback_used: false,
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
  it("shows no note when the server judged its Grounding grounded", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    stubFetch({
      reflect: () => ({
        answer: "It's improved since February.",
        grounding_entry_ids: ["entry-1"],
        grounded: true,
        fallback_used: false,
        session_id: "session-note-1",
        title: "How has my knee been?",
      }),
    });

    renderReflectionPage();
    ask("How has my knee been?");

    expect(await screen.findByText("It's improved since February.")).toBeInTheDocument();
    expect(screen.queryByText(/nothing in your history matched/i)).not.toBeInTheDocument();
  });

  it("shows a fallback note when the server disclosed recent Entries instead of an Answer", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    stubFetch({
      reflect: () => ({
        answer: "Nothing matched, but here's what you wrote lately.",
        grounding_entry_ids: ["entry-1"],
        grounded: false,
        fallback_used: true,
        session_id: "session-note-2",
        title: "Anything about scuba diving?",
      }),
    });

    renderReflectionPage();
    ask("Anything about scuba diving?");

    expect(
      await screen.findByText("Nothing matched, but here's what you wrote lately."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /nothing in your history matched this question — this is what you wrote in the last few days/i,
      ),
    ).toBeInTheDocument();
  });

  it("shows an ungrounded note (no fallback) when nothing matched and nothing recent existed either", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    stubFetch({
      reflect: () => ({
        answer: "I couldn't find anything about that.",
        grounding_entry_ids: [],
        grounded: false,
        fallback_used: false,
        session_id: "session-note-3",
        title: "Anything about scuba diving?",
      }),
    });

    renderReflectionPage();
    ask("Anything about scuba diving?");

    expect(await screen.findByText("I couldn't find anything about that.")).toBeInTheDocument();
    const note = screen.getByText(/nothing in your history matched this question/i);
    expect(note).toBeInTheDocument();
    expect(note.textContent).not.toMatch(/last few days/i);
  });

  // Ticket 7: the disclosure beneath each turn is the only way to tell a
  // confident wrong Answer from a right one by eye — its label must carry
  // ADR 0024's grounded/fallback distinction, not just render *something*.
  // ADR 0025's acceptance criteria requires this to keep working on a
  // restored turn too, including the "hasn't reached this Device yet"
  // placeholder — this Entry is present locally, so the ordinary label path
  // is what's under test here.
  it("shows a Grounding disclosure labelled 'Grounded' for a grounded turn", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    stubFetch({
      reflect: () => ({
        answer: "It's improved since February.",
        grounding_entry_ids: ["entry-1"],
        grounded: true,
        fallback_used: false,
        session_id: "session-disclosure-1",
        title: "How has my knee been?",
      }),
    });

    renderReflectionPage("/reflect", {
      ...defaultEntryStoreContext,
      entries: [entry({ id: "entry-1", body: "Knee felt better today" })],
    });
    ask("How has my knee been?");

    expect(await screen.findByText("It's improved since February.")).toBeInTheDocument();
    expect(screen.getByText("Grounded in 1 Entry")).toBeInTheDocument();
  });

  it("shows a Grounding disclosure labelled as recent Entries, not Grounding, for a fallback turn", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    stubFetch({
      reflect: () => ({
        answer: "Nothing matched, but here's what you wrote lately.",
        grounding_entry_ids: ["entry-1"],
        grounded: false,
        fallback_used: true,
        session_id: "session-disclosure-2",
        title: "Anything about scuba diving?",
      }),
    });

    renderReflectionPage("/reflect", {
      ...defaultEntryStoreContext,
      entries: [entry({ id: "entry-1", body: "Just a regular Tuesday" })],
    });
    ask("Anything about scuba diving?");

    expect(
      await screen.findByText("Nothing matched, but here's what you wrote lately."),
    ).toBeInTheDocument();
    expect(screen.getByText("1 recent Entry")).toBeInTheDocument();
    expect(screen.queryByText(/^Grounded/)).not.toBeInTheDocument();
  });
});
