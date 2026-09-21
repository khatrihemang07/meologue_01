import { describe, expect, it } from "vitest";
import { dayOf, timeOf, withDay, withTime } from "./task-fields";

// Issue #435's own code review: `dayOf`/`timeOf`/`withDay`/`withTime` are
// the one place `useTaskDateState` (apps/web) and `OverdueRescheduleAction`
// (apps/web) both split and recombine a Task's `date` — see `withDay`'s own
// doc comment for why. Covered here, directly, rather than only indirectly
// through either caller's own test suite, since both callers depend on the
// exact same arithmetic staying correct.

describe("dayOf", () => {
  it("returns null for a null date", () => {
    expect(dayOf(null)).toBeNull();
  });

  it("returns the day of an all-day date unchanged", () => {
    expect(dayOf("2026-03-05")).toBe("2026-03-05");
  });

  it("drops the time-of-day off a timed date", () => {
    expect(dayOf("2026-03-05T09:00")).toBe("2026-03-05");
  });
});

describe("timeOf", () => {
  it("returns null for a null date", () => {
    expect(timeOf(null)).toBeNull();
  });

  it("returns null for an all-day date", () => {
    expect(timeOf("2026-03-05")).toBeNull();
  });

  it("returns the time-of-day of a timed date", () => {
    expect(timeOf("2026-03-05T09:00")).toBe("09:00");
  });
});

describe("withDay", () => {
  it("moves a null date to the new day, staying all-day", () => {
    expect(withDay(null, "2026-03-06")).toBe("2026-03-06");
  });

  it("moves an all-day date to the new day, staying all-day", () => {
    expect(withDay("2026-03-05", "2026-03-06")).toBe("2026-03-06");
  });

  // Issue #256's own criterion, the one this helper exists to keep true in
  // exactly one place: changing the day preserves an already-chosen time.
  it("moves a timed date to the new day, keeping its own time-of-day", () => {
    expect(withDay("2026-03-05T09:00", "2026-03-06")).toBe("2026-03-06T09:00");
  });
});

describe("withTime", () => {
  it("returns null for a null date — there is no day to attach a time to", () => {
    expect(withTime(null, "09:00")).toBeNull();
  });

  // Issue #256's own criterion, the Time-button half: setting a time
  // preserves the already-chosen day.
  it("combines an all-day date's own day with the new time", () => {
    expect(withTime("2026-03-05", "09:00")).toBe("2026-03-05T09:00");
  });

  it("replaces a timed date's own time with the new one, keeping its day", () => {
    expect(withTime("2026-03-05T14:30", "09:00")).toBe("2026-03-05T09:00");
  });

  // Issue #256's own criterion: clearing the time alone keeps the day —
  // only clearing the date itself clears both.
  it("drops the time and keeps the day when time is null", () => {
    expect(withTime("2026-03-05T09:00", null)).toBe("2026-03-05");
  });
});
