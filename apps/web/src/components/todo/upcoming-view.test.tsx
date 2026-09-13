import type { Task } from "@meologue/core";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpcomingView } from "./upcoming-view";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task",
    deviceId: "device-a",
    content: "content",
    completedAt: null,
    orderKey: "V",
    dayOrder: "V",
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

function renderUpcomingView(overrides: Partial<Parameters<typeof UpcomingView>[0]> = {}) {
  const props = {
    tasks: [] as Task[],
    detailActions: {
      projects: [],
      labels: [],
      onOpenDetail: vi.fn(),
      onSetPriority: vi.fn(),
      onSetDate: vi.fn(),
      onSetDateString: vi.fn(),
      datesWithTasks: new Map(),
      onSetProject: vi.fn(),
      onSetLabels: vi.fn(),
      onCopyLink: vi.fn(),
      onRename: vi.fn(),
      commentCountFor: vi.fn(() => 0),
    },
    onComplete: vi.fn(),
    onCompleteForever: vi.fn(),
    onRequestDelete: vi.fn(),
    onOpenSchedule: vi.fn(),
    ...overrides,
  };
  render(<UpcomingView {...props} />);
  return props;
}

describe("UpcomingView", () => {
  // Pinned to the reference capture's own "today" (docs/reference/todoist/
  // README.md: 10 Sep 2026, a Thursday) so every heading this suite reads
  // matches DATE-05's own wording verbatim, mirroring TodayView's own
  // fixed-clock reasoning (today-view.test.tsx's header comment).
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 10, 12, 0)); // Sep 10, 2026, local noon
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads an explanatory empty state, not a blank panel, when nothing is dated today or later", () => {
    renderUpcomingView({ tasks: [] });

    expect(screen.getByText("Nothing scheduled")).toBeInTheDocument();
  });

  it("excludes an overdue Task — that's Today's section, not Upcoming's", () => {
    renderUpcomingView({
      tasks: [task({ id: "late", content: "late task", date: "2026-09-01" })],
    });

    expect(screen.queryByText("late task")).not.toBeInTheDocument();
    expect(screen.getByText("Nothing scheduled")).toBeInTheDocument();
  });

  it("headings read exactly '10 Sep ‧ Today ‧ Thursday' and '11 Sep ‧ Tomorrow ‧ Friday'", () => {
    renderUpcomingView({
      tasks: [
        task({ id: "today", content: "today task", date: "2026-09-10" }),
        task({ id: "tomorrow", content: "tomorrow task", date: "2026-09-11" }),
      ],
    });

    expect(screen.getByText("10 Sep ‧ Today ‧ Thursday")).toBeInTheDocument();
    expect(screen.getByText("11 Sep ‧ Tomorrow ‧ Friday")).toBeInTheDocument();
  });

  it("a day beyond tomorrow gets a weekday-only heading, no relative word", () => {
    renderUpcomingView({
      tasks: [task({ id: "later", content: "later task", date: "2026-09-12" })],
    });

    expect(screen.getByText("12 Sep ‧ Saturday")).toBeInTheDocument();
  });

  it("renders each day's Tasks under its own section, in chronological day order", () => {
    renderUpcomingView({
      tasks: [
        task({ id: "later", content: "later task", date: "2026-09-12" }),
        task({ id: "today", content: "today task", date: "2026-09-10" }),
      ],
    });

    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(["10 Sep ‧ Today ‧ Thursday", "12 Sep ‧ Saturday"]);
  });
});
