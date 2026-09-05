import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_COMPLETED_STYLE, useSettingsStore } from "@/lib/settings";
import { ComposerSection } from "./composer-section";

describe("ComposerSection", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.setState({
      completedStyle: DEFAULT_COMPLETED_STYLE,
      formatBarVisible: false,
      smartDatesEnabled: true,
    });
    delete document.documentElement.dataset.completedStyle;
  });

  afterEach(() => {
    delete document.documentElement.dataset.completedStyle;
  });

  // Issue #202: promoted from the button beside Send (composer.tsx) — the
  // button stays exactly where it is; this is a second way to reach the
  // identical Device setting.
  describe("format toolbar visibility", () => {
    it("is off by default", () => {
      render(<ComposerSection />);

      expect(screen.getByRole("switch", { name: "Show while writing" })).toHaveAttribute(
        "aria-checked",
        "false",
      );
    });

    it("turns on on click, and persists it", () => {
      render(<ComposerSection />);

      fireEvent.click(screen.getByRole("switch", { name: "Show while writing" }));

      expect(screen.getByRole("switch", { name: "Show while writing" })).toHaveAttribute(
        "aria-checked",
        "true",
      );
      expect(useSettingsStore.getState().formatBarVisible).toBe(true);
      expect(localStorage.getItem("meologue.format-bar-visible")).toBe("true");
    });

    it("turns off again on a second click", () => {
      useSettingsStore.setState({ formatBarVisible: true });
      render(<ComposerSection />);

      fireEvent.click(screen.getByRole("switch", { name: "Show while writing" }));

      expect(screen.getByRole("switch", { name: "Show while writing" })).toHaveAttribute(
        "aria-checked",
        "false",
      );
      expect(useSettingsStore.getState().formatBarVisible).toBe(false);
    });

    it("gives the switch the 44px touch target every other control on this page has", () => {
      render(<ComposerSection />);

      expect(screen.getByRole("switch", { name: "Show while writing" })).toHaveClass("h-11");
    });
  });

  // Issue #163. Moved from settings-page.test.tsx (issue #202) — unchanged.
  describe("completed checklist item style", () => {
    it("marks grayed out (the default) as initially selected", () => {
      render(<ComposerSection />);

      expect(screen.getByRole("button", { name: "Grayed out" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(screen.getByRole("button", { name: "Grayed out and strikethrough" })).toHaveAttribute(
        "aria-pressed",
        "false",
      );
    });

    it("applies and persists a choice immediately on click, with no save step", () => {
      render(<ComposerSection />);

      fireEvent.click(screen.getByRole("button", { name: "Strikethrough" }));

      expect(screen.getByRole("button", { name: "Strikethrough" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      // "Applies" here is the same one-attribute write `applyAccent`/
      // `applyTextSize` make — see `lib/theme.ts`'s `applyCompletedStyle`.
      expect(document.documentElement.dataset.completedStyle).toBe("strike");
      expect(useSettingsStore.getState().completedStyle).toBe("strike");
      expect(localStorage.getItem("meologue.completed-style")).toBe("strike");
    });

    // Issue #163's own acceptance criterion: four stacked rows, each
    // showing a real sample in ITS OWN style rather than describing it in
    // words. The sample carries `data-completed-style` scoped to a small
    // wrapper (not <html>), which is what lets a row demonstrate an option
    // that isn't the one currently selected — see `CompletedStyleRow`'s own
    // doc comment (completed-style-row.tsx) for why that wrapper, rather
    // than a second copy of the colour/decoration mapping, is what makes
    // that work.
    it("renders four rows, each with a real sample wearing its own style attribute, hidden from assistive tech", () => {
      render(<ComposerSection />);

      const rows: [string, string][] = [
        ["Grayed out and strikethrough", "grayAndStrike"],
        ["Grayed out", "gray"],
        ["Strikethrough", "strike"],
        ["None", "none"],
      ];
      for (const [label, id] of rows) {
        const row = screen.getByRole("button", { name: label });
        const sample = row.querySelector(`[data-completed-style="${id}"]`);
        expect(sample).not.toBeNull();
        expect(sample).toHaveAttribute("aria-hidden", "true");
      }
    });

    // ADR 0008: a Device setting never rewrites an Entry. There's no
    // Entry-store write to assert didn't happen — `setCompletedStyle`
    // (settings.ts) only ever calls `localStorage.setItem` and the
    // store's own `set` — so this instead pins the touch target every
    // other choice on this page already gets (ADR 0036's 44px minimum),
    // which is the one behavioural requirement specific to this control
    // that isn't already covered by `settings.test.ts`/`theme.test.ts`.
    it("gives each row the 44px touch target every other control on this page has", () => {
      render(<ComposerSection />);

      for (const label of ["Grayed out and strikethrough", "Grayed out", "Strikethrough", "None"]) {
        expect(screen.getByRole("button", { name: label })).toHaveAttribute("data-size", "touch");
      }
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
});
