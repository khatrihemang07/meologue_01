import type { MonthDay, RecurrenceFrequency } from "@meologue/core";
import { parseRecurrence } from "@meologue/core";
import { format } from "date-fns";
import { CalendarDays } from "lucide-react";
import type * as React from "react";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogPortal,
  DialogTitle,
} from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { localDayKey, parseDayKey } from "@/lib/local-day-key";
import { cn } from "@/lib/utils";

type BasedOn = "scheduled" | "completed";
/** The dialog's own five dropdown values — "workday" (not `RecurrenceUnit`'s own vocabulary, which has no workday member at all) stands for the grammar's `workdays` frequency, per this file's own header comment on the Todoist-label/grammar-word split. */
type Unit = "day" | "week" | "workday" | "month" | "year";
type Ends = "never" | "onDate";

/** This dialog's whole local state — four controls' worth, nothing else. `endDateKey` is always a valid `YYYY-MM-DD`, even while `ends === "never"` (so switching to "On date" never has to invent one on the spot). */
interface Draft {
  readonly basedOn: BasedOn;
  readonly unit: Unit;
  /** 1-999. Meaningless while `unit === "workday"` — the field is disabled then, and `buildPhrase` never reads it in that branch. */
  readonly interval: number;
  readonly ends: Ends;
  readonly endDateKey: string;
}

// Todoist's own captured option order and wording — "Weekday" is Todoist's
// label; the phrase this dialog emits for it is "workday" (the grammar's
// own accepted spelling, see this file's own header comment).
const UNIT_OPTIONS: ReadonlyArray<{ value: Unit; label: string }> = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "workday", label: "Weekday" },
  { value: "month", label: "Month" },
  { value: "year", label: "Year" },
];

function unitLabel(unit: Unit): string {
  return UNIT_OPTIONS.find((option) => option.value === unit)?.label ?? "Day";
}

function clampInterval(n: number): number {
  if (!Number.isFinite(n)) {
    return 1;
  }
  return Math.min(999, Math.max(1, Math.round(n)));
}

function frequencyToUnit(kind: RecurrenceFrequency["kind"]): Unit | null {
  switch (kind) {
    case "daily":
      return "day";
    case "weekly":
      return "week";
    case "workdays":
      return "workday";
    case "monthly":
      return "month";
    case "yearly":
      return "year";
    // "weekdays" (a specific named-day list, e.g. "every friday") and
    // "monthlyOrdinalWeekday" ("every 3rd friday") have no dropdown value
    // that means them — see this file's own header comment.
    default:
      return null;
  }
}

/** `null` when `monthDay.year` is absent — a hand-typed phrase's "ending D Mon" clause can omit the year (`parser.ts`'s own `ENDING_CLAUSE`), and resolving that to one concrete calendar date is `../../../../packages/core/src/recurrence/engine.ts`'s own private job (`resolveBoundDate`), not this file's to reimplement — `deriveDraft` falls back to its own default day instead of guessing a year here. */
function monthDayToDayKey(monthDay: MonthDay): string | null {
  if (monthDay.year === null) {
    return null;
  }
  return localDayKey(new Date(monthDay.year, monthDay.month - 1, monthDay.day));
}

/** Captured defaults (this file's own header comment): Scheduled date, Day, interval 1, Ends Never. `today` seeds the "On date" field even while `ends` starts as "never" — see `Draft`'s own doc comment. */
function defaultDraft(today: Date): Draft {
  return {
    basedOn: "scheduled",
    unit: "day",
    interval: 1,
    ends: "never",
    endDateKey: localDayKey(today),
  };
}

/**
 * Seeds a draft from the Task's current recurrence phrase (or `null`),
 * exactly as it would be read back by `parseRecurrence` — never a second,
 * hand-maintained parse of the same text. Falls back to `defaultDraft`
 * whenever there's nothing to seed from (`recurrence === null`) or the
 * phrase refuses to parse at all; falls back only for the *frequency* half
 * of the draft when the phrase parses to a frequency this dialog's Unit
 * dropdown can't represent (this file's own header comment) — "Based on"
 * and "Ends" still seed correctly in that case, since neither depends on
 * the frequency.
 */
/**
 * The Task's own phrase when this dialog's controls cannot express it, and
 * `null` when they can — the exact condition under which `deriveDraft`
 * below discards the frequency it parsed and falls back to Day/1.
 * Deliberately the same `frequencyToUnit(...) === null` test that produces
 * the narrowing, rather than a second list of "unsupported" kinds kept
 * alongside it: one of those two would eventually be updated without the
 * other, and the failure mode is a warning that stops appearing for a rule
 * that is still being narrowed.
 *
 * A phrase that doesn't parse at all is NOT reported here. `deriveDraft`
 * falls back for that too, but there is no rule to lose — the Task is
 * carrying text the engine already refuses, and telling someone a rule
 * they never had is about to be replaced would be a lie.
 */
function unrepresentablePhrase(recurrence: string | null): string | null {
  if (recurrence === null) {
    return null;
  }
  const parsed = parseRecurrence(recurrence);
  if (parsed.kind !== "parsed") {
    return null;
  }
  return frequencyToUnit(parsed.rule.frequency.kind) === null ? recurrence : null;
}

function deriveDraft(recurrence: string | null, today: Date): Draft {
  const fallback = defaultDraft(today);
  if (recurrence === null) {
    return fallback;
  }
  const parsed = parseRecurrence(recurrence);
  if (parsed.kind !== "parsed") {
    return fallback;
  }
  const { rule } = parsed;
  const basedOn: BasedOn = rule.anchor === "completion" ? "completed" : "scheduled";
  const ends: Ends = rule.endBound === null ? "never" : "onDate";
  const endDateKey =
    rule.endBound === null
      ? fallback.endDateKey
      : (monthDayToDayKey(rule.endBound) ?? fallback.endDateKey);
  const unit = frequencyToUnit(rule.frequency.kind);
  if (unit === null) {
    return { ...fallback, basedOn, ends, endDateKey };
  }
  return {
    basedOn,
    unit,
    interval: unit === "workday" ? 1 : clampInterval(rule.interval),
    ends,
    endDateKey,
  };
}

/**
 * The one place a `Draft` becomes text. Every branch below is checked
 * against `packages/core/src/recurrence/parser.ts` directly (this file's
 * own header comment) — nothing here is a guess at what the grammar
 * accepts.
 */
function buildPhrase(draft: Draft): string {
  const bang = draft.basedOn === "completed" ? "!" : "";
  const core =
    draft.unit === "workday"
      ? "workday"
      : draft.interval === 1
        ? draft.unit
        : `${draft.interval} ${draft.unit}s`;
  let phrase = `every${bang} ${core}`;
  if (draft.ends === "onDate") {
    const date = parseDayKey(draft.endDateKey);
    if (date !== undefined) {
      // `ENDING_CLAUSE` (parser.ts): "ending <D> <month-name> [YYYY]" — the
      // year is always included here, never omitted, so a phrase this
      // dialog itself produced always re-seeds to a concrete `endDateKey`
      // (see `monthDayToDayKey`'s own doc comment on why an absent year is
      // a hand-typed-phrase case this dialog never creates itself).
      phrase += ` ending ${format(date, "d MMM yyyy")}`;
    }
  }
  return phrase;
}

function formatDayKeyForInput(dayKey: string): string {
  const date = parseDayKey(dayKey);
  return date === undefined ? "" : format(date, "dd/MM/yyyy");
}

const DD_MM_YYYY = /^(\d{2})\/(\d{2})\/(\d{4})$/;

/** `null` when `text` isn't a complete, calendar-valid DD/MM/YYYY date — including a value like "31/02/2026" that `Date`'s own constructor would silently roll over into March, which this rejects rather than accept a day the reader didn't type. */
function parseDdMmYyyy(text: string): string | null {
  const match = DD_MM_YYYY.exec(text);
  if (match === null) {
    return null;
  }
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return localDayKey(date);
}

export interface TaskCustomRepeatDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fired on `Escape` alongside Radix's own default close (not `preventDefault()`-ed) — task-time-dialog.tsx's own identical hand-off, so the host can close the scheduler beneath this dialog too. */
  onEscape: () => void;
  /** `Task.dateString` — the recurrence phrase currently on the Task, or `null`. Seeds this dialog's draft on every open via `deriveDraft`/`parseRecurrence`, the one recurrence door this file's own header comment already establishes — never a second, hand-built representation of the rule. */
  recurrence: string | null;
  /** Fired only on Save, with the phrase `buildPhrase` produced — the exact same shape a reader could have typed into "Type a date", for the caller to hand to the identical `onPickRecurrence` path that phrase already uses. Never fired by Cancel/Escape/an outside click. */
  onSave: (phrase: string) => void;
  /**
   * Read once per open, not per render — mirrors `task-schedule-
   * popover.tsx`'s own identical `now` prop and identical reason: the "On
   * date" field's own default (this file's own header comment) needs a
   * stable "today," and a fresh `new Date()` on every render risks that
   * default drifting mid-interaction. Defaults to `new Date()` for callers
   * (tests) that don't need to pin it.
   */
  now?: Date;
  /**
   * Issue #342 — `DialogContent`'s own `restoreFocusTo`. This dialog's
   * real opener is the Repeat menu's "Custom…" item (`task-schedule-
   * popover.tsx`'s own two-step `openCustomRepeatAfterRepeatCloseRef`
   * hand-off, issues #255/#292), which is gone by the time this dialog's
   * `FocusScope` would otherwise capture it — leaving `document.body`
   * captured instead (see `ui/dialog.tsx`'s own header comment for why
   * that reads as "nothing to restore to," not a usable target). The
   * caller names the Repeat trigger itself here, the one still-mounted
   * place a keyboard user actually was.
   */
  restoreFocusTo?: React.RefObject<HTMLElement | null>;
}

export function TaskCustomRepeatDialog({
  open,
  onOpenChange,
  onEscape,
  recurrence,
  onSave,
  now = new Date(),
  restoreFocusTo,
}: TaskCustomRepeatDialogProps) {
  const [draft, setDraft] = useState<Draft>(() => deriveDraft(recurrence, now));
  const [endDateText, setEndDateText] = useState(() => formatDayKeyForInput(draft.endDateKey));
  // The phrase this dialog is about to narrow, or `null` when it can
  // represent what the Task already holds. Held in state and written by the
  // same re-seed effect as `draft`, rather than derived per render from the
  // `recurrence` prop: both answer the same question — "what was on the Task
  // when this dialog opened" — and computing one from a live prop while the
  // other is frozen at open is how the warning would end up describing a
  // rule the controls below no longer reflect.
  const [unrepresentable, setUnrepresentable] = useState<string | null>(() =>
    unrepresentablePhrase(recurrence),
  );
  const [unitMenuOpen, setUnitMenuOpen] = useState(false);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const unitMenuRef = useRef<HTMLDivElement>(null);

  const basedOnName = useId();
  const endsName = useId();
  const intervalId = useId();
  const workdayHintId = useId();
  const unitListboxId = useId();

  // Re-seed only on the open transition — Cancel/Escape/an outside click
  // (Radix's own ordinary dismiss behaviour, left alone) never reach
  // `onSave`, so the next open has to reflect the Task's real `recurrence`,
  // not an abandoned draft. Mirrors task-time-dialog.tsx's own identical
  // effect and identical reasoning; `now` is deliberately not a dependency
  // for the same reason that file's own `time` isn't re-read mid-open — see
  // this component's own `now` prop doc comment.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-seed only on the open/close transition, not on every `recurrence`/`now` change while already open (see the paragraph above).
  useEffect(() => {
    if (open) {
      const seeded = deriveDraft(recurrence, now);
      setDraft(seeded);
      setEndDateText(formatDayKeyForInput(seeded.endDateKey));
      setUnrepresentable(unrepresentablePhrase(recurrence));
      setUnitMenuOpen(false);
      setCalendarOpen(false);
    }
  }, [open]);

  // Closes the unit listbox on an outside click — the same "click away
  // dismisses" behaviour every other popup in this app gets from Radix,
  // reimplemented by hand here because this listbox isn't a Radix
  // primitive (this file's own header comment on why).
  useEffect(() => {
    if (!unitMenuOpen) {
      return;
    }
    function handlePointerDown(event: MouseEvent) {
      if (unitMenuRef.current !== null && !unitMenuRef.current.contains(event.target as Node)) {
        setUnitMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [unitMenuOpen]);

  function selectUnit(unit: Unit) {
    setDraft((d) => ({
      ...d,
      unit,
      // Switching into Weekday drops whatever interval was typed — that
      // field is about to become disabled, and "every workday" never reads
      // it (buildPhrase's own branch). Switching back out simply resumes
      // at 1 rather than resurrecting a stale number.
      interval: unit === "workday" ? 1 : d.interval,
    }));
    setUnitMenuOpen(false);
  }

  function handleEndDateTextChange(text: string) {
    setEndDateText(text);
    const dayKey = parseDdMmYyyy(text);
    if (dayKey !== null) {
      setDraft((d) => ({ ...d, endDateKey: dayKey }));
    }
  }

  function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSave(buildPhrase(draft));
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} modal={false}>
      <DialogPortal>
        <DialogContent
          open={open}
          restoreFocusTo={restoreFocusTo}
          data-testid="custom-repeat-dialog"
          onEscapeKeyDown={onEscape}
          className="-translate-x-1/2 -translate-y-1/2 fixed top-1/2 left-1/2 z-[70] flex w-[480px] max-w-[calc(100%-2rem)] flex-col gap-3 p-4 text-sm outline-hidden"
          style={{
            // PRESERVED: fixed, not `minHeight`. Todoist's own captured
            // dialog does not resize when the "On date" row appears (this
            // file's own header comment) — measured 480x403 before and
            // after that reveal — and a fixed height is what keeps that true
            // regardless of which "Ends" branch is showing. This number
            // does not change with viewport width either, for the same
            // reason: the captured non-resize behaviour is about which
            // Task-recurrence state is showing, not about how narrow the
            // viewport is, so there is no width at which this should start
            // resizing on its own.
            //
            // RELAXED: "fits without scrolling" is not preserved — only
            // "never silently clips" is. At 480px wide, in every state this
            // dialog can show, 403px was always enough room (that's the
            // whole basis for the measurement above). Once the width clamp
            // above lets this dialog get narrower than 480px, labels wrap to
            // more lines, and a longer `unrepresentable` warning can wrap
            // too — either can need more than 403px of content height. The
            // `<form>` below (`flex-1 overflow-auto min-h-0`) is what
            // absorbs that: a flex child with `min-h-0` and `overflow-auto`
            // never forces this fixed-height parent to grow past 403px (per
            // the flexbox spec, a scrolling flex item's automatic minimum
            // size is 0, not its content size), so the extra content scrolls
            // inside the form, with Cancel/Save staying put, instead of
            // being cut off outside it.
            height: "403px",
            borderRadius: "10px",
            background: "rgb(31, 31, 31)",
            color: "rgb(255, 255, 255)",
            boxShadow: "rgba(0, 0, 0, 0.16) 0px 2px 8px 0px",
          }}
        >
          <DialogTitle className="sr-only">Custom repeat</DialogTitle>
          <DialogDescription className="sr-only">
            Build a custom recurrence rule for this Task.
          </DialogDescription>

          <form
            onSubmit={handleSave}
            className="flex flex-1 min-h-0 flex-col justify-between gap-4 overflow-auto"
          >
            {unrepresentable !== null && (
              <p
                data-testid="custom-repeat-unrepresentable"
                className="rounded-md px-2 py-1.5 text-xs"
                style={{ background: "rgb(60, 45, 45)", color: "rgb(255, 209, 209)" }}
              >
                This Task repeats “{unrepresentable}”, which can’t be built here. Saving replaces
                it.
              </p>
            )}
            <fieldset className="flex flex-col gap-1">
              <legend className="text-xs font-medium" style={{ color: "rgb(169, 169, 169)" }}>
                Based on
              </legend>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name={basedOnName}
                  value="scheduled"
                  checked={draft.basedOn === "scheduled"}
                  onChange={() => setDraft((d) => ({ ...d, basedOn: "scheduled" }))}
                />
                Scheduled date
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name={basedOnName}
                  value="completed"
                  checked={draft.basedOn === "completed"}
                  onChange={() => setDraft((d) => ({ ...d, basedOn: "completed" }))}
                />
                Completed date
              </label>
            </fieldset>

            <fieldset className="flex flex-col gap-1">
              <legend className="text-xs font-medium" style={{ color: "rgb(169, 169, 169)" }}>
                Every
              </legend>
              <div className="flex items-center gap-2">
                <label htmlFor={intervalId} className="sr-only">
                  Every
                </label>
                <input
                  id={intervalId}
                  type="number"
                  min={1}
                  max={999}
                  aria-label="Every"
                  disabled={draft.unit === "workday"}
                  aria-describedby={draft.unit === "workday" ? workdayHintId : undefined}
                  value={draft.interval}
                  onChange={(event) => {
                    const raw = event.target.value;
                    if (raw === "") {
                      return;
                    }
                    const n = Number(raw);
                    if (!Number.isFinite(n)) {
                      return;
                    }
                    setDraft((d) => ({ ...d, interval: clampInterval(n) }));
                  }}
                  className="w-16 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground disabled:opacity-50"
                />

                <div ref={unitMenuRef} className="relative">
                  {/* Todoist's own captured markup is `div[role="combobox"]`, not a `<select>`/`<button>` — this file's own header comment on why Radix `Select` (which renders a `<button>`) isn't used either. */}
                  <div
                    role="combobox"
                    aria-haspopup="listbox"
                    aria-expanded={unitMenuOpen}
                    aria-controls={unitListboxId}
                    aria-label="Unit"
                    tabIndex={0}
                    onClick={() => setUnitMenuOpen((v) => !v)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setUnitMenuOpen((v) => !v);
                      } else if (event.key === "Escape" && unitMenuOpen) {
                        event.preventDefault();
                        setUnitMenuOpen(false);
                      }
                    }}
                    className="w-fit cursor-pointer rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
                  >
                    {unitLabel(draft.unit)}
                  </div>
                  {/*
                    Checked for the same behind-the-dialog risk as the
                    "Select date" popover above, and it is NOT at risk: unlike
                    `PopoverContent`, this listbox is never portalled — it is
                    an ordinary descendant of `DialogContent` (`@/components/ui/dialog`)
                    (`unitMenuRef`'s own sibling below), so it paints inside
                    that Content's own `z-[70]` stacking context rather than
                    competing with it. Its `z-10` only has to beat this
                    dialog's OTHER children, which are all `z-index: auto`, so
                    it already wins locally with no change needed. (A portalled
                    popover escapes that same stacking context by rendering
                    into `document.body`, which is exactly why it — and only
                    it — could paint behind a `z-[70]` ancestor it isn't a
                    descendant of.)
                  */}
                  {unitMenuOpen && (
                    <div
                      id={unitListboxId}
                      role="listbox"
                      aria-label="Unit"
                      className="absolute z-10 mt-1 w-max rounded-md border border-border bg-popover py-1 text-sm text-popover-foreground shadow-md"
                    >
                      {UNIT_OPTIONS.map((option) => (
                        // Matches the captured `div[role="option"]` list, the
                        // same reasoning as the combobox trigger above.
                        // `tabIndex={-1}` keeps this out of Tab order (the
                        // combobox trigger owns focus, the same
                        // aria-activedescendant-adjacent shape `quick-add-
                        // autocomplete-listbox.tsx` already uses) while
                        // `onKeyDown` still gives Enter/Space a way to
                        // select it once it's reached some other way.
                        <div
                          key={option.value}
                          role="option"
                          aria-selected={option.value === draft.unit}
                          tabIndex={-1}
                          onClick={() => selectUnit(option.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              selectUnit(option.value);
                            }
                          }}
                          className={cn(
                            "cursor-default px-2 py-1",
                            option.value === draft.unit && "bg-accent text-accent-foreground",
                          )}
                        >
                          {option.label}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              {draft.unit === "workday" && (
                <p id={workdayHintId} className="text-xs" style={{ color: "rgb(169, 169, 169)" }}>
                  meologue's recurrence grammar gives "every workday" a fixed interval of 1 — "every
                  N workdays" isn't a phrase the parser accepts, so this field is disabled while
                  Weekday is selected.
                </p>
              )}
            </fieldset>

            <fieldset className="flex flex-col gap-1">
              <legend className="text-xs font-medium" style={{ color: "rgb(169, 169, 169)" }}>
                Ends
              </legend>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name={endsName}
                  value="never"
                  checked={draft.ends === "never"}
                  onChange={() => setDraft((d) => ({ ...d, ends: "never" }))}
                />
                Never
              </label>
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name={endsName}
                    value="onDate"
                    checked={draft.ends === "onDate"}
                    onChange={() => setDraft((d) => ({ ...d, ends: "onDate" }))}
                  />
                  On date (inclusive)
                </label>
                {draft.ends === "onDate" && (
                  <>
                    <input
                      type="text"
                      aria-label="Repeat until date"
                      placeholder="DD/MM/YYYY"
                      value={endDateText}
                      onChange={(event) => handleEndDateTextChange(event.target.value)}
                      className="w-24 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
                    />
                    <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
                      <PopoverTrigger asChild>
                        <button
                          type="button"
                          aria-label="Select date"
                          className="rounded-md border border-border p-1 text-foreground"
                        >
                          <CalendarDays className="size-4" />
                        </button>
                      </PopoverTrigger>
                      <PopoverContent
                        align="start"
                        data-testid="custom-repeat-date-popover"
                        // `ui/popover.tsx`'s own default is `z-[60]` — fine for
                        // its one other caller (the scheduler's anchored
                        // popover, which sits over ordinary page content), but
                        // this dialog itself is `z-[70]` (above), so its OWN
                        // default paints BEHIND this dialog. Found live in a
                        // real browser: only the bottom one or two rows of
                        // dates peeked out below the Cancel/Save row, the
                        // header and top weeks fully hidden, unusable by
                        // mouse — typing the date manually still worked,
                        // which is exactly why the (jsdom, no stacking
                        // context) suite never caught it. Overridden here
                        // rather than in `ui/popover.tsx`: this dialog is the
                        // one caller that knows it needs to beat its own
                        // z-70, and raising the shared primitive's default
                        // would just move the same "picker behind host"
                        // problem onto every other caller's z-index instead
                        // of fixing it for the one caller that has it.
                        // `cn("z-[60]", className)` in `ui/popover.tsx` runs
                        // through tailwind-merge, which treats `z-[60]` and
                        // `z-[80]` as the same conflicting utility group and
                        // keeps whichever comes later — so this wins over the
                        // primitive's own default without editing it.
                        className="z-[80]"
                      >
                        <Calendar
                          mode="single"
                          today={now}
                          selected={parseDayKey(draft.endDateKey)}
                          onSelect={(day) => {
                            if (day !== undefined) {
                              const dayKey = localDayKey(day);
                              setDraft((d) => ({ ...d, endDateKey: dayKey }));
                              setEndDateText(format(day, "dd/MM/yyyy"));
                              setCalendarOpen(false);
                            }
                          }}
                        />
                      </PopoverContent>
                    </Popover>
                  </>
                )}
              </div>
            </fieldset>

            {/*
              No `mt-auto` here — the form's own `justify-between` (above)
              already pins this row to the bottom by distributing the
              form's free space between every group, this one included. An
              auto margin on this row would absorb ALL of that free space
              itself before `justify-between` ever got to run (flexbox
              resolves auto margins first), collapsing right back to one
              lump of dead space above this row — the thing being fixed.
            */}
            <div className="flex justify-end gap-2">
              <DialogClose asChild>
                <Button type="button" variant="outline" size="sm">
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" size="sm">
                Save
              </Button>
            </div>
          </form>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}
