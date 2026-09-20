import { mustParseLocalDayKey, parseQuickAdd } from "@meologue/core";
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useDraftDateState } from "./use-draft-date-state";

const now = mustParseLocalDayKey("2026-01-01");

function tokensFor(text: string) {
  return parseQuickAdd(text, { now }).tokens;
}

function draft(text: string, onTextChange: (next: string) => void) {
  return renderHook(() => useDraftDateState(text, tokensFor(text), now, onTextChange)).result;
}

describe("useDraftDateState", () => {
  it("reads null day/time/dateString from a title with no date-family words", () => {
    const result = draft("buy milk", vi.fn());

    expect(result.current.dateDay).toBeNull();
    expect(result.current.dateTime).toBeNull();
    expect(result.current.dateString).toBeNull();
  });

  it("reads the day off a recognised absolute date", () => {
    const result = draft("buy milk 25 Dec 2026", vi.fn());

    expect(result.current.dateDay).toBe("2026-12-25");
  });

  it("reads the time off a recognised 24-hour time, independent of any date", () => {
    const result = draft("buy milk 14:30", vi.fn());

    expect(result.current.dateTime).toBe("14:30");
    expect(result.current.dateDay).toBeNull();
  });

  it("reads a recurrence phrase's canonical form as dateString", () => {
    const result = draft("water the plants every day", vi.fn());

    expect(result.current.dateString).toBe("every day");
  });

  it("setScheduleDay appends literal date words when the draft carries no date yet, and they read back as a real date token", () => {
    const onTextChange = vi.fn();
    const result = draft("buy milk", onTextChange);

    result.current.setScheduleDay("2026-12-25");

    expect(onTextChange).toHaveBeenCalledTimes(1);
    const next = onTextChange.mock.calls[0]?.[0] as string;
    expect(next).toBe("buy milk 25 Dec 2026");
    const reparsed = parseQuickAdd(next, { now });
    expect(reparsed.date).toBe("2026-12-25");
  });

  it("setScheduleDay replaces an existing date token's words in place, keeping the surrounding text", () => {
    const text = "Buy milk 5 Jan and eggs";
    const onTextChange = vi.fn();
    const result = draft(text, onTextChange);

    result.current.setScheduleDay("2026-12-25");

    const next = onTextChange.mock.calls[0]?.[0] as string;
    expect(next).toBe("Buy milk 25 Dec 2026 and eggs");
    const reparsed = parseQuickAdd(next, { now });
    expect(reparsed.date).toBe("2026-12-25");
  });

  it("setScheduleDay(null) removes the date words entirely", () => {
    const onTextChange = vi.fn();
    const result = draft("Buy milk 5 Jan", onTextChange);

    result.current.setScheduleDay(null);

    expect(onTextChange).toHaveBeenCalledWith("Buy milk");
  });

  it("setScheduleDay(null) also removes an existing time", () => {
    const onTextChange = vi.fn();
    const result = draft("Buy milk 5 Jan 14:30", onTextChange);

    result.current.setScheduleDay(null);

    expect(onTextChange).toHaveBeenCalledWith("Buy milk");
  });

  it("setScheduleDay(null) removes an existing recurrence phrase too", () => {
    const onTextChange = vi.fn();
    const result = draft("water the plants every day", onTextChange);

    result.current.setScheduleDay(null);

    expect(onTextChange).toHaveBeenCalledWith("water the plants");
  });

  it("setScheduleTime is a no-op when no day is set", () => {
    const onTextChange = vi.fn();
    const result = draft("buy milk", onTextChange);

    result.current.setScheduleTime("09:00");

    expect(onTextChange).not.toHaveBeenCalled();
  });

  it("setScheduleTime appends literal time words once a day is set, and they read back as part of the same due date", () => {
    const onTextChange = vi.fn();
    const result = draft("Buy milk 25 Dec 2026", onTextChange);

    result.current.setScheduleTime("09:00");

    const next = onTextChange.mock.calls[0]?.[0] as string;
    expect(next).toBe("Buy milk 25 Dec 2026 09:00");
    const reparsed = parseQuickAdd(next, { now });
    expect(reparsed.date).toBe("2026-12-25T09:00");
  });

  it("setScheduleTime replaces an existing time token's words in place", () => {
    const onTextChange = vi.fn();
    const result = draft("Buy milk 25 Dec 2026 09:00", onTextChange);

    result.current.setScheduleTime("18:00");

    expect(onTextChange).toHaveBeenCalledWith("Buy milk 25 Dec 2026 18:00");
  });

  it("setScheduleTime(null) removes only the time, keeping the day", () => {
    const onTextChange = vi.fn();
    const result = draft("Buy milk 25 Dec 2026 09:00", onTextChange);

    result.current.setScheduleTime(null);

    expect(onTextChange).toHaveBeenCalledWith("Buy milk 25 Dec 2026");
  });

  it("setScheduleRecurrence replaces a plain date with the recurrence phrase", () => {
    const onTextChange = vi.fn();
    const result = draft("Water the plants 25 Dec 2026", onTextChange);

    result.current.setScheduleRecurrence("every day", "2026-01-01");

    expect(onTextChange).toHaveBeenCalledWith("Water the plants every day");
  });

  it("setScheduleRecurrence replaces an existing recurrence phrase's own words", () => {
    const onTextChange = vi.fn();
    const result = draft("Water the plants every day", onTextChange);

    result.current.setScheduleRecurrence("every week", "2026-01-05");

    expect(onTextChange).toHaveBeenCalledWith("Water the plants every week");
  });

  it("setScheduleRecurrence appends the phrase when the draft has no date-family words yet", () => {
    const onTextChange = vi.fn();
    const result = draft("Water the plants", onTextChange);

    result.current.setScheduleRecurrence("every day", "2026-01-01");

    expect(onTextChange).toHaveBeenCalledWith("Water the plants every day");
  });
});
