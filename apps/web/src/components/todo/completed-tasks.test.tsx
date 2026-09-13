import type { Task } from "@meologue/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CompletedTaskRow } from "./completed-tasks";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "1",
    deviceId: "device-a",
    content: "buy milk",
    completedAt: "2026-01-01T00:00:00.000Z",
    orderKey: "V",
    dayOrder: "V",
    // Issue #196: updatedAt starts equal to createdAt
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    seq: 1,
    syncedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    // Undated, no deadline, priority 1 ("no priority") — none
    // of these tests exercise scheduling, so the fixture matches
    // packages/core/src/test-support/task-fixture.ts's own default rather
    // than inventing a second convention for "nothing set" here.
    date: null,
    deadline: null,
    priority: 1,
    // No Labels, doesn't repeat — the same "concrete value, not a gap"
    // default packages/core/src/test-support/task-fixture.ts's own
    // fixture uses for these two issue #170 fields.
    labelIds: [],
    dateString: null,
    // In Inbox, no Section, top-level — the same "nothing chosen yet"
    // state every other #171 field above defaults to, and what a Task
    // created directly in Todo starts with (@meologue/core's task-types.ts).
    projectId: null,
    sectionId: null,
    parentId: null,
    description: null,
    ...overrides,
  };
}

/**
 * ROW-14 (parity-ledger.md), the user's 2026-09-13 decision to match
 * Todoist: this file used to cover `CompletedTasks`, a collapsed
 * `<details>` disclosure below Inbox's own list. That component is gone —
 * `task-tree.tsx` now interleaves one `CompletedTaskRow` per completed
 * sibling inline, in place, and this suite covers that row alone (its own
 * position among other rows is `task-tree.test.tsx`'s "completed Tasks
 * interleave inline (ROW-14)" describe block, not this file's concern).
 */
describe("CompletedTaskRow", () => {
  it("renders with its own checkbox already checked, matching Todoist's element/role/name", () => {
    render(
      <CompletedTaskRow task={task()} depth={1} onUncomplete={vi.fn()} onOpenDetail={vi.fn()} />,
    );

    const checkbox = screen.getByRole("checkbox", { name: "Mark task as incomplete" });
    expect(checkbox).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("buy milk")).toBeInTheDocument();
  });

  it("un-completes through its own checkbox, with the whole Task, not just its id", () => {
    const onUncomplete = vi.fn();
    const completed = task({ id: "a" });
    render(
      <CompletedTaskRow
        task={completed}
        depth={1}
        onUncomplete={onUncomplete}
        onOpenDetail={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "Mark task as incomplete" }));

    expect(onUncomplete).toHaveBeenCalledWith(completed);
  });

  it("opens the Task's own detail view when its title is clicked", () => {
    const onOpenDetail = vi.fn();
    const completed = task({ id: "a" });
    render(
      <CompletedTaskRow
        task={completed}
        depth={1}
        onUncomplete={vi.fn()}
        onOpenDetail={onOpenDetail}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "buy milk" }));

    expect(onOpenDetail).toHaveBeenCalledWith(completed);
  });

  // Issue #237: this surface used to hardcode `line-through` unconditionally
  // instead of reading the "Completed checklist item" setting
  // (`data-completed-style`, index.css) the way History/Composer already
  // do — so the same completed Task struck through here and merely dimmed
  // there. `.completed-task-text` is the shared class index.css's one rule
  // reads (alongside `.completed-sample`); asserting it, and asserting
  // `line-through` is gone, is what would catch a regression back to the
  // hardcoded class. jsdom applies no real cascade, so this only proves the
  // class is present/absent, not the resulting decoration or colour
  // (`completed-style.spec.ts`, apps/e2e, is what proves that).
  it("gives a completed Task's own text the shared completed-style class instead of hardcoding line-through", () => {
    render(
      <CompletedTaskRow task={task()} depth={1} onUncomplete={vi.fn()} onOpenDetail={vi.fn()} />,
    );

    const title = screen.getByRole("button", { name: "buy milk" });
    expect(title).toHaveClass("completed-task-text");
    expect(title).not.toHaveClass("line-through");
  });

  // ROW-15 (parity-ledger.md), issue #250: this surface used to drop a
  // completed Task's own date entirely — the second of ROW-15's two
  // divergences (the first, strikethrough always rendering regardless of
  // Settings, is index.css's own `[data-surface="todo"]` re-point of
  // `--checked-list-text-decoration`/`-color`, not something jsdom's own
  // lack of a real cascade can pin from a test).
  it("shows a completed Task's own date, muted through DATE-02's completion rule", () => {
    // Far enough in the past, relative to whatever day this suite actually
    // runs on, to fall past DATE-11's "further out" edge and land on the
    // plain absolute `formatDay` wording ("2 Jan", day-then-month) rather
    // than a relative word this test would then have to compute for itself.
    render(
      <CompletedTaskRow
        task={task({ date: "2020-01-02" })}
        depth={1}
        onUncomplete={vi.fn()}
        onOpenDetail={vi.fn()}
      />,
    );

    expect(screen.getByText("2 Jan")).toBeInTheDocument();
  });

  it("renders no date at all for a completed Task that never had one", () => {
    render(
      <CompletedTaskRow
        task={task({ date: null })}
        depth={1}
        onUncomplete={vi.fn()}
        onOpenDetail={vi.fn()}
      />,
    );

    expect(screen.queryByText("2 Jan")).not.toBeInTheDocument();
  });

  it("indents by depth exactly like an active row (task-row-content.tsx's own formula)", () => {
    render(
      <CompletedTaskRow task={task()} depth={3} onUncomplete={vi.fn()} onOpenDetail={vi.fn()} />,
    );

    const row = screen.getByText("buy milk").closest("li");
    expect(row).toHaveStyle({ paddingLeft: "52px" });
  });

  it("carries data-task-id (for todo-keymap.ts's focusedTaskId) and data-completed-task (for task-tree.tsx's own measureRows exclusion)", () => {
    render(
      <CompletedTaskRow
        task={task({ id: "a" })}
        depth={1}
        onUncomplete={vi.fn()}
        onOpenDetail={vi.fn()}
      />,
    );

    const row = screen.getByText("buy milk").closest("li");
    expect(row).toHaveAttribute("data-task-id", "a");
    expect(row).toHaveAttribute("data-completed-task", "true");
  });

  it("marks its own title as a row-nav-target, the same cycle stop an active row's title is", () => {
    render(
      <CompletedTaskRow task={task()} depth={1} onUncomplete={vi.fn()} onOpenDetail={vi.fn()} />,
    );

    expect(screen.getByRole("button", { name: "buy milk" })).toHaveAttribute("data-row-nav-target");
  });
});
