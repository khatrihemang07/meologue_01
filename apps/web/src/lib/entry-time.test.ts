import { afterEach, describe, expect, it, vi } from "vitest";
import { formatAbsoluteTime, formatEntryTime } from "./entry-time";

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * See entry-day.test.ts's own copy of this helper for why a plain
 * `vi.spyOn(Intl, "DateTimeFormat")` isn't enough here: it swaps in a mock
 * whose `new` produces an object missing the native class's internal
 * formatting slots, so `.format()` on it throws. Forwarding to the real
 * constructor via `Reflect.construct` keeps formatters genuinely
 * functional while still counting how many actually got built.
 */
function spyOnDateTimeFormatConstructor() {
  const OriginalDateTimeFormat = Intl.DateTimeFormat;
  // biome-ignore lint/complexity/useArrowFunction: must stay a real `function` — vitest's mock only treats a `function`/`class`-shaped implementation as constructable, and `new Intl.DateTimeFormat(...)` in the code under test needs that.
  return vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function (...args: unknown[]) {
    return Reflect.construct(OriginalDateTimeFormat, args);
  } as unknown as typeof Intl.DateTimeFormat);
}

describe("formatEntryTime", () => {
  it("renders a date and clock time", () => {
    expect(formatEntryTime("2026-08-15T17:27:00.000Z")).toMatch(/2026.*\d{1,2}:\d{2}\s?(AM|PM)$/i);
  });

  it("returns null for a createdAt that doesn't parse as a date", () => {
    expect(formatEntryTime("not-a-date")).toBeNull();
  });
});

describe("formatAbsoluteTime", () => {
  it("renders a more precise timestamp than formatEntryTime, with weekday and seconds", () => {
    const absolute = formatAbsoluteTime("2026-08-15T17:27:03.000Z");

    expect(absolute).toMatch(/2026/);
    expect(absolute).toMatch(/:\d{2}:\d{2}\s?(AM|PM)$/i);
  });

  it("returns null for a createdAt that doesn't parse as a date", () => {
    expect(formatAbsoluteTime("not-a-date")).toBeNull();
  });
});

// Issue #81: formatAbsoluteTime's `toLocaleString` call carried an options
// bag, which — unlike the bare zero-argument form — builds a fresh
// `Intl.DateTimeFormat` internally on every call rather than reusing V8's
// cached one. Entry-row.tsx calls this for every row's hover tooltip
// (lazily since this same issue's fix 3, but still once per row that's
// ever hovered), so a per-call formatter meant repeated construction cost
// on top of the repeated format cost.
describe("formatAbsoluteTime formatter caching", () => {
  it("constructs its Intl.DateTimeFormat at most once across many calls, with unchanged output", async () => {
    vi.resetModules();
    const { formatAbsoluteTime: freshFormatAbsoluteTime } = await import("./entry-time");
    const spy = spyOnDateTimeFormatConstructor();

    const results = [
      freshFormatAbsoluteTime("2026-08-15T17:27:03.000Z"),
      freshFormatAbsoluteTime("2026-08-16T09:05:12.000Z"),
      freshFormatAbsoluteTime("2026-08-17T23:59:59.000Z"),
    ];

    expect(spy).toHaveBeenCalledTimes(1);
    expect(freshFormatAbsoluteTime("2026-08-15T17:27:03.000Z")).toBe(results[0]);
  });
});
