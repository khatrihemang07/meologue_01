import type { Task } from "@meologue/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CompletedTasks } from "./completed-tasks";

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

describe("CompletedTasks", () => {
  it("renders nothing when there is nothing completed yet", () => {
    const { container } = render(<CompletedTasks tasks={[]} onUncomplete={vi.fn()} />);

    expect(container).toBeEmptyDOMElement();
  });

  it("lists a completed Task, findable behind the disclosure", () => {
    render(<CompletedTasks tasks={[task()]} onUncomplete={vi.fn()} />);

    expect(screen.getByText("Completed (1)")).toBeInTheDocument();
    expect(screen.getByText("buy milk")).toBeInTheDocument();
  });

  it("restores a completed Task through its own control", () => {
    const onUncomplete = vi.fn();
    render(<CompletedTasks tasks={[task({ id: "a" })]} onUncomplete={onUncomplete} />);

    fireEvent.click(screen.getByRole("button", { name: 'Restore "buy milk"' }));

    expect(onUncomplete).toHaveBeenCalledWith("a");
  });

  // Issue #237: this surface used to hardcode `line-through` unconditionally
  // instead of reading the "Completed checklist item" setting
  // (`data-completed-style`, index.css) the way History/Composer already
  // do — so the same completed Task struck through here and merely dimmed
  // there. `.completed-task-text` is the shared class index.css's one rule
  // reads (alongside `.completed-sample`); asserting it, and asserting
  // `line-through` is gone, is what would catch a regression back to the
  // hardcoded class. jsdom applies no real cascade, so this only proves the
  // class is present/absent, not the resulting decoration or colour.
  it("gives a completed Task's own text the shared completed-style class instead of hardcoding line-through", () => {
    render(<CompletedTasks tasks={[task()]} onUncomplete={vi.fn()} />);

    const text = screen.getByText("buy milk");
    expect(text).toHaveClass("completed-task-text");
    expect(text).not.toHaveClass("line-through");
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
    render(<CompletedTasks tasks={[task({ date: "2020-01-02" })]} onUncomplete={vi.fn()} />);

    expect(screen.getByText("2 Jan")).toBeInTheDocument();
  });

  it("renders no date at all for a completed Task that never had one", () => {
    render(<CompletedTasks tasks={[task({ date: null })]} onUncomplete={vi.fn()} />);

    expect(screen.queryByText("2 Jan")).not.toBeInTheDocument();
  });
});
