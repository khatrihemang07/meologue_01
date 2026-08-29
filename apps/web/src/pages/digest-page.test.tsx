import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "@/lib/settings";
import type { EntryStoreOutletContext } from "@/pages/entry-store-layout";
import { DigestPage } from "./digest-page";

// DigestPage lives inside EntryStoreLayout in App.tsx (issue #71 — the
// layout drives Sync even though this page reads no Entry directly), so
// this needs the same hand-built-Outlet-context stand-in
// sessions-page.test.tsx and reflection-page.test.tsx already use in place
// of the real store-opening machinery.
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

function renderDigestPage() {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/digest"]}>
        <LocationProbe />
        <Routes>
          <Route element={<Outlet context={defaultEntryStoreContext} />}>
            <Route path="/digest" element={<DigestPage />} />
            <Route path="/digest/:period/:date" element={<p>opened digest</p>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

type DigestFixture = {
  period: string;
  period_start: string;
  period_end: string;
  body: string;
  grounding_entry_ids: string[];
  prev_date: string | null;
  next_date: string | null;
  // Issue #132 / ADR 0039.
  stale: boolean;
  revision: number;
  written_at: string;
};

function digestFixture(overrides: Partial<DigestFixture> & { period: string }): DigestFixture {
  return {
    period_start: "2026-08-20",
    period_end: "2026-08-20",
    body: "You wrote about your knee again today.\nIt's improved since February.",
    grounding_entry_ids: ["entry-1"],
    prev_date: null,
    next_date: null,
    stale: false,
    revision: 1,
    written_at: "2026-08-21T06:00:00Z",
    ...overrides,
  };
}

/**
 * Routes a fetch to one of `/v1/digests/day`, `/v1/digests/week`,
 * `/v1/digests/month` by pathname, each independently configurable — the
 * three cards fetch independently, so a realistic stub has to be able to
 * answer them differently (e.g. day has a Digest, month doesn't yet).
 * `"network-error"` throws; anything else is served as a 200 (a Digest or
 * `null`), a 404, or a 500 as given.
 */
function stubDigestFetch(
  responses: Record<
    "day" | "week" | "month",
    { status: number; digest: DigestFixture | null } | "network-error"
  >,
) {
  const fetchMock = vi.fn(async (url: string) => {
    const path = new URL(url).pathname;
    const period = (["day", "week", "month"] as const).find((p) => path === `/v1/digests/${p}`);
    const outcome = period ? responses[period] : undefined;
    if (outcome === undefined) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    if (outcome === "network-error") {
      throw new Error("network down");
    }
    return {
      ok: outcome.status < 300,
      status: outcome.status,
      json: async () => ({ digest: outcome.digest }),
    };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("DigestPage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    // `serverReachable`/`capabilities` (issue #133) reset here too — both
    // are singleton store state a prior test's simulated network failure
    // can leave behind, and `serverReachable: false` in particular would
    // pause every later test's own Digest queries before they ever fired.
    useSettingsStore.setState({
      serverUrl: "",
      serverReachable: true,
      capabilities: null,
    });
  });

  it("with Sync off, says so, points at Settings, and makes no request at all", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    renderDigestPage();

    expect(screen.getByText(/Sync is off/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "add a Server URL" })).toHaveAttribute(
      "href",
      "/settings",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renders all three cards with their label, date range, and a clamped two-line teaser", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    stubDigestFetch({
      day: {
        status: 200,
        digest: digestFixture({
          period: "day",
          period_start: "2026-08-20",
          period_end: "2026-08-20",
        }),
      },
      week: {
        status: 200,
        digest: digestFixture({
          period: "week",
          period_start: "2026-08-17",
          period_end: "2026-08-23",
        }),
      },
      month: {
        status: 200,
        digest: digestFixture({
          period: "month",
          period_start: "2026-08-01",
          period_end: "2026-08-31",
        }),
      },
    });

    renderDigestPage();

    expect(await screen.findByText("Last day")).toBeInTheDocument();
    expect(screen.getByText("Last week")).toBeInTheDocument();
    expect(screen.getByText("Last month")).toBeInTheDocument();

    // The date under the day card is one date, not a range.
    expect(screen.getByText("Aug 20, 2026")).toBeInTheDocument();
    // The week card shows a real range.
    expect(screen.getByText("Aug 17 – Aug 23, 2026")).toBeInTheDocument();
    // The month card reads naturally — "August 2026", not a 1–31 range —
    // because period_start and period_end fall in the same calendar month.
    expect(screen.getByText("August 2026")).toBeInTheDocument();

    // #128: nothing is clamped while the three fit one screen, which is
    // what jsdom's un-measurable viewport always reports (see
    // `useFittedDigests`' own fallback). The prose itself is never
    // truncated in the DOM either way — it is the wrapper around it that
    // carries a `max-height`, and here it carries none.
    const teasers = screen.getAllByText(/You wrote about your knee again today\./);
    expect(teasers.length).toBeGreaterThan(0);
    for (const teaser of teasers) {
      expect(teaser.className).not.toContain("line-clamp");
      expect(teaser.parentElement?.style.maxHeight).toBe("");
    }

    // The "read the rest" affordance is in the DOM at every size — it is
    // what keeps the measurement above it stable — but it is
    // `visibility: hidden`, and out of the accessibility tree with it, until
    // there is genuinely more to read.
    const affordances = screen.getAllByText("Read the rest");
    expect(affordances.length).toBeGreaterThan(0);
    for (const affordance of affordances) {
      expect(affordance.className).toContain("invisible");
      expect(affordance).toHaveAttribute("aria-hidden", "true");
    }
  });

  it("links each card to /digest/{period}/{period_start}", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    stubDigestFetch({
      day: {
        status: 200,
        digest: digestFixture({
          period: "day",
          period_start: "2026-08-20",
          period_end: "2026-08-20",
        }),
      },
      week: { status: 200, digest: null },
      month: { status: 200, digest: null },
    });

    renderDigestPage();

    const dayLink = await screen.findByRole("link", { name: /Last day/ });
    expect(dayLink).toHaveAttribute("href", "/digest/day/2026-08-20");
  });

  it("reports a 404 on any Digest route as 'this Server doesn't support Digests yet'", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    stubDigestFetch({
      day: { status: 404, digest: null },
      week: { status: 200, digest: null },
      month: { status: 200, digest: null },
    });

    renderDigestPage();

    expect(await screen.findByText("This Server doesn't support Digests yet.")).toBeInTheDocument();
  });

  it("reports a non-404 failure as unreachable, per ADR 0025 rather than rendering empty", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    stubDigestFetch({
      day: { status: 500, digest: null },
      week: { status: 200, digest: null },
      month: { status: 200, digest: null },
    });

    renderDigestPage();

    expect(
      await screen.findByText("Couldn't load your Digests. Check your Server and try again."),
    ).toBeInTheDocument();
  });

  it("reports a network failure as unreachable too, without throwing", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    stubDigestFetch({
      day: "network-error",
      week: { status: 200, digest: null },
      month: { status: 200, digest: null },
    });

    renderDigestPage();

    expect(
      await screen.findByText("Couldn't load your Digests. Check your Server and try again."),
    ).toBeInTheDocument();
  });

  // Issue #133: "existing Digests still readable" — a Period that already
  // loaded successfully must stay on screen next to the banner rather than
  // the whole page collapsing to one error message the moment any one of
  // the three requests fails.
  it("keeps an already-loaded Digest visible next to the unreachable banner", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    stubDigestFetch({
      day: {
        status: 200,
        digest: digestFixture({
          period: "day",
          period_start: "2026-08-20",
          period_end: "2026-08-20",
        }),
      },
      week: "network-error",
      month: { status: 200, digest: null },
    });

    renderDigestPage();

    expect(
      await screen.findByText("Couldn't load your Digests. Check your Server and try again."),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Last day/ })).toBeInTheDocument();
  });

  it("offers a Retry on the unreachable banner", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    stubDigestFetch({
      day: "network-error",
      week: { status: 200, digest: null },
      month: { status: 200, digest: null },
    });

    renderDigestPage();

    const banner = await screen.findByTestId("server-unreachable-banner");
    expect(within(banner).getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("reads as working and waiting, not broken, for a Period with no Digest yet — worded per Period", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    stubDigestFetch({
      day: { status: 200, digest: null },
      week: { status: 200, digest: null },
      month: { status: 200, digest: null },
    });

    renderDigestPage();

    expect(
      await screen.findByText("No daily Digest yet — one is written the day after you write."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("No weekly Digest yet — one is written once your first week is complete."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("No monthly Digest yet — one is written once your first month is complete."),
    ).toBeInTheDocument();
  });

  it("navigates to the reader page when a card is clicked", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    stubDigestFetch({
      day: {
        status: 200,
        digest: digestFixture({
          period: "day",
          period_start: "2026-08-20",
          period_end: "2026-08-20",
        }),
      },
      week: { status: 200, digest: null },
      month: { status: 200, digest: null },
    });

    renderDigestPage();

    const dayLink = await screen.findByRole("link", { name: /Last day/ });
    dayLink.click();

    await waitFor(() => {
      expect(screen.getByTestId("location-path")).toHaveTextContent("/digest/day/2026-08-20");
    });
  });

  // Issue #132 / ADR 0039.
  it("shows a neutral stale marker on a stale card, and none on a fresh one — no Regenerate button either way", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    stubDigestFetch({
      day: {
        status: 200,
        digest: digestFixture({
          period: "day",
          period_start: "2026-08-20",
          period_end: "2026-08-20",
          stale: true,
        }),
      },
      week: {
        status: 200,
        digest: digestFixture({
          period: "week",
          period_start: "2026-08-17",
          period_end: "2026-08-23",
          stale: false,
        }),
      },
      month: { status: 200, digest: null },
    });

    renderDigestPage();

    expect(
      await screen.findByText("Entries for this day changed after this Digest was written."),
    ).toBeInTheDocument();
    // The week card fetched successfully and is not stale — no marker for
    // it, and the month noun never appears at all since that card never
    // resolved a Digest.
    expect(
      screen.queryByText("Entries for this week changed after this Digest was written."),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Entries for this month changed after this Digest was written\./),
    ).not.toBeInTheDocument();

    // Cards never get a Regenerate action — only the reader does (issue
    // #132: "a card is 'the latest of this Period,' not a specific date").
    expect(screen.queryByRole("button", { name: "Regenerate" })).not.toBeInTheDocument();
  });
});
