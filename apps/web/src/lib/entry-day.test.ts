import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deviceUtcOffsetMinutes,
  entryDayKey,
  formatClockTime,
  formatDaySeparator,
} from "./entry-day";

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * A call-counting spy on the global `Intl.DateTimeFormat` constructor that
 * still produces real, working instances — a bare `vi.spyOn(Intl,
 * "DateTimeFormat")` replaces the native class with a mock whose `new`
 * doesn't carry over its internal formatting slots, so the very first
 * `.format()` call on the "instance" it hands back throws. Forwarding to
 * the real constructor via `Reflect.construct` (from a `function`, not an
 * arrow — vitest requires that shape to treat a mock as constructable)
 * keeps every formatter genuinely functional while still counting how many
 * times the code under test actually built one.
 */
function spyOnDateTimeFormatConstructor() {
  const OriginalDateTimeFormat = Intl.DateTimeFormat;
  // biome-ignore lint/complexity/useArrowFunction: must stay a real `function` — vitest's mock only treats a `function`/`class`-shaped implementation as constructable, and `new Intl.DateTimeFormat(...)` in the code under test needs that.
  return vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function (...args: unknown[]) {
    return Reflect.construct(OriginalDateTimeFormat, args);
  } as unknown as typeof Intl.DateTimeFormat);
}

// +05:30, the offset the export tests use, chosen because it is one of the
// offsets where a naive UTC slice lands on the wrong calendar day.
const IST = 330;

describe("entryDayKey", () => {
  it("returns the local calendar day at the given offset", () => {
    expect(entryDayKey("2026-08-15T12:00:00.000Z", IST)).toBe("2026-08-15");
  });

  it("groups a late-evening UTC instant into the next local day east of UTC", () => {
    // 23:00Z on the 14th is 04:30 on the 15th in IST — the midnight case
    // that makes this share Export's helper rather than slice the ISO string.
    expect(entryDayKey("2026-08-14T23:00:00.000Z", IST)).toBe("2026-08-15");
  });

  it("groups an early-morning UTC instant into the previous local day west of UTC", () => {
    expect(entryDayKey("2026-08-15T02:00:00.000Z", -300)).toBe("2026-08-14");
  });

  it("returns null for a createdAt that doesn't parse as a date", () => {
    expect(entryDayKey("not-a-date", IST)).toBeNull();
  });
});

describe("formatDaySeparator", () => {
  it("names the current day Today", () => {
    expect(formatDaySeparator("2026-08-18", "2026-08-18")).toBe("Today");
  });

  it("names the day before Yesterday", () => {
    expect(formatDaySeparator("2026-08-17", "2026-08-18")).toBe("Yesterday");
  });

  it("crosses a month boundary when naming Yesterday", () => {
    expect(formatDaySeparator("2026-07-31", "2026-08-01")).toBe("Yesterday");
  });

  it("names an older day in this year without the year", () => {
    const label = formatDaySeparator("2026-08-14", "2026-08-18");

    expect(label).toMatch(/14/);
    expect(label).not.toMatch(/2026/);
  });

  it("includes the year for a day in a different year", () => {
    expect(formatDaySeparator("2025-12-30", "2026-08-18")).toMatch(/2025/);
  });

  it("returns the key unchanged when it isn't a date", () => {
    expect(formatDaySeparator("not-a-day", "2026-08-18")).toBe("not-a-day");
  });
});

describe("formatClockTime", () => {
  it("renders a clock time with no date, because the day separator carries the date", () => {
    const clock = formatClockTime("2026-08-15T17:27:00.000Z");

    expect(clock).toMatch(/^\d{1,2}:\d{2}(\s| )?(AM|PM)?$/i);
    expect(clock).not.toMatch(/2026/);
  });

  it("returns null for a createdAt that doesn't parse as a date", () => {
    expect(formatClockTime("not-a-date")).toBeNull();
  });
});

describe("deviceUtcOffsetMinutes", () => {
  it("reports minutes east of UTC, the sign convention toLocalParts expects", () => {
    expect(deviceUtcOffsetMinutes()).toBe(-new Date().getTimezoneOffset());
  });
});

// Issue #81: `formatClockTime` and `formatDaySeparator` used to call
// `toLocaleTimeString`/`toLocaleDateString` *with an options bag*, which
// builds a brand-new `Intl.DateTimeFormat` internally on every call rather
// than reusing V8's cached zero-argument formatter — for History rendering
// hundreds of rows, that meant hundreds of fresh formatters per render.
// These tests prove both things a lazily-cached formatter promises: it's
// built at most once (module-reset first, so an earlier test in this file
// having already warmed the cache can't hide a regression here), and
// reusing it produces the exact same output every time.
describe("formatter caching", () => {
  it("formatClockTime constructs its Intl.DateTimeFormat at most once across many calls", async () => {
    vi.resetModules();
    const { formatClockTime: freshFormatClockTime } = await import("./entry-day");
    const spy = spyOnDateTimeFormatConstructor();

    const results = [
      freshFormatClockTime("2026-08-15T17:27:00.000Z"),
      freshFormatClockTime("2026-08-16T09:05:00.000Z"),
      freshFormatClockTime("2026-08-17T23:59:00.000Z"),
    ];

    expect(spy).toHaveBeenCalledTimes(1);
    // Same instant formatted the same way every time — caching the
    // formatter must not change what it produces.
    expect(freshFormatClockTime("2026-08-15T17:27:00.000Z")).toBe(results[0]);
  });

  it("formatDaySeparator reuses one formatter per year-suffix shape, not one per call", async () => {
    vi.resetModules();
    const { formatDaySeparator: freshFormatDaySeparator } = await import("./entry-day");
    const spy = spyOnDateTimeFormatConstructor();

    // Three calls with no year suffix (same calendar year as today) ...
    freshFormatDaySeparator("2026-08-10", "2026-08-18");
    freshFormatDaySeparator("2026-08-11", "2026-08-18");
    freshFormatDaySeparator("2026-08-12", "2026-08-18");
    // ... and two with one (a different year than today) — five calls
    // total, but only two distinct options shapes, so only two formatters.
    freshFormatDaySeparator("2025-08-10", "2026-08-18");
    freshFormatDaySeparator("2025-08-11", "2026-08-18");

    expect(spy).toHaveBeenCalledTimes(2);
  });
});
