import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localDayKey } from "./local-day-key";

describe("localDayKey — the local-day rule, not a UTC conversion", () => {
  // Pacific/Kiritimati sits at UTC+14, the furthest-east timezone that
  // exists — chosen specifically because a local midnight there is still
  // the *previous* day in UTC. `vi.stubEnv` reassigns `TZ` for the process;
  // only *new* `Date`s built after that pick up the new zone, which is
  // exactly what this test needs (nothing here relies on any `Date`
  // constructed before this `beforeEach` runs).
  beforeEach(() => {
    vi.stubEnv("TZ", "Pacific/Kiritimati");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("names a near-midnight local day by the day a reader would name it, not the UTC day", () => {
    // Local midnight (00:30) on the 1st, at UTC+14, is 10:30 the *previous*
    // day in UTC. A day key derived via `toISOString().slice(0, 10)` (or
    // any other UTC accessor) would silently answer the 31st here — this
    // pins that `localDayKey` never takes that route.
    const localMidnightOnThe1st = new Date(2026, 0, 1, 0, 30, 0);

    expect(localMidnightOnThe1st.toISOString().slice(0, 10)).toBe("2025-12-31");
    expect(localDayKey(localMidnightOnThe1st)).toBe("2026-01-01");
  });
});
