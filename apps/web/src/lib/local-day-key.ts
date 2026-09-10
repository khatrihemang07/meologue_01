/**
 * `localDayKey`/`parseDayKey` — a `Date` <-> `YYYY-MM-DD` conversion pair
 * for a calendar-cell `Date`, as opposed to an Entry's `createdAt` instant.
 * Originally private to `date-picker-sheet.tsx` (issue #146); moved here so
 * the six-line pair carries no dependencies of its own. See "Why these two
 * live apart from the picker" below for why that move matters.
 *
 * ## Why these two don't just call `entry-day.ts`'s `entryDayKey`
 *
 * `apps/web/src/lib/entry-day.ts` establishes the one rule this app uses
 * for "what local day does this belong to" (ADR 0018, still load-bearing
 * per ADRs 0020/0030/0036): read local calendar fields at the Device's own
 * UTC offset, never a UTC conversion — because History's day separators and
 * Export's per-day files have to agree at midnight, and the only way to
 * guarantee that is to share the rule rather than restate it.
 *
 * `entryDayKey` exists to convert an Entry's *instant* (`createdAt`, a UTC
 * timestamp with no calendar day of its own until an offset is applied)
 * into a local day — that's what its `offsetMinutes` parameter is for. A
 * day tapped in a calendar grid is not an instant: `react-day-picker` hands
 * back a `Date` built directly from the cell's year/month/day at local
 * midnight, with no "now" or UTC timestamp involved anywhere upstream.
 * There is no offset to apply and nothing for `entryDayKey` to convert, so
 * calling it here would not be "reusing the shared rule" — it would be
 * inventing a fake instant just to hand it to a function built for a
 * different job.
 *
 * What *does* carry over from `entry-day.ts` is the discipline, not the
 * function: read a `Date`'s local fields directly, and never let it pass
 * through a UTC accessor first. `localDayKey` below is that discipline
 * applied to a calendar-cell `Date` instead of an Entry's `createdAt`.
 *
 * ## Why these two live apart from the picker
 *
 * `date-picker-sheet.tsx` statically imports `react-day-picker` (via
 * `@/components/ui/calendar`) and `date-fns` at module scope — real weight
 * for rendering a calendar grid, not for six lines of date-field
 * arithmetic. Because Rollup ships whatever a module imports together as
 * one chunk, every caller that imported `localDayKey` alone from that file
 * paid for the calendar grid too, whether or not it ever rendered
 * `DatePickerSheet`. Six eager Todo modules did exactly that — todo-
 * sidebar.tsx, today-view.tsx, add-task-form.tsx, filter-view.tsx,
 * upcoming-view.tsx, task-schedule-popover.tsx — and so did todo-page.tsx
 * itself. Splitting `localDayKey`/`parseDayKey` into a module with no
 * imports of its own removes that redundant weight from all of them.
 *
 * That said, measure honestly rather than assume: `src/pages/todo-page.tsx`
 * moved only from 83,540 to 83,253 gzip bytes against
 * `scripts/check-bundle-size.mjs`'s unchanged 87,600-byte ceiling — nowhere
 * near the picker's own ~15 KB, because `today-view.tsx` is itself a
 * *static* import of `todo-page.tsx` and genuinely renders `DatePickerSheet`
 * (its date-field editor), not just `localDayKey`. That one real usage
 * already keeps `date-picker-sheet.tsx` — and `react-day-picker`/`date-fns`
 * with it — on Todo's eager chunk regardless of this split; the other five
 * callers' imports were redundant weight riding along, not the sole cause
 * of it. This module still earns its keep: it removes a real duplicate
 * (`task-schedule-popover.tsx`'s own former private `parseDayKey`) and
 * means the day-key arithmetic no longer depends on which caller happens to
 * also need the picker component. It also keeps `task-detail-view.tsx`'s own
 * lazily-loaded chunk clear of `react-day-picker`, which a single
 * `localDayKey` import had just pulled into it (29,626 gzip bytes against
 * that entry's 35,300 ceiling, where routing the import through
 * `date-picker-sheet.tsx` instead cost it ~15 KB more), and
 * `task-schedule-sheet.tsx` dropped 391 bytes. But a future move of
 * `DatePickerSheet`'s
 * own `today-view.tsx` usage behind a lazy boundary is what would actually
 * unlock the larger number this file's move alone could not.
 *
 * `date-fns` (used in `date-picker-sheet.tsx` for month arithmetic and the
 * Confirm button's human-readable label) is not used by either function
 * below, and never was — it has no role in deriving the emitted day key,
 * which is exactly the second-source-of-truth issue #146 warns against.
 */

/**
 * Turns a calendar-cell `Date` (e.g. from `react-day-picker`) into the same
 * YYYY-MM-DD shape `entryDayKey` (lib/entry-day.ts) produces, by reading
 * the `Date`'s *local* fields directly with `getFullYear`/`getMonth`/
 * `getDate`. The trap this avoids: `date.toISOString()` (or any `getUTC*`
 * getter) converts the instant through UTC first. A `Date` built for local
 * midnight on, say, the 1st is a *negative-offset* instant the previous day
 * in UTC for any Device east of UTC — so slicing the ISO string would
 * silently name the wrong day. Reading the local fields the `Date` was
 * actually constructed from sidesteps the conversion entirely.
 */
export function localDayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * The inverse of `localDayKey`, for seeding a picker's initial selection
 * and visible month from a YYYY-MM-DD key. `new Date(dayKey)` — passing the
 * string straight to the `Date` constructor — parses it as UTC midnight,
 * which risks the mirror image of `localDayKey`'s trap: for a Device *west*
 * of UTC, `new Date("2026-01-01")`'s local fields read back as December
 * 31st. The three-argument numeric constructor used here always builds a
 * local-time `Date` from the fields given, so no such conversion happens.
 *
 * Accepts `null` as well as `undefined` for "no day": `date-picker-
 * sheet.tsx`'s `initialDate` prop is optional (`string | undefined`), while
 * `task-schedule-popover.tsx`'s `dateDay` prop is a nullable Task field
 * (`string | null`) — both mean the identical "nothing to seed" and share
 * the identical parsing beneath that, so one function answers both rather
 * than each caller converting its own absence sentinel first.
 */
export function parseDayKey(dayKey: string | null | undefined): Date | undefined {
  if (dayKey === undefined || dayKey === null) {
    return undefined;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (match === null) {
    return undefined;
  }
  const [, year, month, day] = match;
  return new Date(Number(year), Number(month) - 1, Number(day));
}
