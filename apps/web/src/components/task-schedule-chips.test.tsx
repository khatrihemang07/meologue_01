import type { Project, Task } from "@meologue/core";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TaskScheduleChips } from "./task-schedule-chips";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    deviceId: "device-1",
    content: "buy milk",
    completedAt: null,
    orderKey: "V",
    dayOrder: "V",
    // Issue #196: updatedAt starts equal to createdAt
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    seq: null,
    syncedAt: null,
    deletedAt: null,
    date: null,
    deadline: null,
    priority: 1,
    labelIds: [],
    dateString: null,
    projectId: null,
    sectionId: null,
    parentId: null,
    description: null,
    ...overrides,
  };
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "project-1",
    deviceId: "device-1",
    name: "Groceries",
    colour: "#b8256f",
    favourite: false,
    archived: false,
    parentId: null,
    description: null,
    orderKey: "V",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    seq: null,
    syncedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

describe("TaskScheduleChips (issue #181)", () => {
  it("renders nothing at all for a Task with no Date, no Priority above 1, and no Project", () => {
    const { container } = render(<TaskScheduleChips task={task()} projects={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the Date, but no Priority or Project chip, for an undated-priority Inbox Task with a Date", () => {
    render(<TaskScheduleChips task={task({ date: "2026-09-03" })} projects={[]} />);
    expect(screen.getByText("Sep 3")).toBeInTheDocument();
    expect(screen.queryByText(/^P\d$/)).not.toBeInTheDocument();
  });

  it("shows the Priority chip only once above level 1 — the sort chain's own 'no priority' restraint", () => {
    const { rerender } = render(<TaskScheduleChips task={task({ priority: 1 })} projects={[]} />);
    expect(screen.queryByText(/^P\d$/)).not.toBeInTheDocument();

    rerender(<TaskScheduleChips task={task({ priority: 4 })} projects={[]} />);
    expect(screen.getByText("P1")).toBeInTheDocument();
  });

  it("shows the Task's own Project name, resolved live off `projects`", () => {
    render(
      <TaskScheduleChips
        task={task({ projectId: "project-1" })}
        projects={[project({ id: "project-1", name: "Groceries" })]}
      />,
    );
    expect(screen.getByText("Groceries")).toBeInTheDocument();
  });

  it("falls back to Inbox for a projectId this Device cannot resolve", () => {
    render(<TaskScheduleChips task={task({ projectId: "gone" })} projects={[]} />);
    expect(screen.getByText("Inbox")).toBeInTheDocument();
  });

  it("never shows Deadline or a recurrence rule — fields the Composer's add field doesn't understand", () => {
    render(
      <TaskScheduleChips
        task={task({ deadline: "2026-09-10", dateString: "every weekday" })}
        projects={[]}
      />,
    );
    expect(screen.queryByText(/Sep 10/)).not.toBeInTheDocument();
    expect(screen.queryByText("every weekday")).not.toBeInTheDocument();
  });

  // The coordinator's own live-verification catch against criterion 9: a
  // completed recurring occurrence's `task.date` has already advanced to
  // the NEXT occurrence, so it must not be shown — see this module's own
  // `hideDate` doc comment for the full argument.
  describe("hideDate (issue #181's own coordinator gap-fix)", () => {
    it("suppresses the Date chip when hideDate is true, even though the Task carries one", () => {
      render(
        <TaskScheduleChips task={task({ date: "2026-09-05" })} projects={[]} hideDate={true} />,
      );
      expect(screen.queryByText("Sep 5")).not.toBeInTheDocument();
    });

    it("keeps Priority and Project showing while Date is hidden — only Date has the occurrence problem", () => {
      render(
        <TaskScheduleChips
          task={task({ date: "2026-09-05", priority: 4, projectId: "project-1" })}
          projects={[project({ id: "project-1", name: "Groceries" })]}
          hideDate={true}
        />,
      );
      expect(screen.queryByText("Sep 5")).not.toBeInTheDocument();
      expect(screen.getByText("P1")).toBeInTheDocument();
      expect(screen.getByText("Groceries")).toBeInTheDocument();
    });

    it("renders nothing at all when hideDate is the only thing the Task would otherwise have shown", () => {
      const { container } = render(
        <TaskScheduleChips task={task({ date: "2026-09-05" })} projects={[]} hideDate={true} />,
      );
      expect(container).toBeEmptyDOMElement();
    });

    it("defaults to false — an ordinary row's Date keeps showing when the caller says nothing", () => {
      render(<TaskScheduleChips task={task({ date: "2026-09-05" })} projects={[]} />);
      expect(screen.getByText("Sep 5")).toBeInTheDocument();
    });
  });
});
