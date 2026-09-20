import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "@/lib/settings";
import { TimeSourcesSection } from "./time-sources-section";

function renderSection() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter>
        <TimeSourcesSection />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("TimeSourcesSection", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    useSettingsStore.setState({ serverUrl: "", serverReachable: true });
  });

  it("adds a named Toggl Activity source and shows the configured source", async () => {
    useSettingsStore.getState().setServerUrl("https://time.example");
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/v1/time/sources") && init?.method === "POST") {
        expect(JSON.parse(init.body as string)).toEqual({
          name: "Work activity",
          kind: "toggl_activity",
          path: "/Users/me/Toggl.sqlite",
        });
        return {
          ok: true,
          status: 201,
          json: async () => ({
            id: "toggl-source",
            name: "Work activity",
            kind: "toggl_activity",
            path: "/Users/me/Toggl.sqlite",
            enabled: true,
          }),
        };
      }
      return { ok: true, status: 200, json: async () => [] };
    });
    vi.stubGlobal("fetch", fetchMock);

    renderSection();

    fireEvent.change(screen.getByLabelText("Source name"), { target: { value: "Work activity" } });
    fireEvent.change(screen.getByLabelText("Toggl database path"), {
      target: { value: "/Users/me/Toggl.sqlite" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add Time source" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Work activity")).toBeInTheDocument();
    expect(screen.getByText("Added. Importing activity in the background.")).toBeInTheDocument();
  });
});
