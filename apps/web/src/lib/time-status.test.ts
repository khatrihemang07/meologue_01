import { describe, expect, it } from "vitest";
import { formatNewestRecord, importSummary } from "@/lib/time-status";
import type { TimeSource } from "@/lib/time-transport";

/**
 * Issue #418's refresh-observability follow-up.
 *
 * "Refresh now" imported nothing and gave no clue why. The root cause was
 * operational — the sources pointed at stale snapshot copies of the recorder
 * databases, so every refresh correctly found 0 new records — but the UI
 * could not distinguish that from "Refresh now" silently doing nothing.
 * These two pure functions are what makes a run's result diagnosable: what
 * to say when it finishes, and how to phrase "how recent is this source's
 * data" without a raw ISO timestamp.
 */

function source(overrides: Partial<TimeSource>): TimeSource {
  return {
    id: "source-1",
    name: "Toggl Track",
    kind: "toggl_activity",
    path: "/Users/me/Toggl.sqlite",
    enabled: true,
    last_attempt_at: "2026-09-21T09:00:00Z",
    last_success_at: "2026-09-21T09:00:05Z",
    last_inserted_count: 0,
    last_warning_count: 0,
    last_error: null,
    last_scheduled_run_on: null,
    newest_record_at: null,
    state: "idle",
    ...overrides,
  } as TimeSource;
}

// Built from local Y/M/D/H/M rather than a UTC `Z` string, and compared
// against expectations phrased the same way, so this file's assertions do
// not depend on which timezone the machine running the suite happens to be
// in — `formatNewestRecord` reads the *local* clock, deliberately, the same
// Device-local convention `time-page.tsx` already uses for the day's own
// scale.
function localInstant(year: number, month: number, day: number, hour: number, minute: number) {
  return new Date(year, month - 1, day, hour, minute, 0).toISOString();
}

describe("formatNewestRecord", () => {
  const now = new Date(2026, 8, 21, 12, 0, 0);

  it("says never for a source that has stored nothing", () => {
    expect(formatNewestRecord(null, now)).toBe("never");
    expect(formatNewestRecord(undefined, now)).toBe("never");
  });

  it("shows just the clock for a record from today", () => {
    expect(formatNewestRecord(localInstant(2026, 9, 21, 8, 12), now)).toBe("08:12");
  });

  it("names yesterday rather than a bare date one day back", () => {
    expect(formatNewestRecord(localInstant(2026, 9, 20, 22, 25), now)).toBe("22:25 yesterday");
  });

  it("falls back to a full date once it is neither today nor yesterday", () => {
    expect(formatNewestRecord(localInstant(2026, 9, 18, 14, 3), now)).toBe("Sep 18, 14:03");
  });
});

describe("importSummary", () => {
  const now = new Date(2026, 8, 21, 12, 0, 0);

  it("names each source's new count once a run inserted something", () => {
    const summary = importSummary(
      [
        source({ name: "Toggl Track", last_inserted_count: 25 }),
        source({ id: "source-2", name: "Clockify Desktop", last_inserted_count: 20 }),
      ],
      now,
    );
    expect(summary).toBe("Import finished — Toggl Track: 25 new · Clockify Desktop: 20 new");
  });

  it("names each source's newest record when every one of them found nothing new", () => {
    // The exact defect this exists for: a stale snapshot file reports 0 new
    // on every run, forever, and looks identical to a healthy source that
    // simply has nothing new to import unless the newest record is shown.
    const summary = importSummary(
      [
        source({
          name: "Toggl Track",
          last_inserted_count: 0,
          newest_record_at: localInstant(2026, 9, 20, 22, 25),
        }),
        source({
          id: "source-2",
          name: "Clockify Desktop",
          last_inserted_count: 0,
          newest_record_at: localInstant(2026, 9, 21, 8, 12),
        }),
      ],
      now,
    );
    expect(summary).toBe(
      "Nothing new. Newest records: Toggl Track 22:25 yesterday · Clockify Desktop 08:12.",
    );
  });

  it("names a failing source's error rather than folding it into the new-count line", () => {
    const summary = importSummary(
      [
        source({ name: "Toggl Track", last_inserted_count: 5 }),
        source({
          id: "source-2",
          name: "Clockify Desktop",
          last_error: "source database is unreadable",
        }),
      ],
      now,
    );
    expect(summary).toContain("Toggl Track: 5 new");
    expect(summary).toContain("Clockify Desktop failed — source database is unreadable");
  });

  it("says nothing happened when the run touched no sources at all", () => {
    expect(importSummary([], now)).toBe("Import finished.");
  });

  // The Server's refresh only runs enabled sources (`enabled_sources` /
  // `run_enabled_sources` in server/src/time.rs), so an archived source's
  // outcome fields are always stale — carried over from whichever run last
  // touched it, possibly long ago. Quoting them as if this run produced them
  // is the exact defect issue #427's code review caught.
  it("omits an archived source's stale count from the finish message", () => {
    const summary = importSummary(
      [
        source({ name: "Toggl Track", last_inserted_count: 25 }),
        source({
          id: "source-2",
          name: "Old Clockify",
          enabled: false,
          last_inserted_count: 5,
        }),
      ],
      now,
    );
    expect(summary).toBe("Import finished — Toggl Track: 25 new");
    expect(summary).not.toContain("Old Clockify");
  });

  it("lets an archived source's stale non-zero count neither appear among newest records nor break the all-zero verdict", () => {
    const summary = importSummary(
      [
        source({
          name: "Toggl Track",
          last_inserted_count: 0,
          newest_record_at: localInstant(2026, 9, 20, 22, 25),
        }),
        source({
          id: "source-2",
          name: "Old Clockify",
          enabled: false,
          last_inserted_count: 5,
          newest_record_at: localInstant(2026, 9, 21, 8, 12),
        }),
      ],
      now,
    );
    expect(summary).toBe("Nothing new. Newest records: Toggl Track 22:25 yesterday.");
    expect(summary).not.toContain("Old Clockify");
  });

  it("does not report an archived source's stale error as a failure of this run", () => {
    const summary = importSummary(
      [
        source({ name: "Toggl Track", last_inserted_count: 5 }),
        source({
          id: "source-2",
          name: "Old Clockify",
          enabled: false,
          last_error: "source database is unreadable",
        }),
      ],
      now,
    );
    expect(summary).toBe("Import finished — Toggl Track: 5 new");
    expect(summary).not.toContain("Old Clockify");
  });
});
