import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TODO_KEY_BINDINGS } from "@/lib/todo-keymap";
import { TodoKeyboardShortcutsOverlay } from "./todo-keyboard-shortcuts-overlay";

describe("TodoKeyboardShortcutsOverlay", () => {
  it("renders nothing while closed", () => {
    render(<TodoKeyboardShortcutsOverlay open={false} onOpenChange={vi.fn()} />);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("titles itself 'Keyboard Shortcuts'", () => {
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

  it("lists the newly-bound rows, including the new Add task section", () => {
    render(<TodoKeyboardShortcutsOverlay open={true} onOpenChange={vi.fn()} />);

    // Scoped to the section heading (`h3`) — "Add task" is also the
    // *label* of the unrelated `quick-add` binding (General section, `Q`),
    // the same ambiguity `todo-keyboard-shortcuts-overlay.test.tsx`'s own
    // earlier "Edit task" comment already calls out for section headings
    // vs. row labels.
    expect(screen.getByText("Add task", { selector: "h3" })).toBeInTheDocument();
    expect(
      screen.getByText("Add new task to the bottom of the list", { selector: "dt" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Complete focused task", { selector: "dt" })).toBeInTheDocument();
    expect(screen.getByText("Comment on task", { selector: "dt" })).toBeInTheDocument();
    expect(screen.getByText("Copy link to task", { selector: "dt" })).toBeInTheDocument();
    expect(screen.getByText("Open settings", { selector: "dt" })).toBeInTheDocument();
  });

  // Coordinator's own re-audit found three more real (b)s in a second pass.
  it("lists the rows added by the coordinator's re-audit", () => {
    render(<TodoKeyboardShortcutsOverlay open={true} onOpenChange={vi.fn()} />);

    expect(screen.getByText("Open label…", { selector: "dt" })).toBeInTheDocument();
    expect(screen.getByText("Go to reporting", { selector: "dt" })).toBeInTheDocument();
    // Both "Open settings" and "Open themes" resolve to the same
    // destination (`/settings`) but are listed as two honest, separate
    // rows — matching Todoist's own two separate overlay entries.
    expect(screen.getByText("Open themes", { selector: "dt" })).toBeInTheDocument();
  });
});
