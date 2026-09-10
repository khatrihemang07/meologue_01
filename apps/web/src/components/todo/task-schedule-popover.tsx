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
import { localDayKey } from "@/components/date-picker-sheet";
import { Button, buttonVariants } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { resolveRecurrencePhrase } from "@/lib/quick-add-task";
import { cn } from "@/lib/utils";

/**
 * The inverse of `localDayKey`, local to this file the same way
 * `date-picker-sheet.tsx`'s own private `parseDayKey` and
 * `format-task-date.ts`'s own private `parseLocalDay` each are — three
 * independent, identically-shaped three-line functions rather than one
 * shared export, matching this codebase's existing precedent for this
 * exact conversion rather than introducing a fourth pattern to reconcile
 * them under.
 */
function parseDayKey(dayKey: string | null): Date | undefined {
  if (dayKey === null) {
    return undefined;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (match === null) {
    return undefined;
  }
  const [, year, month, day] = match;
  return new Date(Number(year), Number(month) - 1, Number(day));
}

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

export interface TaskSchedulePopoverProps {
  /** The trigger this popover anchors under — task-schedule-sheet.tsx's own "Date" button. */
  trigger: React.ReactNode;
  /** `Task.date`'s day component (`YYYY-MM-DD`), or `null` — this popover only ever picks a day; `task-schedule-sheet.tsx`'s own "Add a time" toggle is untouched by it and preserves whatever time-of-day was already set (its own `setDay` helper). */
  dateDay: string | null;
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
}

export function TaskSchedulePopover({
  trigger,
  dateDay,
  dateString,
  datesWithTasks,
  onPickDay,
  onPickRecurrence,
  now = new Date(),
}: TaskSchedulePopoverProps) {
  const [open, setOpen] = useState(false);
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
  const thisWeekend = nextSaturday(now);
  const nextWeek = nextMonday(now);

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
          <QuickOption
            icon={CalendarDays}
            label="Today"
            hint={format(now, "EEE")}
            onClick={() => commitDay(nowKey)}
          />
          <QuickOption
            icon={Sun}
            label="Tomorrow"
            hint={format(tomorrow, "EEE")}
            onClick={() => commitDay(localDayKey(tomorrow))}
          />
          <QuickOption
            icon={Sofa}
            label="This weekend"
            hint={format(thisWeekend, "EEE")}
            onClick={() => commitDay(localDayKey(thisWeekend))}
          />
          <QuickOption
            icon={CalendarRange}
            label="Next week"
            hint={format(nextWeek, "EEE d MMM")}
            onClick={() => commitDay(localDayKey(nextWeek))}
          />
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
            today: "[&>button]:font-bold [&>button]:text-[color:var(--td-calendar-today)]",
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
