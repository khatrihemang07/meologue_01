import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OPEN_QUICK_ADD_EVENT } from "@/lib/todo-keymap";
import { TodoCreateFab } from "./todo-create-fab";

// Mirrors todo-nav.test.tsx's own stand-in ("jsdom implements no
// matchMedia at all") — every test below that doesn't call this renders
// under `test/setup.ts`'s global stub, which already answers `false` for
// every query but `(hover: hover)` (that file's own doc comment), so the
// narrow case needs no stub of its own. This is the one direction that
// does.
function installWideMatchMedia() {
  Object.defineProperty(window, "matchMedia", {
    value: vi.fn(() => ({
      matches: true,
      media: "",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
    configurable: true,
    writable: true,
  });
}

function removeMatchMedia() {
  Object.defineProperty(window, "matchMedia", {
    value: undefined,
    configurable: true,
    writable: true,
  });
}

describe("TodoCreateFab", () => {
  afterEach(removeMatchMedia);

  // Asserts the narrow breakpoint by name, per the ticket's own acceptance
  // criterion ("a test states which breakpoint it asserts") — this is the
  // half `test/setup.ts`'s global stub makes trivially true by construction
  // (it answers narrow to everything), so it exists mainly to pair with
  // the wide test below and give both a name.
  it("renders at the narrow breakpoint", () => {
    render(<TodoCreateFab />);

    expect(screen.getByRole("button", { name: "Quick add" })).toBeInTheDocument();
  });

  // The half the global stub cannot give by accident (this ticket's own
  // brief): every query answers narrow under it, so "it renders" can pass
  // for the wrong reason forever while "it doesn't render when wide" is
  // never actually exercised. Pinning `matchMedia` to the wide answer here
  // is what makes this assertion possible to fail.
  it("does not render at the wide (min-width: 900px) breakpoint", () => {
    installWideMatchMedia();

    render(<TodoCreateFab />);

    expect(screen.queryByRole("button", { name: "Quick add" })).not.toBeInTheDocument();
  });

  // Reuses the identical door todo-sidebar.tsx's own "Add task" button
  // already opens the global Quick Add dialog through — see
  // todo-sidebar.test.tsx's "dispatches OPEN_QUICK_ADD_EVENT when Add task
  // is clicked" for the pattern this mirrors. todo-page.tsx's existing
  // listener is what actually opens `QuickAddDialog`; this only has to
  // prove the event fires.
  it("dispatches OPEN_QUICK_ADD_EVENT when clicked", () => {
    const handler = vi.fn();
    document.addEventListener(OPEN_QUICK_ADD_EVENT, handler);
    try {
      render(<TodoCreateFab />);

      fireEvent.click(screen.getByRole("button", { name: "Quick add" }));

      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener(OPEN_QUICK_ADD_EVENT, handler);
    }
  });

  // Named "Quick add", not "Add task" — todo-page.test.tsx's own comment
  // records "exactly one Add task-named button in the tree" as a
  // load-bearing invariant (AddTaskForm's own trigger). A second button
  // sharing that name would make every `getByRole("button", { name: "Add
  // task" })` in this repo ambiguous the moment both are mounted together
  // on todo-page.tsx.
  it("is never named 'Add task'", () => {
    render(<TodoCreateFab />);

    expect(screen.queryByRole("button", { name: "Add task" })).not.toBeInTheDocument();
  });

  // 56 CSS px (size-14), matching Todoist's own measured FAB (the ticket's
  // brief) rather than only clearing the acceptance criterion's 48px
  // floor. jsdom lays nothing out (shell.test.tsx's own comment on the
  // identical limit), so this can only confirm the class landed, not the
  // rendered pixels — real measurement is a device/browser concern this
  // agent could not verify.
  it("is 56 CSS px square (size-14)", () => {
    render(<TodoCreateFab />);

    expect(screen.getByRole("button", { name: "Quick add" }).className).toContain("size-14");
  });
});
