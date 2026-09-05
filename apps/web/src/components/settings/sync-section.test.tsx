import { PROTOCOL_VERSION } from "@meologue/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "@/lib/settings";
import { useSyncStatusStore } from "@/lib/sync-status";
import { SyncSection } from "./sync-section";

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

describe("SyncSection", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.setState({ serverUrl: "" });
    useSyncStatusStore.setState({ lastAttempt: null });
    // A quiet default so tests that don't care about the server check don't
    // make a real network call — this section checks on every mount now.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => healthResponse(PROTOCOL_VERSION)),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("initialises the Server URL field from the store", () => {
    useSettingsStore.setState({ serverUrl: "https://phone.example:41207" });

    render(<SyncSection />);

    expect(screen.getByLabelText(/server url/i)).toHaveValue("https://phone.example:41207");
  });

  it("does not persist the Server URL until Save is clicked", () => {
    render(<SyncSection />);

    fireEvent.change(screen.getByLabelText(/server url/i), {
      target: { value: "https://phone.example:41207" },
    });

    expect(useSettingsStore.getState().serverUrl).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(useSettingsStore.getState().serverUrl).toBe("https://phone.example:41207");
  });

  it("shows the normalised value after saving", () => {
    render(<SyncSection />);

    fireEvent.change(screen.getByLabelText(/server url/i), {
      target: { value: "  https://phone.example:41207/  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(screen.getByLabelText(/server url/i)).toHaveValue("https://phone.example:41207");
  });

  it("saves the Server URL on plain Enter, with no chord needed (issue #76)", () => {
    render(<SyncSection />);
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
    render(<SyncSection />);

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
      const fetchMock = vi.fn(async () => healthResponse(PROTOCOL_VERSION));
      vi.stubGlobal("fetch", fetchMock);

      render(<SyncSection />);

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
      const fetchMock = vi.fn(async () => healthResponse(PROTOCOL_VERSION));
      vi.stubGlobal("fetch", fetchMock);
      render(<SyncSection />);
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
      const fetchMock = vi.fn(async () => healthResponse(PROTOCOL_VERSION));
      vi.stubGlobal("fetch", fetchMock);
      const successToast = vi.spyOn(toast, "success");
      const errorToast = vi.spyOn(toast, "error");

      render(<SyncSection />);

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
        vi.fn(async () =>
          healthResponse(PROTOCOL_VERSION, {
            reflect: true,
            digest: false,
            embeddings: true,
            todo: true,
          }),
        ),
      );

      render(<SyncSection />);

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
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => healthResponse(PROTOCOL_VERSION)),
      );

      render(<SyncSection />);

      const status = await screen.findByTestId("server-status");
      expect(status).toHaveTextContent(/^Reachable — this server is up/i);
    });

    it("shows a toast reporting the result when Save is clicked", async () => {
      render(<SyncSection />);
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
      render(<SyncSection />);
      const errorToast = vi.spyOn(toast, "error");

      fireEvent.change(screen.getByLabelText(/server url/i), {
        target: { value: "https://phone.example:41207" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => expect(errorToast).toHaveBeenCalledWith(expect.stringMatching(/503/)));
    });

    it("clears the inline status when the field is edited, and returns it when reverted", async () => {
      useSettingsStore.setState({ serverUrl: "https://phone.example:41207" });
      const fetchMock = vi.fn(async () => healthResponse(PROTOCOL_VERSION));
      vi.stubGlobal("fetch", fetchMock);

      render(<SyncSection />);
      await screen.findByTestId("server-status");

      const input = screen.getByLabelText(/server url/i);

      fireEvent.change(input, { target: { value: "https://phone.example:41207x" } });
      expect(screen.queryByTestId("server-status")).not.toBeInTheDocument();

      fireEvent.change(input, { target: { value: "https://phone.example:41207" } });
      expect(screen.getByTestId("server-status")).toBeInTheDocument();

      // No re-check for the reverted edit — the status came back from the
      // URL/result pairing already held, not a second fetch.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("reports a protocol mismatch distinctly from a reachable server", async () => {
      useSettingsStore.setState({ serverUrl: "https://phone.example:41207" });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => healthResponse(PROTOCOL_VERSION + 1)),
      );
      render(<SyncSection />);

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

      render(<SyncSection />);

      expect(screen.queryByTestId("sync-failure-reason")).not.toBeInTheDocument();
    });

    it("shows the recorded reason beside the Server URL when Sync is failing", () => {
      useSettingsStore.setState({ serverUrl: "https://phone.example:41207" });
      useSyncStatusStore
        .getState()
        .recordFailure("https://phone.example:41207", "sync request failed with status 500");

      render(<SyncSection />);

      expect(screen.getByTestId("sync-failure-reason")).toHaveTextContent(
        "sync request failed with status 500",
      );
    });

    it("clears the failure reason the moment a later attempt succeeds, with no reload", async () => {
      useSettingsStore.setState({ serverUrl: "https://phone.example:41207" });
      useSyncStatusStore.getState().recordFailure("https://phone.example:41207", "boom");
      render(<SyncSection />);
      expect(screen.getByTestId("sync-failure-reason")).toBeInTheDocument();

      useSyncStatusStore.getState().recordSuccess("https://phone.example:41207");

      await waitFor(() =>
        expect(screen.queryByTestId("sync-failure-reason")).not.toBeInTheDocument(),
      );
    });

    it("hides the failure reason while the field is mid-edit, away from the saved value", () => {
      useSettingsStore.setState({ serverUrl: "https://phone.example:41207" });
      useSyncStatusStore.getState().recordFailure("https://phone.example:41207", "boom");
      render(<SyncSection />);
      expect(screen.getByTestId("sync-failure-reason")).toBeInTheDocument();

      fireEvent.change(screen.getByLabelText(/server url/i), {
        target: { value: "https://phone.example:41207/typing" },
      });

      expect(screen.queryByTestId("sync-failure-reason")).not.toBeInTheDocument();
    });

    it("fires no toast when a Sync attempt fails in the background", () => {
      useSettingsStore.setState({ serverUrl: "https://phone.example:41207" });
      const errorToast = vi.spyOn(toast, "error");

      render(<SyncSection />);
      useSyncStatusStore.getState().recordFailure("https://phone.example:41207", "boom");

      expect(errorToast).not.toHaveBeenCalled();
    });
  });
});
