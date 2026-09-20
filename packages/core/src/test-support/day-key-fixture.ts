import type { LocalDateTimeKey, LocalDayKey } from "../local-day-key";
import { mustParseLocalDateTimeKey, mustParseLocalDayKey } from "../local-day-key";

/**
 * `mustParseLocalDayKey`, named the way `./task-fixture.ts`'s own `task()`
 * is — a short fixture helper for a test literal, not a cast. Every
 * `TaskStore.setDateString`/`advanceRecurring`/`postpone` call in
 * `./task-store-contract.ts` that used to pass a bare `"2026-01-05"`-style
 * `string` for `today` now passes `dayKey("2026-01-05")` instead: a real
 * parse of a literal the author already knows is well-formed, exercised at
 * every one of those literals rather than assumed once (issue #300).
 */
export function dayKey(value: string): LocalDayKey {
  return mustParseLocalDayKey(value);
}

/**
 * `dayKey`'s own sibling for `QuickAddOptions.now` (issue #383) — a
 * `"YYYY-MM-DDTHH:MM"` literal a test already knows is well-formed,
 * parsed for real rather than cast. Every quick-add test's own `NOW`
 * gained an explicit time-of-day once `QuickAddOptions.now` stopped
 * accepting a bare `LocalDayKey`.
 */
export function dateTimeKey(value: string): LocalDateTimeKey {
  return mustParseLocalDateTimeKey(value);
}
