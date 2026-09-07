import { afterEach, describe, expect, it } from "vitest";
import { isAtLeastAsNewAs, isStrictlyNewerThan } from "./updated-at";

const REAL_TZ = process.env.TZ;

afterEach(() => {
  if (REAL_TZ === undefined) {
    delete process.env.TZ;
  } else {
    process.env.TZ = REAL_TZ;
  }
});

describe("ordering updated_at by instant", () => {
  it("orders the Server's six-digit shape against this client's three-digit one", () => {
    // Same instant — the byte comparison gets this wrong because '0' < 'Z'.
    expect(isAtLeastAsNewAs("2026-09-05T16:23:02.500000Z", "2026-09-05T16:23:02.500Z")).toBe(true);
    expect(isStrictlyNewerThan("2026-09-05T16:23:02.500000Z", "2026-09-05T16:23:02.500Z")).toBe(
      false,
    );
  });

  it("orders the Server's no-fraction shape, which the byte comparison gets backwards", () => {
    // 'Z' > '.', so a raw compare calls the earlier value greater.
    expect(isStrictlyNewerThan("2026-09-05T16:23:02Z", "2026-09-05T16:23:02.500Z")).toBe(false);
    expect(isStrictlyNewerThan("2026-09-05T16:23:02.500Z", "2026-09-05T16:23:02Z")).toBe(true);
  });

  it("collapses a sub-millisecond difference into a tie", () => {
    expect(isStrictlyNewerThan("2026-09-05T16:23:02.500900Z", "2026-09-05T16:23:02.500Z")).toBe(
      false,
    );
    expect(isAtLeastAsNewAs("2026-09-05T16:23:02.500900Z", "2026-09-05T16:23:02.500Z")).toBe(true);
  });

  it("answers false for anything it cannot read, on either side", () => {
    expect(isStrictlyNewerThan("not a timestamp", "2026-09-05T16:23:02.500Z")).toBe(false);
    expect(isStrictlyNewerThan("2026-09-05T16:23:02.500Z", "not a timestamp")).toBe(false);
    expect(isAtLeastAsNewAs(undefined, "2026-09-05T16:23:02.500Z")).toBe(false);
    expect(isAtLeastAsNewAs(null, null)).toBe(false);
  });

  // The SQL side is `strftime`, which reads a timestamp carrying no
  // timezone designator as UTC, on every machine. `Date.parse` reads that
  // same string as LOCAL time. Left alone, the two implementations of one
  // documented rule disagree by the machine's own UTC offset — and Merge,
  // which parses whatever `updated_at` a Backup file happens to hold, would
  // then pick a different winner for the same conflicting row depending on
  // where the Device is.
  describe("a timestamp carrying no timezone designator", () => {
    it("reads as UTC, matching what strftime does with it", () => {
      expect(isAtLeastAsNewAs("2026-01-01T10:00:00", "2026-01-01T10:00:00.000Z")).toBe(true);
      expect(isStrictlyNewerThan("2026-01-01T10:00:00", "2026-01-01T10:00:00.000Z")).toBe(false);
      expect(isStrictlyNewerThan("2026-01-01T10:00:00", "2026-01-01T09:59:59.999Z")).toBe(true);
    });

    it("reads as UTC whatever timezone the Device is in", () => {
      for (const tz of ["UTC", "Asia/Kolkata", "America/Los_Angeles", "Pacific/Kiritimati"]) {
        process.env.TZ = tz;
        expect(
          isStrictlyNewerThan("2026-01-01T10:00:00", "2026-01-01T10:00:00.000Z"),
          `should tie in ${tz}`,
        ).toBe(false);
        expect(
          isAtLeastAsNewAs("2026-01-01T10:00:00", "2026-01-01T10:00:00.000Z"),
          `should tie in ${tz}`,
        ).toBe(true);
      }
    });

    it("still reads a date with no time at all as UTC midnight", () => {
      expect(isAtLeastAsNewAs("2026-01-01", "2026-01-01T00:00:00.000Z")).toBe(true);
      expect(isStrictlyNewerThan("2026-01-01", "2026-01-01T00:00:00.000Z")).toBe(false);
    });

    it("leaves an explicit offset alone rather than forcing it to UTC", () => {
      // 10:00+05:30 is 04:30Z — the offset must be honoured, not overwritten.
      expect(isAtLeastAsNewAs("2026-01-01T10:00:00+05:30", "2026-01-01T04:30:00.000Z")).toBe(true);
      expect(isStrictlyNewerThan("2026-01-01T10:00:00+05:30", "2026-01-01T04:30:00.000Z")).toBe(
        false,
      );
    });
  });
});
