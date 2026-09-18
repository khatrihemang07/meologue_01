import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useSettingsStore } from "@/lib/settings";
import { ComposerSection } from "./composer-section";

describe("ComposerSection", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.setState({
      formatBarVisible: true,
      smartDatesEnabled: true,
      completedTasksVisible: false,
    });
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
});
