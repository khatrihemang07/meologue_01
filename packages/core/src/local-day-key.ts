/**
 * `LocalDayKey` — a branded `YYYY-MM-DD` string naming a floating calendar
 * day, as opposed to a UTC instant (`Date.toISOString()`'s own shape).
 * Issue #300: the same bug — a UTC instant handed to a parameter that
 * meant a floating local day — was found and fixed four times in one
 * night (#290, #296), because every one of those parameters was typed
 * plain `string`, and a `string` accepts either shape without complaint.
 * This type closes the class rather than sampling it: a `today`/`now`
 * parameter that requires `LocalDayKey` cannot compile against
 * `new Date().toISOString()`, `completedAt`, or any other instant,
 * because none of those are `LocalDayKey` — only `apps/web`'s
 * `localDayKey()` (`lib/local-day-key.ts`) and this module's own
 * `parseLocalDayKey`/`mustParseLocalDayKey` ever produce one.
 *
 * **Why the type lives here, in `packages/core`, when its one real
 * producer (`localDayKey()`) lives in `apps/web`.** The parameters that
 * need to say "a floating local day, not an instant" — `TaskStore`'s
 * `today` arguments — are core's own interface, and packages/core's
 * exports are the only surface apps/web (and any future caller) import
 * types from. Defining `LocalDayKey` in apps/web instead would mean core
 * — the thing actually declaring "this parameter means a calendar day" —
 * couldn't reference its own parameter's type without an inverted
 * dependency (core importing from apps/web). This does NOT give core a
 * notion of local time: core still never reads a clock, never resolves an
 * offset, and never constructs a `LocalDayKey` itself (there is no
 * `Date`-consuming function here, deliberately) — it only names the shape
 * of a value some other layer already resolved against a local clock.
 * `localDayKey()` stays exactly where it is, the one place that actually
 * touches a `Date`'s local fields; it now simply returns this type
 * instead of a bare `string`, re-exported from `@meologue/core` so
 * apps/web imports the brand from the same place every `TaskStore`
 * consumer already imports `TaskStore` from.
 *
 * **How far the brand spreads (deliberately not very far).** `Task.date`
 * is also a floating value, and slicing or comparing it is always safe —
 * #296's sweep established that in the file that sweep audited
 * (`entry-day.ts`'s `shiftDayKey`, `backfill-tasks.ts`'s fallback). It
 * stays a plain `string`: it is never the thing an instant gets handed to
 * by mistake, because nothing threads `new Date().toISOString()` into a
 * `Task.date`-typed parameter — the four real bugs were all "today"-
 * shaped parameters specifically. Branding `Task.date` too would spread
 * the type through every Task-reading function in both packages for no
 * additional safety. The brand stays scoped to the parameters that were
 * actually the site of a real bug: `TaskStore.setDateString`,
 * `TaskStore.advanceRecurring`, and `TaskStore.postpone`'s `today`
 * arguments.
 *
 * **`RecurrenceReference.now` and `QuickAddOptions.now` are NOT branded,
 * on purpose, and this is the one place this type deliberately falls
 * short of issue #300's own suggested shape.** Both are constructed
 * inline in `apps/web/src/components/todo/task-schedule-popover.tsx`
 * (`{ now }`/`{ dueDate, now }`, from that file's own `now: string`
 * parameter) — a file this change is not permitted to touch (concurrent
 * work on the same checkout). Branding either field would make that
 * file's own two call sites fail to compile with no way to fix them here.
 * Every one of the four historical bugs was a `TaskStore` method, never a
 * bare `RecurrenceReference`/`QuickAddOptions` construction, so scoping
 * the brand to `TaskStore` still closes the entire observed class; the
 * gap this leaves is `task-schedule-popover.tsx`'s own `now` staying an
 * unbranded `string`, tracked as follow-up rather than silently dropped.
 *
 * **Why `completedAt` (the instant `advanceRecurring` also takes) is NOT
 * branded.** Issue #300 raises this as worth considering — the two
 * parameters are adjacent and both `string` today, so swapping them
 * compiles. But every one of the four real incidents fed an instant where
 * a day was wanted, never the reverse; branding the instant side too
 * would only guard against a swap that has never actually happened, at
 * the cost of an `Instant`-shaped cast or parse at every literal
 * timestamp in `task-store-contract.ts` (dozens of them) — the exact
 * cast proliferation issue #300 warns against introducing to make things
 * compile. The asymmetric brand (day branded, instant not) matches the
 * asymmetric risk.
 */
export type LocalDayKey = string & { readonly __brand: "LocalDayKey" };

const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The runtime check behind `parseLocalDayKey`/`mustParseLocalDayKey` — a
 * bare `YYYY-MM-DD` shape, deliberately no calendar validity check (no
 * "April has 30 days" rejection): `../recurrence/calendar.ts`'s own
 * `parseFloating` is where that validation already lives for every other
 * floating-date consumer, and duplicating it here would be a second
 * source of truth for what counts as a valid day. This function only
 * answers "is this shaped like a day key," which is all a brand can ever
 * promise about a `string` at compile time anyway.
 */
export function isLocalDayKey(value: string): value is LocalDayKey {
  return DAY_KEY_PATTERN.test(value);
}

/**
 * The "explicit parse" issue #300 names as the brand's other legitimate
 * producer, alongside `localDayKey()` (apps/web's `lib/local-day-key.ts`)
 * itself. For a boundary that receives a `string` it cannot prove came
 * from `localDayKey()` — a value read back off a wire payload or out of
 * storage — this is how that boundary converts it into a `LocalDayKey`
 * without an `as LocalDayKey` cast standing in for validation that never
 * actually happened. Returns `null` rather than throwing, matching this
 * package's own `RecurrenceParseResult`/`Date.parse`-failure discipline
 * of a checked return over a thrown exception for input that didn't come
 * from a caller who already validated it.
 */
export function parseLocalDayKey(value: string): LocalDayKey | null {
  return isLocalDayKey(value) ? value : null;
}

/**
 * `parseLocalDayKey`, but for a caller that already knows `value` is
 * shaped like a day key and would rather fail loudly than thread a
 * `| null` through — chiefly `packages/core/src/test-support/task-store-
 * contract.ts`'s own literal `"2026-01-05"`-style fixtures, which this
 * ticket converts from a raw `string` argument (silently accepted before
 * the brand existed) into `mustParseLocalDayKey("2026-01-05")` — a real
 * parse, not an `as LocalDayKey` cast standing in for one. Throws rather
 * than returning `undefined`-through-`LocalDayKey` (which would defeat
 * the brand) when `value` isn't `YYYY-MM-DD`.
 */
export function mustParseLocalDayKey(value: string): LocalDayKey {
  const parsed = parseLocalDayKey(value);
  if (parsed === null) {
    throw new Error(`not a YYYY-MM-DD local day key: ${JSON.stringify(value)}`);
  }
  return parsed;
}
