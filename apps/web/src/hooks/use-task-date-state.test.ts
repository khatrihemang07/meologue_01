import type { Task } from "@meologue/core";
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useTaskDateState } from "./use-task-date-state";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "1",
    deviceId: "device-a",
    content: "buy milk",
    completedAt: null,
    orderKey: "V",
    dayOrder: "V",
    // Issue #196: updatedAt starts equal to createdAt
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    seq: 1,
    syncedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    // Undated, no deadline, priority 1 ("no priority") — the
    // same default packages/core/src/test-support/task-fixture.ts uses.
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

describe("useTaskDateState", () => {
  it("splits an undated Task into null day and null time", () => {
    const { result } = renderHook(() => useTaskDateState(task(), vi.fn()));

    expect(result.current.dateDay).toBeNull();
    expect(result.current.dateTime).toBeNull();
  });

  it("splits a date-only Task's date into a day with a null time", () => {
    const { result } = renderHook(() => useTaskDateState(task({ date: "2026-03-05" }), vi.fn()));

    expect(result.current.dateDay).toBe("2026-03-05");
    expect(result.current.dateTime).toBeNull();
  });

  it("splits a Task with a time-of-day into both day and time", () => {
    const { result } = renderHook(() =>
      useTaskDateState(task({ date: "2026-03-05T14:30" }), vi.fn()),
    );

    expect(result.current.dateDay).toBe("2026-03-05");
    expect(result.current.dateTime).toBe("14:30");
  });

  // Issue #256's own criterion: setting a time preserves the chosen day.
  it("setScheduleTime combines the new time with the already-chosen day", () => {
    const onSetDate = vi.fn();
    const { result } = renderHook(() => useTaskDateState(task({ date: "2026-03-05" }), onSetDate));

    result.current.setScheduleTime("09:00");

    expect(onSetDate).toHaveBeenCalledWith("1", "2026-03-05T09:00");
  });

  // Issue #256's own criterion: changing the day preserves an
  // already-chosen time.
  it("setScheduleDay combines the new day with an already-chosen time", () => {
    const onSetDate = vi.fn();
    const { result } = renderHook(() =>
      useTaskDateState(task({ date: "2026-03-05T09:00" }), onSetDate),
    );

    result.current.setScheduleDay("2026-03-06");

    expect(onSetDate).toHaveBeenCalledWith("1", "2026-03-06T09:00");
  });

  // Issue #256's own criterion: clearing the date clears the time too —
  // `setScheduleDay(null)` never re-attaches the Task's existing time.
  it("setScheduleDay(null) clears the date and does not preserve the time", () => {
    const onSetDate = vi.fn();
    const { result } = renderHook(() =>
      useTaskDateState(task({ date: "2026-03-05T09:00" }), onSetDate),
    );

    result.current.setScheduleDay(null);

    expect(onSetDate).toHaveBeenCalledWith("1", null);
  });

  // Deliberately preserved edge (this hook's own header comment): setting
  // a time when no day is chosen is a no-op, matching both former call
  // sites and the fact that `TaskSchedulePopover` never offers a time
  // control until a day exists.
  it("setScheduleTime is a no-op when no day is chosen", () => {
    const onSetDate = vi.fn();
    const { result } = renderHook(() => useTaskDateState(task({ date: null }), onSetDate));

    result.current.setScheduleTime("09:00");

    expect(onSetDate).not.toHaveBeenCalled();
  });

  // Deliberately preserved edge (this hook's own header comment):
  // clearing the time alone keeps the day — only clearing the date itself
  // clears both.
  it("setScheduleTime(null) keeps the day and drops only the time", () => {
    const onSetDate = vi.fn();
    const { result } = renderHook(() =>
      useTaskDateState(task({ date: "2026-03-05T09:00" }), onSetDate),
    );

    result.current.setScheduleTime(null);

    expect(onSetDate).toHaveBeenCalledWith("1", "2026-03-05");
  });
});
