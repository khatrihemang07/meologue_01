import type { LocalDayKey } from "../local-day-key";
import { mustParseLocalDayKey } from "../local-day-key";

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
