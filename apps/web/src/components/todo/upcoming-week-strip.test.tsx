import type { Task } from "@meologue/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { UpcomingWeekStrip } from "./upcoming-week-strip";

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

// Thu 10 Sep 2026 — the identical "today" upcoming-view.test.tsx and
// task-views.test.ts's own upcomingDayHeading() block both fix "now" to,
// so every dayKey below reads the same across all three files.
const NOW = "2026-09-10T12:00";

function renderStrip(overrides: Partial<Parameters<typeof UpcomingWeekStrip>[0]> = {}) {
  const props = {
    tasks: [] as Task[],
    now: NOW,
    selectedDayKey: "2026-09-10",
    onSelectDay: vi.fn(),
    ...overrides,
  };
  render(<UpcomingWeekStrip {...props} />);
  return props;
}

describe("UpcomingWeekStrip (issue #343)", () => {
  it("renders exactly seven days, Monday first, in chronological order", () => {
    renderStrip();

    const buttons = screen.getAllByRole("button").filter((b) => b.hasAttribute("data-day-key"));
    expect(buttons.map((b) => b.getAttribute("data-day-key"))).toEqual([
      "2026-09-07",
      "2026-09-08",
      "2026-09-09",
      "2026-09-10",
      "2026-09-11",
      "2026-09-12",
      "2026-09-13",
    ]);
  });

  it("tapping a day — including one carrying nothing — reports that dayKey", () => {
    const onSelectDay = vi.fn();
    renderStrip({ onSelectDay, tasks: [] });

    const friday = screen.getByRole("button", { name: /Friday 11/ });
    fireEvent.click(friday);

    expect(onSelectDay).toHaveBeenCalledExactlyOnceWith("2026-09-11");
  });

  it("paints the selected day's circle with --td-calendar-selected, not a literal colour", () => {
    renderStrip({ selectedDayKey: "2026-09-11" });

    const friday = screen.getByRole("button", { name: /Friday 11/ });
    const circle = friday.querySelector('[aria-hidden="true"].rounded-full.font-medium');
    expect(circle).not.toBeNull();
    expect((circle as HTMLElement).style.backgroundColor).toBe("var(--td-calendar-selected)");
  });

  it("today's own text reads --td-calendar-today ONLY while unselected — a distinct, non-filled treatment from the selected day", () => {
    renderStrip({ selectedDayKey: "2026-09-11" }); // today (10th) is NOT selected

    const today = screen.getByRole("button", { name: /Thursday 10, today/ });
    const circle = today.querySelector(
      '[aria-hidden="true"].rounded-full.font-medium',
    ) as HTMLElement;
    expect(circle.style.color).toBe("var(--td-calendar-today)");
    expect(circle.style.backgroundColor).toBe("");
  });

  it("today loses its own red text the moment it becomes the selected day — filled, not merely red", () => {
    renderStrip({ selectedDayKey: "2026-09-10" }); // today IS selected

    const today = screen.getByRole("button", { name: /Thursday 10, today/ });
    const circle = today.querySelector(
      '[aria-hidden="true"].rounded-full.font-medium',
    ) as HTMLElement;
    expect(circle.style.backgroundColor).toBe("var(--td-calendar-selected)");
  });

  it("lights the dot with --td-calendar-busy-dot only for a day carrying a dated Task", () => {
    renderStrip({ tasks: [task({ id: "wed", date: "2026-09-09" })] });

    const wednesday = screen.getByRole("button", { name: /Wednesday 9, .*has scheduled tasks/ });
    const dot = wednesday.querySelector(
      '[aria-hidden="true"].rounded-full:not(.font-medium)',
    ) as HTMLElement;
    expect(dot.style.backgroundColor).toBe("var(--td-calendar-busy-dot)");

    const tuesday = screen.getByRole("button", { name: /^Tuesday 8/ });
    const tuesdayDot = tuesday.querySelector(
      '[aria-hidden="true"].rounded-full:not(.font-medium)',
    ) as HTMLElement;
    expect(tuesdayDot.style.backgroundColor).toBe("transparent");
  });

  it("does NOT light the dot for a Deadline-only Task on that day — date only, per the override on issue #343's own tracking comment", () => {
    renderStrip({ tasks: [task({ id: "wed", date: null, deadline: "2026-09-09" })] });

    const wednesday = screen.getByRole("button", { name: /^Wednesday 9/ });
    expect(wednesday).not.toHaveAccessibleName(/has scheduled tasks/);
  });

  it("shows the jump-back-to-today control only once a non-today day is selected", () => {
    renderStrip({ selectedDayKey: "2026-09-10" }); // today selected
    expect(screen.queryByRole("button", { name: "Jump to today" })).not.toBeInTheDocument();

    cleanup();
    renderStrip({ selectedDayKey: "2026-09-12" }); // a different day selected
    expect(screen.getByRole("button", { name: "Jump to today" })).toBeInTheDocument();
  });

  it("the jump-back control reports today's own dayKey when tapped", () => {
    const onSelectDay = vi.fn();
    renderStrip({ selectedDayKey: "2026-09-12", onSelectDay });

    fireEvent.click(screen.getByRole("button", { name: "Jump to today" }));

    expect(onSelectDay).toHaveBeenCalledExactlyOnceWith("2026-09-10");
  });
});
