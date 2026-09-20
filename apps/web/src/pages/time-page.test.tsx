import type { ServerCapabilities } from "@meologue/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  it("hides and restores a source lane without refetching the day", async () => {
    useSettingsStore.setState({ serverUrl: "https://server.example", capabilities: SUPPORTED });
    const fetchMock = stubServer({
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
    });

    renderPage();

    const clockifyLane = await screen.findByRole("switch", { name: "Clockify Desktop lane" });
    expect(clockifyLane).toHaveAttribute("aria-checked", "true");

    fireEvent.click(clockifyLane);

    // The lane goes; its switch stays, so it can be brought back.
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "Clockify Desktop lane" }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("region", { name: "Toggl Track lane" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Clockify Desktop lane" })).toHaveAttribute(
      "aria-checked",
      "false",
    );

    fireEvent.click(screen.getByRole("switch", { name: "Clockify Desktop lane" }));
    expect(
      await screen.findByRole("region", { name: "Clockify Desktop lane" }),
    ).toBeInTheDocument();

    // Lane selection is a rendering decision over a day already fetched.
    expect(fetchMock).toHaveBeenCalledTimes(2);
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

  it("says a configured Server simply recorded nothing today", async () => {
    useSettingsStore.setState({ serverUrl: "https://server.example", capabilities: SUPPORTED });
    stubServer({ sources: [sourceFixture({})], intervals: [] });

    renderPage();

    expect(await screen.findByText(/No activity was recorded today/i)).toBeInTheDocument();
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
});
