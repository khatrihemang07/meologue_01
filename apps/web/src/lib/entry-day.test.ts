import { describe, expect, it } from "vitest";
import {
  deviceUtcOffsetMinutes,
  entryDayKey,
  formatClockTime,
  formatDaySeparator,
} from "./entry-day";

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
