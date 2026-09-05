import type { WireConfigResponse } from "@meologue/core";
import { PROTOCOL_VERSION } from "@meologue/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "@/lib/settings";
import { useSyncStatusStore } from "@/lib/sync-status";
import { SyncSection } from "./sync-section";

// Issue #203: `SyncSection` now also reads `useServerConfig` (its own
// "On the server" sub-group), which needs a `QueryClient` in context —
// mirrors `ai-section.test.tsx`'s identical `renderAiSection` helper, a
// fresh client per render so no test's cache can leak into another's.
function renderSyncSection() {
  const queryClient = new QueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <SyncSection />
    </QueryClientProvider>,
  );
}

function healthResponse(protocolVersion: number, capabilities?: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      service: "meologue-server",
      protocol_version: protocolVersion,
      ...(capabilities !== undefined ? { capabilities } : {}),
    }),
  };
}

function errorResponse(status: number) {
  return { ok: false, status, json: async () => ({}) };
}

// Issue #203: `SyncSection` now also fetches `GET /v1/config` for its own
// "On the server" sub-group, against the same stubbed global `fetch` every
// test in this file already points at `/v1/health`. A single unconditional
// mock (this file's own pattern before this ticket) would hand a
// health-shaped body back to a `/v1/config` request too, which the config
// query would happily accept as `{ ok: true }` and then crash rendering
// `ServerSyncFields` against a body with no `tz` field. `stubFetch` routes
// on the request URL so every existing health-check test keeps working
// unchanged, and `/v1/config` gets a plausible, empty response instead.
const EMPTY_CONFIG_RESPONSE: WireConfigResponse = {
  mode: "production",
  locked: false,
  unembedded_entries: 0,
  chat_base_url: { value: null, source: "unset" },
  chat_model: { value: null, source: "unset" },
  chat_api_key: { value: null, source: "unset" },
  embed_base_url: { value: null, source: "unset" },
  embed_model: { value: null, source: "unset" },
  embed_api_key: { value: null, source: "unset" },
  tz: { value: null, source: "unset" },
  reflect: { stored: null, configured: false, boot_active: false, effective: false },
  digest: { stored: null, configured: false, boot_active: false, effective: false },
  embeddings: { stored: null, configured: false, boot_active: false, effective: false },
};

function stubFetch(protocolVersion: number, capabilities?: unknown) {
  return vi.fn(async (url: string) => {
    if (typeof url === "string" && url.includes("/v1/config")) {
      return { ok: true, status: 200, json: async () => EMPTY_CONFIG_RESPONSE };
    }
    return healthResponse(protocolVersion, capabilities);
  });
}

/**
 * A fuller double than `stubFetch` for the "server timezone" tests below —
 * these care about the exact `GET`/`PATCH /v1/config` exchange, not the
 * health check `stubFetch` exists for. `onPatch` gets the parsed
 * `WireConfigPatch` body and returns either the config the Server would
 * echo back, or `{ status }` for a failed write.
 */
function stubConfigFetch(
  initialConfig: typeof EMPTY_CONFIG_RESPONSE,
  onPatch?: (patch: Record<string, unknown>) => typeof EMPTY_CONFIG_RESPONSE | { status: number },
) {
  // Stateful, not a fixed response per call — see `ai-section.test.tsx`'s
  // identical `stubAiFetch` for why: the GET a successful PATCH's own
  // `invalidateQueries` triggers right after has to see what was just
  // written, not the config this Server started with.
  let current = initialConfig;
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (typeof url === "string" && url.includes("/v1/config")) {
      if (init?.method === "PATCH") {
        const patch = JSON.parse(String(init.body)) as Record<string, unknown>;
        const outcome = onPatch?.(patch) ?? current;
        if ("status" in outcome) {
          return { ok: false, status: outcome.status, json: async () => ({}) };
        }
        current = outcome;
        return { ok: true, status: 200, json: async () => outcome };
      }
      return { ok: true, status: 200, json: async () => current };
    }
    return healthResponse(PROTOCOL_VERSION);
  });
}

describe("SyncSection", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.setState({ serverUrl: "" });
    useSyncStatusStore.setState({ lastAttempt: null });
    // A quiet default so tests that don't care about the server check don't
    // make a real network call — this section checks on every mount now.
    vi.stubGlobal("fetch", stubFetch(PROTOCOL_VERSION));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("initialises the Server URL field from the store", () => {
    useSettingsStore.setState({ serverUrl: "https://phone.example:41207" });

    renderSyncSection();

    expect(screen.getByLabelText(/server url/i)).toHaveValue("https://phone.example:41207");
  });

  it("does not persist the Server URL until Save is clicked", () => {
    renderSyncSection();

    fireEvent.change(screen.getByLabelText(/server url/i), {
      target: { value: "https://phone.example:41207" },
    });

    expect(useSettingsStore.getState().serverUrl).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(useSettingsStore.getState().serverUrl).toBe("https://phone.example:41207");
  });

  it("shows the normalised value after saving", () => {
    renderSyncSection();

    fireEvent.change(screen.getByLabelText(/server url/i), {
      target: { value: "  https://phone.example:41207/  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(screen.getByLabelText(/server url/i)).toHaveValue("https://phone.example:41207");
  });

  it("saves the Server URL on plain Enter, with no chord needed (issue #76)", () => {
    renderSyncSection();
    const input = screen.getByLabelText(/server url/i);

    fireEvent.change(input, { target: { value: "https://phone.example:41207" } });
    // A single-line input has no newline to protect the way a Composer's
    // textarea does, so plain Enter — not the Composer's Cmd/Ctrl chord —
    // is what saves here. Submitting a `<form>` on Enter in a text field is
    // a native browser default action, not something sync-section.tsx wires
    // up in JS, and jsdom doesn't simulate that default action for a
    // synthetic keydown — so this fires the `submit` event a real Enter
    // press causes the browser to dispatch, which is what sync-section.tsx
    // actually listens for.
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    expect(useSettingsStore.getState().serverUrl).toBe("https://phone.example:41207");
  });

  it("keeps what the user typed when storage refuses the write", () => {
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    renderSyncSection();

    fireEvent.change(screen.getByLabelText(/server url/i), {
      target: { value: "https://phone.example:41207" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // Reading the stored value back instead of computing it would blank the
    // field here, telling the user the save took when nothing was written.
    expect(screen.getByLabelText(/server url/i)).toHaveValue("https://phone.example:41207");
  });

  describe("server reachability", () => {
    it("reports no server configured on mount, and makes no request", async () => {
      const fetchMock = stubFetch(PROTOCOL_VERSION);
      vi.stubGlobal("fetch", fetchMock);

      renderSyncSection();

      const status = await screen.findByTestId("server-status");
      expect(status).toHaveTextContent(/no server/i);
      expect(fetchMock).not.toHaveBeenCalled();
      // Not configured is a deliberate, valid state (ADR 0011) — it reads
      // with the same muted tone as "reachable", not the red tone every
      // other failure reason gets.
      expect(status).not.toHaveClass("text-destructive");
    });

    it("reports no server configured when Save is clicked with an empty field, without a request", async () => {
      useSettingsStore.setState({ serverUrl: "https://phone.example:41207" });
      const fetchMock = stubFetch(PROTOCOL_VERSION);
      vi.stubGlobal("fetch", fetchMock);
      renderSyncSection();
      await screen.findByTestId("server-status");
      fetchMock.mockClear();
      const errorToast = vi.spyOn(toast, "error");

      fireEvent.change(screen.getByLabelText(/server url/i), { target: { value: "" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() =>
        expect(screen.getByTestId("server-status")).toHaveTextContent(/no server/i),
      );
      expect(fetchMock).not.toHaveBeenCalled();
      expect(errorToast).not.toHaveBeenCalled();
    });

    it("shows the saved server's status inline on open, with no toast", async () => {
      useSettingsStore.setState({ serverUrl: "https://phone.example:41207" });
      const fetchMock = stubFetch(PROTOCOL_VERSION);
      vi.stubGlobal("fetch", fetchMock);
      const successToast = vi.spyOn(toast, "success");
      const errorToast = vi.spyOn(toast, "error");

      renderSyncSection();

      expect(await screen.findByTestId("server-status")).toHaveTextContent(/reachable/i);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://phone.example:41207/v1/health",
        expect.anything(),
      );
      expect(successToast).not.toHaveBeenCalled();
      expect(errorToast).not.toHaveBeenCalled();
    });

    // Issue #133: a bare "Reachable" was true and useless on a Server that
    // answers its health check but has no model behind either feature —
    // Settings now names the specific gap.
    it("names the missing Digest model on an otherwise-reachable server", async () => {
      useSettingsStore.setState({ serverUrl: "https://phone.example:41207" });
      vi.stubGlobal(
        "fetch",
        stubFetch(PROTOCOL_VERSION, {
          reflect: true,
          digest: false,
          embeddings: true,
          todo: true,
        }),
      );

      renderSyncSection();

      const status = await screen.findByTestId("server-status");
      expect(status).toHaveTextContent(/reachable/i);
      expect(status).toHaveTextContent(/no digest model configured/i);
      // Still a neutral, not an error, tone — a missing model is a
      // configuration fact, not a failure, the same reasoning
      // "not-configured" gets above.
      expect(status).not.toHaveClass("text-destructive");
    });

    it("keeps the bare reachable message when the server omits capabilities entirely", async () => {
      useSettingsStore.setState({ serverUrl: "https://phone.example:41207" });
      vi.stubGlobal("fetch", stubFetch(PROTOCOL_VERSION));

      renderSyncSection();

      const status = await screen.findByTestId("server-status");
      expect(status).toHaveTextContent(/^Reachable — this server is up/i);
    });

    it("shows a toast reporting the result when Save is clicked", async () => {
      renderSyncSection();
      // Let the mount check settle first, so the next fetch call can only
      // be the one Save triggers.
      await screen.findByTestId("server-status");

      const successToast = vi.spyOn(toast, "success");

      fireEvent.change(screen.getByLabelText(/server url/i), {
        target: { value: "https://phone.example:41207" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() =>
        expect(successToast).toHaveBeenCalledWith(expect.stringMatching(/reachable/i)),
      );
    });

    it("reports an outcome other than ok as an error toast, with distinct copy", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => errorResponse(503)),
      );
      renderSyncSection();
      const errorToast = vi.spyOn(toast, "error");

      fireEvent.change(screen.getByLabelText(/server url/i), {
        target: { value: "https://phone.example:41207" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => expect(errorToast).toHaveBeenCalledWith(expect.stringMatching(/503/)));
    });

    it("clears the inline status when the field is edited, and returns it when reverted", async () => {
      useSettingsStore.setState({ serverUrl: "https://phone.example:41207" });
      const fetchMock = stubFetch(PROTOCOL_VERSION);
      vi.stubGlobal("fetch", fetchMock);

      renderSyncSection();
      await screen.findByTestId("server-status");

      const input = screen.getByLabelText(/server url/i);

      fireEvent.change(input, { target: { value: "https://phone.example:41207x" } });
      expect(screen.queryByTestId("server-status")).not.toBeInTheDocument();

      fireEvent.change(input, { target: { value: "https://phone.example:41207" } });
      expect(screen.getByTestId("server-status")).toBeInTheDocument();

      // No re-check for the reverted edit — the status came back from the
      // URL/result pairing already held, not a second `/v1/health` fetch.
      // Two calls, not one, since issue #203: `SyncSection` now also fires
      // `GET /v1/config` for its own "On the server" sub-group on the same
      // mount, against this same stubbed `fetch` — a fact about the mount
      // this assertion has to account for, not something the reverted edit
      // itself triggered a second time.
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("reports a protocol mismatch distinctly from a reachable server", async () => {
      useSettingsStore.setState({ serverUrl: "https://phone.example:41207" });
      vi.stubGlobal("fetch", stubFetch(PROTOCOL_VERSION + 1));
      renderSyncSection();

      const status = await screen.findByTestId("server-status");
      expect(status).toHaveTextContent(new RegExp(`v${PROTOCOL_VERSION + 1}`));
      expect(status).not.toHaveTextContent(/^Reachable/);
    });
  });

  // Ticket 40: distinct from the "server reachability" block above, which is
  // a one-off health probe — this is the reason an actual, ongoing Sync
  // attempt is failing, sourced from lib/sync-status.ts.
  describe("sync failure reason", () => {
    it("shows nothing when the last attempt against the saved Server URL succeeded", () => {
      useSettingsStore.setState({ serverUrl: "https://phone.example:41207" });
      useSyncStatusStore.getState().recordSuccess("https://phone.example:41207");

      renderSyncSection();

      expect(screen.queryByTestId("sync-failure-reason")).not.toBeInTheDocument();
    });

    it("shows the recorded reason beside the Server URL when Sync is failing", () => {
      useSettingsStore.setState({ serverUrl: "https://phone.example:41207" });
      useSyncStatusStore
        .getState()
        .recordFailure("https://phone.example:41207", "sync request failed with status 500");

      renderSyncSection();

      expect(screen.getByTestId("sync-failure-reason")).toHaveTextContent(
        "sync request failed with status 500",
      );
    });

    it("clears the failure reason the moment a later attempt succeeds, with no reload", async () => {
      useSettingsStore.setState({ serverUrl: "https://phone.example:41207" });
      useSyncStatusStore.getState().recordFailure("https://phone.example:41207", "boom");
      renderSyncSection();
      expect(screen.getByTestId("sync-failure-reason")).toBeInTheDocument();

      useSyncStatusStore.getState().recordSuccess("https://phone.example:41207");

      await waitFor(() =>
        expect(screen.queryByTestId("sync-failure-reason")).not.toBeInTheDocument(),
      );
    });

    it("hides the failure reason while the field is mid-edit, away from the saved value", () => {
      useSettingsStore.setState({ serverUrl: "https://phone.example:41207" });
      useSyncStatusStore.getState().recordFailure("https://phone.example:41207", "boom");
      renderSyncSection();
      expect(screen.getByTestId("sync-failure-reason")).toBeInTheDocument();

      fireEvent.change(screen.getByLabelText(/server url/i), {
        target: { value: "https://phone.example:41207/typing" },
      });

      expect(screen.queryByTestId("sync-failure-reason")).not.toBeInTheDocument();
    });

    it("fires no toast when a Sync attempt fails in the background", () => {
      useSettingsStore.setState({ serverUrl: "https://phone.example:41207" });
      const errorToast = vi.spyOn(toast, "error");

      renderSyncSection();
      useSyncStatusStore.getState().recordFailure("https://phone.example:41207", "boom");

      expect(errorToast).not.toHaveBeenCalled();
    });
  });

  // Issue #203: the "On the server" sub-group's one row — the timezone
  // Digest buckets by.
  describe("server timezone", () => {
    it("shows the resolved timezone and says it came from the environment", async () => {
      useSettingsStore.setState({ serverUrl: "https://phone.example:41207" });
      vi.stubGlobal(
        "fetch",
        stubConfigFetch({ ...EMPTY_CONFIG_RESPONSE, tz: { value: "UTC", source: "env" } }),
      );

      renderSyncSection();

      expect(await screen.findByLabelText("Timezone")).toHaveValue("UTC");
      expect(screen.getByText(/from this server's own environment/i)).toBeInTheDocument();
    });

    it("disables the timezone field and hides no row when the Server reports itself locked", async () => {
      useSettingsStore.setState({ serverUrl: "https://phone.example:41207" });
      vi.stubGlobal(
        "fetch",
        stubConfigFetch({
          ...EMPTY_CONFIG_RESPONSE,
          locked: true,
          tz: { value: "UTC", source: "env" },
        }),
      );

      renderSyncSection();

      expect(await screen.findByLabelText("Timezone")).toBeDisabled();
      expect(screen.getByText(/locked/i)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Save timezone" })).toBeDisabled();
    });

    it("saves an edited timezone, reports it as stored, and says a restart is needed", async () => {
      useSettingsStore.setState({ serverUrl: "https://phone.example:41207" });
      const fetchMock = stubConfigFetch(EMPTY_CONFIG_RESPONSE, (patch) => ({
        ...EMPTY_CONFIG_RESPONSE,
        tz: { value: patch.tz as string, source: "stored" },
      }));
      vi.stubGlobal("fetch", fetchMock);

      renderSyncSection();
      const timezoneField = await screen.findByLabelText("Timezone");

      fireEvent.change(timezoneField, { target: { value: "America/New_York" } });
      fireEvent.click(screen.getByRole("button", { name: "Save timezone" }));

      await screen.findByText("Saved.");
      expect(screen.getByText(/restart the server/i)).toBeInTheDocument();
      expect(fetchMock).toHaveBeenCalledWith("https://phone.example:41207/v1/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tz: "America/New_York" }),
      });
    });

    it("reports a failed save as unreachable, not as a rejected value", async () => {
      useSettingsStore.setState({ serverUrl: "https://phone.example:41207" });
      vi.stubGlobal(
        "fetch",
        stubConfigFetch(EMPTY_CONFIG_RESPONSE, () => {
          throw new Error("network down");
        }),
      );

      renderSyncSection();
      const timezoneField = await screen.findByLabelText("Timezone");
      fireEvent.change(timezoneField, { target: { value: "America/New_York" } });
      fireEvent.click(screen.getByRole("button", { name: "Save timezone" }));

      expect(await screen.findByText(/couldn't reach the server/i)).toBeInTheDocument();
    });
  });
});
