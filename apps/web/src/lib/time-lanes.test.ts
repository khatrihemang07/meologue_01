import { describe, expect, it } from "vitest";
import {
  dayFraction,
  formatDuration,
  lanesFor,
  MINIMUM_INTERVAL_FRACTION,
  placeLane,
} from "@/lib/time-lanes";
import type { ActivityInterval } from "@/lib/time-transport";

/**
 * The lane geometry issue #420's comparison depends on.
 *
 * These are here rather than in `time-page.test.tsx` because jsdom has no
 * layout engine: every `getBoundingClientRect` it returns is zero, so a test
 * rendering the page could never tell a correct lane split from one that
 * stacked every record on top of the last. Asserting on the fractions the page
 * turns into styles is the only place the claim can actually be checked.
 */

const DAY_START = Date.parse("2026-03-15T00:00:00Z");
const DAY_END = Date.parse("2026-03-16T00:00:00Z");

let sequence = 0;

function interval(
  overrides: Partial<ActivityInterval> & Pick<ActivityInterval, "started_at" | "ended_at">,
): ActivityInterval {
  sequence += 1;
  return {
    id: `interval-${sequence}`,
    source_id: "source-a",
    source_name: "Toggl Track",
    source_kind: "toggl_activity",
    source_enabled: true,
    provider_record_id: `record-${sequence}`,
    label: "Xcode",
    detail: null,
    idle: false,
    ...overrides,
  };
}

/** `HH:MM` on the fixture day, as an ISO instant. */
function at(clock: string): string {
  return `2026-03-15T${clock}:00Z`;
}

describe("dayFraction", () => {
  it("places an instant at its proportion of the day", () => {
    expect(dayFraction(Date.parse(at("06:00")), DAY_START, DAY_END)).toBeCloseTo(0.25, 10);
    expect(dayFraction(Date.parse(at("12:00")), DAY_START, DAY_END)).toBeCloseTo(0.5, 10);
  });

  it("clamps a record that began before the day or ended after it", () => {
    // A stretch of work that ran past midnight belongs to both days it covers.
    // On this one it starts at the top edge rather than somewhere above it,
    // which is what stops it being drawn off the top of the scale.
    expect(dayFraction(Date.parse("2026-03-14T22:00:00Z"), DAY_START, DAY_END)).toBe(0);
    expect(dayFraction(Date.parse("2026-03-16T02:00:00Z"), DAY_START, DAY_END)).toBe(1);
  });
});

describe("placeLane", () => {
  it("gives a lane with no overlaps the full width", () => {
    const placed = placeLane(
      [
        interval({ started_at: at("09:00"), ended_at: at("10:00") }),
        interval({ started_at: at("11:00"), ended_at: at("12:00") }),
      ],
      DAY_START,
      DAY_END,
    );

    expect(placed.map((entry) => [entry.column, entry.columns])).toEqual([
      [0, 1],
      [0, 1],
    ]);
    expect(placed.map((entry) => entry.top)).toEqual([
      expect.closeTo(9 / 24, 10),
      expect.closeTo(11 / 24, 10),
    ]);
    expect(placed.map((entry) => entry.height)).toEqual([
      expect.closeTo(1 / 24, 10),
      expect.closeTo(1 / 24, 10),
    ]);
  });

  it("splits overlapping records into side-by-side columns", () => {
    // The whole point of the comparison: two records covering the same clock
    // period must both remain reachable, not one hidden behind the other.
    const placed = placeLane(
      [
        interval({ started_at: at("09:00"), ended_at: at("11:00"), label: "first" }),
        interval({ started_at: at("10:00"), ended_at: at("12:00"), label: "second" }),
      ],
      DAY_START,
      DAY_END,
    );

    expect(placed.map((entry) => [entry.interval.label, entry.column, entry.columns])).toEqual([
      ["first", 0, 2],
      ["second", 1, 2],
    ]);
  });

  it("treats records that merely touch as not overlapping", () => {
    // One ending exactly where the next begins is the ordinary case for a
    // recorder that logs every application switch. Narrowing the day for it
    // would halve the width of almost every record there is.
    const placed = placeLane(
      [
        interval({ started_at: at("09:00"), ended_at: at("10:00") }),
        interval({ started_at: at("10:00"), ended_at: at("11:00") }),
      ],
      DAY_START,
      DAY_END,
    );

    expect(placed.every((entry) => entry.columns === 1)).toBe(true);
  });

  it("narrows only the cluster that overlaps, not the whole lane", () => {
    const placed = placeLane(
      [
        interval({ started_at: at("01:00"), ended_at: at("02:00"), label: "alone early" }),
        interval({ started_at: at("09:00"), ended_at: at("11:00"), label: "busy a" }),
        interval({ started_at: at("09:30"), ended_at: at("10:30"), label: "busy b" }),
        interval({ started_at: at("20:00"), ended_at: at("21:00"), label: "alone late" }),
      ],
      DAY_START,
      DAY_END,
    );

    const widths = Object.fromEntries(placed.map((entry) => [entry.interval.label, entry.columns]));
    expect(widths).toEqual({
      "alone early": 1,
      "busy a": 2,
      "busy b": 2,
      "alone late": 1,
    });
  });

  it("reuses a column once its previous record has ended", () => {
    // Three records, but never more than two at once, so the lane splits in
    // two rather than three: the third reuses the slot the first vacated.
    const placed = placeLane(
      [
        interval({ started_at: at("09:00"), ended_at: at("10:00"), label: "a" }),
        interval({ started_at: at("09:30"), ended_at: at("11:30"), label: "b" }),
        interval({ started_at: at("10:30"), ended_at: at("11:00"), label: "c" }),
      ],
      DAY_START,
      DAY_END,
    );

    expect(placed.map((entry) => [entry.interval.label, entry.column, entry.columns])).toEqual([
      ["a", 0, 2],
      ["b", 1, 2],
      ["c", 0, 2],
    ]);
  });

  it("keeps a seconds-long record tall enough to point at", () => {
    // The Toggl database this was built against records stretches as short as
    // ten seconds. At a true fraction of a day that is sub-pixel on any real
    // screen, and a record nobody can click is not individually accessible.
    const heights = placeLane(
      [interval({ started_at: at("09:00"), ended_at: "2026-03-15T09:00:10Z" })],
      DAY_START,
      DAY_END,
    ).map((entry) => entry.height);

    const trueFraction = 10_000 / (24 * 60 * 60 * 1000);
    expect(trueFraction).toBeLessThan(MINIMUM_INTERVAL_FRACTION);
    expect(heights).toEqual([expect.closeTo(MINIMUM_INTERVAL_FRACTION, 10)]);
  });

  it("separates records that only overlap once drawn at their minimum height", () => {
    // The defect this exists for, found by measuring real boxes in a browser
    // rather than in jsdom: two twenty-second records half a minute apart do
    // not overlap on the clock at all, but both are drawn at the three-minute
    // minimum, so the second covers the first. Deciding columns from the clock
    // alone left a run of them stacked and unreachable while every unit test
    // stayed green.
    const placed = placeLane(
      [
        interval({
          started_at: "2026-03-15T09:00:00Z",
          ended_at: "2026-03-15T09:00:20Z",
          label: "a",
        }),
        interval({
          started_at: "2026-03-15T09:00:30Z",
          ended_at: "2026-03-15T09:00:50Z",
          label: "b",
        }),
      ],
      DAY_START,
      DAY_END,
    );

    expect(placed.map((entry) => [entry.interval.label, entry.column, entry.columns])).toEqual([
      ["a", 0, 2],
      ["b", 1, 2],
    ]);
  });

  it("leaves short records alone once they are far enough apart to be drawn apart", () => {
    // The control for the case above. Without it, "always split short records"
    // would pass that test and quietly narrow every quiet stretch of the day.
    const minimumMinutes = MINIMUM_INTERVAL_FRACTION * 24 * 60;
    expect(minimumMinutes).toBeCloseTo(3, 10);

    const placed = placeLane(
      [
        interval({
          started_at: "2026-03-15T09:00:00Z",
          ended_at: "2026-03-15T09:00:20Z",
          label: "a",
        }),
        interval({
          started_at: "2026-03-15T09:04:00Z",
          ended_at: "2026-03-15T09:04:20Z",
          label: "b",
        }),
      ],
      DAY_START,
      DAY_END,
    );

    expect(placed.every((entry) => entry.columns === 1)).toBe(true);
  });

  it("orders by start instant regardless of the order it was handed", () => {
    const placed = placeLane(
      [
        interval({ started_at: at("15:00"), ended_at: at("16:00"), label: "later" }),
        interval({ started_at: at("09:00"), ended_at: at("10:00"), label: "earlier" }),
      ],
      DAY_START,
      DAY_END,
    );

    expect(placed.map((entry) => entry.interval.label)).toEqual(["earlier", "later"]);
  });
});

describe("lanesFor", () => {
  it("groups a day's intervals into one lane per recorder", () => {
    const lanes = lanesFor([
      interval({ started_at: at("09:00"), ended_at: at("10:00") }),
      interval({
        started_at: at("09:30"),
        ended_at: at("10:30"),
        source_id: "source-b",
        source_name: "Clockify Desktop",
        source_kind: "clockify_auto_tracker",
      }),
      interval({ started_at: at("11:00"), ended_at: at("12:00") }),
    ]);

    expect(lanes.map((lane) => [lane.sourceName, lane.intervals.length])).toEqual([
      ["Clockify Desktop", 1],
      ["Toggl Track", 2],
    ]);
    expect(lanes.map((lane) => lane.sourceKind)).toEqual([
      "clockify_auto_tracker",
      "toggl_activity",
    ]);
  });

  it("keeps an archived source's lane but sorts it after the active ones", () => {
    // Archival stops future imports; it does not erase the days a source
    // already covered (issue #423). Its lane stays, and it stays out of the
    // way of the lanes someone is actually reading.
    const lanes = lanesFor([
      interval({
        started_at: at("09:00"),
        ended_at: at("10:00"),
        source_id: "archived",
        source_name: "Abandoned recorder",
        source_enabled: false,
      }),
      interval({ started_at: at("09:00"), ended_at: at("10:00") }),
    ]);

    expect(lanes.map((lane) => [lane.sourceName, lane.enabled])).toEqual([
      ["Toggl Track", true],
      ["Abandoned recorder", false],
    ]);
  });

  it("has no lane for a source that recorded nothing on this day", () => {
    expect(lanesFor([])).toEqual([]);
  });
});

describe("placeLane with a caller-supplied minimum", () => {
  it("draws a short record at the minimum the caller asked for, not the default", () => {
    // Issue #418: at high zoom the minimum comes from `time-zoom.ts`'s
    // `minimumFraction`, not the fixed three-minute default below — a
    // caller that passes a smaller minimum must see it actually used.
    const tighterMinimum = 1 / (24 * 200); // ~18 seconds of a day
    const heights = placeLane(
      [interval({ started_at: at("09:00"), ended_at: "2026-03-15T09:00:10Z" })],
      DAY_START,
      DAY_END,
      tighterMinimum,
    ).map((entry) => entry.height);

    expect(heights).toEqual([expect.closeTo(tighterMinimum, 10)]);
  });
});

describe("formatDuration", () => {
  it("drops to the largest unit that says something", () => {
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(90_000)).toBe("1m 30s");
    expect(formatDuration(3_900_000)).toBe("1h 5m");
  });
});
