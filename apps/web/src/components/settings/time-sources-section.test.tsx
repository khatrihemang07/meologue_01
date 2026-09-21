import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

  it("posts the recorder that was chosen, not the one the form opened on", async () => {
    // Both supported databases are Core Data SQLite files in similar places,
    // and the Server validates the file against the kind it was told. A form
    // that always sent `toggl_activity` would save a Clockify source that then
    // imported nothing, with no error anywhere to explain it.
    useSettingsStore.getState().setServerUrl("https://time.example");
    let posted: unknown;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/v1/time/sources") && init?.method === "POST") {
        posted = JSON.parse(init.body as string);
        return {
          ok: true,
          status: 201,
          json: async () => ({
            id: "clockify-source",
            name: "Desktop tracker",
            kind: "clockify_auto_tracker",
            path: "/Users/me/Clockify.sqlite",
            enabled: true,
          }),
        };
      }
      return { ok: true, status: 200, json: async () => [] };
    });
    vi.stubGlobal("fetch", fetchMock);

    renderSection();

    fireEvent.change(screen.getByLabelText("Recorder"), {
      target: { value: "clockify_auto_tracker" },
    });
    fireEvent.change(screen.getByLabelText("Source name"), {
      target: { value: "Desktop tracker" },
    });
    // The path field renames itself, so the label is the proof the form
    // followed the choice rather than merely recording it.
    fireEvent.change(screen.getByLabelText("Clockify database path"), {
      target: { value: "/Users/me/Clockify.sqlite" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add Time source" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(posted).toEqual({
      name: "Desktop tracker",
      kind: "clockify_auto_tracker",
      path: "/Users/me/Clockify.sqlite",
    });
    // Scoped to the list: the same label is also the `<option>` that was just
    // chosen, so an unscoped query would pass without the source ever landing.
    const configured = within(screen.getByRole("list", { name: "Configured Time sources" }));
    expect(configured.getByText("Desktop tracker")).toBeInTheDocument();
    expect(configured.getByText("Clockify Desktop — Auto Tracker")).toBeInTheDocument();
  });

  it("archives a source and re-enables it, without ever offering to delete it", async () => {
    // Issue #423: archival stops future imports, and there is deliberately no
    // destructive action here — an Activity interval is evidence attributed to
    // its source, so deleting the source would either orphan the evidence or
    // take it with it.
    useSettingsStore.getState().setServerUrl("https://time.example");
    let enabled = true;
    const patched: unknown[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        const body = JSON.parse(init.body as string);
        patched.push({ url, body });
        enabled = body.enabled;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: "toggl-source",
            name: "Work activity",
            kind: "toggl_activity",
            path: "/Users/me/Toggl.sqlite",
            enabled,
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => [
          {
            id: "toggl-source",
            name: "Work activity",
            kind: "toggl_activity",
            path: "/Users/me/Toggl.sqlite",
            enabled,
          },
        ],
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    renderSection();

    fireEvent.click(await screen.findByRole("button", { name: "Archive Work activity" }));

    const reEnable = await screen.findByRole("button", { name: "Re-enable Work activity" });
    expect(screen.getByText(/Archived\. Its Activity stays/i)).toBeInTheDocument();
    const configured = within(screen.getByRole("list", { name: "Configured Time sources" }));
    expect(configured.getByText(/Work activity \(archived\)/)).toBeInTheDocument();

    fireEvent.click(reEnable);
    await screen.findByRole("button", { name: "Archive Work activity" });
    expect(screen.getByText(/Re-enabled\. Importing anything recorded since/i)).toBeInTheDocument();

    expect(patched).toEqual([
      { url: "https://time.example/v1/time/sources/toggl-source", body: { enabled: false } },
      { url: "https://time.example/v1/time/sources/toggl-source", body: { enabled: true } },
    ]);
    // Nothing on this surface can destroy a source or its evidence.
    expect(screen.queryByRole("button", { name: /delete|remove/i })).not.toBeInTheDocument();
  });

  it("says so when the Server's configuration is locked", async () => {
    // A locked Server keeps refusing however the form is filled in, so this
    // has to read differently from "the Server rejected what you typed".
    useSettingsStore.getState().setServerUrl("https://time.example");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === "PATCH") {
          return { ok: false, status: 423, json: async () => ({}) };
        }
        return {
          ok: true,
          status: 200,
          json: async () => [
            {
              id: "toggl-source",
              name: "Work activity",
              kind: "toggl_activity",
              path: "/Users/me/Toggl.sqlite",
              enabled: true,
            },
          ],
        };
      }),
    );

    renderSection();

    fireEvent.click(await screen.findByRole("button", { name: "Archive Work activity" }));

    expect(await screen.findByText(/configuration is locked/i)).toBeInTheDocument();
    // And the row is unchanged, rather than optimistically showing archived.
    expect(screen.getByRole("button", { name: "Archive Work activity" })).toBeInTheDocument();
  });
});
