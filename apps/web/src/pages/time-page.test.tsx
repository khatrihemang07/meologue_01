import type { ServerCapabilities } from "@meologue/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    expect(screen.getByRole("list", { name: "Toggl Track activity" })).toHaveTextContent("Code");
    expect(screen.getByRole("list", { name: "Clockify Desktop activity" })).toHaveTextContent(
      "Figma",
    );

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
    expect(detailRequests).toBe(0);

    fireEvent.click(block);

    const detail = await screen.findByRole("region", { name: "Activity interval" });
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
      expect(screen.queryByRole("region", { name: "Activity interval" })).not.toBeInTheDocument(),
    );
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
});
