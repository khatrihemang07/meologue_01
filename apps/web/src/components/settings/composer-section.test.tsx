import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "@/lib/settings";
import { ComposerSection } from "./composer-section";

describe("ComposerSection", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.setState({
      formatBarVisible: true,
      smartDatesEnabled: true,
      completedTasksVisible: false,
      dictationUrl: "",
      dictationToken: "",
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // "Toolbar means always" rework: Settings is now the ONLY switch for this
  // Device setting — the inline toggle beside Send (composer.tsx) is gone
  // — and the toolbar is on by default on every device, not just while the
  // Composer happens to have focus.
  describe("format toolbar visibility", () => {
    it("is on by default", () => {
      render(<ComposerSection />);

      expect(screen.getByRole("switch", { name: "Show the format toolbar" })).toHaveAttribute(
        "aria-checked",
        "true",
      );
    });

    it("turns off on click, and persists it", () => {
      render(<ComposerSection />);

      fireEvent.click(screen.getByRole("switch", { name: "Show the format toolbar" }));

      expect(screen.getByRole("switch", { name: "Show the format toolbar" })).toHaveAttribute(
        "aria-checked",
        "false",
      );
      expect(useSettingsStore.getState().formatBarVisible).toBe(false);
      expect(localStorage.getItem("meologue.format-bar-visible")).toBe("false");
    });

    it("turns on again on a second click", () => {
      useSettingsStore.setState({ formatBarVisible: false });
      render(<ComposerSection />);

      fireEvent.click(screen.getByRole("switch", { name: "Show the format toolbar" }));

      expect(screen.getByRole("switch", { name: "Show the format toolbar" })).toHaveAttribute(
        "aria-checked",
        "true",
      );
      expect(useSettingsStore.getState().formatBarVisible).toBe(true);
    });

    it("gives the switch the 44px touch target every other control on this page has", () => {
      render(<ComposerSection />);

      expect(screen.getByRole("switch", { name: "Show the format toolbar" })).toHaveClass("h-11");
    });
  });

  // Issue #170. Moved from settings-page.test.tsx (issue #202) — unchanged.
  describe("smart date recognition", () => {
    it("is on by default", () => {
      render(<ComposerSection />);

      expect(screen.getByRole("switch", { name: "Smart date recognition" })).toHaveAttribute(
        "aria-checked",
        "true",
      );
    });

    it("turns off on click, and persists it", () => {
      render(<ComposerSection />);

      fireEvent.click(screen.getByRole("switch", { name: "Smart date recognition" }));

      expect(screen.getByRole("switch", { name: "Smart date recognition" })).toHaveAttribute(
        "aria-checked",
        "false",
      );
      expect(useSettingsStore.getState().smartDatesEnabled).toBe(false);
      expect(localStorage.getItem("meologue.smart-dates-enabled")).toBe("false");
    });

    it("turns on again on a second click", () => {
      useSettingsStore.setState({ smartDatesEnabled: false });
      render(<ComposerSection />);

      fireEvent.click(screen.getByRole("switch", { name: "Smart date recognition" }));

      expect(screen.getByRole("switch", { name: "Smart date recognition" })).toHaveAttribute(
        "aria-checked",
        "true",
      );
      expect(useSettingsStore.getState().smartDatesEnabled).toBe(true);
    });
  });

  // Issue #358.
  describe("completed tasks visibility", () => {
    it("is off by default, matching Todoist's own measured default", () => {
      render(<ComposerSection />);

      expect(screen.getByRole("switch", { name: "Show completed Tasks" })).toHaveAttribute(
        "aria-checked",
        "false",
      );
    });

    it("turns on on click, and persists it", () => {
      render(<ComposerSection />);

      fireEvent.click(screen.getByRole("switch", { name: "Show completed Tasks" }));

      expect(screen.getByRole("switch", { name: "Show completed Tasks" })).toHaveAttribute(
        "aria-checked",
        "true",
      );
      expect(useSettingsStore.getState().completedTasksVisible).toBe(true);
      expect(localStorage.getItem("meologue.completed-tasks-visible")).toBe("true");
    });

    it("turns off again on a second click", () => {
      useSettingsStore.setState({ completedTasksVisible: true });
      render(<ComposerSection />);

      fireEvent.click(screen.getByRole("switch", { name: "Show completed Tasks" }));

      expect(screen.getByRole("switch", { name: "Show completed Tasks" })).toHaveAttribute(
        "aria-checked",
        "false",
      );
      expect(useSettingsStore.getState().completedTasksVisible).toBe(false);
    });
  });

  describe("dictation (issue #454)", () => {
    function stubHealth(response: () => Response | Promise<Response>) {
      const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => response());
      vi.stubGlobal("fetch", fetchMock);
      return fetchMock;
    }
    const health = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

    it("masks the token and carries the Backup hint", () => {
      render(<ComposerSection />);

      expect(screen.getByLabelText("Gateway token")).toHaveAttribute("type", "password");
      expect(screen.getByText(/not included in Backups/)).toBeInTheDocument();
    });

    it("saves a normalised URL and the token only on Save", () => {
      render(<ComposerSection />);

      fireEvent.change(screen.getByLabelText("Gateway URL"), {
        target: { value: " http://mac.local:8765/ " },
      });
      fireEvent.change(screen.getByLabelText("Gateway token"), { target: { value: "tok" } });
      expect(useSettingsStore.getState().dictationUrl).toBe("");

      fireEvent.click(screen.getByRole("button", { name: "Save dictation" }));

      expect(useSettingsStore.getState().dictationUrl).toBe("http://mac.local:8765");
      expect(useSettingsStore.getState().dictationToken).toBe("tok");
      expect(screen.getByLabelText("Gateway URL")).toHaveValue("http://mac.local:8765");
    });

    it("Test reports a healthy gateway", async () => {
      const fetchMock = stubHealth(() =>
        health({
          ok: true,
          status: "ok",
          openwhispr: { reachable: true, version: "1.9.0", verifiedVersion: "1.9.0" },
        }),
      );
      render(<ComposerSection />);
      fireEvent.change(screen.getByLabelText("Gateway URL"), { target: { value: "http://gw" } });
      fireEvent.change(screen.getByLabelText("Gateway token"), { target: { value: "tok" } });

      fireEvent.click(screen.getByRole("button", { name: "Test dictation gateway" }));

      await waitFor(() =>
        expect(screen.getByTestId("dictation-status")).toHaveTextContent(
          "Connected — OpenWhispr 1.9.0",
        ),
      );
      expect(fetchMock.mock.calls[0]?.[0]).toBe("http://gw/v1/health");
    });

    it("Test reports a degraded gateway", async () => {
      stubHealth(() =>
        health({
          ok: true,
          status: "degraded",
          openwhispr: { reachable: false, version: null, verifiedVersion: "1.9.0" },
        }),
      );
      render(<ComposerSection />);
      fireEvent.change(screen.getByLabelText("Gateway URL"), { target: { value: "http://gw" } });

      fireEvent.click(screen.getByRole("button", { name: "Test dictation gateway" }));

      await waitFor(() =>
        expect(screen.getByTestId("dictation-status")).toHaveTextContent(
          "Connected, but degraded:",
        ),
      );
    });

    it("Test reports a rejected token and an unreachable gateway", async () => {
      stubHealth(() => health({}, 401));
      render(<ComposerSection />);
      fireEvent.change(screen.getByLabelText("Gateway URL"), { target: { value: "http://gw" } });
      fireEvent.click(screen.getByRole("button", { name: "Test dictation gateway" }));
      await waitFor(() =>
        expect(screen.getByTestId("dictation-status")).toHaveTextContent(
          "The dictation gateway rejected the token.",
        ),
      );

      stubHealth(() => {
        throw new TypeError("Failed to fetch");
      });
      fireEvent.click(screen.getByRole("button", { name: "Test dictation gateway" }));
      await waitFor(() =>
        expect(screen.getByTestId("dictation-status")).toHaveTextContent(
          "Couldn't reach the dictation gateway.",
        ),
      );
    });
  });
});
