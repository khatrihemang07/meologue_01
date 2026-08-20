import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes, useLocation } from "react-router";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "@/lib/settings";
import type { EntryStoreOutletContext } from "@/pages/entry-store-layout";
import { SessionsPage } from "./sessions-page";

// SessionsPage lives inside EntryStoreLayout in App.tsx alongside the other
// `/reflect*` routes, even though it reads nothing from the Entry store
// itself — mirroring the real route tree, the same
// hand-built-Outlet-context stand-in composer-page.test.tsx,
// history-page.test.tsx and reflection-page.test.tsx already use in place
// of the real store-opening machinery.
const defaultEntryStoreContext: EntryStoreOutletContext = {
  entries: [],
  sendEntry: vi.fn(),
  search: vi.fn(async () => []),
  disabled: false,
};

function LocationProbe() {
  const location = useLocation();
  return <p data-testid="location-path">{location.pathname}</p>;
}

function renderSessionsPage() {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/reflect/list"]}>
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
    useSettingsStore.setState({ theme: "system", serverUrl: "" });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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

  it("has a Back control returning to /reflect", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    stubSessionsFetch([]);

    renderSessionsPage();
    await screen.findByText(/no sessions yet/i);

    expect(screen.getByRole("link", { name: "Back" })).toHaveAttribute("href", "/reflect");
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
    // The Session itself is untouched — still named on screen, in the
    // confirm step's own warning.
    expect(screen.getByText(/how has my knee been/i)).toBeInTheDocument();
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
});
