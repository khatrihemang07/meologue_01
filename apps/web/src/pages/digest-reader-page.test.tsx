import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "@/lib/settings";
import type { EntryStoreOutletContext } from "@/pages/entry-store-layout";
import { DigestReaderPage } from "./digest-reader-page";

const defaultEntryStoreContext: EntryStoreOutletContext = {
  entries: [],
  sendEntry: vi.fn(),
  editEntry: vi.fn(),
  commitEntryEdit: vi.fn(),
  removeEntry: vi.fn(),
  search: vi.fn(async () => []),
  getEntries: vi.fn(async () => []),
  pagination: { hasMore: false, fetching: false, fetchMore: vi.fn() },
  tasks: [],
  completedTasks: [],
  addTask: vi.fn(),
  completeTask: vi.fn(),
  uncompleteTask: vi.fn(),
  renameTask: vi.fn(),
  reorderTask: vi.fn(),
  reorderTaskToday: vi.fn(),
  removeTask: vi.fn(),
  setTaskDate: vi.fn(),
  setTaskDeadline: vi.fn(),
  setTaskPriority: vi.fn(),
  setTaskLabels: vi.fn(),
  setTaskDescription: vi.fn(),
  listTasksInProject: vi.fn(async () => []),
  listTaskChildren: vi.fn(async () => []),
  listTasksInSection: vi.fn(async () => []),
  listTaskDescendants: vi.fn(async () => []),
  advanceRecurringTask: vi.fn(),
  completeForeverTask: vi.fn(),
  postponeTask: vi.fn(),
  // Issue #171's three structural Task setters — these tests never
  // exercise Project/Section moves or reparenting, so a stub is enough
  // to satisfy EntryStoreOutletContext's shape.
  setTaskProject: vi.fn(),
  setTaskSection: vi.fn(),
  setTaskParent: vi.fn(async () => {}),
  labels: [],
  resolveLabelIds: vi.fn(async () => []),
  comments: [],
  addComment: vi.fn(),
  editComment: vi.fn(),
  removeComment: vi.fn(),
  // Issue #171's Projects and Sections — these tests never exercise
  // them either, same reasoning as the setTaskProject/etc. stubs above.
  projects: [],
  addProject: vi.fn(),
  renameProject: vi.fn(),
  setProjectColour: vi.fn(),
  setProjectDescription: vi.fn(),
  setProjectFavourite: vi.fn(),
  archiveProject: vi.fn(),
  unarchiveProject: vi.fn(),
  setProjectParent: vi.fn(async () => {}),
  reorderProject: vi.fn(),
  listSections: vi.fn(async () => []),
  addSection: vi.fn(async () => {}),
  renameSection: vi.fn(),
  setSectionDescription: vi.fn(),
  reorderSection: vi.fn(),
  deleteSection: vi.fn(),
  archiveSection: vi.fn(),
  unarchiveSection: vi.fn(),
  events: [],
  listEventsByTask: vi.fn(async () => []),
  listEventsByProject: vi.fn(async () => []),
  disabled: false,
};

function LocationProbe() {
  const location = useLocation();
  return <p data-testid="location-path">{location.pathname}</p>;
}

function renderDigestReaderPage(initialPath = "/digest/day/2026-08-20") {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <LocationProbe />
        <Routes>
          <Route element={<Outlet context={defaultEntryStoreContext} />}>
            <Route path="/digest" element={<p>digest cards</p>} />
            <Route path="/digest/:period/:date" element={<DigestReaderPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function stubDigestAtFetch(response: { status: number; digest: unknown } | "network-error") {
  const fetchMock = vi.fn(async () => {
    if (response === "network-error") {
      throw new Error("network down");
    }
    return {
      ok: response.status < 300,
      status: response.status,
      json: async () => ({ digest: response.digest }),
    };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("DigestReaderPage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    // `serverReachable`/`capabilities` (issue #133) reset here too — see
    // `digest-page.test.tsx`'s identical reset for why a prior test's
    // simulated network failure must not leak into a later one.
    useSettingsStore.setState({
      serverUrl: "",
      serverReachable: true,
      capabilities: null,
    });
  });

  it("with Sync off, says so, points at Settings, and makes no request at all", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    renderDigestReaderPage();

    expect(screen.getByText(/Sync is off/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "add a Server URL" })).toHaveAttribute(
      "href",
      "/settings",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches GET /v1/digests/:period/:date and shows the Period, its date range, and the full prose", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    const fetchMock = stubDigestAtFetch({
      status: 200,
      digest: {
        period: "day",
        period_start: "2026-08-20",
        period_end: "2026-08-20",
        body: "You wrote about your knee again today.\n\nIt's improved since February.",
        grounding_entry_ids: ["entry-1"],
        prev_date: "2026-08-18",
        next_date: null,
        stale: false,
        revision: 1,
        written_at: "2026-08-21T06:00:00Z",
      },
    });

    renderDigestReaderPage("/digest/day/2026-08-20");

    // Await content that only renders once the fetch has actually resolved
    // — the title itself (`periodTitle`) renders synchronously from the
    // route params alone, so awaiting it wouldn't give the async fetch a
    // chance to settle first.
    expect(await screen.findByText(/You wrote about your knee again today\./)).toBeInTheDocument();
    expect(screen.getByText("Day Digest")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("https://phone.example:41207/v1/digests/day/2026-08-20");
    expect(screen.getByText("Aug 20, 2026")).toBeInTheDocument();
    expect(screen.getByText(/It's improved since February\./)).toBeInTheDocument();

    // Issue #72: a `prev_date` renders as a genuine link (so it's a real
    // history entry, not in-page state — see digest-reader-page.tsx's own
    // comment citing ADR 0025), while a `null` `next_date` renders as a
    // disabled control rather than not rendering at all.
    expect(screen.getByRole("link", { name: "Previous Digest" })).toHaveAttribute(
      "href",
      "/digest/day/2026-08-18",
    );
    expect(screen.getByRole("button", { name: "Next Digest" })).toBeDisabled();
  });

  // Issue #140: the Digest reader now renders through `inlineProse`, the
  // same inline renderer as the Entry bubble and Grounding — so a `**bold**`
  // the Server wrote reaches the reader as a `<strong>`, not literal
  // asterisks. `inlineProse` never enters the block layer (ADR 0041), so a
  // heading- or bullet-looking line stays plain text too, rather than
  // becoming an `<h1>`/`<ul>` that would break the line-count measurement a
  // block element elsewhere in this codebase depends on.
  it("renders the Digest body's inline formatting, with no block element for a heading- or bullet-looking line", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    stubDigestAtFetch({
      status: 200,
      digest: {
        period: "day",
        period_start: "2026-08-20",
        period_end: "2026-08-20",
        body: "Your **knee** felt better today.\n# Not a heading, just text.",
        grounding_entry_ids: ["entry-1"],
        prev_date: null,
        next_date: null,
        stale: false,
        revision: 1,
        written_at: "2026-08-21T06:00:00Z",
      },
    });

    renderDigestReaderPage("/digest/day/2026-08-20");

    const strong = await screen.findByText("knee");
    expect(strong.tagName).toBe("STRONG");

    const headingLooking = screen.getByText(/Not a heading, just text\./);
    expect(["H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "LI"]).not.toContain(
      headingLooking.tagName,
    );
  });

  it("shows the Period and its date range for a week Digest", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    stubDigestAtFetch({
      status: 200,
      digest: {
        period: "week",
        period_start: "2026-08-17",
        period_end: "2026-08-23",
        body: "A quiet week.",
        grounding_entry_ids: [],
        prev_date: null,
        next_date: null,
        stale: false,
        revision: 1,
        written_at: "2026-08-21T06:00:00Z",
      },
    });

    renderDigestReaderPage("/digest/week/2026-08-17");

    expect(await screen.findByText("A quiet week.")).toBeInTheDocument();
    expect(screen.getByText("Week Digest")).toBeInTheDocument();
    expect(screen.getByText("Aug 17 – Aug 23, 2026")).toBeInTheDocument();
  });

  it("reads naturally for a month Digest whose start and end fall in the same month", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    stubDigestAtFetch({
      status: 200,
      digest: {
        period: "month",
        period_start: "2026-08-01",
        period_end: "2026-08-31",
        body: "A month of writing about your knee.",
        grounding_entry_ids: [],
        prev_date: null,
        next_date: null,
        stale: false,
        revision: 1,
        written_at: "2026-08-21T06:00:00Z",
      },
    });

    renderDigestReaderPage("/digest/month/2026-08-01");

    expect(await screen.findByText("A month of writing about your knee.")).toBeInTheDocument();
    expect(screen.getByText("Month Digest")).toBeInTheDocument();
    expect(screen.getByText("August 2026")).toBeInTheDocument();
  });

  it("reports a 200 with digest: null as 'no Digest was written for this date'", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    stubDigestAtFetch({ status: 200, digest: null });

    renderDigestReaderPage("/digest/day/2026-08-20");

    expect(await screen.findByText("No Digest was written for this date.")).toBeInTheDocument();

    // A stale URL naming a date with no Digest has no `prev_date`/
    // `next_date` to build a stepper from at all — this asserts the page
    // renders no stepping controls here rather than, say, two disabled ones
    // with nothing behind them (digest-reader-page.tsx's own comment on
    // this branch explains why).
    expect(screen.queryByRole("link", { name: /previous|next digest/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /previous|next digest/i })).not.toBeInTheDocument();
  });

  it("reports a 404 as 'this Server doesn't support Digests yet'", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    stubDigestAtFetch({ status: 404, digest: null });

    renderDigestReaderPage("/digest/day/2026-08-20");

    expect(await screen.findByText("This Server doesn't support Digests yet.")).toBeInTheDocument();
  });

  it("reports a non-404 failure as unreachable, per ADR 0025 rather than rendering empty", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    stubDigestAtFetch({ status: 500, digest: null });

    renderDigestReaderPage("/digest/day/2026-08-20");

    expect(
      await screen.findByText("Couldn't load this Digest. Check your Server and try again."),
    ).toBeInTheDocument();
  });

  it("reports a network failure as unreachable too, without throwing", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    stubDigestAtFetch("network-error");

    renderDigestReaderPage("/digest/day/2026-08-20");

    expect(
      await screen.findByText("Couldn't load this Digest. Check your Server and try again."),
    ).toBeInTheDocument();
  });

  // Issue #132 / ADR 0039: staleness and the Regenerate action.
  describe("regenerate and staleness", () => {
    it("shows the neutral stale marker when the Digest is stale", async () => {
      useSettingsStore.getState().setServerUrl("https://phone.example:41207");
      stubDigestAtFetch({
        status: 200,
        digest: {
          period: "day",
          period_start: "2026-08-20",
          period_end: "2026-08-20",
          body: "Body.",
          grounding_entry_ids: [],
          prev_date: null,
          next_date: null,
          stale: true,
          revision: 2,
          written_at: "2026-08-22T06:00:00Z",
        },
      });

      renderDigestReaderPage("/digest/day/2026-08-20");

      expect(
        await screen.findByText("Entries for this day changed after this Digest was written."),
      ).toBeInTheDocument();
      // Provenance cue: revision 2 reads "Regenerated", never "Written" —
      // the exact date is locale/timezone-dependent (`written_at` renders
      // in the reader's own local timezone, `digest-format.ts`'s
      // `formatDigestProvenance`), so only the label is asserted on here.
      expect(screen.getByText(/^Regenerated /)).toBeInTheDocument();
    });

    it("shows no stale marker, and a Written provenance cue, for a fresh revision 1 Digest", async () => {
      useSettingsStore.getState().setServerUrl("https://phone.example:41207");
      stubDigestAtFetch({
        status: 200,
        digest: {
          period: "day",
          period_start: "2026-08-20",
          period_end: "2026-08-20",
          body: "Body.",
          grounding_entry_ids: [],
          prev_date: null,
          next_date: null,
          stale: false,
          revision: 1,
          written_at: "2026-08-21T06:00:00Z",
        },
      });

      renderDigestReaderPage("/digest/day/2026-08-20");

      expect(await screen.findByText(/^Written /)).toBeInTheDocument();
      expect(
        screen.queryByText("Entries for this day changed after this Digest was written."),
      ).not.toBeInTheDocument();
    });

    it("Regenerate is enabled even when the Digest is not stale — it is not gated on staleness at all", async () => {
      useSettingsStore.getState().setServerUrl("https://phone.example:41207");
      stubDigestAtFetch({
        status: 200,
        digest: {
          period: "day",
          period_start: "2026-08-20",
          period_end: "2026-08-20",
          body: "Fresh, not stale.",
          grounding_entry_ids: [],
          prev_date: null,
          next_date: null,
          stale: false,
          revision: 1,
          written_at: "2026-08-21T06:00:00Z",
        },
      });

      renderDigestReaderPage("/digest/day/2026-08-20");

      expect(await screen.findByText("Fresh, not stale.")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Regenerate" })).toBeEnabled();
    });

    it("Regenerate is available even with no Digest at all for this date — the rescue for a Period past MAX_ATTEMPTS", async () => {
      useSettingsStore.getState().setServerUrl("https://phone.example:41207");
      stubDigestAtFetch({ status: 200, digest: null });

      renderDigestReaderPage("/digest/day/2026-08-20");

      expect(await screen.findByText("No Digest was written for this date.")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Regenerate" })).toBeEnabled();
    });

    it("a successful Regenerate refreshes the shown body without a manual refresh", async () => {
      useSettingsStore.getState().setServerUrl("https://phone.example:41207");

      // A stateful stub, unlike `stubDigestAtFetch`'s single canned
      // response: this test needs the plain GET the page starts with, the
      // POST .../regenerate the click fires, and a second GET (fired by
      // TanStack Query's own automatic refetch once
      // `RegenerateAction`'s `onSuccess` invalidates the query) to all
      // agree on the same, evolving server-side state — exactly what a
      // real Server round trip would do.
      let current = {
        period: "day",
        period_start: "2026-08-20",
        period_end: "2026-08-20",
        body: "Written by the worker.",
        grounding_entry_ids: ["entry-1"],
        prev_date: null,
        next_date: null,
        stale: true,
        revision: 1,
        written_at: "2026-08-21T06:00:00Z",
      };

      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        const path = new URL(url).pathname;
        if (path === "/v1/digests/day/2026-08-20/regenerate") {
          expect(init?.method).toBe("POST");
          current = {
            ...current,
            body: "Regenerated, freshly written from today's Entries.",
            stale: false,
            revision: 2,
            written_at: "2026-08-22T06:00:00Z",
          };
          return { ok: true, status: 200, json: async () => ({ digest: current }) };
        }
        if (path === "/v1/digests/day/2026-08-20") {
          return { ok: true, status: 200, json: async () => ({ digest: current }) };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      });
      vi.stubGlobal("fetch", fetchMock);

      renderDigestReaderPage("/digest/day/2026-08-20");

      expect(await screen.findByText("Written by the worker.")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));

      expect(
        await screen.findByText("Regenerated, freshly written from today's Entries."),
      ).toBeInTheDocument();
      expect(screen.queryByText("Written by the worker.")).not.toBeInTheDocument();
      // The refreshed body's own provenance cue and stale marker follow
      // along too — nothing here is a stale echo of the pre-regenerate
      // state.
      expect(screen.getByText(/^Regenerated /)).toBeInTheDocument();
      expect(
        screen.queryByText("Entries for this day changed after this Digest was written."),
      ).not.toBeInTheDocument();
    });
  });

  // Issue #72: back/forward controls that walk the archive by following the
  // Server's own `prev_date`/`next_date`, never computing one — see
  // digest-reader-page.tsx's `DigestStepControl` for the full reasoning.
  describe("stepping", () => {
    it("renders both controls with accessible names when both neighbours exist", async () => {
      useSettingsStore.getState().setServerUrl("https://phone.example:41207");
      stubDigestAtFetch({
        status: 200,
        digest: {
          period: "day",
          period_start: "2026-08-20",
          period_end: "2026-08-20",
          body: "A day.",
          grounding_entry_ids: [],
          prev_date: "2026-08-19",
          next_date: "2026-08-21",
          stale: false,
          revision: 1,
          written_at: "2026-08-21T06:00:00Z",
        },
      });

      renderDigestReaderPage("/digest/day/2026-08-20");

      expect(await screen.findByRole("link", { name: "Previous Digest" })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Next Digest" })).toBeInTheDocument();
    });

    it("back navigates to prev_date's URL and forward navigates to next_date's URL", async () => {
      useSettingsStore.getState().setServerUrl("https://phone.example:41207");
      stubDigestAtFetch({
        status: 200,
        digest: {
          period: "day",
          period_start: "2026-08-20",
          period_end: "2026-08-20",
          body: "A day.",
          grounding_entry_ids: [],
          prev_date: "2026-08-19",
          next_date: "2026-08-21",
          stale: false,
          revision: 1,
          written_at: "2026-08-21T06:00:00Z",
        },
      });

      renderDigestReaderPage("/digest/day/2026-08-20");

      expect(await screen.findByRole("link", { name: "Previous Digest" })).toHaveAttribute(
        "href",
        "/digest/day/2026-08-19",
      );
      expect(screen.getByRole("link", { name: "Next Digest" })).toHaveAttribute(
        "href",
        "/digest/day/2026-08-21",
      );
    });

    it("stepping is a real route change: browser back from a step returns to the prior Digest, not out of the archive", async () => {
      // `<Link>` (a push, not `navigate(..., { replace: true })`) is what
      // this test locks in — a `replace` would overwrite the entry behind
      // it, so browser back from the stepped-to Digest would jump straight
      // out to the cards instead of landing back on the Digest just left.
      useSettingsStore.getState().setServerUrl("https://phone.example:41207");
      stubDigestAtFetch({
        status: 200,
        digest: {
          period: "day",
          period_start: "2026-08-20",
          period_end: "2026-08-20",
          body: "A day.",
          grounding_entry_ids: [],
          prev_date: "2026-08-19",
          next_date: null,
          stale: false,
          revision: 1,
          written_at: "2026-08-21T06:00:00Z",
        },
      });

      renderDigestReaderPage("/digest/day/2026-08-20");

      const prevLink = await screen.findByRole("link", { name: "Previous Digest" });
      fireEvent.click(prevLink);

      expect(screen.getByTestId("location-path")).toHaveTextContent("/digest/day/2026-08-19");
    });

    it("skips a gap: a prev_date three days earlier is followed as-is, not recomputed", async () => {
      // Proves the client never adds/subtracts a day itself — it was
      // handed "2026-08-15" (three days back, not "yesterday") because the
      // Server already skipped a Period with no Digest in between
      // (`server/src/digest.rs`'s neighbour queries), and the client's only
      // job is to follow that date exactly.
      useSettingsStore.getState().setServerUrl("https://phone.example:41207");
      stubDigestAtFetch({
        status: 200,
        digest: {
          period: "day",
          period_start: "2026-08-18",
          period_end: "2026-08-18",
          body: "A day, after a gap.",
          grounding_entry_ids: [],
          prev_date: "2026-08-15",
          next_date: null,
          stale: false,
          revision: 1,
          written_at: "2026-08-21T06:00:00Z",
        },
      });

      renderDigestReaderPage("/digest/day/2026-08-18");

      expect(await screen.findByRole("link", { name: "Previous Digest" })).toHaveAttribute(
        "href",
        "/digest/day/2026-08-15",
      );
    });

    it("disables back when prev_date is null and forward when next_date is null", async () => {
      useSettingsStore.getState().setServerUrl("https://phone.example:41207");
      stubDigestAtFetch({
        status: 200,
        digest: {
          period: "day",
          period_start: "2026-08-20",
          period_end: "2026-08-20",
          body: "A day.",
          grounding_entry_ids: [],
          prev_date: null,
          next_date: "2026-08-21",
          stale: false,
          revision: 1,
          written_at: "2026-08-21T06:00:00Z",
        },
      });

      renderDigestReaderPage("/digest/day/2026-08-20");

      expect(await screen.findByRole("button", { name: "Previous Digest" })).toBeDisabled();
      expect(screen.getByRole("link", { name: "Next Digest" })).toHaveAttribute(
        "href",
        "/digest/day/2026-08-21",
      );
    });

    it("disables both controls when both prev_date and next_date are null (the only Digest of this Period)", async () => {
      useSettingsStore.getState().setServerUrl("https://phone.example:41207");
      stubDigestAtFetch({
        status: 200,
        digest: {
          period: "day",
          period_start: "2026-08-20",
          period_end: "2026-08-20",
          body: "The only day.",
          grounding_entry_ids: [],
          prev_date: null,
          next_date: null,
          stale: false,
          revision: 1,
          written_at: "2026-08-21T06:00:00Z",
        },
      });

      renderDigestReaderPage("/digest/day/2026-08-20");

      expect(await screen.findByRole("button", { name: "Previous Digest" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Next Digest" })).toBeDisabled();
    });
  });
});
