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
 * **`RecurrenceReference.now` and `QuickAddOptions.now` are branded too,
 * closing the gap issue #300 deliberately left open.** #300 stopped short
 * of these two fields because both are constructed inline in
 * `apps/web/src/components/todo/task-schedule-popover.tsx`
 * (`{ now }`/`{ dueDate, now }`, from that file's own `now: string`
 * parameter) — a file #300 was not permitted to touch (concurrent work on
 * the same checkout, #303). Issue #314 reaches it once that file was
 * clear: `resolveSchedulePreview`'s own `now` parameter is now
 * `LocalDayKey` rather than `string`, and its one call site already hands
 * it `localDayKey(now)` — a real producer, not a cast — so both inline
 * object literals produce the branded value through the parameter rather
 * than casting to it. Every one of the four historical bugs was a
 * `TaskStore` method, never a bare `RecurrenceReference`/`QuickAddOptions`
 * construction, so the brand was already closing the entire *observed*
 * class before this; #314 closes the one *reachable-but-unobserved* gap
 * the type's own shape still allowed.
 *
 * **Issue #383 moves `QuickAddOptions.now` off this brand and onto
 * `LocalDateTimeKey` below.** `RecurrenceReference.now` stays exactly
 * `LocalDayKey` — the recurrence engine has no time-of-day concept at
 * all, deliberately (a rule's own `time` field is a separate, optional
 * clause the parser attaches, not something `now` ever carries) — but
 * the quick-add parser gained one: "noon" typed after noon has already
 * passed today has to know *when* "today" is, not just *which day* it
 * is, to decide whether that means today or tomorrow. A caller that
 * needs both (`task-schedule-popover.tsx`'s own `resolveSchedulePreview`,
 * which calls both `parseQuickAdd` and `firstOccurrence` against the
 * identical instant) derives the `LocalDayKey` from its own
 * `LocalDateTimeKey` by slicing the leading 10 characters — the two
 * brands share that prefix by construction, so the day is never a
 * second, independently-resolved value that could disagree with the
 * time.
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

/**
 * `LocalDateTimeKey` — a branded `YYYY-MM-DDTHH:MM` string naming a
 * floating calendar day AND a time of day together, always both (issue
 * #383's own criterion: "every caller passes a real time of day; nothing
 * silently defaults to midnight"). This is `QuickAddOptions.now`'s own
 * type as of #383 — `LocalDayKey`'s sibling, not a replacement for it:
 * `RecurrenceReference.now` and every `TaskStore` `today` parameter stay
 * `LocalDayKey`, deliberately (this type's own header comment, above,
 * explains why the recurrence engine has no time-of-day concept to gain).
 *
 * Not `Task.date`'s own encoding (`../task-fields.ts`'s `DATE_PATTERN`,
 * re-exported as plain `string` there): that field is *optionally*
 * timed — `YYYY-MM-DD` alone is a valid all-day value — because an
 * all-day Task genuinely has no time of its own. `now` is never "all
 * day": there is always a real clock reading behind it, so requiring the
 * `T`-suffix in the type (rather than leaving it optional the way
 * `Task.date` must) is what makes "forgot to pass a real time" a compile
 * error instead of a value that quietly means midnight forever.
 *
 * The one real producer is `apps/web`'s `localDateTimeKey()`
 * (`lib/local-day-key.ts`, alongside `localDayKey()` itself) — this
 * module's own `parseLocalDateTimeKey`/`mustParseLocalDateTimeKey` are the
 * explicit-parse boundary for a value read back from storage rather than
 * freshly read off a clock, mirroring `LocalDayKey`'s own two-producer
 * shape exactly.
 */
export type LocalDateTimeKey = string & { readonly __brand: "LocalDateTimeKey" };

const DATE_TIME_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/** The runtime check behind `parseLocalDateTimeKey`/`mustParseLocalDateTimeKey` — `isLocalDayKey`'s own sibling, requiring the `THH:MM` suffix that type deliberately refuses. No calendar-validity check here either, for the identical reason `isLocalDayKey`'s own comment gives. */
export function isLocalDateTimeKey(value: string): value is LocalDateTimeKey {
  return DATE_TIME_KEY_PATTERN.test(value);
}

/** `parseLocalDayKey`'s own sibling for `LocalDateTimeKey` — a boundary that receives a `string` it cannot prove already carries a time (a value read back off a wire payload or out of storage) converts it here rather than casting. `null`, not a throw, for input that didn't come from a caller who already validated it. */
export function parseLocalDateTimeKey(value: string): LocalDateTimeKey | null {
  return isLocalDateTimeKey(value) ? value : null;
}

/** `mustParseLocalDayKey`'s own sibling — a caller that already knows `value` is `YYYY-MM-DDTHH:MM`-shaped and would rather fail loudly than thread a `| null` through. Throws rather than returning `undefined`-through-`LocalDateTimeKey`, which would defeat the brand. */
export function mustParseLocalDateTimeKey(value: string): LocalDateTimeKey {
  const parsed = parseLocalDateTimeKey(value);
  if (parsed === null) {
    throw new Error(`not a YYYY-MM-DDTHH:MM local date-time key: ${JSON.stringify(value)}`);
  }
  return parsed;
}

/**
 * `LocalDateTimeKey` -> the `LocalDayKey` sharing its leading 10
 * characters — the one place this conversion happens, so every caller
 * that needs both a quick-add `now` and a recurrence `now` for the
 * identical instant (`task-schedule-popover.tsx`'s own
 * `resolveSchedulePreview`, `apps/web`'s `commitTaskTitle`/
 * `taskFieldsFromQuickAdd`) derives the day from the time rather than
 * resolving two independent values that could disagree. Safe without a
 * `null` case: every `LocalDateTimeKey` is, by its own brand, already
 * `YYYY-MM-DD` for its first 10 characters.
 */
export function localDayKeyOf(dateTime: LocalDateTimeKey): LocalDayKey {
  return dateTime.slice(0, 10) as LocalDayKey;
}
