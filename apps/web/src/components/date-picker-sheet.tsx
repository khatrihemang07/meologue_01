/**
 * A month-grid date picker in a bottom Sheet (issue #146), built in
 * isolation ahead of the day separator that will open it — a later change
 * wires this to History; nothing here knows History exists.
 *
 * Tap-then-confirm, not tap-to-commit: choosing a day only highlights it,
 * and the explicit Confirm action is what calls `onConfirm`. That split is
 * deliberate — a mis-tap on a small screen would otherwise cost History a
 * long scroll back with no way to undo it, where here it costs nothing
 * because nothing happened yet.
 *
 * Every date in the grid is selectable, including a day with no Entries —
 * the grid is calendar arithmetic (via `react-day-picker`) and deliberately
 * does not know where the journal is dense. There is no `disabled` matcher
 * anywhere in this file; if you're tempted to add one, don't — see the
 * issue's own acceptance criteria.
 *
 * Modeled on `EntryActionsSheet` (`entry-actions.tsx`): one `Sheet`, driven
 * by open/closed state its caller owns, with a `SheetTitle` for Dialog's
 * required accessible name.
 *
 * ## Why this file derives its own local-day key, instead of importing one
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
 * into a local day — that's what the `offsetMinutes` parameter is for. A
 * day tapped in this grid is not an instant: `react-day-picker` hands back
 * a `Date` built directly from the cell's year/month/day at local midnight,
 * with no "now" or UTC timestamp involved anywhere upstream. There is no
 * offset to apply and nothing for `entryDayKey` to convert, so calling it
 * here would not be "reusing the shared rule" — it would be inventing a
 * fake instant just to hand it to a function built for a different job.
 *
 * What *does* carry over from `entry-day.ts` is the discipline, not the
 * function: read a `Date`'s local fields directly, and never let it pass
 * through a UTC accessor first. `localDayKey` below is that discipline
 * applied to a calendar-cell `Date` instead of an Entry's `createdAt`.
 * `date-fns` (added alongside `react-day-picker` for this component) is
 * used only for month arithmetic and the human-readable label on the
 * Confirm button — it is never used to derive the emitted day key, which is
 * exactly the second-source-of-truth the issue warns against.
 */
import { format } from "date-fns";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";

/**
 * Turns a calendar-cell `Date` from `react-day-picker` into the same
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
 * The inverse of `localDayKey`, for seeding the grid's initial selection
 * and visible month from a YYYY-MM-DD key. `new Date(dayKey)` — passing the
 * string straight to the `Date` constructor — parses it as UTC midnight,
 * which risks the mirror image of `localDayKey`'s trap: for a Device *west*
 * of UTC, `new Date("2026-01-01")`'s local fields read back as December
 * 31st. The three-argument numeric constructor used here always builds a
 * local-time `Date` from the fields given, so no such conversion happens.
 */
function parseDayKey(dayKey: string | undefined): Date | undefined {
  if (dayKey === undefined) {
    return undefined;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (match === null) {
    return undefined;
  }
  const [, year, month, day] = match;
  return new Date(Number(year), Number(month) - 1, Number(day));
}

export interface DatePickerSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** YYYY-MM-DD day key to seed the grid's selected day and visible month with. */
  initialDate?: string;
  /** Fires once, only from the explicit Confirm action — never from tapping a day alone. */
  onConfirm: (dayKey: string) => void;
}

export function DatePickerSheet({
  open,
  onOpenChange,
  initialDate,
  onConfirm,
}: DatePickerSheetProps) {
  const [selected, setSelected] = useState<Date | undefined>(() => parseDayKey(initialDate));
  const [month, setMonth] = useState<Date>(() => parseDayKey(initialDate) ?? new Date());

  // Re-seed every time the sheet opens, rather than carrying over whatever
  // was left highlighted from a previous open-then-dismiss: a dismiss (see
  // `onOpenChange` below) never reaches `onConfirm`, so the grid shouldn't
  // look like it committed to anything the next time it opens either.
  useEffect(() => {
    if (open) {
      const seeded = parseDayKey(initialDate);
      setSelected(seeded);
      setMonth(seeded ?? new Date());
    }
  }, [open, initialDate]);

  function handleConfirm() {
    if (selected === undefined) {
      return;
    }
    onConfirm(localDayKey(selected));
    onOpenChange(false);
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent>
        <SheetTitle className="px-1 pt-1 text-sm font-medium">Choose a date</SheetTitle>
        <Calendar
          mode="single"
          selected={selected}
          onSelect={setSelected}
          month={month}
          onMonthChange={setMonth}
          // Every date stays tappable — deliberately no `disabled` matcher.
          // See this file's own top comment for why that's a rule, not an
          // oversight.
          className="mx-auto"
        />
        <Button
          type="button"
          size="touch"
          className="mt-1"
          disabled={selected === undefined}
          onClick={handleConfirm}
        >
          {selected === undefined ? "Confirm" : `Confirm ${format(selected, "MMMM d, yyyy")}`}
        </Button>
      </SheetContent>
    </Sheet>
  );
}
