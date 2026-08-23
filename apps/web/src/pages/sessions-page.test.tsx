import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes, useLocation } from "react-router";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readLastSessionId, writeLastSessionId } from "@/lib/last-session";
import { useSettingsStore } from "@/lib/settings";
import type { EntryStoreOutletContext } from "@/pages/entry-store-layout";
import { SessionsPage } from "./sessions-page";

// SessionsPage lives inside EntryStoreLayout in App.tsx alongside the other
// `/reflect*` routes, even though it reads nothing from the Entry store
// itself — mirroring the real route tree, the same
// hand-built-Outlet-context stand-in composer-page.test.tsx and
// reflection-page.test.tsx already use in place of the real
// store-opening machinery.
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

function LocationProbe() {
  const location = useLocation();
  return <p data-testid="location-path">{location.pathname}</p>;
}

function renderSessionsPage(initialEntries: string[] = ["/reflect/list"]) {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={initialEntries}>
        <LocationProbe />
        <Routes>
          <Route element={<Outlet context={defaultEntryStoreContext} />}>
            <Route path="/reflect/list" element={<SessionsPage />} />
            <Route path="/reflect/:sessionId" element={<p>opened session</p>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function stubSessionsFetch(sessions: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, json: async () => sessions })),
  );
}

type DeleteOutcome = "ok" | "not-found" | "server-error" | "network-error";

/**
 * A stateful fetch stub good for both `GET /v1/sessions` and
 * `DELETE /v1/sessions/:id`: a successful delete actually removes the
 * Session from the list this same mock serves next, so
 * "the row disappears" can be asserted the same way the real app shows it
 * — through the list query re-fetching after the mutation's own
 * `invalidateQueries` — rather than by asserting on the mutation call
 * alone.
 */
function stubSessionsFetchWithDelete(
  initialSessions: { id: string; title: string; created_at: string; updated_at: string }[],
  deleteOutcome: DeleteOutcome = "ok",
) {
  let sessions = [...initialSessions];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "DELETE") {
      if (deleteOutcome === "network-error") {
        throw new Error("network down");
      }
      if (deleteOutcome === "not-found") {
        // A 404 means the Server no longer has this Session — almost always
        // because another Device deleted it (ADR 0025). So the row really is
        // gone server-side, and the refetch must reflect that; returning it
        // again would model a Server that 404s on a row it still lists.
        const goneId = url.split("/").pop();
        sessions = sessions.filter((session) => session.id !== goneId);
        return { ok: false, status: 404, json: async () => ({}) };
      }
      if (deleteOutcome === "server-error") {
        return { ok: false, status: 500, json: async () => ({}) };
      }
      const id = url.split("/").pop();
      sessions = sessions.filter((session) => session.id !== id);
      return { ok: true, status: 204, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => sessions };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/**
 * Issue #64: a fetch stub whose `GET /v1/sessions` response depends on the
 * request's own `?q=` — keyed by the exact (decoded) query string, `""` for
 * "no `q`, or blank". This is deliberately not a re-implementation of the
 * Server's `ILIKE` matching (`server/tests/sessions.rs` already covers
 * that); it exists to prove the page's own wiring: that typing changes what
 * gets requested and rendered, and that the request is built and decoded
 * correctly on a round trip.
 */
function stubSessionsFetchByQuery(
  responses: Record<
    string,
    { id: string; title: string; created_at: string; updated_at: string }[]
  >,
) {
  const fetchMock = vi.fn(async (url: string) => {
    const q = new URL(url).searchParams.get("q") ?? "";
    return { ok: true, status: 200, json: async () => responses[q] ?? [] };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function openSearch() {
  fireEvent.click(screen.getByRole("button", { name: "Search Sessions" }));
}

const oneSession = {
  id: "session-1",
  title: "How has my knee been?",
  created_at: "2026-08-01T00:00:00Z",
  updated_at: "2026-08-20T00:00:00Z",
};

function openConfirm() {
  fireEvent.click(screen.getByRole("button", { name: /delete "how has my knee been\?"/i }));
}

function confirmDelete() {
  fireEvent.click(screen.getByRole("button", { name: /delete permanently/i }));
}

describe("SessionsPage", () => {
  beforeEach(() => {
    localStorage.clear();
    // Issue #80's remembered-Session backup (`last-session.ts`) lives in
    // sessionStorage, not localStorage — cleared here too so a prior
    // test's write can't leak into this one's delete/back assertions.
    sessionStorage.clear();
    useSettingsStore.setState({ theme: "system", serverUrl: "" });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("shows a hint that Sessions need a Server URL when Sync is off, and never fetches", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    renderSessionsPage();

    expect(screen.getByText(/sync is off/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /add a server url/i })).toHaveAttribute(
      "href",
      "/settings",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows a loading state before the fetch resolves", () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );

    renderSessionsPage();

    expect(screen.getByText(/loading sessions/i)).toBeInTheDocument();
  });

  it("shows an empty state when the Server holds no Sessions yet", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    stubSessionsFetch([]);

    renderSessionsPage();

    expect(await screen.findByText(/no sessions yet/i)).toBeInTheDocument();
  });

  it("shows an unreachable state on a Server failure, distinct from the empty state", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })),
    );

    renderSessionsPage();

    expect(await screen.findByText(/couldn't load your sessions/i)).toBeInTheDocument();
    expect(screen.queryByText(/no sessions yet/i)).not.toBeInTheDocument();
  });

  it("renders each Session's title and last-used time, newest first as returned by the Server", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    stubSessionsFetch([
      {
        id: "session-1",
        title: "How has my knee been?",
        created_at: "2026-08-01T00:00:00Z",
        updated_at: "2026-08-20T00:00:00Z",
      },
      {
        id: "session-2",
        title: "What did I write about the flat move?",
        created_at: "2026-07-01T00:00:00Z",
        updated_at: "2026-07-01T00:00:00Z",
      },
    ]);

    renderSessionsPage();

    expect(await screen.findByText("How has my knee been?")).toBeInTheDocument();
    expect(screen.getByText("What did I write about the flat move?")).toBeInTheDocument();
    const rows = screen
      .getAllByRole("link")
      .filter((link) => link.getAttribute("href")?.startsWith("/reflect/"));
    expect(rows[0]).toHaveAttribute("href", "/reflect/session-1");
    expect(rows[1]).toHaveAttribute("href", "/reflect/session-2");
  });

  it("navigates to a Session's own URL when its row is tapped", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    stubSessionsFetch([
      {
        id: "session-1",
        title: "How has my knee been?",
        created_at: "2026-08-01T00:00:00Z",
        updated_at: "2026-08-20T00:00:00Z",
      },
    ]);

    renderSessionsPage();

    const row = await screen.findByRole("link", { name: /how has my knee been/i });
    fireEvent.click(row);

    expect(screen.getByTestId("location-path")).toHaveTextContent("/reflect/session-1");
  });

  it("treats a Session another Device already deleted as done, not as a Server failure", async () => {
    // The defect this pins: `not-found` was collapsed into the same branch as
    // a real failure, so deleting a row another Device had already removed
    // blamed a Server that was working *and* skipped the invalidate, leaving
    // the phantom row on screen — the one outcome that actually looks broken.
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    stubSessionsFetchWithDelete([oneSession], "not-found");

    renderSessionsPage();
    await screen.findByText("How has my knee been?");

    fireEvent.click(screen.getByRole("button", { name: 'Delete "How has my knee been?"' }));
    fireEvent.click(screen.getByRole("button", { name: /delete permanently/i }));

    // The row goes, and no failure is reported anywhere on screen — the
    // confirm box closes rather than staying open with an error in it.
    await waitFor(() => {
      expect(screen.queryByText("How has my knee been?")).not.toBeInTheDocument();
    });
    expect(screen.queryByText(/couldn't delete this session/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/is permanent/i)).not.toBeInTheDocument();
  });

  it("Back returns to the Conversation it was opened from, not a fresh Session", async () => {
    // The defect this pins: a fixed `to=\"/reflect\"` dropped a reader who
    // arrived here from an open Session into a *new, empty* one — losing the
    // Conversation they were reading, which is precisely what Sessions exists
    // to stop happening.
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    stubSessionsFetch([]);

    renderSessionsPage(["/reflect/session-1", "/reflect/list"]);
    await screen.findByText(/no sessions yet/i);

    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    expect(screen.getByTestId("location-path")).toHaveTextContent("/reflect/session-1");
  });

  it("Back falls to /reflect when there is nothing behind it", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    stubSessionsFetch([]);

    renderSessionsPage();
    await screen.findByText(/no sessions yet/i);

    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    expect(screen.getByTestId("location-path")).toHaveTextContent("/reflect");
  });

  it("requires a confirm step before a delete is ever sent — the first tap sends nothing", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    const fetchMock = stubSessionsFetchWithDelete([oneSession]);

    renderSessionsPage();
    await screen.findByText("How has my knee been?");

    openConfirm();

    // The confirm step itself is up, and it says this plainly rather than
    // reading like an ordinary "are you sure?" — permanent, every Device.
    expect(
      screen.getByText(/is permanent, and removes the Conversation from every Device/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/every device/i)).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(
        ([, init]) => (init as RequestInit | undefined)?.method === "DELETE",
      ),
    ).toBe(false);
    // The Session itself is untouched — still named on screen both in its
    // own row (still rendered behind the dialog, unlike the old in-row
    // two-step this replaced) and in the confirm step's own warning.
    expect(screen.getAllByText(/how has my knee been/i).length).toBeGreaterThanOrEqual(2);
  });

  it("cancelling the confirm step sends nothing and returns to the plain row", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    const fetchMock = stubSessionsFetchWithDelete([oneSession]);

    renderSessionsPage();
    await screen.findByText("How has my knee been?");

    openConfirm();
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

    expect(
      screen.queryByText(/is permanent, and removes the Conversation from every Device/i),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /how has my knee been/i })).toHaveAttribute(
      "href",
      "/reflect/session-1",
    );
    expect(
      fetchMock.mock.calls.some(
        ([, init]) => (init as RequestInit | undefined)?.method === "DELETE",
      ),
    ).toBe(false);
  });

  it("confirming sends the DELETE and the row disappears", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    const fetchMock = stubSessionsFetchWithDelete([oneSession]);

    renderSessionsPage();
    await screen.findByText("How has my knee been?");

    openConfirm();
    confirmDelete();

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("https://phone.example:41207/v1/sessions/session-1", {
        method: "DELETE",
      }),
    );

    await waitFor(() =>
      expect(screen.queryByText("How has my knee been?")).not.toBeInTheDocument(),
    );
    expect(await screen.findByText(/no sessions yet/i)).toBeInTheDocument();
  });

  it("keeps the row and reports the failure honestly, rather than silently removing it", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    stubSessionsFetchWithDelete([oneSession], "server-error");
    const errorToast = vi.spyOn(toast, "error");

    renderSessionsPage();
    await screen.findByText("How has my knee been?");

    openConfirm();
    confirmDelete();

    await waitFor(() => expect(errorToast).toHaveBeenCalled());
    // The row is still there — still confirming, still naming the Session
    // — and says so inline too, rather than this failure being silent.
    expect(screen.getByText(/how has my knee been/i)).toBeInTheDocument();
    expect(screen.getByText(/couldn't delete this session/i)).toBeInTheDocument();
  });

  it("typing in Search narrows the list to what the Server returns for that query", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    const flatMoveSession = {
      id: "session-2",
      title: "What did I write about the flat move?",
      created_at: "2026-07-01T00:00:00Z",
      updated_at: "2026-07-01T00:00:00Z",
    };
    stubSessionsFetchByQuery({
      "": [oneSession, flatMoveSession],
      flat: [flatMoveSession],
    });

    renderSessionsPage();
    await screen.findByText("How has my knee been?");
    expect(screen.getByText("What did I write about the flat move?")).toBeInTheDocument();

    openSearch();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search Sessions" }), {
      target: { value: "flat" },
    });

    await waitFor(() =>
      expect(screen.queryByText("How has my knee been?")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("What did I write about the flat move?")).toBeInTheDocument();
  });

  it("clearing the field restores the full list", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    const flatMoveSession = {
      id: "session-2",
      title: "What did I write about the flat move?",
      created_at: "2026-07-01T00:00:00Z",
      updated_at: "2026-07-01T00:00:00Z",
    };
    stubSessionsFetchByQuery({
      "": [oneSession, flatMoveSession],
      flat: [flatMoveSession],
    });

    renderSessionsPage();
    await screen.findByText("How has my knee been?");

    openSearch();
    const box = screen.getByRole("searchbox", { name: "Search Sessions" });
    fireEvent.change(box, { target: { value: "flat" } });
    await waitFor(() =>
      expect(screen.queryByText("How has my knee been?")).not.toBeInTheDocument(),
    );

    fireEvent.change(box, { target: { value: "" } });

    await waitFor(() => expect(screen.getByText("How has my knee been?")).toBeInTheDocument());
    expect(screen.getByText("What did I write about the flat move?")).toBeInTheDocument();
  });

  it("shows the 'nothing matched' state, not the 'no Sessions yet' state, when a search matches nothing", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    stubSessionsFetchByQuery({
      "": [oneSession],
      "no such thing": [],
    });

    renderSessionsPage();
    await screen.findByText("How has my knee been?");

    openSearch();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search Sessions" }), {
      target: { value: "no such thing" },
    });

    expect(await screen.findByText(/no sessions match/i)).toBeInTheDocument();
    expect(screen.queryByText(/no sessions yet/i)).not.toBeInTheDocument();
  });

  it("sends the query to the transport correctly encoded, including special characters", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => [] }));
    vi.stubGlobal("fetch", fetchMock);

    renderSessionsPage();
    await screen.findByText(/no sessions yet/i);

    openSearch();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search Sessions" }), {
      target: { value: "knee %" },
    });

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("https://phone.example:41207/v1/sessions?q=knee+%25"),
    );
  });

  // Issue #80: Sessions is one of the two places acceptance criteria asks
  // for a deliberate way to start over (reflection-page.test.tsx covers
  // the other, Reflect's own app bar).
  it("shows a New Session control in the app bar, linking to /reflect", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    stubSessionsFetch([]);

    renderSessionsPage();
    await screen.findByText(/no sessions yet/i);

    expect(screen.getByRole("link", { name: "New Session" })).toHaveAttribute("href", "/reflect");
  });

  it("clears the remembered Session id when the deleted Session is the one remembered", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    writeLastSessionId(oneSession.id);
    stubSessionsFetchWithDelete([oneSession]);

    renderSessionsPage();
    await screen.findByText("How has my knee been?");

    openConfirm();
    confirmDelete();

    await waitFor(() =>
      expect(screen.queryByText("How has my knee been?")).not.toBeInTheDocument(),
    );
    expect(readLastSessionId()).toBeNull();
  });

  it("leaves a different remembered Session id untouched when deleting some other Session", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    writeLastSessionId("session-other");
    stubSessionsFetchWithDelete([oneSession]);

    renderSessionsPage();
    await screen.findByText("How has my knee been?");

    openConfirm();
    confirmDelete();

    await waitFor(() =>
      expect(screen.queryByText("How has my knee been?")).not.toBeInTheDocument(),
    );
    expect(readLastSessionId()).toBe("session-other");
  });

  it("clears the remembered Session id even when the delete 404s (already gone, e.g. deleted from another Device)", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    writeLastSessionId(oneSession.id);
    stubSessionsFetchWithDelete([oneSession], "not-found");

    renderSessionsPage();
    await screen.findByText("How has my knee been?");

    openConfirm();
    confirmDelete();

    await waitFor(() =>
      expect(screen.queryByText("How has my knee been?")).not.toBeInTheDocument(),
    );
    expect(readLastSessionId()).toBeNull();
  });

  it("leaves the remembered Session id in place when the delete fails with a real Server error", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    writeLastSessionId(oneSession.id);
    stubSessionsFetchWithDelete([oneSession], "server-error");

    renderSessionsPage();
    await screen.findByText("How has my knee been?");

    openConfirm();
    confirmDelete();

    await waitFor(() =>
      expect(screen.getByText(/couldn't delete this session/i)).toBeInTheDocument(),
    );
    // The Session wasn't actually deleted, so nothing about the memory changes.
    expect(readLastSessionId()).toBe(oneSession.id);
  });
});
