import { describe, expect, it } from "vitest";
import {
  anchoredScrollTop,
  DEFAULT_ZOOM_INDEX,
  minimumFraction,
  scaleMarks,
  ZOOM_LEVELS,
} from "@/lib/time-zoom";

/**
 * Issue #418: the smallest durations (10s–1min records) could not be seen at
 * the page's one fixed scale, and the whole point of zoom is that the scale
 * stops being fixed. These are the pure seams that decide — how tall a
 * record's minimum click target is at a given zoom, where the clock's labels
 * fall, and how to keep the instant under the reader's finger or cursor
 * stationary while the scale changes height underneath it.
 */

describe("ZOOM_LEVELS", () => {
  it("includes the page's original fixed scale as the default", () => {
    expect(ZOOM_LEVELS[DEFAULT_ZOOM_INDEX]).toBe(120);
  });

  it("is sorted so zoomIn/zoomOut can walk it as one axis", () => {
    const sorted = [...ZOOM_LEVELS].sort((a, b) => a - b);
    expect(ZOOM_LEVELS).toEqual(sorted);
  });
});

describe("minimumFraction", () => {
  it("keeps the smallest target at 8px regardless of zoom", () => {
    // At the default 120px/hour a day is 2880px tall, so an 8px target is
    // 8/2880 of the day.
    expect(minimumFraction(120)).toBeCloseTo(8 / 2880, 10);
  });

  it("shrinks as the caller zooms in, since the same fraction now covers more pixels", () => {
    const zoomedOut = minimumFraction(30);
    const zoomedIn = minimumFraction(3840);
    expect(zoomedIn).toBeLessThan(zoomedOut);
    // 128x the px-per-hour must mean 1/128th the fraction for the same 8px.
    expect(zoomedOut / zoomedIn).toBeCloseTo(3840 / 30, 10);
  });
});

/** `list[index]`, throwing rather than returning `undefined` — a louder failure than a non-null assertion for a test that expects the index to exist. */
function nth<T>(list: readonly T[], index: number): T {
  const value = list[index];
  if (value === undefined) {
    throw new Error(`expected an element at index ${index}, but the list has ${list.length}`);
  }
  return value;
}

describe("scaleMarks", () => {
  const DAY_START = Date.parse("2026-03-15T00:00:00Z");
  const DAY_END = Date.parse("2026-03-16T00:00:00Z");

  it("picks a coarser step than an hour once 60-minute marks would sit too close together", () => {
    // At 30px/hour a 60-minute step is 30px apart, under the ~40px floor, so
    // this has to fall back to a 2-hour step (60px apart) instead.
    const marks = scaleMarks(DAY_START, DAY_END, 30);
    const minutesBetween = (nth(marks, 1).instant - nth(marks, 0).instant) / 60_000;
    expect(minutesBetween).toBe(120);
    expect(marks).toHaveLength(12);
  });

  it("picks a finer step once there is room for one, never coarser than an hour above 60px/hour", () => {
    // At 120px/hour, 30-minute marks are 60px apart (>= the 40px floor) and
    // that is the finest step the day divides evenly by that still clears it.
    const marks = scaleMarks(DAY_START, DAY_END, 120);
    const minutesBetween = (nth(marks, 1).instant - nth(marks, 0).instant) / 60_000;
    expect(minutesBetween).toBe(30);
    expect(marks).toHaveLength(48);
  });

  it("reaches one-minute marks at the top zoom level", () => {
    const marks = scaleMarks(DAY_START, DAY_END, 3840);
    const minutesBetween = (nth(marks, 1).instant - nth(marks, 0).instant) / 60_000;
    expect(minutesBetween).toBe(1);
  });

  it("labels every mark by reading the clock at its own instant, not by assuming local midnight", () => {
    // The Server resolves a day against its own timezone (ADR 0092), which a
    // Device several hours off UTC does not begin at local midnight for. An
    // implementation that placed marks by local hour would pile the first
    // several onto the top edge instead of spacing them evenly. Mirrors the
    // property `time-lanes.ts`'s retired `hourMarks` documented.
    const marks = scaleMarks(DAY_START, DAY_END, 120);
    for (const mark of marks) {
      const at = new Date(mark.instant);
      const expectedLabel = `${String(at.getHours()).padStart(2, "0")}:${String(
        at.getMinutes(),
      ).padStart(2, "0")}`;
      expect(mark.label).toBe(expectedLabel);
    }
  });

  it("marks every mark's top as its own fraction of the day, strictly increasing", () => {
    const marks = scaleMarks(DAY_START, DAY_END, 120);
    const tops = marks.map((mark) => mark.top);
    expect(tops[0]).toBe(0);
    for (let i = 1; i < tops.length; i += 1) {
      expect(nth(tops, i)).toBeGreaterThan(nth(tops, i - 1));
    }
  });

  it("flags only the hour boundaries as major, whatever the chosen step", () => {
    const marks = scaleMarks(DAY_START, DAY_END, 120);
    for (const mark of marks) {
      const at = new Date(mark.instant);
      expect(mark.major).toBe(at.getMinutes() === 0);
    }
  });
});

describe("anchoredScrollTop", () => {
  it("keeps the instant under the focal point at the same screen position after zooming in", () => {
    // A day is 2880px tall at 120px/hour and 5760px at 240px/hour — exactly
    // double, chosen so the expected result is exact rather than approximate.
    const next = anchoredScrollTop({
      scrollTop: 600,
      focalOffset: 100,
      timelineTop: 0,
      oldPxPerHour: 120,
      newPxPerHour: 240,
    });
    // The focal instant sat at content-offset 700 (600 scrolled + 100 into the
    // viewport) out of 2880px — 24.305...% of the day. At double the height
    // that is offset 1400; putting that back 100px below the viewport's top
    // means scrolling to 1300.
    expect(next).toBe(1300);
  });

  it("keeps the instant stationary when zooming out too", () => {
    const next = anchoredScrollTop({
      scrollTop: 1300,
      focalOffset: 100,
      timelineTop: 0,
      oldPxPerHour: 240,
      newPxPerHour: 120,
    });
    expect(next).toBe(600);
  });

  it("accounts for the timeline's own offset within the scroll content", () => {
    // Identical to the first case but the timeline scale starts 50px into the
    // scrollable content (e.g. below some other heading), which the focal
    // instant's offset has to be measured from rather than from the very top.
    const next = anchoredScrollTop({
      scrollTop: 650,
      focalOffset: 100,
      timelineTop: 50,
      oldPxPerHour: 120,
      newPxPerHour: 240,
    });
    expect(next).toBe(1350);
  });

  it("never returns a negative scrollTop", () => {
    const next = anchoredScrollTop({
      scrollTop: 0,
      focalOffset: 0,
      timelineTop: 0,
      oldPxPerHour: 3840,
      newPxPerHour: 30,
    });
    expect(next).toBeGreaterThanOrEqual(0);
  });
});
