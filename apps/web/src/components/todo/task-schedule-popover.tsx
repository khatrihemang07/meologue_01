/**
 * Todoist's own scheduler (issue #227, `docs/reference/todoist/
 * scheduler-and-priority.md` §§1-4) — an anchored popover, not the
 * centred/bottom-sheet shape every other picker in this app uses
 * (`ui/popover.tsx`'s own header comment explains why that primitive
 * exists at all). Replaces task-schedule-sheet.tsx's own former "Today /
 * Tomorrow / Pick a date / Clear date" button row for the Date field
 * specifically — Deadline keeps that older row untouched (this ticket's
 * own scope: Deadline is Pro-gated on the captured account, SCHED-13/
 * DATE-08 are `blocked`, and CLAUDE.md's brief is explicit that nothing
 * here should guess at its picker).
 *
 * **One parser, not two (this ticket's own "finding that shrinks it").**
 * The "Type a date" input below resolves through the identical
 * `@meologue/core` `parseQuickAdd` engine `../../lib/todo-quick-add-
 * recognition.ts` already wraps for the Composer's inline highlighting,
 * and the identical `firstOccurrence`/`resolveRecurrencePhrase` pair
 * `../../lib/quick-add-task.ts` already uses to turn a recognised
 * recurrence token into a Task's `dateString` at creation time. This file
 * builds no second grammar — it only re-runs that one, keyed off this
 * popover's own typed text instead of a title being composed.
 *
 * **A deliberate, disclosed design decision this reference corpus never
 * measured:** picking a quick option or a calendar day always commits a
 * plain, non-recurring date and clears any Recurrence the Task already
 * had (`onPickDay`'s own doc comment). Todoist's own capture never
 * exercised "pick a plain date on a Task that's already recurring" (its
 * own §7 table marks the dedicated Repeat dialog's contents a `GAP`), so
 * there is nothing to replicate here — this is the one coherent rule
 * consistent with CONTEXT.md's Recurrence entry ("what the user typed…
 * is what is stored") and with SCHED-04/05 being the only *observed*
 * door onto setting a Recurrence at all: the typed input is that door,
 * both for giving a Task its first Recurrence and for changing or
 * clearing one it already has (issue #227's own "editable Recurrence"
 * ask), and it is seeded with the Task's current `dateString` on every
 * open so editing one reads as editing, not retyping from scratch.
 */
import type { QuickAddToken } from "@meologue/core";
import { firstOccurrence, parseQuickAdd, parseRecurrence } from "@meologue/core";
import { addDays, format, nextMonday, nextSaturday } from "date-fns";
import { CalendarDays, CalendarRange, CircleSlash, Repeat, Sofa, Sun, X } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { localDayKey, parseDayKey } from "@/lib/local-day-key";
import { resolveRecurrencePhrase } from "@/lib/quick-add-task";
import { cn } from "@/lib/utils";

/** One resolved "Type a date" preview — either a plain date or a Recurrence, never both (mirrors quick-add-task.ts's own resolveRecurrence: "a recognised recurrence's own computed first occurrence overrides whatever plain date token also matched"). */
interface SchedulePreview {
  readonly day: string;
  readonly dateString: string | null;
  /** Only meaningful when `dateString` isn't null — whether the phrase has no `starting`/`ending`/`for` bound at all (SCHED-04's own captured "→ Forever"). A bounded phrase renders "→ Ends" here rather than the exact resolved end date: that would mean re-deriving `../recurrence/engine.ts`'s own private `resolveBoundDate` a second time outside the engine, for a detail this ticket's own reference capture never measured beyond the unbounded case. */
  readonly forever: boolean;
}

/** Resolves `text` against `now`/`dueDate` exactly as described in this file's own header comment. `null` for empty or unrecognised input — the caller renders nothing above the quick options in that case, matching SCHED-04's "preview appears once text resolves." */
function resolveSchedulePreview(
  text: string,
  now: string,
  dueDate: string | null,
): SchedulePreview | null {
  const trimmed = text.trim();
  if (trimmed === "") {
    return null;
  }
  const { tokens } = parseQuickAdd(trimmed, { now });
  const recurrenceToken = tokens.find(
    (token): token is Extract<QuickAddToken, { kind: "recurrence" }> => token.kind === "recurrence",
  );
  if (recurrenceToken !== undefined) {
    const phrase = resolveRecurrencePhrase(recurrenceToken.raw);
    const outcome = firstOccurrence(phrase, { dueDate, now });
    if (outcome.kind !== "occurrence") {
      return null;
    }
    const parsed = parseRecurrence(phrase);
    const forever =
      parsed.kind === "parsed" &&
      parsed.rule.endBound === null &&
      parsed.rule.durationBound === null;
    return { day: outcome.date, dateString: phrase, forever };
  }
  const dateToken = tokens.find(
    (token): token is Extract<QuickAddToken, { kind: "date" }> => token.kind === "date",
  );
  if (dateToken !== undefined) {
    return { day: dateToken.date, dateString: null, forever: false };
  }
  return null;
}

// A default time for the "Add a time" toggle below — 9am reads as "start
// of a normal working day" without this file trying to guess a reader's
// actual schedule; the picker exists specifically so nobody has to type a
// more precise one, and the `<input type="time">` right below it is where
// that precision comes from instead. (Relocated here from
// task-schedule-sheet.tsx by issue #249, along with the toggle and input
// themselves — see this file's own dateDay/dateTime doc comments below.)
const DEFAULT_TIME = "09:00";

export interface TaskSchedulePopoverProps {
  /** The trigger this popover anchors under — task-schedule-sheet.tsx's own "Date" button. */
  trigger: React.ReactNode;
  /**
   * `Task.date`'s day component (`YYYY-MM-DD`), or `null`. `onPickDay`
   * itself still only ever commits a *day* — see its own doc comment,
   * unchanged by issue #249 — but this popover is no longer only a day
   * picker: it also owns the "Add a time" toggle and the time-of-day input
   * beneath the calendar (`dateTime`/`onSetTime` below), relocated here
   * from `task-schedule-sheet.tsx`'s own Date section. The toggle and
   * input render only once `dateDay` isn't `null` — there is no time-of-day
   * to attach to an unset date.
   */
  dateDay: string | null;
  /**
   * `Task.date`'s time-of-day component (`HH:MM`), or `null` when the Task
   * is all-day. Seeds the "Add a time" checkbox (checked iff non-`null`)
   * and the `<input type="time">` shown once it's checked (issue #249).
   */
  dateTime: string | null;
  /**
   * Sets or clears the time-of-day on whatever day is already chosen —
   * fired by checking/unchecking "Add a time" (with `DEFAULT_TIME`, or
   * `null`) and by editing the time input directly. Unlike `onPickDay`,
   * this never touches `dateString` and never closes the popover — setting
   * a time is not "picking a day," and a caller combining this with the
   * currently-chosen `dateDay` is what keeps a day change from dropping an
   * already-chosen time and vice versa (`task-schedule-sheet.tsx`'s own
   * wiring does this, mirroring its former `setDay` helper).
   */
  onSetTime: (time: string | null) => void;
  /** `Task.dateString` — the Recurrence phrase currently on the Task, or `null`. Seeds the "Type a date" input on every open (this file's own header comment: the one editable surface). */
  dateString: string | null;
  /** Day-keys carrying at least one active Task, each mapped to how many — SCHED-09's calendar dot and SCHED-04's preview subline read the identical source rather than two independently-computed counts. */
  datesWithTasks: ReadonlyMap<string, number>;
  /**
   * Commits a plain day, or `null` to clear the date entirely (the "No
   * Date" quick option) — every quick option, every calendar click, and
   * a typed plain-date match all funnel through here. Per this file's own
   * header comment, a caller is expected to also clear any existing
   * `dateString` when this fires with a non-`undefined` argument (whether
   * `null` or a day) — `task-schedule-sheet.tsx`'s own wiring does this.
   */
  onPickDay: (day: string | null) => void;
  /** Commits a Recurrence phrase already validated as a live "occurrence" outcome, alongside its own resolved first date — SCHED-04/05's typed preview, clicked or committed via Enter. */
  onPickRecurrence: (dateString: string, day: string) => void;
  /** Read once per popover open, not per render — every quick option and the typed preview need the identical "today," and a fresh `new Date()` on each keystroke risks "Today" itself rolling over mid-interaction. Defaults to `new Date()` for callers (tests) that don't need to pin it. */
  now?: Date;
  /**
   * Controlled open state (issue #249) — omit both `open` and
   * `onOpenChange` for a caller happy with this popover's own internal
   * open/closed state, exactly as before this ticket; every existing
   * caller (`task-schedule-sheet.tsx`) does this today and is unaffected.
   * When `open` is provided, it alone decides whether the popover is
   * shown — this component no longer tracks that state itself — and every
   * transition (a day pick, an outside click, Escape, …) is reported
   * through `onOpenChange` instead of applied internally, the same
   * "controlled input" shape React's own `<input>` uses.
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function TaskSchedulePopover({
  trigger,
  dateDay,
  dateTime,
  onSetTime,
  dateString,
  datesWithTasks,
  onPickDay,
  onPickRecurrence,
  now = new Date(),
  open: openProp,
  onOpenChange,
}: TaskSchedulePopoverProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  // Controlled iff a caller passed `open` at all — checked once via the
  // prop's presence, not compared against a sentinel, so a caller that
  // passes `open={undefined}` explicitly still falls back to internal
  // state exactly like one that omits the prop entirely.
  const isControlled = openProp !== undefined;
  const open = isControlled ? openProp : internalOpen;
  function setOpen(next: boolean) {
    if (!isControlled) {
      setInternalOpen(next);
    }
    onOpenChange?.(next);
  }
  const [typed, setTyped] = useState("");
  const [month, setMonth] = useState<Date>(() => parseDayKey(dateDay) ?? now);
  const inputId = useId();

  // Re-seed on every open, mirroring DatePickerSheet's own identical
  // reasoning (date-picker-sheet.tsx's header comment): a dismiss never
  // commits, so the next open shouldn't look like it remembers a typed
  // draft the reader never confirmed. Seeding `typed` from `dateString`
  // (not blank) is this file's own departure from that precedent — see
  // the header comment on why an existing Recurrence has to start
  // visible for "editable" to mean anything.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-seed only on the open/close transition, not on every `now` tick or `dateDay`/`dateString` change while already open — `now` in particular has no stable identity across renders (its own default-parameter `new Date()`), so including it here would re-run this effect on every render the popover is open for, not just at open.
  useEffect(() => {
    if (open) {
      setTyped(dateString ?? "");
      setMonth(parseDayKey(dateDay) ?? now);
    }
  }, [open]);

  const nowKey = localDayKey(now);
  const preview = resolveSchedulePreview(typed, nowKey, dateDay);

  function commitDay(day: string | null) {
    onPickDay(day);
    setOpen(false);
  }

  function commitPreview() {
    if (preview === null) {
      return;
    }
    if (preview.dateString !== null) {
      onPickRecurrence(preview.dateString, preview.day);
    } else {
      onPickDay(preview.day);
    }
    setOpen(false);
  }

  const tomorrow = addDays(now, 1);
  const nextWeek = nextMonday(now);
  // SCHED-02: date-fns's `nextSaturday` is already "the next Saturday
  // strictly after `now`" — the exact rule Todoist's own "Next weekend"
  // needs, verified against both captured data points (scheduler-and-
  // priority.md §2 / parity-ledger.md SCHED-02): from Sat 12 Sep it lands
  // a full week out, Sat 19 Sep (never "today" even though today IS a
  // Saturday), and from the original Thu 10 Sep capture it lands two days
  // out, Sat 12 Sep. Renamed from `thisWeekend` — this was Todoist's own
  // slot 3 label until it (and the hint format below) changed between 10
  // and 11 Sep 2026 (SCHED-02's "Earlier note"); the underlying date math
  // never needed to change, only the label, its position (now slot 4,
  // after Next week), and the hint format (full date, not bare weekday).
  const nextWeekend = nextSaturday(now);

  // SCHED-02/03: Today/Tomorrow/Next week/Next weekend, in Todoist's own
  // order, each carrying the day-key it would commit — used both to render
  // the button and, per SCHED-03, to drop whichever one already matches
  // the Task's current date ("the quick option matching the task's current
  // date disappears," parity-ledger.md SCHED-03). `No Date` is handled
  // separately below: it isn't keyed to a day at all, and its own gate
  // (`dateDay !== null`) predates and is independent of this one.
  const quickOptionDefs = [
    {
      key: "today",
      icon: CalendarDays,
      label: "Today",
      hint: format(now, "EEE"),
      day: nowKey,
    },
    {
      key: "tomorrow",
      icon: Sun,
      label: "Tomorrow",
      hint: format(tomorrow, "EEE"),
      day: localDayKey(tomorrow),
    },
    {
      key: "next-week",
      icon: CalendarRange,
      label: "Next week",
      hint: format(nextWeek, "EEE d MMM"),
      day: localDayKey(nextWeek),
    },
    {
      key: "next-weekend",
      icon: Sofa,
      label: "Next weekend",
      hint: format(nextWeekend, "EEE d MMM"),
      day: localDayKey(nextWeekend),
    },
  ].filter((option) => option.day !== dateDay);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        data-testid="scheduler-view"
        // Radix's `Popover.Portal` renders to `document.body` by default —
        // a sibling of `chat-shell-layout.tsx`'s own `data-surface="todo"`
        // div, not a descendant of it, so every `--td-*` token (and the
        // overridden `--muted`/`--border`/etc. base ones) this component
        // reads would otherwise resolve to nothing: found live, in a real
        // browser, as an entirely unstyled card (no background, no
        // border, no radius, no shadow) sitting at the viewport's origin
        // — none of it visible from a jsdom test, which never lays
        // anything out or portals anywhere real. Re-declaring the
        // attribute here re-establishes the scope directly on the
        // portaled node itself, which is all index.css's attribute
        // selector ever required in the first place.
        data-surface="todo"
        className="flex flex-col gap-2 p-2 text-sm"
        style={{
          width: "var(--td-popover-width)",
          minHeight: "var(--td-popover-min-height)",
          borderRadius: "var(--td-popover-radius)",
          background: "var(--td-popover-background)",
          border: "1px solid var(--td-popover-border)",
          boxShadow: "var(--td-popover-shadow)",
        }}
      >
        <div className="relative">
          <label htmlFor={inputId} className="sr-only">
            Type a date
          </label>
          <input
            id={inputId}
            type="text"
            placeholder="Type a date"
            maxLength={150}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitPreview();
              }
            }}
            className="w-full rounded-md border border-border bg-background px-2 py-1 pr-7 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          {typed !== "" && (
            <button
              type="button"
              aria-label="Clear"
              onClick={() => setTyped("")}
              className="-translate-y-1/2 absolute top-1/2 right-1.5 rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>

        {preview !== null && (
          <button
            type="button"
            data-testid="scheduler-date-preview"
            onClick={commitPreview}
            className="flex flex-col items-start gap-0.5 rounded-md border border-border px-2 py-1.5 text-left hover:bg-accent"
          >
            <span className="flex items-center gap-1.5 font-medium">
              {preview.dateString !== null ? (
                <Repeat className="size-3.5" />
              ) : (
                <CalendarDays className="size-3.5" />
              )}
              {format(parseDayKey(preview.day) ?? now, "EEE d MMM")}
              {preview.dateString !== null && (
                <span className="text-muted-foreground">
                  → {preview.forever ? "Forever" : "Ends"}
                </span>
              )}
            </span>
            <span className="text-muted-foreground text-xs">
              {(() => {
                const count = datesWithTasks.get(preview.day) ?? 0;
                return count === 0 ? "No tasks" : `${count} task${count === 1 ? "" : "s"}`;
              })()}
            </span>
          </button>
        )}

        <div className="flex flex-col">
          {quickOptionDefs.map((option) => (
            <QuickOption
              key={option.key}
              icon={option.icon}
              label={option.label}
              hint={option.hint}
              onClick={() => commitDay(option.day)}
            />
          ))}
          {/* SCHED-03: only offered once a date already exists. */}
          {dateDay !== null && (
            <QuickOption
              icon={CircleSlash}
              label="No Date"
              hint={null}
              onClick={() => commitDay(null)}
            />
          )}
        </div>

        <Calendar
          mode="single"
          weekStartsOn={1}
          // `today` follows this component's own injected `now`, not
          // react-day-picker's reading of the system clock. Everything else
          // here already derives from `now` — SCHED-02's Today/Tomorrow
          // hints, the preview line above — so leaving DayPicker on its own
          // clock let the calendar's "today" cell disagree with every other
          // date in the same popover. It also made SCHED-07's own test pass
          // on exactly one day in history: it asserts `data-today="true"` on
          // 2026-09-10, the reference capture instant, through an attribute
          // DayPicker derived from the real date, so the suite went red the
          // morning after and would have stayed red for good.
          today={now}
          // SCHED-06's own captured header reads "M T W T F S S" — a
          // single letter per weekday — where react-day-picker's own
          // default formatter ("cccccc", date-fns's 2-letter standalone
          // form) renders "Mo Tu We Th Fr Sa Su" instead. Overridden here
          // rather than left at the default, which this ticket's own
          // reference measurement would otherwise silently diverge from.
          formatters={{ formatWeekdayName: (day) => format(day, "EEEEE") }}
          month={month}
          onMonthChange={setMonth}
          selected={parseDayKey(dateDay)}
          onSelect={(day) => {
            if (day !== undefined) {
              commitDay(localDayKey(day));
            }
          }}
          modifiers={{
            weekend: (day) => day.getDay() === 0 || day.getDay() === 6,
            busy: (day) => datesWithTasks.has(localDayKey(day)),
          }}
          modifiersClassNames={{
            // SCHED-10: dimmed independently of today/busy — `--muted-
            // foreground` already resolves to the measured rgb(204,204,204)
            // under this surface's dark theme (index.css's own `.dark
            // [data-surface="todo"]` block), so this reuses that token
            // rather than adding a second literal for the identical colour.
            weekend: "[&>button]:text-muted-foreground",
            // SCHED-09: a 3×3px dot drawn with `::before`, no extra DOM
            // node — the `day` cell below is already `position: relative`
            // (Calendar's own base `day` classNames), which is what lets
            // this dot position against the cell rather than the page.
            busy: "before:absolute before:bottom-0.5 before:left-1/2 before:size-[3px] before:-translate-x-1/2 before:rounded-full before:bg-[color:var(--td-calendar-busy-dot)] before:content-['']",
          }}
          classNames={{
            // SCHED-07: bold + coloured text ONLY — deliberately no
            // background/ring. react-day-picker v10 sets no `aria-current`
            // of its own (verified against its own DayButton/DayPicker
            // source before this was written) so there's nothing to
            // suppress here beyond not adding a visual ring — do not
            // "fix" this back in.
            //
            // The trailing `!` (Tailwind v4's important modifier) is load-
            // bearing, not decoration: on a weekend, this same cell also
            // carries `modifiersClassNames.weekend`'s
            // `[&>button]:text-muted-foreground` below, and both compile to
            // an equal-specificity `.<modifier> > button { color: … }` rule
            // — which one wins is decided by Tailwind's generated-CSS
            // source order, not by the order these two class strings are
            // concatenated onto the cell's `class` attribute, so reordering
            // the JSX alone would not have been a real fix. Without `!`,
            // today-on-a-weekend rendered grey instead of today-red
            // (SCHED-07); `!important` here forces today's colour to win
            // regardless of stylesheet order, without touching index.css or
            // any `--td-*` token.
            today: "[&>button]:font-bold [&>button]:text-[color:var(--td-calendar-today)]!",
            // SCHED-08: a 24px filled circle — `size-6` (Tailwind's 24px)
            // plus `rounded-full` on a square box is exactly a 12px
            // corner radius, the measured figure, not merely "looks round."
            selected:
              "[&>button]:bg-[color:var(--td-calendar-selected)] [&>button]:text-white [&>button]:font-bold [&>button]:hover:bg-[color:var(--td-calendar-selected)]",
            day_button: cn(
              buttonVariants({ variant: "ghost" }),
              "size-6 w-6 rounded-full p-0 font-normal aria-selected:opacity-100",
            ),
          }}
          className="mx-auto"
        />

        {/*
          Relocated from task-schedule-sheet.tsx's own Date section by
          issue #249 — roughly where Todoist's own Time button sits,
          below the calendar (this ticket's own reference: the dedicated
          Time dialog behind that button is a separate follow-up, not
          built here). Gated on `dateDay !== null` for the identical
          reason the sheet gated it before: there is no time-of-day to
          attach to an unset date.
        */}
        {dateDay !== null && (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={dateTime !== null}
              onChange={(event) => {
                onSetTime(event.target.checked ? DEFAULT_TIME : null);
              }}
            />
            Add a time
          </label>
        )}
        {dateTime !== null && (
          <input
            type="time"
            aria-label="Time"
            value={dateTime}
            onChange={(event) => onSetTime(event.target.value)}
            className="w-fit rounded-md border border-border bg-background px-2 py-1 text-sm"
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

function QuickOption({
  icon: Icon,
  label,
  hint,
  onClick,
}: {
  icon: typeof CalendarDays;
  label: string;
  hint: string | null;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={onClick}
      className="h-8 justify-between px-2 font-normal"
      // Explicit, rather than left to the browser's own name-from-content
      // algorithm: the label and hint sit in two sibling `<span>`s with no
      // literal whitespace between them in the DOM, which concatenates to
      // "TodayThu" (verified against this file's own test suite) instead
      // of the visually-obvious "Today Thu" a sighted reader sees.
      aria-label={hint === null ? label : `${label} ${hint}`}
    >
      <span className="flex items-center gap-2">
        <Icon className="size-4 text-muted-foreground" />
        {label}
      </span>
      {hint !== null && <span className="text-muted-foreground text-xs">{hint}</span>}
    </Button>
  );
}
