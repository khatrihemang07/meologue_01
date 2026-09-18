import { describe, expect, it } from "vitest";
import { describeTaskDay, formatDay, formatTaskDate } from "./format-task-date";

const NOW = new Date(2026, 8, 10, 12, 0);

describe("formatDay", () => {
  it("formats a bare day as 'd MMM', day-then-month — Todoist's order — with no tone of any kind", () => {
    expect(formatDay("2026-09-03")).toBe("3 Sep");
  });

  it("returns the raw string for something that isn't YYYY-MM-DD", () => {
    expect(formatDay("not-a-day")).toBe("not-a-day");
  });
});

describe("formatTaskDate", () => {
  it("exactly one day overdue reads 'Yesterday', toned overdue", () => {
    const display = formatTaskDate("2026-09-09", { now: NOW });
    expect(display.text).toBe("Yesterday");
    expect(display.tone).toBe("overdue");
    expect(display.colour).toBe("var(--td-date-overdue)");
  });

  it("further overdue falls back to the plain absolute day, still toned overdue — the 'further out' gap, the overdue side of it", () => {
    const display = formatTaskDate("2026-09-01", { now: NOW });
    expect(display.text).toBe("1 Sep");
    expect(display.tone).toBe("overdue");
    expect(display.colour).toBe("var(--td-date-overdue)");
  });

  it("due today reads 'Today', toned today, in the measured green (Dark theme)", () => {
    const display = formatTaskDate("2026-09-10", { now: NOW });
    expect(display.text).toBe("Today");
    expect(display.tone).toBe("today");
    expect(display.colour).toBe("var(--td-date-today)");
  });

  // Same capture: measured `rgb(255,154,20)` orange — a tone of its own,
  // no longer folded into "upcoming".
  it("due tomorrow reads 'Tomorrow', toned tomorrow, in the measured orange (Dark theme)", () => {
    const display = formatTaskDate("2026-09-11", { now: NOW });
    expect(display.text).toBe("Tomorrow");
    expect(display.tone).toBe("tomorrow");
    expect(display.colour).toBe("var(--td-date-tomorrow)");
  });

  it("two to six days out reads the weekday name alone, toned upcoming", () => {
    // 13 Sep 2026 is a Sunday, three days after the 10 Sep 2026 Thursday
    // this file's own `NOW` fixes as "today."
    const display = formatTaskDate("2026-09-13", { now: NOW });
    expect(display.text).toBe("Sunday");
    expect(display.tone).toBe("upcoming");
  });

  it("seven or more days out falls back to the plain absolute day, toned 'none' — the 'further out' gap, the upcoming side of it", () => {
    const display = formatTaskDate("2026-09-20", { now: NOW });
    expect(display.text).toBe("20 Sep");
    expect(display.tone).toBe("none");
    expect(display.colour).toBe("var(--td-date-muted)");
  });

  it("a timed date appends the time of day after whatever word the day itself resolved to, with no comma — measured live as 'Tomorrow 9:30 AM'", () => {
    const display = formatTaskDate("2026-09-11T09:30", { now: NOW });
    expect(display.text).toBe("Tomorrow 9:30 AM");
  });

  it("a far-out timed date combines the day-then-month fallback with the no-comma time suffix", () => {
    const display = formatTaskDate("2026-09-21T09:30", { now: NOW });
    expect(display.text).toBe("21 Sep 9:30 AM");
  });

  it("a recurring Task appends ↻ after the date, in the date's own colour", () => {
    const display = formatTaskDate("2026-09-13", { now: NOW, recurring: true });
    expect(display.text).toBe("Sunday ↻");
    expect(display.tone).toBe("upcoming");
    expect(display.colour).toBe("var(--td-date-upcoming)");
  });

  it("completion overrides the colour to the shared muted grey, regardless of the underlying tone", () => {
    const overdue = formatTaskDate("2026-09-09", { now: NOW, completed: true });
    expect(overdue.text).toBe("Yesterday");
    expect(overdue.tone).toBe("overdue");
    expect(overdue.colour).toBe("var(--td-date-muted)");

    const upcoming = formatTaskDate("2026-09-13", { now: NOW, completed: true });
    expect(upcoming.tone).toBe("upcoming");
    expect(upcoming.colour).toBe("var(--td-date-muted)");
  });

  it("defaults `now` to the real clock when the caller passes none", () => {
    // Not asserting a specific word — only that this doesn't throw and
    // returns a real DateTone, so a caller that omits `now` (every
    // production call site) still gets a usable result.
    const display = formatTaskDate("2026-09-11");
    expect(["overdue", "today", "tomorrow", "upcoming", "none"]).toContain(display.tone);
  });
});

describe("describeTaskDay — the day-only core task-schedule-sheet.tsx declined to adopt", () => {
  it("agrees with formatTaskDate's own wording for a bare day, with no time/recurrence/completion to consider", () => {
    expect(describeTaskDay("2026-09-13", NOW)).toEqual({
      text: "Sunday",
      tone: "upcoming",
      colour: "var(--td-date-upcoming)",
    });
  });
});
