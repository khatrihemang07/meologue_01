import type { ServerCapabilities } from "@meologue/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { useSettingsStore } from "@/lib/settings";
import { TimePage } from "./time-page";

/**
 * What this file can and cannot settle.
 *
 * jsdom has no layout engine, so nothing here can prove that two overlapping
 * records really are drawn side by side — every box it measures is zero. The
 * geometry claims live in `lib/time-lanes.test.ts`, against the fractions this
 * page turns into styles. What belongs here is everything jsdom *can* see:
 * that a lane exists per recorder, that each is separately named and
 * switchable, that an archived source keeps its lane, and that a day is
 * fetched once rather than once per source.
 */

const SUPPORTED: ServerCapabilities = {
  reflect: true,
  digest: true,
  embeddings: true,
  todo: true,
  time: true,
} as ServerCapabilities;

/**
 * An instant at `hour` today, so these fixtures stay inside the Device-local
 * day the page builds its scale from whenever the suite happens to run.
 */
function todayAt(hour: number, minute = 0, second = 0): string {
  const instant = new Date();
  instant.setHours(hour, minute, second, 0);
  return instant.toISOString();
}

function intervalFixture(overrides: Record<string, unknown>) {
  return {
    id: "interval-1",
    source_id: "toggl-source",
    source_name: "Toggl Track",
    source_kind: "toggl_activity",
    source_enabled: true,
    provider_record_id: "provider-1",
    started_at: todayAt(10),
    ended_at: todayAt(10, 1, 15),
    label: "Code",
    detail: "Welcome — meologue_01",
    idle: false,
    ...overrides,
  };
}

function sourceFixture(overrides: Record<string, unknown>) {
  return {
    id: "toggl-source",
    name: "Toggl Track",
    kind: "toggl_activity",
    path: "/Users/me/Toggl.sqlite",
    enabled: true,
    // The import status a real Server always sends (issue #421). Omitting it
    // here made every test run as though an import were in flight, which is a
    // state no Server this code talks to can actually report.
    last_attempt_at: "2026-09-20T09:00:00Z",
    last_success_at: "2026-09-20T09:00:05Z",
    last_inserted_count: 0,
    last_warning_count: 0,
    last_error: null,
    last_scheduled_run_on: null,
    // Issue #418: `null` here (rather than omitted) matches what a real
    // Server sends for a source with no stored records — same reason
    // `last_attempt_at`/`last_success_at` are stated explicitly above rather
    // than left to accidentally read as "an import is running".
    newest_record_at: null,
    state: "idle",
    ...overrides,
  };
}

function stubServer({
  sources,
  intervals,
  onIntervalsRequest,
}: {
  sources: unknown[];
  intervals: unknown[];
  onIntervalsRequest?: (url: URL) => void;
}) {
  const fetchMock = vi.fn(async (url: string) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/v1/time/sources") {
      return { ok: true, status: 200, json: async () => sources };
    }
    if (parsed.pathname === "/v1/time/intervals") {
      onIntervalsRequest?.(parsed);
      return { ok: true, status: 200, json: async () => intervals };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderPage() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter>
        <TimePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("TimePage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    useSettingsStore.setState({ serverUrl: "", capabilities: null });
  });

  it("gives each recorder its own lane against the same day", async () => {
    useSettingsStore.setState({ serverUrl: "https://server.example", capabilities: SUPPORTED });
    let requested: URL | undefined;
    const fetchMock = stubServer({
      sources: [
        sourceFixture({}),
        sourceFixture({
          id: "clockify-source",
          name: "Clockify Desktop",
          kind: "clockify_auto_tracker",
        }),
      ],
      intervals: [
        intervalFixture({}),
        intervalFixture({
          id: "interval-2",
          source_id: "clockify-source",
          source_name: "Clockify Desktop",
          source_kind: "clockify_auto_tracker",
          label: "Figma",
          detail: "Time lanes",
          // Deliberately the same clock period as the Toggl record: the point
          // of lanes is that both stay readable rather than one winning.
          started_at: todayAt(10),
          ended_at: todayAt(10, 1, 15),
        }),
      ],
      onIntervalsRequest: (url) => {
        requested = url;
      },
    });

    renderPage();

    expect(await screen.findByRole("heading", { name: "Today" })).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "Toggl Track lane" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Clockify Desktop lane" })).toBeInTheDocument();
    // The accessible name, not visible text content: issue #429 draws a
    // record this short (75s, well under the minimum span) at a fixed 8px
    // with no inline label at all — the tooltip and accessible name are what
    // carry its facts at that size, which is exactly what this asserts.
    expect(
      within(screen.getByRole("list", { name: "Toggl Track activity" })).getByRole("button", {
        name: /^Code,/,
      }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("list", { name: "Clockify Desktop activity" })).getByRole("button", {
        name: /^Figma,/,
      }),
    ).toBeInTheDocument();

    // One request for the whole day, not one per source — the response already
    // says which recorder each record came from.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(requested?.searchParams.get("day")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(requested?.searchParams.has("source_id")).toBe(false);
  });

  it("hides and restores a source lane, asking the Server for the selection", async () => {
    // Since issue #424 lane selection is part of the query rather than a
    // client-side filter over a whole day: the Server's daily query accepts
    // the selected source ids, and a day fetched with a selection is cached
    // under that selection, so stepping back to it is instant.
    useSettingsStore.setState({ serverUrl: "https://server.example", capabilities: SUPPORTED });
    const requests: string[] = [];
    stubServer({
      sources: [
        sourceFixture({}),
        sourceFixture({ id: "clockify-source", name: "Clockify Desktop" }),
      ],
      intervals: [
        intervalFixture({}),
        intervalFixture({
          id: "interval-2",
          source_id: "clockify-source",
          source_name: "Clockify Desktop",
          label: "Figma",
        }),
      ],
      onIntervalsRequest: (url) => {
        requests.push(url.searchParams.get("source_ids") ?? "<absent>");
      },
    });

    renderPage();

    const clockifyLane = await screen.findByRole("switch", { name: "Clockify Desktop lane" });
    expect(clockifyLane).toHaveAttribute("aria-checked", "true");
    // Nothing hidden means no selection to send: the Server's default is
    // every source, and sending an explicit list would be noise.
    await waitFor(() => expect(requests).toEqual(["<absent>"]));

    fireEvent.click(clockifyLane);

    await waitFor(() => expect(requests).toEqual(["<absent>", "toggl-source"]));
    expect(screen.getByRole("switch", { name: "Clockify Desktop lane" })).toHaveAttribute(
      "aria-checked",
      "false",
    );

    // The switch stays even with no records of its own in the response, which
    // is why the picker is built from the configured sources rather than from
    // the day that came back.
    fireEvent.click(screen.getByRole("switch", { name: "Clockify Desktop lane" }));
    expect(
      await screen.findByRole("region", { name: "Clockify Desktop lane" }),
    ).toBeInTheDocument();
  });

  it("keeps an archived source's lane and says that is what it is", async () => {
    // Archiving stops future imports; it does not erase the days a recorder
    // already covered, so its lane has to stay identifiable (issue #423).
    useSettingsStore.setState({ serverUrl: "https://server.example", capabilities: SUPPORTED });
    stubServer({
      sources: [sourceFixture({})],
      intervals: [
        intervalFixture({}),
        intervalFixture({
          id: "interval-2",
          source_id: "retired-source",
          source_name: "Retired recorder",
          source_enabled: false,
          label: "Old work",
        }),
      ],
    });

    renderPage();

    const lane = await screen.findByRole("region", { name: "Retired recorder lane" });
    expect(lane).toHaveTextContent("archived");
    expect(lane).toHaveAttribute("data-source-enabled", "false");
  });

  it("does not hide a lone recorder behind a lane picker", async () => {
    // With one recorder there is nothing to compare and nothing to switch off,
    // so the picker would only be a control that removes the whole page.
    useSettingsStore.setState({ serverUrl: "https://server.example", capabilities: SUPPORTED });
    stubServer({ sources: [sourceFixture({})], intervals: [intervalFixture({})] });

    renderPage();

    expect(await screen.findByRole("region", { name: "Toggl Track lane" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Source lanes" })).not.toBeInTheDocument();
  });

  it("says a configured Server simply recorded nothing on this day", async () => {
    useSettingsStore.setState({ serverUrl: "https://server.example", capabilities: SUPPORTED });
    stubServer({ sources: [sourceFixture({})], intervals: [] });

    renderPage();

    expect(await screen.findByText(/No activity was recorded on this day/i)).toBeInTheDocument();
    // Distinct from having no source at all, which sends you to Settings.
    expect(screen.queryByText(/No Time sources are enabled yet/i)).not.toBeInTheDocument();
  });

  it("opens a useful empty state when the Server supports Time but has no sources", async () => {
    useSettingsStore.setState({ serverUrl: "https://server.example", capabilities: SUPPORTED });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => [] })),
    );

    renderPage();

    expect(screen.getByRole("banner")).toHaveTextContent("Time");
    await screen.findByText(/No Time sources are enabled yet/i);
    expect(screen.getByRole("link", { name: "Server Settings" })).toHaveAttribute(
      "href",
      "/settings",
    );
  });

  it("treats a Server whose only source is archived as having none enabled", async () => {
    useSettingsStore.setState({ serverUrl: "https://server.example", capabilities: SUPPORTED });
    stubServer({ sources: [sourceFixture({ enabled: false })], intervals: [] });

    renderPage();

    expect(await screen.findByText(/No Time sources are enabled yet/i)).toBeInTheDocument();
  });

  it("explains that Time needs a Server when Sync is off", () => {
    renderPage();

    expect(screen.getByText(/Sync is off/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /add a Server URL/i })).toHaveAttribute(
      "href",
      "/settings",
    );
  });

  it("does not present an older Server without the Time capability as an empty Time source list", () => {
    useSettingsStore.setState({
      serverUrl: "https://server.example",
      capabilities: {
        reflect: true,
        digest: true,
        embeddings: true,
        todo: true,
      } as unknown as ServerCapabilities,
    });

    renderPage();

    expect(screen.getByText(/doesn't support Time yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/No Time sources are enabled yet/i)).not.toBeInTheDocument();
  });

  it("moves between days by calendar date and can come back to today", async () => {
    // Stepping a date, not adding 24 hours: on a daylight-saving day those
    // are different, and the Server's own day boundaries are calendar ones.
    useSettingsStore.setState({ serverUrl: "https://server.example", capabilities: SUPPORTED });
    const days: string[] = [];
    stubServer({
      sources: [sourceFixture({})],
      intervals: [intervalFixture({})],
      onIntervalsRequest: (url) => {
        const day = url.searchParams.get("day");
        if (day) days.push(day);
      },
    });

    renderPage();

    await screen.findByRole("region", { name: "Toggl Track lane" });
    const today = new Date();
    const iso = (date: Date) =>
      `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
        date.getDate(),
      ).padStart(2, "0")}`;
    const shift = (days: number) => {
      const at = new Date(today);
      at.setDate(at.getDate() + days);
      return iso(at);
    };

    expect(days).toEqual([iso(today)]);
    // "Today" is the label while it is today, and disabled because it is
    // already where you are.
    expect(screen.getByRole("heading", { name: "Today" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Today" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Previous day" }));
    await waitFor(() => expect(days).toEqual([iso(today), shift(-1)]));
    // The heading names the day once it is not today, so the view never
    // claims to be showing today when it is not.
    expect(screen.queryByRole("heading", { name: "Today" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Next day" }));
    await waitFor(() => expect(days.at(-1)).toBe(iso(today)));

    fireEvent.click(screen.getByRole("button", { name: "Next day" }));
    await waitFor(() => expect(days.at(-1)).toBe(shift(1)));

    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    await waitFor(() => expect(days.at(-1)).toBe(iso(today)));
  });

  it("sends a search term to the Server and says what it narrowed to", async () => {
    // Time searches what recorders observed. Narrowing happens on the Server,
    // against the normalized label and detail, and never reaches into
    // Entries, Tasks or any other Destination.
    useSettingsStore.setState({ serverUrl: "https://server.example", capabilities: SUPPORTED });
    const terms: (string | null)[] = [];
    stubServer({
      sources: [sourceFixture({})],
      intervals: [intervalFixture({})],
      onIntervalsRequest: (url) => terms.push(url.searchParams.get("q")),
    });

    renderPage();
    await screen.findByRole("region", { name: "Toggl Track lane" });

    fireEvent.change(screen.getByLabelText("Search this day's activity"), {
      target: { value: "xcode" },
    });

    await waitFor(() => expect(terms.at(-1)).toBe("xcode"));
    expect(await screen.findByText(/matching .xcode./)).toBeInTheDocument();

    // A cleared box asks for the whole day again rather than for nothing.
    fireEvent.change(screen.getByLabelText("Search this day's activity"), {
      target: { value: "   " },
    });
    await waitFor(() => expect(terms.at(-1)).toBe(null));
  });

  it("says when a search matched nothing, distinctly from an empty day", async () => {
    useSettingsStore.setState({ serverUrl: "https://server.example", capabilities: SUPPORTED });
    stubServer({ sources: [sourceFixture({})], intervals: [] });

    renderPage();
    await screen.findByText(/No activity was recorded on this day/i);

    fireEvent.change(screen.getByLabelText("Search this day's activity"), {
      target: { value: "nothing" },
    });

    expect(await screen.findByText(/Nothing on this day matches/)).toBeInTheDocument();
  });

  it("fetches a record's provider evidence only when the record is opened", async () => {
    // The whole reason the daily response omits `raw_row`: a dense day would
    // otherwise carry every provider's icons and BLOBs whether or not anyone
    // looked at one.
    useSettingsStore.setState({ serverUrl: "https://server.example", capabilities: SUPPORTED });
    let detailRequests = 0;
    const fetchMock = vi.fn(async (url: string) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/v1/time/sources") {
        return { ok: true, status: 200, json: async () => [sourceFixture({})] };
      }
      if (parsed.pathname === "/v1/time/intervals") {
        return { ok: true, status: 200, json: async () => [intervalFixture({ idle: true })] };
      }
      if (parsed.pathname === "/v1/time/intervals/interval-1") {
        detailRequests += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ...intervalFixture({ idle: true }),
            raw_row: {
              ZFILENAME: { type: "text", value: "Code" },
              ZISIDLE: { type: "integer", value: 1 },
              ZCLIENT: { type: "blob", base64: "3q2+7w==" },
              ZTITLE: { type: "null" },
            },
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();

    const block = await screen.findByRole("button", { name: /^Code,/ });
    expect(block).toHaveAttribute("aria-expanded", "false");
    // Issue #429: the hover tooltip carries what a block this small cannot
    // show in its own text.
    expect(block).toHaveAttribute("title", expect.stringContaining("Code"));
    expect(detailRequests).toBe(0);

    fireEvent.click(block);

    // The below-the-timeline panel is gone (issue #429): detail is now a
    // Radix Popover anchored to the block, `role="dialog"` rather than
    // `role="region"`.
    const detail = await screen.findByRole("dialog", { name: "Activity interval" });
    await waitFor(() => expect(detailRequests).toBe(1));

    const facts = within(detail);
    expect(facts.getByText("Toggl Track")).toBeInTheDocument();
    expect(facts.getByText("Welcome — meologue_01")).toBeInTheDocument();
    expect(facts.getByText("Reported by the recorder")).toBeInTheDocument();
    // Every provider column is offered, including the ones nothing maps.
    expect(facts.getByText("ZISIDLE")).toBeInTheDocument();
    // A BLOB is described, not pasted in as mangled text.
    expect(facts.getByText(/binary \(8 base64 characters\)/)).toBeInTheDocument();

    fireEvent.click(facts.getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Activity interval" })).not.toBeInTheDocument(),
    );
    // Closing returns focus to the record that opened it, rather than
    // leaving focus nowhere (Radix's own default has nothing real to
    // restore it to — see `comparative-timeline.tsx`'s own comment on why
    // `IntervalBlock` owns this itself).
    expect(block).toHaveFocus();
  });

  describe("a short block's click target stays inside its own slot (issue #429)", () => {
    it("draws a sub-minimum record's <li> at exactly the 8px floor, with a button carrying no vertical padding or loose line height that could push it taller", async () => {
      // Measured in a real browser: the button's content (`py-0.5` padding
      // plus a 10px text line at `leading-tight`) rendered ~18px tall inside
      // an 8px `<li>`, so a "short" block's real click target reached into
      // its neighbours regardless of how tightly `time-lanes.ts` packed
      // them. jsdom cannot measure the button's own rendered box (no layout
      // engine), but it CAN read back the exact inline style React set on
      // the `<li>` slot, and the exact classes the button was given — which
      // is what this asserts instead: the slot is genuinely 8px, and the
      // button's own classes guarantee nothing inside it can exceed that
      // (`h-full`/`min-h-0` rather than a content-driven height, no `py-*`,
      // `leading-none` rather than `leading-tight`), plus the label line
      // itself is absent below `LABEL_MIN_PX` rather than merely small.
      useSettingsStore.setState({ serverUrl: "https://server.example", capabilities: SUPPORTED });
      // 75s, well under the 4-minute minimum span at the default 120px/hour
      // zoom (`minimumFraction(120)`), so `placeLane` inflates it to the
      // minimum and `IntervalBlock` floors its rendered height at
      // `MIN_TARGET_PX` (8px).
      stubServer({ sources: [sourceFixture({})], intervals: [intervalFixture({})] });

      renderPage();

      const block = await screen.findByRole("button", { name: /^Code,/ });
      const slot = block.closest("li");
      expect(slot).toHaveStyle({ height: "8px" });

      expect(block.className).toContain("h-full");
      expect(block.className).toContain("min-h-0");
      expect(block.className).toContain("leading-none");
      expect(block.className).not.toMatch(/\bpy-\d/);
      expect(block.className).not.toContain("leading-tight");

      // Too short to fit even the label — the tooltip and accessible name
      // carry its facts instead.
      expect(block).toHaveTextContent("");
    });
  });

  describe("record detail popover (issue #429)", () => {
    function stubDetailServer() {
      let detailRequests = 0;
      const fetchMock = vi.fn(async (url: string) => {
        const parsed = new URL(url);
        if (parsed.pathname === "/v1/time/sources") {
          return { ok: true, status: 200, json: async () => [sourceFixture({})] };
        }
        if (parsed.pathname === "/v1/time/intervals") {
          return { ok: true, status: 200, json: async () => [intervalFixture({})] };
        }
        if (parsed.pathname === "/v1/time/intervals/interval-1") {
          detailRequests += 1;
          return {
            ok: true,
            status: 200,
            json: async () => ({ ...intervalFixture({}), raw_row: {} }),
          };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      });
      vi.stubGlobal("fetch", fetchMock);
      return () => detailRequests;
    }

    it("closes on Escape and returns focus to the record", async () => {
      useSettingsStore.setState({ serverUrl: "https://server.example", capabilities: SUPPORTED });
      stubDetailServer();
      renderPage();

      const block = await screen.findByRole("button", { name: /^Code,/ });
      fireEvent.click(block);
      await screen.findByRole("dialog", { name: "Activity interval" });

      fireEvent.keyDown(document, { key: "Escape" });

      await waitFor(() =>
        expect(screen.queryByRole("dialog", { name: "Activity interval" })).not.toBeInTheDocument(),
      );
      expect(block).toHaveFocus();
    });

    it("closes on an outside click and returns focus to the record", async () => {
      useSettingsStore.setState({ serverUrl: "https://server.example", capabilities: SUPPORTED });
      stubDetailServer();
      renderPage();

      const block = await screen.findByRole("button", { name: /^Code,/ });
      fireEvent.click(block);
      await screen.findByRole("dialog", { name: "Activity interval" });

      // Radix's DismissableLayer registers its own `document` pointerdown
      // listener in a `setTimeout(0)` after mount — the same race a real
      // browser has for a click in the same tick a popover opens
      // (task-detail-view.test.tsx's own `clickOutside` helper documents
      // the identical wait). Without it this dispatches into a listener
      // that doesn't exist yet.
      await new Promise((resolve) => setTimeout(resolve, 0));
      fireEvent.pointerDown(document.body);
      fireEvent.click(document.body);

      await waitFor(() =>
        expect(screen.queryByRole("dialog", { name: "Activity interval" })).not.toBeInTheDocument(),
      );
      expect(block).toHaveFocus();
    });

    it("toggles closed when the same open record is clicked again", async () => {
      useSettingsStore.setState({ serverUrl: "https://server.example", capabilities: SUPPORTED });
      stubDetailServer();
      renderPage();

      const block = await screen.findByRole("button", { name: /^Code,/ });
      fireEvent.click(block);
      await screen.findByRole("dialog", { name: "Activity interval" });

      fireEvent.click(block);

      await waitFor(() =>
        expect(screen.queryByRole("dialog", { name: "Activity interval" })).not.toBeInTheDocument(),
      );
    });

    it("carries the Android back-button opt-in marker so hardware Back closes it instead of leaving Time", async () => {
      // platform/back-button.android.ts's own DISMISSIBLE_OVERLAY_SELECTOR
      // only recognizes an overlay it can positively identify — this
      // popover matches none of its other fingerprints (a plain Radix
      // Popover, `role="dialog"`, no `data-slot`), so it opts in with this
      // marker. That file's own suite proves the selector; this proves the
      // marker is actually on the element it depends on, in the real DOM
      // Radix renders, and that a dispatched Escape (what a positive match
      // triggers) really does close a REAL Radix Popover, not just a
      // hand-built stand-in div.
      useSettingsStore.setState({ serverUrl: "https://server.example", capabilities: SUPPORTED });
      stubDetailServer();
      renderPage();

      const block = await screen.findByRole("button", { name: /^Code,/ });
      fireEvent.click(block);
      const detail = await screen.findByRole("dialog", { name: "Activity interval" });
      expect(detail).toHaveAttribute("data-back-dismissible", "");
      expect(detail).toHaveAttribute("data-state", "open");

      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );

      await waitFor(() =>
        expect(screen.queryByRole("dialog", { name: "Activity interval" })).not.toBeInTheDocument(),
      );
    });
  });

  it("starts a refresh and says how many sources it queued", async () => {
    useSettingsStore.setState({ serverUrl: "https://server.example", capabilities: SUPPORTED });
    let refreshes = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const parsed = new URL(url);
        if (parsed.pathname === "/v1/time/refresh" && init?.method === "POST") {
          refreshes += 1;
          return { ok: true, status: 202, json: async () => ({ queued: 2 }) };
        }
        if (parsed.pathname === "/v1/time/sources") {
          return { ok: true, status: 200, json: async () => [sourceFixture({})] };
        }
        return { ok: true, status: 200, json: async () => [] };
      }),
    );

    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Refresh now" }));

    expect(await screen.findByText(/Importing 2 sources…/)).toBeInTheDocument();
    expect(refreshes).toBe(1);
  });

  it("says an import is already running rather than quietly doing nothing", async () => {
    // Two runs over the same sources would race each other's writes, so a
    // second press has to be told, not ignored.
    useSettingsStore.setState({ serverUrl: "https://server.example", capabilities: SUPPORTED });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const parsed = new URL(url);
        if (parsed.pathname === "/v1/time/refresh" && init?.method === "POST") {
          return { ok: false, status: 409, json: async () => ({}) };
        }
        if (parsed.pathname === "/v1/time/sources") {
          return { ok: true, status: 200, json: async () => [sourceFixture({})] };
        }
        return { ok: true, status: 200, json: async () => [] };
      }),
    );

    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Refresh now" }));

    expect(await screen.findByText("An import is already running.")).toBeInTheDocument();
  });

  it("reports each source's own outcome, so one failure hides no others", async () => {
    // The point of recording outcomes per source rather than per run: a
    // broken recorder must be readable *beside* the healthy ones, not instead
    // of them.
    useSettingsStore.setState({ serverUrl: "https://server.example", capabilities: SUPPORTED });
    stubServer({
      sources: [
        sourceFixture({
          name: "Healthy",
          last_inserted_count: 12,
          last_warning_count: 3,
        }),
        sourceFixture({
          id: "broken-source",
          name: "Broken",
          last_error: "source database is unreadable",
          last_success_at: null,
        }),
        sourceFixture({
          id: "busy-source",
          name: "Busy",
          state: "running",
        }),
      ],
      intervals: [],
    });

    renderPage();

    const status = within(await screen.findByRole("list", { name: "Time source status" }));
    expect(status.getByText(/12 new/)).toBeInTheDocument();
    expect(status.getByText(/3 record\(s\) skipped/)).toBeInTheDocument();
    expect(status.getByText(/Last run failed — source database is unreadable/)).toBeInTheDocument();
    expect(status.getByText("running")).toBeInTheDocument();
    // The nightly run is reported separately from the last success: any
    // trigger moves the success, but only a completed daily run moves this.
    expect(status.getAllByText(/no nightly run yet/)).toHaveLength(2);

    // While a run is in flight the action says so and cannot start a second.
    expect(screen.getByRole("button", { name: "Importing…" })).toBeDisabled();
  });

  it("does not poll a Server that has Time but cannot report run state", async () => {
    // A Server between #418 and #421 sends no `state` at all. Treating that
    // as "running" would leave the page polling it forever and the Refresh
    // action permanently disabled.
    useSettingsStore.setState({ serverUrl: "https://server.example", capabilities: SUPPORTED });
    const older = sourceFixture({});
    delete (older as Record<string, unknown>).state;
    stubServer({ sources: [older], intervals: [] });

    renderPage();

    expect(await screen.findByRole("button", { name: "Refresh now" })).toBeEnabled();
  });

  it("survives a run finishing, and re-reads the day it imported into", async () => {
    // The transition no other test here made: running -> idle. Handling it
    // during render called `setMessage` on every subsequent render and React
    // tore the page down with "Too many re-renders" — which only showed up
    // when a real import finished in a real browser.
    useSettingsStore.setState({ serverUrl: "https://server.example", capabilities: SUPPORTED });
    let running = true;
    let intervalRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const parsed = new URL(url);
        if (parsed.pathname === "/v1/time/refresh" && init?.method === "POST") {
          return { ok: true, status: 202, json: async () => ({ queued: 1 }) };
        }
        if (parsed.pathname === "/v1/time/sources") {
          const state = running ? "running" : "idle";
          // The next poll sees the run finished.
          running = false;
          return { ok: true, status: 200, json: async () => [sourceFixture({ state })] };
        }
        if (parsed.pathname === "/v1/time/intervals") {
          intervalRequests += 1;
          return { ok: true, status: 200, json: async () => [] };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      }),
    );

    renderPage();

    // While the run is in flight the action says so and cannot start another.
    expect(await screen.findByRole("button", { name: "Importing…" })).toBeDisabled();

    // Once it ends the page is still alive, says so, and has re-read the day
    // the run may have imported into.
    expect(await screen.findByRole("button", { name: "Refresh now" })).toBeEnabled();
    // Issue #418: the finish message now names each source's own result
    // (`importSummary`) rather than a flat "Import finished." — here, one
    // source that found nothing new and has no stored record of its own yet.
    expect(
      await screen.findByText("Nothing new. Newest records: Toggl Track never."),
    ).toBeInTheDocument();
    await waitFor(() => expect(intervalRequests).toBeGreaterThan(1));

    // And it settles: no render loop, so the message does not keep churning.
    const settled = intervalRequests;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(intervalRequests).toBe(settled);
  });

  it("names each source's new count when a refresh finishes having imported something", async () => {
    // The other half of `importSummary`: once at least one source actually
    // found something, the message is the per-source new-count line, not the
    // all-zero "Nothing new" phrasing above.
    useSettingsStore.setState({ serverUrl: "https://server.example", capabilities: SUPPORTED });
    let running = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const parsed = new URL(url);
        if (parsed.pathname === "/v1/time/refresh" && init?.method === "POST") {
          return { ok: true, status: 202, json: async () => ({ queued: 2 }) };
        }
        if (parsed.pathname === "/v1/time/sources") {
          const state = running ? "running" : "idle";
          // The next poll sees the run finished.
          running = false;
          return {
            ok: true,
            status: 200,
            json: async () => [
              sourceFixture({
                id: "toggl-source",
                name: "Toggl Track",
                last_inserted_count: 25,
                state,
              }),
              sourceFixture({
                id: "clockify-source",
                name: "Clockify Desktop",
                last_inserted_count: 20,
                state,
              }),
            ],
          };
        }
        if (parsed.pathname === "/v1/time/intervals") {
          return { ok: true, status: 200, json: async () => [] };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      }),
    );

    renderPage();

    expect(await screen.findByRole("button", { name: "Importing…" })).toBeDisabled();
    expect(await screen.findByRole("button", { name: "Refresh now" })).toBeEnabled();
    expect(
      await screen.findByText("Import finished — Toggl Track: 25 new · Clockify Desktop: 20 new"),
    ).toBeInTheDocument();
  });

  it("shows each source's file path and newest record, so a frozen source is diagnosable", async () => {
    // Issue #418: "Refresh now" imported nothing and gave no clue why — the
    // sources pointed at stale snapshot copies of the recorder databases.
    // Neither fact (which file, how recent its data) was visible anywhere.
    useSettingsStore.setState({ serverUrl: "https://server.example", capabilities: SUPPORTED });
    stubServer({
      sources: [
        sourceFixture({
          path: "/Users/me/Library/Application Support/stale-copy/Toggl.sqlite",
          newest_record_at: todayAt(8, 12),
        }),
      ],
      intervals: [],
    });

    renderPage();

    const status = within(await screen.findByRole("list", { name: "Time source status" }));
    expect(
      status.getByText("/Users/me/Library/Application Support/stale-copy/Toggl.sqlite"),
    ).toBeInTheDocument();
    expect(status.getByText(/Newest record 08:12/)).toBeInTheDocument();
  });

  it("changes the timeline's scale height and disables zoom buttons at each end", async () => {
    // Issue #418: the page used to render every day at one fixed 120px/hour
    // scale, unreadable for records a few seconds long. `use-timeline-zoom.ts`
    // owns the gesture wiring (its own test file covers ctrl+wheel, pinch and
    // the keyboard); this only has to prove the buttons this page renders are
    // actually wired to it — the lane element's own drawn height changes, and
    // both buttons disable at the ends of `ZOOM_LEVELS`.
    useSettingsStore.setState({ serverUrl: "https://server.example", capabilities: SUPPORTED });
    stubServer({ sources: [sourceFixture({})], intervals: [intervalFixture({})] });

    renderPage();

    const lane = await screen.findByRole("list", { name: "Toggl Track activity" });
    // 120px/hour, the default (`zoomLevelAt`'s own `DEFAULT_ZOOM_INDEX`).
    expect(lane).toHaveStyle({ height: "2880px" });

    const zoomIn = screen.getByRole("button", { name: "Zoom in" });
    const zoomOut = screen.getByRole("button", { name: "Zoom out" });
    expect(zoomOut).toBeEnabled();

    fireEvent.click(zoomIn);
    expect(lane).toHaveStyle({ height: "5760px" });

    // Walk to the top of ZOOM_LEVELS and confirm it stops growing and disables.
    for (let i = 0; i < 6; i += 1) {
      fireEvent.click(zoomIn);
    }
    expect(zoomIn).toBeDisabled();
    expect(lane).toHaveStyle({ height: `${3840 * 24}px` });

    // And down to the bottom.
    for (let i = 0; i < 8; i += 1) {
      fireEvent.click(zoomOut);
    }
    expect(zoomOut).toBeDisabled();
    expect(lane).toHaveStyle({ height: `${30 * 24}px` });
  });

  it("gives the scale gutter an explicit height that tracks the current zoom", async () => {
    // Defect fixed by this issue: the gutter's positioned container (the div
    // `scaleMarks`' labels are placed inside, marked `data-time-scale`) had no
    // height of its own — it holds only absolutely-positioned `<span>` marks,
    // which do not contribute to a parent's height — so every mark's `top: N%`
    // resolved against a ZERO-height box and every label collapsed onto the
    // same spot at the gutter's top instead of spreading down the scale.
    useSettingsStore.setState({ serverUrl: "https://server.example", capabilities: SUPPORTED });
    stubServer({ sources: [sourceFixture({})], intervals: [intervalFixture({})] });

    const { container } = renderPage();
    await screen.findByRole("list", { name: "Toggl Track activity" });

    const scale = container.querySelector("[data-time-scale]");
    expect(scale).toHaveStyle({ height: "2880px" });

    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(scale).toHaveStyle({ height: "5760px" });
  });

  describe("landing on the day's activity, not its empty hours (issue #430)", () => {
    /**
     * A stand-in for the real height `DayNavigator`, `RefreshRow` and
     * `SearchField` contribute above the timeline, inside the SAME Shell
     * scroll region the anchor writes `scrollTop` into. jsdom has no layout
     * engine, so every real `getBoundingClientRect` in this suite otherwise
     * comes back hard zero (`time-lanes.test.ts`'s own header comment names
     * the same limitation) — patched here the way
     * `use-timeline-zoom.test.tsx`'s own `renderHarnessWithScaleOffset` does,
     * so the anchor effect's "measure `[data-time-scale]`, not the wrapper"
     * fix (`comparative-timeline.tsx`'s own comment on it) is actually
     * exercised rather than silently degenerating to zero either way.
     */
    const SCALE_OFFSET_PX = 150;
    let restoreGetBoundingClientRect: (() => void) | null = null;

    function stubScrollGeometry() {
      const original = HTMLElement.prototype.getBoundingClientRect;
      HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
        if (this.dataset.testid === "shell-scroll-region") {
          return { top: 0 } as DOMRect;
        }
        if (this.hasAttribute("data-time-scale")) {
          const scroller = document.querySelector<HTMLElement>(
            '[data-testid="shell-scroll-region"]',
          );
          return { top: SCALE_OFFSET_PX - (scroller?.scrollTop ?? 0) } as DOMRect;
        }
        return original.call(this);
      };
      restoreGetBoundingClientRect = () => {
        HTMLElement.prototype.getBoundingClientRect = original;
      };
    }

    afterEach(() => {
      restoreGetBoundingClientRect?.();
      restoreGetBoundingClientRect = null;
    });

    function yesterdayIso(): string {
      const at = new Date();
      at.setDate(at.getDate() - 1);
      return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(
        at.getDate(),
      ).padStart(2, "0")}`;
    }

    function localInstant(daysFromToday: number, hour: number, minute = 0): string {
      const instant = new Date();
      instant.setDate(instant.getDate() + daysFromToday);
      instant.setHours(hour, minute, 0, 0);
      return instant.toISOString();
    }

    it("does not move the scroll while a day change is pending, then lands on the new day's first record", async () => {
      // Measured (pre-fix): scrollTop jumped to ~23:00 on a day whose first
      // record is 00:03. Root cause: `placeholderData: (previous) =>
      // previous` means `lanes` is never empty the instant `day` changes — it
      // is still TODAY's real records while the new day's request is in
      // flight — so an effect anchoring on `dayStart` alone fired against
      // stale data, mapping today's 10:00 record onto the NEW day's scale.
      useSettingsStore.setState({ serverUrl: "https://server.example", capabilities: SUPPORTED });
      stubScrollGeometry();

      let releaseYesterday: () => void = () => {};
      const yesterday = yesterdayIso();
      const fetchMock = vi.fn(async (url: string) => {
        const parsed = new URL(url);
        if (parsed.pathname === "/v1/time/sources") {
          return { ok: true, status: 200, json: async () => [sourceFixture({})] };
        }
        if (parsed.pathname === "/v1/time/intervals") {
          const day = parsed.searchParams.get("day");
          if (day === yesterday) {
            // The defect's own trigger: the new day's own request does not
            // resolve instantly, leaving the placeholder (today's data) on
            // screen for a beat.
            await new Promise<void>((resolve) => {
              releaseYesterday = resolve;
            });
            return {
              ok: true,
              status: 200,
              json: async () => [
                intervalFixture({
                  id: "interval-yesterday",
                  started_at: localInstant(-1, 0, 3),
                  ended_at: localInstant(-1, 0, 4),
                }),
              ],
            };
          }
          return { ok: true, status: 200, json: async () => [intervalFixture({})] };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      });
      vi.stubGlobal("fetch", fetchMock);

      renderPage();
      await screen.findByRole("region", { name: "Toggl Track lane" });
      const scroller = screen.getByTestId("shell-scroll-region");
      const scrollTopBeforeNavigating = scroller.scrollTop;

      fireEvent.click(screen.getByRole("button", { name: "Previous day" }));

      // While yesterday's own fetch is still pending, the scroll position
      // must not have jumped at all yet.
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      expect(scroller.scrollTop).toBe(scrollTopBeforeNavigating);

      releaseYesterday();

      // Once yesterday's real data lands, it settles on THAT day's first (and
      // only) record: 00:03, 3 minutes into a 1440-minute, 2880px-tall day
      // (6px), plus the scale's own 150px offset within the scroll region,
      // minus the 60px top margin.
      await waitFor(() => expect(scroller.scrollTop).toBe(96));
    });

    it("does not re-anchor a day that only refetched, as Refresh now's running -> idle transition does", async () => {
      // "Refresh now" itself only starts the mutation; the intervals refetch
      // this test cares about is the running -> idle transition
      // `refresh-row.tsx` invalidates `["time", "intervals"]` on — the same
      // mechanism "survives a run finishing, and re-reads the day it
      // imported into" (above) already proves fires. This test's own job is
      // only what THAT refetch must not do to the reader's scroll. (A
      // background refetch of an already-cached query key never goes through
      // TanStack's placeholder phase, so `dataReady` alone already protects
      // this particular case — the next test below is the one that actually
      // needs `anchoredDayRef`.)
      useSettingsStore.setState({ serverUrl: "https://server.example", capabilities: SUPPORTED });
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(2026, 8, 2, 12, 0)); // Sep 2, 2026 (Wed), local noon
      stubScrollGeometry();

      let running = true;
      let intervalRequests = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          const parsed = new URL(url);
          if (parsed.pathname === "/v1/time/sources") {
            const state = running ? "running" : "idle";
            // The next poll sees the run finished.
            running = false;
            return { ok: true, status: 200, json: async () => [sourceFixture({ state })] };
          }
          if (parsed.pathname === "/v1/time/intervals") {
            intervalRequests += 1;
            return {
              ok: true,
              status: 200,
              json: async () => [
                intervalFixture({ started_at: todayAt(8), ended_at: todayAt(8, 5) }),
              ],
            };
          }
          return { ok: false, status: 404, json: async () => ({}) };
        }),
      );

      renderPage();
      await screen.findByRole("region", { name: "Toggl Track lane" });
      const scroller = screen.getByTestId("shell-scroll-region");
      // now (noon) is half the day: 0.5 * 2880 = 1440, plus the scale's own
      // 150px offset, minus the 60px top margin.
      await waitFor(() => expect(scroller.scrollTop).toBe(1530));

      // A reader who scrolled to look at something else, deliberately away
      // from where the anchor landed.
      scroller.scrollTop = 900;

      // The running -> idle transition (a real poll, `refetchInterval: 1000`
      // on the sources query) invalidates and refetches the SAME day's
      // intervals — `lanes` gets a new array identity, but the day itself
      // never changed.
      await waitFor(() => expect(intervalRequests).toBeGreaterThan(1), { timeout: 3000 });

      expect(scroller.scrollTop).toBe(900);

      vi.useRealTimers();
    });

    it("does not re-anchor when a search on the same day goes through a placeholder of its own", async () => {
      // A search term changes the query KEY (`activityIntervalsQueryKey`
      // folds `search` in) without changing `day` — so it goes through
      // exactly the same placeholder-then-real-data cycle a day change does,
      // `dataReady` included: false while the filtered request is in flight,
      // true again once it lands. Unlike a plain background refetch (the
      // test above), THIS is the case `anchoredDayRef` — not `dataReady` on
      // its own — has to keep from re-anchoring, because `dataReady` really
      // does flip back to `true` with `dayStart` unchanged.
      useSettingsStore.setState({ serverUrl: "https://server.example", capabilities: SUPPORTED });
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(2026, 8, 2, 12, 0)); // Sep 2, 2026 (Wed), local noon
      stubScrollGeometry();

      let releaseSearch: () => void = () => {};
      const fetchMock = vi.fn(async (url: string) => {
        const parsed = new URL(url);
        if (parsed.pathname === "/v1/time/sources") {
          return { ok: true, status: 200, json: async () => [sourceFixture({})] };
        }
        if (parsed.pathname === "/v1/time/intervals") {
          if (parsed.searchParams.get("q")) {
            await new Promise<void>((resolve) => {
              releaseSearch = resolve;
            });
            // A label distinct from the unfiltered day's "Code" below, so the
            // test can tell "still showing the PLACEHOLDER" apart from
            // "showing the real filtered result" — the two would otherwise
            // read identically and the assertions below would pass whether
            // or not the real data had actually landed yet.
            return {
              ok: true,
              status: 200,
              json: async () => [
                intervalFixture({
                  id: "interval-xcode",
                  label: "Xcode session",
                  started_at: todayAt(8),
                  ended_at: todayAt(8, 5),
                }),
              ],
            };
          }
          return {
            ok: true,
            status: 200,
            json: async () => [
              intervalFixture({ started_at: todayAt(8), ended_at: todayAt(8, 5) }),
            ],
          };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      });
      vi.stubGlobal("fetch", fetchMock);

      renderPage();
      await screen.findByRole("region", { name: "Toggl Track lane" });
      const scroller = screen.getByTestId("shell-scroll-region");
      // now (noon) is half the day: 0.5 * 2880 = 1440, plus the scale's own
      // 150px offset, minus the 60px top margin.
      await waitFor(() => expect(scroller.scrollTop).toBe(1530));

      // A reader who scrolled to look at something else, deliberately away
      // from where the anchor landed.
      scroller.scrollTop = 900;

      fireEvent.change(screen.getByLabelText("Search this day's activity"), {
        target: { value: "xcode" },
      });

      // While the SAME day's filtered request is pending — the placeholder
      // (still "Code", the unfiltered fixture) — the scroll must not move.
      await waitFor(() =>
        expect(
          fetchMock.mock.calls.some(
            (call) => new URL(String(call[0])).searchParams.get("q") === "xcode",
          ),
        ).toBe(true),
      );
      expect(screen.getByRole("list", { name: "Toggl Track activity" })).toHaveTextContent("Code");
      expect(scroller.scrollTop).toBe(900);

      releaseSearch();

      // The real filtered result lands for the SAME day.
      await screen.findByText("Xcode session");
      expect(scroller.scrollTop).toBe(900);

      vi.useRealTimers();
    });

    it("anchors today with the current time low in the view, recent activity above it", async () => {
      useSettingsStore.setState({ serverUrl: "https://server.example", capabilities: SUPPORTED });
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(2026, 8, 2, 12, 0)); // Sep 2, 2026 (Wed), local noon
      stubScrollGeometry();
      stubServer({
        sources: [sourceFixture({})],
        intervals: [intervalFixture({ started_at: todayAt(8), ended_at: todayAt(8, 5) })],
      });

      // An 800px view, set before the page renders: the anchor reads it once,
      // when today's data first lands. jsdom otherwise reports 0.
      const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
      Object.defineProperty(HTMLElement.prototype, "clientHeight", {
        configurable: true,
        get(this: HTMLElement) {
          return this.dataset.testid === "shell-scroll-region" ? 800 : 0;
        },
      });
      onTestFinished(() => {
        if (clientHeight) {
          Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeight);
        }
      });
      renderPage();
      await screen.findByRole("region", { name: "Toggl Track lane" });
      const scroller = screen.getByTestId("shell-scroll-region");

      // now (noon) is half the day: 0.5 * 2880 = 1440, plus the scale's own
      // 150px offset, minus 70% of the 800px view (560) — so the last few
      // hours sit above "now" instead of a screen of empty afternoon below it.
      await waitFor(() => expect(scroller.scrollTop).toBe(1030));

      vi.useRealTimers();
    });
  });

  it("draws a now line across the lane, only on today, that reads the clock rather than freezing at mount", async () => {
    useSettingsStore.setState({ serverUrl: "https://server.example", capabilities: SUPPORTED });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 8, 2, 12, 0)); // Sep 2, 2026 (Wed), local noon
    stubServer({
      sources: [sourceFixture({})],
      intervals: [intervalFixture({ started_at: todayAt(8), ended_at: todayAt(8, 5) })],
    });

    const { container } = renderPage();
    await screen.findByRole("region", { name: "Toggl Track lane" });

    // Noon is exactly halfway through the day.
    expect(container.querySelector('li[aria-hidden="true"].border-destructive')).toHaveStyle({
      top: "50%",
    });

    // Leave today (unmounting the line — see the next test) and come back
    // once the clock has moved on, rather than waiting out a real 60-second
    // interval tick: this proves `now` actually re-reads `Date.now()` rather
    // than being frozen at the value it first mounted with.
    fireEvent.click(screen.getByRole("button", { name: "Previous day" }));
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Today" })).not.toBeInTheDocument(),
    );
    vi.setSystemTime(new Date(2026, 8, 2, 18, 0)); // 18:00 — three-quarters through the day.
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    await screen.findByRole("heading", { name: "Today" });

    await waitFor(() =>
      expect(container.querySelector('li[aria-hidden="true"].border-destructive')).toHaveStyle({
        top: "75%",
      }),
    );

    vi.useRealTimers();
  });

  it("draws no now line on a day that is not today", async () => {
    useSettingsStore.setState({ serverUrl: "https://server.example", capabilities: SUPPORTED });
    stubServer({ sources: [sourceFixture({})], intervals: [intervalFixture({})] });

    const { container } = renderPage();
    await screen.findByRole("region", { name: "Toggl Track lane" });

    fireEvent.click(screen.getByRole("button", { name: "Previous day" }));
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Today" })).not.toBeInTheDocument(),
    );

    expect(
      container.querySelector('li[aria-hidden="true"].border-destructive'),
    ).not.toBeInTheDocument();
  });
});
