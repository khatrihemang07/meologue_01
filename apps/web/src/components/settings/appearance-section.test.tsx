import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useSettingsStore } from "@/lib/settings";
import { AppearanceSection } from "./appearance-section";

// Moved from settings-page.test.tsx (issue #202) — Theme's own assertions
// are unchanged; only the render target narrowed from the whole page to
// this one topic section, which is self-contained and needs no provider.
describe("AppearanceSection", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.setState({ theme: "system" });
    document.documentElement.classList.remove("dark");
  });

  afterEach(() => {
    document.documentElement.classList.remove("dark");
  });

  it("marks System as the initially selected theme", () => {
    render(<AppearanceSection />);

    expect(screen.getByRole("button", { name: "System" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Light" })).toHaveAttribute("aria-pressed", "false");
  });

  it("applies and persists a theme immediately on click, with no save step", () => {
    render(<AppearanceSection />);

    fireEvent.click(screen.getByRole("button", { name: "Dark" }));

    expect(screen.getByRole("button", { name: "Dark" })).toHaveAttribute("aria-pressed", "true");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(useSettingsStore.getState().theme).toBe("dark");
  });
});
