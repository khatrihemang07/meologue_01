import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TODO_KEY_BINDINGS } from "@/lib/todo-keymap";
import { TodoKeyboardShortcutsOverlay } from "./todo-keyboard-shortcuts-overlay";

describe("TodoKeyboardShortcutsOverlay", () => {
  it("renders nothing while closed", () => {
    render(<TodoKeyboardShortcutsOverlay open={false} onOpenChange={vi.fn()} />);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("titles itself 'Keyboard Shortcuts', matching keyboard.md's own overlay", () => {
    render(<TodoKeyboardShortcutsOverlay open={true} onOpenChange={vi.fn()} />);

    expect(screen.getByRole("dialog", { name: "Keyboard Shortcuts" })).toBeInTheDocument();
  });

  it("renders a row for every distinct label in TODO_KEY_BINDINGS", () => {
    render(<TodoKeyboardShortcutsOverlay open={true} onOpenChange={vi.fn()} />);

    // `getByText(label, { selector: "dt" })`, not a bare `getByText` — one
    // binding's own label ("Edit task") is identical to its section's own
    // heading text, so an unscoped query would match both.
    const labels = new Set(TODO_KEY_BINDINGS.map((binding) => binding.label));
    for (const label of labels) {
      expect(screen.getByText(label, { selector: "dt" })).toBeInTheDocument();
    }
  });

  it("shows the Quick find row's own hint merging both its split bindings", () => {
    render(<TodoKeyboardShortcutsOverlay open={true} onOpenChange={vi.fn()} />);

    expect(screen.getByText("/ or F or ⌘K")).toBeInTheDocument();
  });

  it("never renders a row for a binding that doesn't exist (e.g. no 'Move to…' row)", () => {
    render(<TodoKeyboardShortcutsOverlay open={true} onOpenChange={vi.fn()} />);

    expect(screen.queryByText("Move to…")).not.toBeInTheDocument();
  });
});
