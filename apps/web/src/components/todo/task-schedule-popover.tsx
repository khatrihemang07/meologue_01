/**
 * Todoist's own scheduler (issue #227, `meologue-parity-docs/todoist/
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
import {
  CalendarDays,
  CalendarRange,
  CircleSlash,
  Clock,
  Repeat,
  Sofa,
  Sun,
  X,
} from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useEffect, useId, useRef, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { localDayKey, parseDayKey } from "@/lib/local-day-key";
import { resolveRecurrencePhrase } from "@/lib/quick-add-task";
import { cn } from "@/lib/utils";
import { TaskTimeDialog } from "./task-time-dialog";

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

/** "1st"/"2nd"/"3rd"/"4th"… — the Repeat menu's own "Every month on the 13th"/"Every year on September 13th" wording (SCHED-14's captured strings), spelled out because `date-fns`'s own `format` has no ordinal-day token that produces "13th" on its own. */
function ordinal(day: number): string {
  const mod100 = day % 100;
  if (mod100 >= 11 && mod100 <= 13) {
    return `${day}th`;
  }
  switch (day % 10) {
    case 1:
      return `${day}st`;
    case 2:
      return `${day}nd`;
    case 3:
      return `${day}rd`;
    default:
      return `${day}th`;
  }
}

/** Shared by every Repeat-menu item — deliberately not `task-command-menu.tsx`'s own identical-looking `itemClassName` (that file is out of scope here; this is its own copy, not an import, so the two are free to diverge). */
const repeatItemClassName =
  "flex cursor-pointer items-center rounded-md px-2 py-1.5 text-sm outline-none data-highlighted:bg-white/10";

export interface TaskSchedulePopoverProps {
  /** The trigger this popover anchors under — task-schedule-sheet.tsx's own "Date" button. */
  trigger: React.ReactNode;
  /**
   * `Task.date`'s day component (`YYYY-MM-DD`), or `null`. `onPickDay`
   * itself still only ever commits a *day* — see its own doc comment,
   * unchanged by issue #249 — but this popover is no longer only a day
   * picker: it also owns the Time entry point (`dateTime`/`onSetTime`
   * below) at the bottom, beside Repeat. That button — and the dedicated
   * `TaskTimeDialog` it opens (this ticket's own follow-up to #249, which
   * only relocated an inline toggle here and explicitly left Todoist's
   * own dialog unbuilt) — renders only once `dateDay` isn't `null`: there
   * is no time-of-day to attach to an unset date.
   */
  dateDay: string | null;
  /**
   * `Task.date`'s time-of-day component (`HH:MM`), or `null` when the Task
   * is all-day. Seeds `TaskTimeDialog`'s own draft on every open (that
   * file's own header comment).
   */
  dateTime: string | null;
  /**
   * Sets or clears the time-of-day on whatever day is already chosen —
   * fired only when `TaskTimeDialog`'s own Save is clicked (with whatever
   * its draft resolved to, or `null` once its "Add a time" checkbox is
   * unchecked). Unlike `onPickDay`, this never touches `dateString` and
   * never closes this popover — setting a time is not "picking a day," and
   * a caller combining this with the currently-chosen `dateDay` is what
   * keeps a day change from dropping an already-chosen time and vice versa
   * (`task-schedule-sheet.tsx`'s own wiring does this, mirroring its
   * former `setDay` helper).
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
  // Whether `TaskTimeDialog` is open — read by `PopoverContent`'s own
  // `onFocusOutside`/`onPointerDownOutside` guards below, this popover's
  // own version of the Radix trap issue #255 already named for a
  // DropdownMenu opening a Popover: `TaskTimeDialog`'s own autofocus
  // moves focus to a node this popover's `Content` doesn't contain (a
  // sibling Radix `Dialog.Portal`, not a descendant), which Radix's
  // `DismissableLayer` otherwise reads as "focus left the popover" and
  // dismisses it on the spot. Guarding on this flag rather than removing
  // the guard once the dialog opens is deliberate: the dialog's Save/
  // Cancel buttons live in that same portalled subtree, so every pointer-
  // down inside it needs the identical treatment for as long as it's
  // open, not just the opening instant.
  const [timeDialogOpen, setTimeDialogOpen] = useState(false);
  function ignoreOutsideWhileTimeDialogOpen(event: { preventDefault: () => void }) {
    if (timeDialogOpen) {
      event.preventDefault();
    }
  }
  // "Type a date" — read by the Repeat menu's own "Custom…" item below,
  // which focuses this exact input rather than opening a second dialog
  // (this ticket's own disclosed scope cut: Todoist's dedicated custom-
  // recurrence dialog isn't built here).
  const typedInputRef = useRef<HTMLInputElement>(null);
  // Set by "Custom…"'s own `onSelect`, read once by the Repeat menu's
  // `onCloseAutoFocus` below — the identical two-step handoff issue #255
  // (task-command-menu.tsx's own "Date…" item) had to invent for the
  // identical reason: focusing `typedInputRef` directly from `onSelect`
  // races Radix's own FocusScope teardown for the menu that's still
  // closing, which was that issue's whole root cause. Waiting for
  // `onCloseAutoFocus` — fired once the menu's FocusScope has actually
  // torn down, not merely been told to — is the one signal that a
  // same-tick focus() won't just get yanked back.
  const focusInputAfterRepeatCloseRef = useRef(false);

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

  // Every Repeat-menu option (SCHED-14) commits through this exact same
  // `onPickRecurrence` — the one recurrence door this file's own header
  // comment already established for the typed phrase above. No second
  // representation, no direct Task mutation from here.
  function commitRepeatPhrase(phrase: string, day: string) {
    onPickRecurrence(phrase, day);
    setOpen(false);
  }

  // SCHED-14's five named cadences, each resolved through the identical
  // `firstOccurrence` the typed input already uses — not reconstructed by
  // hand from `dateDay`/`now`. That distinction is load-bearing, not
  // stylistic: `../../packages/core/src/recurrence/recurrence.ts`'s own
  // header comment records that a bare "every day" is
  // completion-anchored to `now` regardless of `dateDay`, while "every
  // month"/"every year" anchor to `dateDay` when one exists — two
  // different rules a hand-written label would have to reimplement (and
  // could drift from) to describe correctly. Reading each option's own
  // weekday/day-of-month/month-and-day off its own real outcome can't.
  const repeatAnchor = parseDayKey(dateDay) ?? now;
  const repeatCandidates: ReadonlyArray<{
    key: string;
    phrase: string;
    label: (resolvedDay: string) => string;
  }> = [
    { key: "day", phrase: "every day", label: () => "Every day" },
    {
      // A named weekday, not a bare "every week". The engine anchors bare
      // "every week" to completion, so a task finished late would drift off
      // the weekday this label promises; "every sunday" stays on Sundays.
      // The weekday is the task's own date's, or today's for an undated
      // task, as in Todoist's "Every week on Saturday" read on Sat 12 Sep.
      key: "week",
      phrase: `every ${format(repeatAnchor, "EEEE").toLowerCase()}`,
      label: (resolvedDay) => `Every week on ${format(parseDayKey(resolvedDay) ?? now, "EEEE")}`,
    },
    {
      key: "workday",
      phrase: "every workday",
      // Todoist's own captured wording, "weekday" — this codebase's own
      // recurrence grammar spells the identical Mon-Fri pattern
      // "workday(s)" instead (`../../packages/core/src/recurrence/
      // parser.ts`'s `/^workdays?$/`). The menu keeps Todoist's label; the
      // committed `dateString` keeps this repo's own accepted spelling —
      // "workday" is not a silent parser extension, it's what already
      // parses, just under a different English word than Todoist's.
      label: () => "Every weekday (Mon - Fri)",
    },
    {
      key: "month",
      phrase: "every month",
      label: (resolvedDay) =>
        `Every month on the ${ordinal((parseDayKey(resolvedDay) ?? now).getDate())}`,
    },
    {
      key: "year",
      phrase: "every year",
      label: (resolvedDay) => {
        const resolved = parseDayKey(resolvedDay) ?? now;
        return `Every year on ${format(resolved, "MMMM")} ${ordinal(resolved.getDate())}`;
      },
    },
  ];
  const repeatOptions = repeatCandidates.flatMap((candidate) => {
    const outcome = firstOccurrence(candidate.phrase, { dueDate: dateDay, now: nowKey });
    // None of these five bare phrases carries a bound, so a non-
    // "occurrence" outcome would mean the engine and this menu have
    // drifted apart, not that this particular input was bad — the same
    // posture `resolveRecurrencePhrase`'s own doc comment (quick-add-
    // task.ts) takes for the identical situation. Skipping the option
    // rather than throwing keeps that drift non-fatal.
    if (outcome.kind !== "occurrence") {
      return [];
    }
    return [
      {
        key: candidate.key,
        phrase: candidate.phrase,
        day: outcome.date,
        label: candidate.label(outcome.date),
      },
    ];
  });
  // Mirrors scheduler-and-priority.md §7's own captured behaviour: "the
  // Repeat button disappears from the panel and is replaced by the
  // resolved preview" once a recurrence is active. Here that's already
  // true by construction — `typed` is seeded from `dateString` on every
  // open (this file's own header comment), so an existing Recurrence
  // already renders as the preview button above; this just hides the
  // Repeat entry point while that's showing, rather than offering two
  // controls that both claim to set the same thing at once.
  const showRepeatControl = preview === null || preview.dateString === null;

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
  ]
    // SCHED-03: the option matching the task's current date is dropped.
    // SCHED-02 (flow 11, Sunday 13 Sep): a slot landing on the same day as an
    // earlier one is dropped too. On a Sunday, Tomorrow and Next week are
    // both Monday, and Todoist showed three options, not four.
    .filter(
      (option, index, all) =>
        option.day !== dateDay && all.findIndex((other) => other.day === option.day) === index,
    );

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
        // See `ignoreOutsideWhileTimeDialogOpen`'s own comment above —
        // both handlers get the guard since either one alone stopping the
        // eventual dismiss is enough, and a pointer-down and a focus
        // change don't always arrive in the same order.
        onFocusOutside={ignoreOutsideWhileTimeDialogOpen}
        onPointerDownOutside={ignoreOutsideWhileTimeDialogOpen}
      >
        <div className="relative">
          <label htmlFor={inputId} className="sr-only">
            Type a date
          </label>
          <input
            ref={typedInputRef}
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
          Todoist's own bottom row (pass2-2026-09-11.md §5: "A Time button
          and a Repeat button sit at the bottom, below the calendar" —
          Time first, Repeat second, exactly this row's own order). The
          former inline "Add a time" checkbox and `<input type="time">`
          (issue #249) no longer render here directly — this ticket's own
          follow-up builds the dedicated `TaskTimeDialog` Todoist itself
          uses (SCHED-11/pass2 §7) behind this Time button instead, with
          that same checkbox and input relocated inside it verbatim (see
          that file's own header comment).
        */}
        <div className="flex items-center gap-2">
          {/*
            Gated on `dateDay !== null` for the identical reason the
            former inline checkbox was: there is no time-of-day to attach
            to an unset date.
          */}
          {dateDay !== null && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => setTimeDialogOpen(true)}
              className="h-8 w-fit justify-start gap-2 px-2 font-normal text-muted-foreground"
            >
              <Clock className="size-4" />
              Time
            </Button>
          )}

          {/*
            Todoist's own Repeat control (issue #227, SCHED-14 — never
            previously built here). Unlike Time (gated on
            `dateDay !== null`), this is never gated: a recurrence's own
            anchor falls back to `now` for an undated Task exactly as
            SCHED-04's typed input already does, so there is no missing
            precondition here the way there is for a time-of-day.
          */}
          {showRepeatControl && (
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  className="h-8 w-fit justify-start gap-2 px-2 font-normal text-muted-foreground"
                >
                  <Repeat className="size-4" />
                  Repeat
                </Button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  data-testid="repeat-menu"
                  align="start"
                  className="flex flex-col gap-0.5 p-1 text-sm"
                  style={{
                    width: "282px",
                    borderRadius: "10px",
                    background: "rgb(40, 40, 40)",
                    border: "1px solid rgb(61, 61, 61)",
                    boxShadow: "rgba(0, 0, 0, 0.12) 0px 0px 8px 0px",
                    zIndex: 1000,
                    color: "rgb(255, 255, 255)",
                  }}
                  // The identical hand-off task-command-menu.tsx's own
                  // "Date…" item needed for issue #255: focusing
                  // `typedInputRef` straight from "Custom…"'s `onSelect`
                  // would race this very menu's own `FocusScope` while it's
                  // still tearing down mid-close-animation. Waiting for
                  // `onCloseAutoFocus` — fired once that teardown is
                  // actually done — and skipping its own default (return
                  // focus to the trigger) is what lets the focus land on
                  // the input instead and stick there.
                  onCloseAutoFocus={(event) => {
                    if (!focusInputAfterRepeatCloseRef.current) {
                      return;
                    }
                    focusInputAfterRepeatCloseRef.current = false;
                    event.preventDefault();
                    typedInputRef.current?.focus();
                  }}
                  // SCHED-11's own follow-up (pass2-2026-09-11.md §7):
                  // "One Escape closes the Repeat/Time layer and the
                  // scheduler beneath it simultaneously" — recorded for
                  // both layers this popover opens, not just
                  // `TaskTimeDialog` (that file's own header comment).
                  // Radix's own default `Escape` handling still closes
                  // this menu alone; not preventDefault()-ed, so that
                  // keeps happening alongside `setOpen(false)` here.
                  onEscapeKeyDown={() => setOpen(false)}
                >
                  {repeatOptions.map((option) => (
                    <DropdownMenu.Item
                      key={option.key}
                      className={repeatItemClassName}
                      onSelect={() => commitRepeatPhrase(option.phrase, option.day)}
                    >
                      {option.label}
                    </DropdownMenu.Item>
                  ))}
                  {/*
                    Todoist's own dedicated custom-recurrence dialog isn't
                    built here (this ticket's own disclosed scope cut) —
                    this focuses the "Type a date" input instead, already
                    pre-filled with whatever Recurrence the Task currently
                    has (this file's own re-seed-on-open effect above), so
                    a reader lands somewhere they can type a custom phrase
                    rather than a dead end.
                  */}
                  <DropdownMenu.Item
                    className={repeatItemClassName}
                    onSelect={() => {
                      focusInputAfterRepeatCloseRef.current = true;
                    }}
                  >
                    Custom…
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          )}
        </div>
      </PopoverContent>
      <TaskTimeDialog
        open={timeDialogOpen}
        onOpenChange={setTimeDialogOpen}
        time={dateTime}
        onSave={onSetTime}
        // SCHED-11's own follow-up — see task-time-dialog.tsx's own
        // header comment: fired on Escape only, alongside that dialog's
        // own default close, so this popover closes with it rather than
        // being left open behind a now-closed Time dialog.
        onEscape={() => setOpen(false)}
      />
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
