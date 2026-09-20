import type { ServerCapabilities } from "@meologue/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "@/lib/settings";
import { TimePage } from "./time-page";

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

  it("shows a configured source's recorded intervals in today's daily timeline", async () => {
    useSettingsStore.setState({
      serverUrl: "https://server.example",
      capabilities: { reflect: true, digest: true, embeddings: true, todo: true, time: true },
    });
    const fetchMock = vi.fn(async (url: string) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/v1/time/sources") {
        return {
          ok: true,
          status: 200,
          json: async () => [
            {
              id: "toggl-source",
              name: "My Toggl activity",
              kind: "toggl_activity",
              path: "/Users/me/Toggl.sqlite",
              enabled: true,
            },
          ],
        };
      }
      if (parsed.pathname === "/v1/time/intervals") {
        expect(parsed.searchParams.get("source_id")).toBe("toggl-source");
        expect(parsed.searchParams.get("day")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        return {
          ok: true,
          status: 200,
          json: async () => [
            {
              id: "interval-1",
              source_id: "toggl-source",
              provider_record_id: "provider-1",
              started_at: "2026-09-20T10:00:00Z",
              ended_at: "2026-09-20T10:01:15Z",
              label: "Code",
              detail: "Welcome — meologue_01",
            },
          ],
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();

    expect(await screen.findByRole("heading", { name: "Today" })).toBeInTheDocument();
    expect(screen.getByText("My Toggl activity")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Activity timeline" })).toHaveTextContent("Code");
    expect(screen.getByText("Welcome — meologue_01")).toBeInTheDocument();
    expect(screen.getByText("1m 15s")).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("opens a useful empty state when the Server supports Time but has no sources", () => {
    useSettingsStore.setState({
      serverUrl: "https://server.example",
      capabilities: { reflect: true, digest: true, embeddings: true, todo: true, time: true },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => [] })),
    );

    renderPage();

    expect(screen.getByRole("banner")).toHaveTextContent("Time");
    return screen
      .findByText(/No Time sources are enabled yet/i)
      .then(() =>
        expect(screen.getByRole("link", { name: "Server Settings" })).toHaveAttribute(
          "href",
          "/settings",
        ),
      );
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
