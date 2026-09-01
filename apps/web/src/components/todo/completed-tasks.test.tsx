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
    createdAt: "2026-01-01T00:00:00.000Z",
    seq: 1,
    syncedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    // Undated, no deadline, no duration, priority 1 ("no priority") — none
    // of these tests exercise scheduling, so the fixture matches
    // packages/core/src/test-support/task-fixture.ts's own default rather
    // than inventing a second convention for "nothing set" here.
    date: null,
    deadline: null,
    duration: null,
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
});
