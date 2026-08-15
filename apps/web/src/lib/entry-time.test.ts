import { describe, expect, it } from "vitest";
import { formatAbsoluteTime, formatEntryTime } from "./entry-time";

describe("formatEntryTime", () => {
  it("renders a clock time", () => {
    expect(formatEntryTime("2026-08-15T17:27:00.000Z")).toMatch(/^\d{1,2}:\d{2}\s?(AM|PM)$/i);
  });

  it("returns null for a createdAt that doesn't parse as a date", () => {
    expect(formatEntryTime("not-a-date")).toBeNull();
  });
});

describe("formatAbsoluteTime", () => {
  it("renders a parseable timestamp", () => {
    expect(formatAbsoluteTime("2026-08-15T17:27:00.000Z")).not.toBeNull();
  });

  it("returns null for a createdAt that doesn't parse as a date", () => {
    expect(formatAbsoluteTime("not-a-date")).toBeNull();
  });
});
