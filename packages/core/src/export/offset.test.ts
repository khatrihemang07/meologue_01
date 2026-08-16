import { describe, expect, it } from "vitest";
import { formatUtcOffset, toLocalParts } from "./offset";

describe("formatUtcOffset", () => {
  it("formats a positive offset", () => {
    expect(formatUtcOffset(330)).toBe("+05:30");
  });

  it("formats a negative offset", () => {
    expect(formatUtcOffset(-270)).toBe("-04:30");
  });

  it("formats UTC itself", () => {
    expect(formatUtcOffset(0)).toBe("+00:00");
  });
});

describe("toLocalParts", () => {
  it("reads local date and time at a positive offset", () => {
    expect(toLocalParts("2026-08-16T11:42:03.000Z", 330)).toEqual({
      date: "2026-08-16",
      time: "17:12:03",
    });
  });

  it("rolls the local date forward past a UTC midnight boundary", () => {
    // 23:30 UTC + 5:30 lands at 05:00 the next local day.
    expect(toLocalParts("2026-08-15T23:30:00.000Z", 330)).toEqual({
      date: "2026-08-16",
      time: "05:00:00",
    });
  });

  it("rolls the local date backward for a negative offset", () => {
    // 00:15 UTC - 4:30 lands the previous local day, at 19:45.
    expect(toLocalParts("2026-08-16T00:15:00.000Z", -270)).toEqual({
      date: "2026-08-15",
      time: "19:45:00",
    });
  });
});
