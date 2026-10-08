import { PROTOCOL_VERSION } from "@meologue/core";
import { QueryClient, QueryClientProvider, queryOptions } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ENTRY_STORE_QUERY_KEY } from "@/lib/query-keys";
import { SettingsPage } from "./settings-page";

const { openEntryStoreMock } = vi.hoisted(() => ({
  openEntryStoreMock: vi.fn(),
}));

// A stand-in for entry-store-layout.tsx's real entryStoreQueryOptions (which
// needs a real SqliteDriver to run migrations against), same shape as
// use-sync-loop.test.tsx's — Settings subscribes to the same query key
// directly (ADR 0008/0009: it's a sibling route with no outlet context).
// Never resolved here: this page-level file is about composition, not
// about what a resolved store lets `DataSection` do — that behaviour moved
// wholesale to `components/settings/data-section.test.tsx` (issue #202),
// which exercises `DataSection` directly against a plain `opened` prop and
// needs none of this scaffolding at all.
vi.mock("@/pages/entry-store-layout", () => ({
  entryStoreQueryOptions: queryOptions({
    queryKey: ENTRY_STORE_QUERY_KEY,
    queryFn: openEntryStoreMock,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    retry: false,
    retryOnMount: false,
  }),
}));

// The `/` route renders a probe element rather than the real ComposerPage:
// nothing in this file needs to re-render everything that page depends on
// (its own store, context, etc.) to prove a Nav link's href is correct.
function renderPage() {
  const queryClient = new QueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/settings"]}>
        <Routes>
          <Route path="/" element={<div>Composer probe</div>} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("SettingsPage", () => {
  beforeEach(() => {
    // Never resolves — this file doesn't exercise anything that depends on
    // the store actually opening (see data-section.test.tsx for that).
    openEntryStoreMock.mockReset();
    openEntryStoreMock.mockReturnValue(new Promise(() => {}));
    // A quiet, generic response for AiSection's models query and
    // SyncSection's own health probe — both mount unconditionally as part
    // of composing the page, and neither's own behaviour is what this file
    // is testing (see ai-section.test.tsx / sync-section.test.tsx).
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          service: "meologue-server",
          protocol_version: PROTOCOL_VERSION,
          models: [],
        }),
      })),
    );
  });

  // Issue #75: Settings is now one of the four Nav destinations itself
  // (Composer, Reflect, Digest, Settings — no History), so this asserts the
  // whole set rather than just the other three the way it did while
  // Settings was reached through a separate app-bar gear.
  it("renders its title in the app bar", () => {
    renderPage();

    // Still scoped to the app bar (role "banner") even though ADR 0036 took
    // the persistent nav's own "Settings" link away: this page's body has
    // headings of its own, and an unscoped match would stop distinguishing
    // the title from them.
    expect(
      within(screen.getByRole("banner")).getByText("Settings", { exact: true }),
    ).toBeInTheDocument();
  });

  // ADR 0036: a destination is pushed over the root screen, so what proves
  // a reader is not stranded is a Back control, not a nav link that was
  // always on screen. Settings keeps this despite ADR 0018 once arguing an
  // always-reachable destination needs no Back — it is no longer always
  // reachable, which was that argument's whole premise.
  it("offers a Back control out to the root screen", () => {
    renderPage();

    expect(screen.getByRole("link", { name: "Back to chats" })).toHaveAttribute("href", "/");
  });

  // Issue #202's own reorganisation: five topics, Appearance/Composer/AI/
  // Sync/Data, each rendered in that order. This is a page-level assertion
  // rather than something any one topic section's own test file can pin —
  // it's a fact about how settings-page.tsx composes them, not about any
  // one of them individually.
  it("renders the five topic sections in order — Appearance, Composer, AI, Sync, Data", () => {
    renderPage();

    const headings = screen
      .getAllByRole("heading", { level: 2 })
      .map((heading) => heading.textContent);
    expect(headings).toEqual(["Appearance", "Composer", "AI", "Sync", "Data"]);
  });
});
