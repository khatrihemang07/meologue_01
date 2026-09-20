import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PrioritySheetContent } from "./priority-sheet-content";

describe("PrioritySheetContent", () => {
  it("marks the current UI priority as pressed", () => {
    render(<PrioritySheetContent uiPriority={1} onSelect={vi.fn()} />);

    expect(screen.getByRole("button", { name: "P1" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "P4" })).toHaveAttribute("aria-pressed", "false");
  });

  it("fires onSelect with the plain UI priority, not an inverted stored value", () => {
    const onSelect = vi.fn();
    render(<PrioritySheetContent uiPriority={4} onSelect={onSelect} />);

    fireEvent.click(screen.getByRole("button", { name: "P2" }));

    expect(onSelect).toHaveBeenCalledWith(2);
  });

  it("colours each option, four distinct colours", () => {
    render(<PrioritySheetContent uiPriority={4} onSelect={vi.fn()} />);

    const swatches = screen
      .getAllByRole("button")
      .filter((b) => /^P[1-4]$/.test(b.textContent ?? ""))
      .map((b) => b.querySelector("span")?.getAttribute("style") ?? "");

    expect(swatches).toHaveLength(4);
    for (const style of swatches) {
      expect(style).toContain("background-color");
    }
    expect(new Set(swatches).size).toBe(4);
  });
});
