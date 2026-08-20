import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes, useLocation } from "react-router";
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
});
