import type { LocalDateTimeKey, QuickAddToken } from "@meologue/core";
import { firstOccurrence, localDayKeyOf, parseQuickAdd, parseRecurrence } from "@meologue/core";
import { addDays, format, nextMonday, nextSaturday } from "date-fns";
import {
  CalendarDays,
  CalendarRange,
  Check,
  CircleSlash,
  Clock,
  Repeat,
  Sofa,
  Sun,
  X,
} from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { localDateTimeKey, localDayKey, parseDayKey } from "@/lib/local-day-key";
import { touchOnlyDevice } from "@/lib/pointer";
import { resolveRecurrencePhrase } from "@/lib/quick-add-task";
import {
  computeSchedulePopoverPlacement,
  type SchedulePopoverPlacement,
} from "@/lib/schedule-popover-placement";
import { cn } from "@/lib/utils";
import { TaskCustomRepeatDialog } from "./task-custom-repeat-dialog";
import { TaskTimeDialog } from "./task-time-dialog";

/** One resolved "Type a date" preview — either a plain date or a Recurrence, never both (mirrors quick-add-task.ts's own resolveRecurrence: "a recognised recurrence's own computed first occurrence overrides whatever plain date token also matched"). */
interface SchedulePreview {
  readonly day: string;
  readonly dateString: string | null;
  readonly forever: boolean;
}

function resolveSchedulePreview(
  text: string,
  now: LocalDateTimeKey,
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
    // firstOccurrence (../../../packages/core/src/recurrence) takes only
    // the day — that engine has no time-of-day concept of its own to
    // gain from issue #383, unlike parseQuickAdd just above.
    const outcome = firstOccurrence(phrase, { dueDate, now: localDayKeyOf(now) });
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

const repeatItemClassName =
  "flex cursor-pointer items-center rounded-md px-2 py-1.5 text-sm outline-none data-highlighted:bg-muted data-highlighted:text-foreground";

/**
 * Every node this popover has to treat as "not outside" for
 * `PopoverContent`'s `DismissableLayer` purposes, even though none of them
 * are DOM — or React-tree — descendants of it: both dialogs this popover
 * opens (`TaskTimeDialog`, `TaskCustomRepeatDialog`; Radix always portals
 * `Dialog.Content` to `document.body`, a sibling of this popover's own
 * portalled `Content`, not a descendant of it), plus `custom-repeat-date-
 * popover` — the Custom-repeat dialog's own "On date" calendar, which is a
 * React descendant of *that* dialog but, being itself a Radix `Popover`,
 * is *also* portalled straight to `document.body`, a second sibling-not-
 * descendant hop. A portal breaks DOM containment at every level it's
 * used, not just the first: leaving that third selector out would make
 * picking an end date read as a click on THIS popover's own boundary and
 * dismiss it, stranding the still-open Custom-repeat dialog on screen
 * behind nothing. Anything a future dialog here portals elsewhere in turn
 * needs adding the same way.
 */
const OWNED_PORTAL_SELECTOR =
  '[data-testid="time-dialog"], [data-testid="custom-repeat-dialog"], [data-testid="custom-repeat-date-popover"]';

/**
 * Whether `target` — the real DOM node an outside interaction landed on —
 * is inside one of `OWNED_PORTAL_SELECTOR`'s nodes. Exported only so
 * `task-schedule-popover.test.tsx` can exercise this classification
 * directly; it is issue #326's fix's one piece jsdom can actually verify
 * (see that test's own comment for why the rest can't be).
 */
export function isOwnedPortalTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(OWNED_PORTAL_SELECTOR) !== null;
}

/**
 * Issue #326: Cancel (and an outside click) on either dialog was *also*
 * closing this popover, though task-time-dialog.tsx's own header comment
 * already documented Cancel as returning to the scheduler.
 *
 * **A first attempt at this fix (superseded here, not stacked on) kept a
 * ref mirroring `timeDialogOpen`/`customRepeatOpen` one render-cycle
 * longer than the state itself, on the theory that the stray dismiss was
 * an `onFocusOutside` firing once `<body>` regained focus after the
 * closing dialog's Cancel button left the document. Instrumented in a
 * real browser, that theory was wrong on two counts that matter:
 * `onFocusOutside` never fires in this sequence at all, and the event's
 * `target` at guard time is the still-mounted Cancel button, not `<body>`.
 * Don't reintroduce a state- or ref-based guard here — see why below.**
 *
 * What actually fires is `onPointerDownOutside`/`onInteractOutside`, and
 * the real mechanism is a race no state or ref can out-wait, only out-
 * target: `DialogPrimitive.Close`'s own React `onClick` runs first,
 * synchronously (`overrideProps → executeDispatch → processDispatchQueue →
 * batchedUpdates`) and flips `timeDialogOpen`/`customRepeatOpen` to
 * `false` — no `DismissableLayer` involved yet. Only *then* does this
 * popover's own `DismissableLayer` recognise that same click's target (the
 * Cancel button) as outside `PopoverContent` — correctly, since the dialog
 * is portalled as a sibling, not a descendant — and dispatch
 * `onPointerDownOutside`/`onInteractOutside`: a non-modal Radix `Popover`
 * defers its own outside-pointerdown check from `pointerdown` to the
 * trailing `click` (`@radix-ui/react-popover` passes `deferPointerDownOutside:
 * true` for exactly this shape), and that deferred check runs through
 * `ReactDOM.flushSync()`. Because React's own delegated click handling
 * (which is what runs `DialogPrimitive.Close`'s `onClick`) is attached
 * lower in the DOM than this popover's own plain `document`-level deferred
 * listener, the state flip is already committed — synchronously, ref and
 * all — before the guard ever runs. There is no render-cycle a ref can
 * lag behind that flush by, because the flush is what forces the ref's own
 * effect to run early too.
 *
 * So the guard doesn't ask "is a dialog of mine open" (state) — it asks
 * "did this interaction land on a node that belongs to one of my own
 * dialogs" (the event's real DOM target, `isOwnedPortalTarget` above),
 * which is unaffected by any of the above: the Cancel button is still the
 * still-mounted node the click landed on regardless of what state has
 * already committed by the time this runs. The same classification
 * protects the OPENING case for free — `TaskTimeDialog`/
 * `TaskCustomRepeatDialog`'s own autofocus moves focus to a node inside
 * one of `OWNED_PORTAL_SELECTOR`'s dialogs, so `onFocusOutside`'s target is
 * inside it too, the identical Radix trap issue #255 already named for a
 * DropdownMenu opening a Popover. Wired to `onFocusOutside`,
 * `onPointerDownOutside`, AND `onInteractOutside` below on purpose, not
 * just whichever one instrumentation caught firing this time: Radix calls
 * `onInteractOutside` alongside whichever of the other two actually fired,
 * and this file has no way to prove a keyboard-activated Cancel (Enter/
 * Space on the focused button — never instrumented; see the commit body)
 * dispatches the identical events a real click does. All three route to
 * the same target check either way, so wiring all three costs nothing and
 * bets on nothing.
 *
 * Save is still the one action meant to close the scheduler along with the
 * dialog (see `handleTimeSave` and `commitRepeatPhrase` below) — both call
 * `setOpen(false)` deliberately rather than leaning on this guard failing
 * to fire. Clicking Save *also* lands inside `OWNED_PORTAL_SELECTOR`, so
 * this guard would suppress its own accidental dismiss too if that
 * explicit call weren't already there — this guard does not, and must
 * not, distinguish Save from Cancel/outside-click/Escape by anything other
 * than where the click landed.
 */
function classifyOutsideInteraction(
  event: CustomEvent<{ originalEvent: PointerEvent | FocusEvent }>,
) {
  if (isOwnedPortalTarget(event.detail.originalEvent.target)) {
    event.preventDefault();
  }
}

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
  onPickRecurrence: (dateString: string, day: string) => void;
  /**
   * Shows the Time button and the "No Date" quick option even while
   * `dateDay` is `null` — issue #435's Reschedule action, whose bulk Time
   * pick and bulk clear both apply to every Overdue Task's own existing
   * date, not to a single date this popover itself chose (it has none:
   * see this popover's own `dateDay` doc comment). Every other caller
   * omits this (defaults `false`) and keeps the ordinary "nothing to set
   * or clear on an unset date" gates below.
   */
  alwaysDated?: boolean;
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
  alwaysDated = false,
  now = new Date(),
  open: openProp,
  onOpenChange,
}: TaskSchedulePopoverProps) {
  // Which shell this renders in — see the branch near the bottom of the
  // component. Issue #365: this used to be `todo-nav.tsx`/
  // `task-detail-view.tsx`'s 900px split, but width answers the wrong
  // question here — a touch tablet at >=900px got a desktop Popover inside
  // what should be a full-screen Sheet. `touchOnlyDevice()` is the actual
  // cause (the soft keyboard), so it's the actual test, at any width.
  const touch = touchOnlyDevice();
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
  // Whether `TaskTimeDialog` is open. Before issue #326's real fix (see
  // `classifyOutsideInteraction` above the component, and its own comment)
  // this flag doubled as the input to a state-based outside-dismiss guard;
  // it no longer is one — the guard now classifies by the interaction's DOM
  // target instead, and reads no React state at all. This flag now does
  // only what its name says: decides whether `TaskTimeDialog` renders open.
  const [timeDialogOpen, setTimeDialogOpen] = useState(false);
  // Issue #292's `TaskCustomRepeatDialog` is the second dialog this popover
  // opens, portalled exactly the same way as `TaskTimeDialog` — same reason
  // this is a plain render flag now too, not a guard input.
  const [customRepeatOpen, setCustomRepeatOpen] = useState(false);
  // "Type a date". Issue #292 moved "Custom…" off this input and onto a
  // real dialog (`TaskCustomRepeatDialog`), so this ref is no longer that
  // item's destination — it stays because `handleCustomRepeatSave` below
  // falls back to this field for a rule the engine can't place, which is
  // the one path that still needs to put text here and focus it.
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
  // The identical hand-off for issue #292's "Custom…" item, which opens a
  // portalled Radix `Dialog` instead of focusing an input. Same race, same
  // signal, same reason it can't be done in `onSelect` — see that item's
  // own comment below.
  const openCustomRepeatAfterRepeatCloseRef = useRef(false);
  // Issue #342 — `TaskCustomRepeatDialog`'s own `restoreFocusTo`. Its real
  // opener, the Repeat menu's "Custom…" item, is unmounted by the time
  // this dialog would otherwise capture a previously-focused element
  // (`openCustomRepeatAfterRepeatCloseRef`'s own comment: the hand-off
  // deliberately focuses nothing before this dialog mounts), so this
  // names the one still-mounted, stable anchor instead: the Repeat
  // trigger button below.
  const repeatTriggerRef = useRef<HTMLButtonElement>(null);
  // Issue #440: the two real DOM nodes the desktop placement below measures
  // — every current `trigger` caller (task-row-content.tsx's own Date
  // button, overdue-reschedule-action.tsx's Reschedule button, quick-add-
  // content.tsx's `Chip`, task-detail-view.tsx's `AttributePill`/
  // `AttributeRow`) already forwards a ref to a real `<button>`, the same
  // node Radix's own `PopoverTrigger` would anchor to internally regardless
  // — and the popover's own content node. State, not a plain `useRef`
  // (React's own documented "measure a DOM node" pattern): Radix's
  // `Popover.Content` sits behind its own `Presence`, which — unlike the
  // trigger, always mounted — only actually renders the content node on the
  // render *after* `open` first flips true, one commit later than a
  // `useLayoutEffect` keyed on `[open]` alone would see. Setting these via
  // `ref={setTriggerEl}`/`ref={setContentEl}` and keying the effect below
  // off the resulting state, rather than off `open`, means it reruns
  // exactly when either node actually shows up, whichever commit that
  // turns out to be — react to the DOM being there, not to when a fixed
  // number of renders should have made it so. Unused by the touch branch
  // below (its `SheetTrigger`/`SheetContent` never receive these refs),
  // which is fine: the effect that reads them bails out whenever either is
  // still `null`.
  const [triggerEl, setTriggerEl] = useState<HTMLButtonElement | null>(null);
  const [contentEl, setContentEl] = useState<HTMLDivElement | null>(null);
  // `null` while unopened or not yet measured (see the effect below) — the
  // desktop branch falls back to an arbitrary `side`/`alignOffset` in that
  // window, which is never actually painted (`useLayoutEffect`'s own
  // comment on the effect just below).
  const [placement, setPlacement] = useState<SchedulePopoverPlacement | null>(null);

  // Issue #440: recomputes once per open (and once more the commit after,
  // when `contentEl` itself lands — this effect's own header comment above
  // on why), against the trigger's and the card's own real rendered
  // geometry (`computeSchedulePopoverPlacement`'s own header comment on why
  // this can't be a Radix `side`/`avoidCollisions` prop combination alone)
  // — not continuously: nothing here re-measures on a keystroke that
  // changes the card's own height (typed preview appearing, say), only on
  // open/mount and on the window resizing while still open (the ticket's
  // own 800×600 trap is about the window's size, which *can* change after
  // open, unlike the card's). `useLayoutEffect`, not `useEffect`: it runs
  // before the browser paints, so the arbitrary position the very first
  // (unmeasured) commit below renders at is never actually shown — the
  // measured, correct position from this effect's own synchronous
  // `setPlacement` is what the browser paints instead, the identical trick
  // Radix's own `PopperContent` uses for its `isPositioned` case
  // (`components/ui/popover.tsx`'s own header comment references the same
  // file this was read from).
  useLayoutEffect(() => {
    if (!open || triggerEl === null || contentEl === null) {
      setPlacement(null);
      return;
    }
    function recomputePlacement() {
      // Narrowed again inside the closure: TypeScript can't see that the
      // outer `null` checks still hold by the time a later `resize` fires
      // this same function.
      if (triggerEl === null || contentEl === null) {
        return;
      }
      setPlacement(
        computeSchedulePopoverPlacement(
          triggerEl.getBoundingClientRect(),
          contentEl.getBoundingClientRect(),
          {
            width: window.innerWidth,
            height: window.innerHeight,
          },
        ),
      );
    }
    recomputePlacement();
    window.addEventListener("resize", recomputePlacement);
    return () => window.removeEventListener("resize", recomputePlacement);
  }, [open, triggerEl, contentEl]);

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
  const nowDateTimeKey = localDateTimeKey(now);
  const preview = resolveSchedulePreview(typed, nowDateTimeKey, dateDay);

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

  function commitRepeatPhrase(phrase: string, day: string) {
    onPickRecurrence(phrase, day);
    setOpen(false);
  }

  // Issue #326: `TaskTimeDialog`'s own `onSave` used to be `onSetTime`
  // passed straight through, so Save's "closes the scheduler too" outcome
  // was riding the identical accidental route Cancel's bug also rode
  // (`classifyOutsideInteraction`'s own comment above `TaskSchedulePopoverProps`)
  // — it happened to look correct only because nothing was guarding it yet.
  // Now that Cancel is fixed, Save needs its own explicit `setOpen(false)`
  // to keep behaving the same way, the same pattern `commitRepeatPhrase`
  // above already uses for the Repeat menu and the Custom repeat dialog's
  // own successful Save.
  function handleTimeSave(time: string | null) {
    onSetTime(time);
    setOpen(false);
  }

  /**
   * Issue #292's Custom repeat dialog commits through the identical door
   * every other recurrence in this file uses — it hands back a *phrase*,
   * the same text someone could have typed, and that phrase is resolved
   * here by the same `resolveSchedulePreview` the typed input runs on every
   * keystroke. Not `firstOccurrence` directly: the typed path already
   * answers "what day does this rule start on, and is it even placeable",
   * and calling the engine a second way here is how the two paths would
   * eventually disagree about the same phrase.
   *
   * `resolveSchedulePreview` returns `null` when a rule parses but has no
   * occurrence to land on — a bound already in the past ("ending 1 Jan
   * 2020") is the reachable case, since this dialog's own "On date" field
   * will happily accept one. Committing then would set a Recurrence whose
   * next occurrence doesn't exist, and dropping it silently would make Save
   * look broken. So the phrase goes into the "Type a date" field instead,
   * focused: that field already renders this exact grammar's own live
   * preview and refusal, so the reader lands looking at their own rule in
   * the one place that explains why it didn't take, and can edit it there.
   * The scheduler deliberately stays open in that branch.
   */
  function handleCustomRepeatSave(phrase: string) {
    const resolved = resolveSchedulePreview(phrase, nowDateTimeKey, dateDay);
    if (resolved?.dateString != null) {
      commitRepeatPhrase(resolved.dateString, resolved.day);
      return;
    }
    setTyped(phrase);
    typedInputRef.current?.focus();
  }

  const repeatAnchor = parseDayKey(dateDay) ?? now;
  const repeatCandidates: ReadonlyArray<{
    key: string;
    phrase: string;
    label: (resolvedDay: string) => string;
  }> = [
    { key: "day", phrase: "every day", label: () => "Every day" },
    {
      // A named weekday, not a bare "every week". Since #291 the engine
      // anchors an unbanged rule to the due date, so bare "every week" no
      // longer drifts off its weekday the way this comment used to warn —
      // but a named weekday is still the honest label, because it says on
      // the tin which day it keeps rather than leaving a reader to derive
      // it from the anchor rule. `every! week` remains explicitly
      // completion-anchored and would still drift.
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
  // Whether this Task already carries a Recurrence. Issue #293: Todoist
  // does not hide its Repeat entry once one is set — it *replaces* it with a
  // two-part control, a button carrying the rule's own name beside a
  // separate `Clear recurrence` button (finding
  // `C-already-recurring-scheduler-state`, driven 2026-09-14).
  const activeRecurrence = dateString;
  // "What the user typed is what is stored" (CONTEXT.md, Recurrence), so the
  // button carries the stored phrase rather than a re-derived description of
  // it — capitalised only, which is what turns the stored `every day` into
  // Todoist's own displayed `Every day`.
  const recurrenceLabel =
    activeRecurrence === null
      ? null
      : activeRecurrence.charAt(0).toUpperCase() + activeRecurrence.slice(1);

  // The original gate here hid the Repeat control whenever a recurrence
  // preview was showing, to avoid two controls claiming to set the same
  // thing. But `typed` is seeded from `dateString` on every open, so that
  // also hid it for a Task that was *already* recurring — leaving no way to
  // change or clear the rule except by editing the typed text, and no way at
  // all to stop a Task repeating while keeping its date (`No Date` takes the
  // date with it).
  //
  // Narrowed: hide it only while the user is typing a recurrence that is not
  // the one already stored. Then the preview button above is genuinely the
  // thing that commits, and the original concern still holds.
  const typingNewRecurrence =
    preview !== null && preview.dateString !== null && preview.dateString !== activeRecurrence;
  const showRepeatControl = !typingNewRecurrence;

  /**
   * Drops the Recurrence and keeps the day — issue #293's load-bearing
   * distinction, exercised functionally on Todoist rather than merely
   * observed: the control reverted to a plain `Repeat` and the Task's due
   * date was unchanged.
   *
   * Needs no new prop. `onPickDay` already "commits a plain, non-recurring
   * date and clears any Recurrence the Task already had" (this file's own
   * header comment), so handing it the day the Task is already on clears the
   * rule and moves nothing.
   */
  const clearRecurrenceKeepingDate = () => {
    setTyped("");
    onPickDay(dateDay);
    setOpen(false);
  };

  const tomorrow = addDays(now, 1);
  const nextWeek = nextMonday(now);
  const nextWeekend = nextSaturday(now);

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
  ].filter(
    (option, index, all) =>
      option.day !== dateDay && all.findIndex((other) => other.day === option.day) === index,
  );

  // One body, two shells. Everything below renders identically whichever
  // shell wraps it, so the anchored and bottom-sheet variants cannot drift
  // apart the way two copies of this tree would.
  // The scheduler's own fields, shared verbatim by both shells. Extracted
  // when the narrow variant landed (issue #282) so the anchored and
  // bottom-sheet forms render one tree rather than two copies that could
  // drift apart.
  const scheduleFields = (
    <>
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
        {/*
            `alwaysDated` (this popover's own doc comment above): issue
            #435's Reschedule keeps this option reachable even with no
            `dateDay` of its own — every Overdue Task it would clear
            already has a date, this popover just has none picked yet.
          */}
        {(dateDay !== null || alwaysDated) && (
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
        today={now}
        formatters={{
          formatWeekdayName: (day) => format(day, "EEEEE"),
          // Defect 6 (measured 2026-09-15): Todoist's own caption reads
          // "Sep 2026" — react-day-picker's default `formatCaption`
          // (`DateLib.formatMonthYear`) renders the locale's full month
          // name instead ("September 2026"). Same override mechanism as
          // `formatWeekdayName` above, for the identical reason: left at
          // the default, this ticket's own reference measurement would
          // silently diverge from it.
          formatCaption: (month) => format(month, "MMM yyyy"),
        }}
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
          weekend: "[&>button]:text-muted-foreground",
          busy: "before:absolute before:bottom-0.5 before:left-1/2 before:size-[3px] before:-translate-x-1/2 before:rounded-full before:bg-[color:var(--td-calendar-busy-dot)] before:content-['']",
        }}
        classNames={{
          today:
            "[&>button]:font-bold [&:not([data-selected=true])>button]:text-[color:var(--td-calendar-today)]!",
          selected:
            "[&>button]:bg-[color:var(--td-calendar-selected)] [&>button]:text-white [&>button]:font-bold [&>button]:hover:bg-[color:var(--td-calendar-selected)]",
          // Defect 4 (measured 2026-09-15): Todoist gave next-month days
          // shown in its grid (it had Oct 1–11 visible) no distinguishing
          // class at all — a next-month Saturday read exactly like a
          // current-month Saturday. The base `Calendar` primitive
          // (calendar.tsx) dims every `outside` cell
          // (`text-muted-foreground opacity-50`) for its two other
          // callers (the History date picker, the Custom-repeat end-date
          // picker), neither of which this ticket measured against
          // Todoist — so the dimming is cleared here, at this call site
          // only, rather than in the shared primitive. An outside day now
          // falls through to whichever of `weekend`/`today`/`selected`
          // actually applies to it, same as a current-month day.
          outside: "",
          day_button: cn(
            buttonVariants({ variant: "ghost" }),
            "p-0 font-normal aria-selected:opacity-100",
            "h-7 w-[30px] rounded-[12px]",
            // Defect 3 (measured 2026-09-15): Todoist's hover is an
            // OPAQUE rgb(77,77,77) pill, not `ghost`'s translucent
            // `hover:bg-muted` (this theme's `oklab(0.2686 … / 0.5)`) —
            // overridden with the shared `--td-calendar-cell-hover`
            // token (index.css) rather than a second literal, since
            // defect 2's focus pill below is the identical grey at
            // partial opacity. `ghost`'s OWN hover is really two rules —
            // plain `hover:bg-muted` and, separately, `dark:hover:bg-
            // muted/50` (button.tsx) — and only the plain one shares this
            // override's specificity; `.dark .cls:hover` outranks a bare
            // `.cls:hover` regardless of source order, so without a
            // `dark:` twin of this same override, dark mode (the ONLY
            // theme Todoist was ever measured in — this file's own
            // `[data-surface="todo"]` header comment) would keep showing
            // the old translucent wash on top. Repeated rather than
            // computed from the plain class so `cn`'s tailwind-merge sees
            // the identical `dark:hover:bg-*` group and drops `ghost`'s
            // version outright, instead of leaving two same-specificity
            // rules to fight over stylesheet order.
            //
            // Defect 2 (measured 2026-09-15): a focused day cell computed
            // `outline-style: none` and an all-zero `box-shadow` live —
            // no visible focus state at all, unlike every other control
            // in this popover. `ghost`'s own `focus-visible:ring-3
            // focus-visible:ring-ring/50 focus-visible:border-ring`
            // (button.tsx) is neutralised here (`ring-0`/
            // `border-transparent`) and replaced with Todoist's own
            // measured focus-visible pill: `rgba(77, 77, 77, 0.306)`,
            // i.e. the hover token's grey at 30.6% opacity —
            // `color-mix`'s opacity modifier scales a colour's alpha
            // alone when mixed with fully-transparent (CSS Color 4), so
            // `/[30.6%]` on the token reproduces the measured rgba
            // exactly without a second literal. It deliberately sets no
            // text colour, so a focused "today" cell stays today-red —
            // Todoist's own measured behaviour ("inheriting the cell's
            // own text colour").
            "hover:bg-[color:var(--td-calendar-cell-hover)] dark:hover:bg-[color:var(--td-calendar-cell-hover)] focus-visible:border-transparent focus-visible:ring-0 focus-visible:bg-[color:var(--td-calendar-cell-hover)]/[30.6%]",
          ),
        }}
        className="mx-auto"
      />

      <div className="flex items-center gap-2">
        {/*
            Gated on `dateDay !== null` for the identical reason the
            former inline checkbox was: there is no time-of-day to attach
            to an unset date. `alwaysDated` (this popover's own doc
            comment above) is the one deliberate escape hatch — Reschedule
            has no single `dateDay` of its own to gate on, but every
            Overdue Task it applies to already carries a real day.
          */}
        {(dateDay !== null || alwaysDated) && (
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

        {showRepeatControl && (
          <div className="flex w-fit items-center gap-0.5">
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <Button
                  ref={repeatTriggerRef}
                  type="button"
                  variant="ghost"
                  // Issue #293: once a rule is set the trigger carries the
                  // rule's own name, and the menu it opens is named for the
                  // rule rather than for "Repeat" — both driven on Todoist.
                  aria-label={recurrenceLabel ?? "Repeat"}
                  className="h-8 w-fit justify-start gap-2 px-2 font-normal text-muted-foreground"
                >
                  <Repeat className="size-4" />
                  {recurrenceLabel ?? "Repeat"}
                </Button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  data-testid="repeat-menu"
                  align="start"
                  className="z-[70] flex w-[282px] flex-col gap-0.5 rounded-lg border border-border bg-popover p-1 text-popover-foreground text-sm shadow-lg"
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
                    if (openCustomRepeatAfterRepeatCloseRef.current) {
                      openCustomRepeatAfterRepeatCloseRef.current = false;
                      // Same reason the focus case below preventDefault()s:
                      // returning focus to the trigger here would yank it
                      // back out of the dialog that is about to autofocus.
                      event.preventDefault();
                      setCustomRepeatOpen(true);
                      return;
                    }
                    if (!focusInputAfterRepeatCloseRef.current) {
                      return;
                    }
                    focusInputAfterRepeatCloseRef.current = false;
                    event.preventDefault();
                    typedInputRef.current?.focus();
                  }}
                  onEscapeKeyDown={() => setOpen(false)}
                >
                  {repeatOptions.map((option) => (
                    <DropdownMenu.Item
                      key={option.key}
                      className={cn(repeatItemClassName, "justify-between")}
                      onSelect={() => commitRepeatPhrase(option.phrase, option.day)}
                    >
                      {option.label}
                      {/*
                        Issue #293: the active rule carries a check that the
                        plain Repeat menu's items do not. Compared against the
                        stored phrase rather than the rendered label, since
                        the label is re-derived per open and the phrase is
                        what the Task actually holds.
                      */}
                      {option.phrase === activeRecurrence && (
                        <Check aria-hidden="true" className="size-3.5" />
                      )}
                    </DropdownMenu.Item>
                  ))}
                  <DropdownMenu.Item
                    className={repeatItemClassName}
                    onSelect={() => {
                      openCustomRepeatAfterRepeatCloseRef.current = true;
                    }}
                  >
                    Custom…
                  </DropdownMenu.Item>
                  {/*
                    Issue #293's seventh item, present only once a rule is
                    set. Removal has two doors in Todoist — this and the
                    standalone button beside the trigger — and both leave the
                    date alone.
                  */}
                  {activeRecurrence !== null && (
                    <DropdownMenu.Item
                      className={repeatItemClassName}
                      onSelect={clearRecurrenceKeepingDate}
                    >
                      Clear
                    </DropdownMenu.Item>
                  )}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
            {/*
                The standalone half of the two-part control. `Clear
                recurrence` is deliberately NOT `No Date`: it drops the rule
                and keeps the day, which is the distinction meologue had no
                way to express at all before this — `No Date` takes the date
                with it.
              */}
            {activeRecurrence !== null && (
              <Button
                type="button"
                variant="ghost"
                aria-label="Clear recurrence"
                onClick={clearRecurrenceKeepingDate}
                className="size-8 shrink-0 text-muted-foreground"
              >
                <X className="size-4" />
              </Button>
            )}
          </div>
        )}
      </div>
    </>
  );

  if (touch) {
    return (
      <>
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger asChild>{trigger}</SheetTrigger>
          <SheetContent data-testid="scheduler-view" className="gap-2 p-3 text-sm">
            <SheetTitle className="px-1 pb-1 font-medium text-base">Date</SheetTitle>
            {scheduleFields}
          </SheetContent>
        </Sheet>
        <TaskTimeDialog
          open={timeDialogOpen}
          onOpenChange={setTimeDialogOpen}
          time={dateTime}
          onSave={onSetTime}
          onEscape={() => setOpen(false)}
        />
        {/*
          Rendered on the narrow branch too, because `scheduleFields` — and
          so the whole Repeat menu, "Custom…" included — is shared by both
          layouts. Omitting it here would leave the item reachable on a
          phone with nothing behind it, which is the dead end #292 exists to
          remove, reintroduced at the one width nobody tests in jsdom.
        */}
        <TaskCustomRepeatDialog
          open={customRepeatOpen}
          onOpenChange={setCustomRepeatOpen}
          recurrence={activeRecurrence}
          onSave={handleCustomRepeatSave}
          onEscape={() => setOpen(false)}
          now={now}
          restoreFocusTo={repeatTriggerRef}
        />
      </>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger ref={setTriggerEl} asChild>
        {trigger}
      </PopoverTrigger>
      <PopoverContent
        ref={setContentEl}
        data-testid="scheduler-view"
        // Issue #440: below → above → beside, computed by `recomputePlacement`
        // above from the trigger's and this card's own real geometry — see
        // `computeSchedulePopoverPlacement`'s own header comment for why
        // `side`/`align: "start"`/`alignOffset` (never `"center"`) is how that
        // result reaches Radix. `avoidCollisions={false}`: Radix's own
        // flip/shift middleware would otherwise second-guess a placement this
        // component already chose with the real viewport in hand, undoing the
        // beside branch's own deliberate vertical clamp in particular.
        //
        // `data-side`/`data-align-offset` are this component's own, not
        // Radix's — deliberately shadowing the `data-side` Radix's own
        // `PopperContent` already sets from `placedSide` (`components/ui/
        // popover.tsx`'s own `{...props}` spreads after Radix's internal
        // "data-side" key, so a caller-supplied one wins): floating-ui
        // resolves `useFloating`'s returned `placement` — and so Radix's own
        // `data-side` — through a promise-based `computePosition()`, a real
        // (if usually sub-frame) microtask hop behind the `side` prop it was
        // just given, which a synchronous `render`/`fireEvent` test (no
        // intervening `await`) never observes resolve; this component's own
        // `placement` state has no such lag, so asserting against these two
        // attributes instead is what actually lets a test see this
        // component's own choice rather than racing floating-ui's.
        data-side={placement?.side ?? "bottom"}
        data-align-offset={placement === null ? undefined : placement.alignOffset}
        side={placement?.side ?? "bottom"}
        align="start"
        sideOffset={placement?.sideOffset ?? 0}
        alignOffset={placement?.alignOffset ?? 0}
        avoidCollisions={false}
        className="flex flex-col gap-2 p-2 text-sm"
        style={{
          width: "var(--td-popover-width)",
          minHeight: "var(--td-popover-min-height)",
          borderRadius: "var(--td-popover-radius)",
          background: "var(--td-popover-background)",
          border: "1px solid var(--td-popover-border)",
          boxShadow: "var(--td-popover-shadow)",
        }}
        // See `classifyOutsideInteraction`'s own comment above (issue
        // #326) — all three handlers get it, not just whichever one a
        // given interaction happens to fire.
        onFocusOutside={classifyOutsideInteraction}
        onPointerDownOutside={classifyOutsideInteraction}
        onInteractOutside={classifyOutsideInteraction}
      >
        {scheduleFields}
      </PopoverContent>
      <TaskTimeDialog
        open={timeDialogOpen}
        onOpenChange={setTimeDialogOpen}
        time={dateTime}
        // `handleTimeSave`'s own comment above — deliberate, not the
        // accidental route issue #326 fixed.
        onSave={handleTimeSave}
        onEscape={() => setOpen(false)}
      />
      <TaskCustomRepeatDialog
        open={customRepeatOpen}
        onOpenChange={setCustomRepeatOpen}
        // The Task's own stored phrase, so opening "Custom…" on a recurring
        // Task reads as editing the rule it already has rather than
        // starting from a blank one — the identical reason this file's own
        // `typed` seeds from `dateString` (header comment).
        recurrence={activeRecurrence}
        // `handleCustomRepeatSave` only ever closes the *scheduler* by
        // calling `commitRepeatPhrase` (above), which carries its own
        // `setOpen(false)`. Its other branch — a rule with no occurrence
        // left — reaches neither `commitRepeatPhrase` nor any other close
        // call, yet the scheduler still has to stay open there (this
        // function's own comment). It does: that branch's Save button is,
        // like Cancel, a target inside `custom-repeat-dialog`
        // (`OWNED_PORTAL_SELECTOR`), so `classifyOutsideInteraction` treats
        // its own accidental-dismiss race exactly like Cancel's — no
        // branch-specific handling needed, or wanted.
        onSave={handleCustomRepeatSave}
        onEscape={() => setOpen(false)}
        now={now}
        restoreFocusTo={repeatTriggerRef}
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
