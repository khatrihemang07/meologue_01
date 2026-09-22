import { describe, expect, it } from "vitest";
import { localDayKey } from "@/lib/local-day-key";
import {
  effectiveMonthOfWeek,
  indexForWeekStart,
  indexOfMonthStart,
  mondayOfWeek,
  monthKeyOf,
  neighborMonthKey,
  resolveInitialIndex,
  resolveMinMonday,
  sameMonthKey,
  weekDays,
  weekStartForIndex,
} from "./month-list";

describe("mondayOfWeek", () => {
  it("returns the Monday of the week containing a mid-week date", () => {
    // Thu 10 Sep 2026 -> Mon 7 Sep 2026.
    expect(localDayKey(mondayOfWeek(new Date(2026, 8, 10)))).toBe("2026-09-07");
  });

  it("is idempotent on a Monday itself", () => {
    expect(localDayKey(mondayOfWeek(new Date(2026, 8, 7)))).toBe("2026-09-07");
  });

  it("crosses a month boundary correctly", () => {
    // Tue 1 Sep 2026 -> Mon 31 Aug 2026.
    expect(localDayKey(mondayOfWeek(new Date(2026, 8, 1)))).toBe("2026-08-31");
  });
});

describe("weekStartForIndex / indexForWeekStart — inverse pair", () => {
  const minMonday = mondayOfWeek(new Date(2026, 8, 7)); // Mon 7 Sep 2026

  it("index 0 is minMonday itself", () => {
    expect(localDayKey(weekStartForIndex(minMonday, 0))).toBe("2026-09-07");
  });

  it("advances by whole weeks", () => {
    expect(localDayKey(weekStartForIndex(minMonday, 1))).toBe("2026-09-14");
    expect(localDayKey(weekStartForIndex(minMonday, 5))).toBe("2026-10-12");
  });

  it("indexForWeekStart inverts weekStartForIndex for every index it produced", () => {
    for (const index of [0, 1, 5, 52, 520]) {
      const weekStart = weekStartForIndex(minMonday, index);
      expect(indexForWeekStart(minMonday, weekStart)).toBe(index);
    }
  });
});

describe("weekDays", () => {
  it("returns the 7 days of the week starting at the given Monday, in order", () => {
    const days = weekDays(mondayOfWeek(new Date(2026, 8, 10)));
    expect(days.map((d) => localDayKey(d))).toEqual([
      "2026-09-07",
      "2026-09-08",
      "2026-09-09",
      "2026-09-10",
      "2026-09-11",
      "2026-09-12",
      "2026-09-13",
    ]);
  });
});

describe("effectiveMonthOfWeek", () => {
  it("is the week's own Monday's month for a week entirely inside one month", () => {
    const week = mondayOfWeek(new Date(2026, 8, 10)); // Mon 7 Sep
    expect(sameMonthKey(effectiveMonthOfWeek(week), monthKeyOf(new Date(2026, 8, 1)))).toBe(true);
  });

  it("is the LATER month for a week that contains that month's own 1st (Todoist's own in-list label sits on this week)", () => {
    // Mon 28 Sep 2026 - Sun 4 Oct 2026 contains 1 Oct.
    const week = mondayOfWeek(new Date(2026, 8, 30));
    expect(sameMonthKey(effectiveMonthOfWeek(week), monthKeyOf(new Date(2026, 9, 1)))).toBe(true);
  });
});

describe("indexOfMonthStart / neighborMonthKey", () => {
  const minMonday = mondayOfWeek(new Date(2026, 8, 7)); // Mon 7 Sep 2026, Sep's own month

  it("finds the week index carrying October's own 1st", () => {
    const octoberIndex = indexOfMonthStart(minMonday, monthKeyOf(new Date(2026, 9, 1)));
    const week = weekStartForIndex(minMonday, octoberIndex);
    expect(sameMonthKey(effectiveMonthOfWeek(week), monthKeyOf(new Date(2026, 9, 1)))).toBe(true);
    // And the PREVIOUS week does not yet carry October.
    const previousWeek = weekStartForIndex(minMonday, octoberIndex - 1);
    expect(sameMonthKey(effectiveMonthOfWeek(previousWeek), monthKeyOf(new Date(2026, 9, 1)))).toBe(
      false,
    );
  });

  it("neighborMonthKey(-1)/(+1) step by calendar months, not weeks", () => {
    const september = monthKeyOf(new Date(2026, 8, 15));
    expect(neighborMonthKey(september, 1)).toEqual(monthKeyOf(new Date(2026, 9, 1)));
    expect(neighborMonthKey(september, -1)).toEqual(monthKeyOf(new Date(2026, 7, 1)));
  });

  it("crosses a year boundary", () => {
    const december = monthKeyOf(new Date(2026, 11, 15));
    expect(neighborMonthKey(december, 1)).toEqual(monthKeyOf(new Date(2027, 0, 1)));
  });
});

describe("resolveMinMonday", () => {
  it("defaults to now's own current-week Monday when no bound is given", () => {
    const now = new Date(2026, 8, 10, 12, 0); // Thu 10 Sep
    expect(localDayKey(resolveMinMonday(undefined, now))).toBe("2026-09-07");
  });

  it("uses the given bound's own week Monday when one is supplied", () => {
    // History's earlier-bound case (#442): an arbitrary earlier day key.
    expect(localDayKey(resolveMinMonday("2025-01-15", new Date(2026, 8, 10)))).toBe("2025-01-13");
  });
});

describe("resolveInitialIndex", () => {
  const minMonday = mondayOfWeek(new Date(2026, 8, 7)); // Mon 7 Sep 2026

  it("is index 0 (the start) when no initialDay is given", () => {
    expect(resolveInitialIndex(minMonday, undefined)).toBe(0);
  });

  it("is the week index containing the given initialDay", () => {
    expect(resolveInitialIndex(minMonday, "2026-10-12")).toBe(5);
  });

  it("clamps to 0 rather than going negative for an initialDay before minMonday", () => {
    expect(resolveInitialIndex(minMonday, "2026-01-01")).toBe(0);
  });
});
