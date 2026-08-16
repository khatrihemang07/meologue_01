import { PROTOCOL_VERSION } from "@meologue/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "@/lib/settings";
import { useSyncStatusStore } from "@/lib/sync-status";
import { SettingsPage } from "./settings-page";

function renderPage() {
  render(
    <MemoryRouter>
      <SettingsPage />
    </MemoryRouter>,
  );
}

function healthResponse(protocolVersion: number) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ service: "meologue-server", protocol_version: protocolVersion }),
  };
}

function errorResponse(status: number) {
  return { ok: false, status, json: async () => ({}) };
}

describe("SettingsPage", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.setState({ theme: "system", serverUrl: "" });
    useSyncStatusStore.setState({ lastAttempt: null });
    document.documentElement.classList.remove("dark");
    // A quiet default so tests that don't care about the server check don't
    // make a real network call — Settings checks on every mount now.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => healthResponse(PROTOCOL_VERSION)),
    );
  });

  afterEach(() => {
    document.documentElement.classList.remove("dark");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders its title and a back link to the history page", () => {
    renderPage();

    expect(screen.getByText("Settings")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /back/i })).toHaveAttribute("href", "/");
  });

  it("marks System as the initially selected theme", () => {
    renderPage();

    expect(screen.getByRole("button", { name: "System" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Light" })).toHaveAttribute("aria-pressed", "false");
  });

  it("applies and persists a theme immediately on click, with no save step", () => {
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Dark" }));

    expect(screen.getByRole("button", { name: "Dark" })).toHaveAttribute("aria-pressed", "true");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(useSettingsStore.getState().theme).toBe("dark");
  });

  it("initialises the Server URL field from the store", () => {
    useSettingsStore.setState({ serverUrl: "https://phone.example:41207" });

    renderPage();

    expect(screen.getByLabelText(/server url/i)).toHaveValue("https://phone.example:41207");
  });

  it("does not persist the Server URL until Save is clicked", () => {
    renderPage();

    fireEvent.change(screen.getByLabelText(/server url/i), {
      target: { value: "https://phone.example:41207" },
    });

    expect(useSettingsStore.getState().serverUrl).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(useSettingsStore.getState().serverUrl).toBe("https://phone.example:41207");
  });

  it("shows the normalised value after saving", () => {
    renderPage();

    fireEvent.change(screen.getByLabelText(/server url/i), {
      target: { value: "  https://phone.example:41207/  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(screen.getByLabelText(/server url/i)).toHaveValue("https://phone.example:41207");
  });

  it("keeps what the user typed when storage refuses the write", () => {
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    renderPage();

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

      renderPage();

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
      renderPage();
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

      renderPage();

      expect(await screen.findByTestId("server-status")).toHaveTextContent(/reachable/i);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://phone.example:41207/v1/health",
        expect.anything(),
      );
      expect(successToast).not.toHaveBeenCalled();
      expect(errorToast).not.toHaveBeenCalled();
    });

    it("shows a toast reporting the result when Save is clicked", async () => {
      renderPage();
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
      renderPage();
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

      renderPage();
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
      renderPage();

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

      renderPage();

      expect(screen.queryByTestId("sync-failure-reason")).not.toBeInTheDocument();
    });

    it("shows the recorded reason beside the Server URL when Sync is failing", () => {
      useSettingsStore.setState({ serverUrl: "https://phone.example:41207" });
      useSyncStatusStore
        .getState()
        .recordFailure("https://phone.example:41207", "sync request failed with status 500");

      renderPage();

      expect(screen.getByTestId("sync-failure-reason")).toHaveTextContent(
        "sync request failed with status 500",
      );
    });

    it("clears the failure reason the moment a later attempt succeeds, with no reload", async () => {
      useSettingsStore.setState({ serverUrl: "https://phone.example:41207" });
      useSyncStatusStore.getState().recordFailure("https://phone.example:41207", "boom");
      renderPage();
      expect(screen.getByTestId("sync-failure-reason")).toBeInTheDocument();

      useSyncStatusStore.getState().recordSuccess("https://phone.example:41207");

      await waitFor(() =>
        expect(screen.queryByTestId("sync-failure-reason")).not.toBeInTheDocument(),
      );
    });

    it("hides the failure reason while the field is mid-edit, away from the saved value", () => {
      useSettingsStore.setState({ serverUrl: "https://phone.example:41207" });
      useSyncStatusStore.getState().recordFailure("https://phone.example:41207", "boom");
      renderPage();
      expect(screen.getByTestId("sync-failure-reason")).toBeInTheDocument();

      fireEvent.change(screen.getByLabelText(/server url/i), {
        target: { value: "https://phone.example:41207/typing" },
      });

      expect(screen.queryByTestId("sync-failure-reason")).not.toBeInTheDocument();
    });

    it("fires no toast when a Sync attempt fails in the background", () => {
      useSettingsStore.setState({ serverUrl: "https://phone.example:41207" });
      const errorToast = vi.spyOn(toast, "error");

      renderPage();
      useSyncStatusStore.getState().recordFailure("https://phone.example:41207", "boom");

      expect(errorToast).not.toHaveBeenCalled();
    });
  });
});
