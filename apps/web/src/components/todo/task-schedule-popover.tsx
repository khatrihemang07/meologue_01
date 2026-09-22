import type { LocalDateTimeKey, QuickAddToken } from "@meologue/core";
import { firstOccurrence, localDayKeyOf, parseQuickAdd, parseRecurrence } from "@meologue/core";
import { addDays, format, nextMonday, nextSaturday } from "date-fns";
import {
  CalendarClock,
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
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { formatDay } from "@/lib/format-task-date";
import { localDateTimeKey, localDayKey, parseDayKey } from "@/lib/local-day-key";
import { touchOnlyDevice } from "@/lib/pointer";
import { resolveRecurrencePhrase } from "@/lib/quick-add-task";
import {
  computeSchedulePopoverPlacement,
  type PlacementSize,
  type SchedulePopoverPlacement,
} from "@/lib/schedule-popover-placement";
import { cn } from "@/lib/utils";
import { MonthListCalendar } from "./month-list-calendar";
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

/**
 * Issue #436's own comment correction (2026-09-21) measured "Mon -> Wed";
 * this ticket's own real-browser follow-up pass added a second point,
 * "Tue -> Thu" — both "today + 2 days", so that reading is the rule,
 * applied uniformly to every `now`. `laterThisWeekVisible` below is what
 * actually decides whether that reading belongs in the list it would sit
 * in for the five weekdays neither point measured.
 */
function laterThisWeekDay(now: Date): Date {
  return addDays(now, 2);
}

/**
 * Whether `laterThisWeekDay`'s own "+2 days" reading actually belongs in
 * the quick-option list it would replace an elided Today/Tomorrow in.
 * Todoist's two measured points (Mon->Wed, Tue->Thu) never tested a `now`
 * where "+2" either spills past the coming weekend or lands on a day some
 * OTHER option in that same list already names, so — beyond Monday and
 * Tuesday — this is a mechanical consequence of the same "+2 days" reading
 * applied to every weekday, not a third measured point:
 *
 * | `now` | +2 days | shown? | why |
 * |---|---|---|---|
 * | Mon | Wed | yes — measured | |
 * | Tue | Thu | yes — measured | |
 * | Wed | Fri | yes — inferred | before the weekend, no collision |
 * | Thu | Sat | no — inferred | lands ON This weekend's own day |
 * | Fri | Sun | no — inferred | spills past This weekend's Saturday |
 * | Sat | Mon (+2) | no — inferred | collides with Next week's own Monday |
 * | Sun | Tue | yes — inferred | before the (next) weekend, no collision |
 *
 * `otherVisibleDays` is every OTHER local-day-key this popover's own quick
 * options would show alongside "Later this week" — the surviving one of
 * Today/Tomorrow, This weekend, and Next week — passed in by the caller
 * rather than re-derived here, so a future change to any of those three
 * stays correct for free.
 */
function laterThisWeekVisible(
  candidateDay: string,
  thisWeekendDay: string,
  otherVisibleDays: readonly string[],
): boolean {
  return candidateDay < thisWeekendDay && !otherVisibleDays.includes(candidateDay);
}

/**
 * "Opened from a Task: the input is pre-filled with the Task's date text
 * ('19 Sep 21:00', or '19 Sep' without time)" (issue #436's own ticket
 * body) — `formatDay` (`@/lib/format-task-date`) already renders the exact
 * "d MMM" half of that for the row/detail/sidebar (that file's own doc
 * comment: one formatter so those three agree by construction), reused
 * here rather than re-derived so this picker's own prefill can't drift
 * from what the row beside it already shows for the identical day.
 * `time` is `Task.date`'s own `HH:MM` component, concatenated verbatim —
 * Todoist's own captured text is 24-hour, not `formatTaskDate`'s relative
 * "Today"/"Tomorrow" labels or its 12-hour "h:mm a" (that formatter's own
 * job is a row's relative-to-now label, not this field's literal value).
 */
function formatScheduleInputText(day: string, time: string | null): string {
  const datePart = formatDay(day);
  return time === null ? datePart : `${datePart} ${time}`;
}

/**
 * Issue #440's own real-browser follow-up: the card's size *before* it has
 * ever been measured on this popover instance (`lastMeasuredCardSize`,
 * inside the component below) — read from its own sizing tokens
 * (index.css's own `--td-popover-width`/`--td-popover-max-height`,
 * `:root`-scoped, so this resolves identically wherever it's read from,
 * a portalled card included) rather than a hardcoded literal — one source
 * of truth, the CSS itself. The `Number.isFinite` fallback only fires if
 * the custom property can't be read at all (a test environment with no
 * real stylesheet loaded, `getPropertyValue` returning `""`, `parseFloat`ing
 * to `NaN`) — its two literals are kept in sync with index.css's own
 * current defaults, not a second design decision about what this card's
 * size is.
 *
 * `--td-popover-max-height` (issue #436's own real-browser follow-up,
 * renamed from `--td-popover-min-height`: that token's own comment in
 * index.css has the full story) is a CEILING the card's real content sizes
 * under, not a floor it gets padded out to — reading it here as this
 * estimate's own height is still correct precisely because it's a safe
 * UPPER bound: a real card is either at the cap (five options) or shorter
 * (four), never taller, and the post-mount `ResizeObserver` measurement
 * below (`recomputePlacement`) corrects a too-tall guess exactly the way
 * it already corrects a typed-preview row or the Repeat control's two-part
 * layout changing this card's real height — nothing new needed for the
 * four-option case either.
 */
function cardSizeFromCssTokens(): PlacementSize {
  const style = getComputedStyle(document.documentElement);
  const width = Number.parseFloat(style.getPropertyValue("--td-popover-width"));
  const height = Number.parseFloat(style.getPropertyValue("--td-popover-max-height"));
  return {
    width: Number.isFinite(width) ? width : 250,
    height: Number.isFinite(height) ? height : 555,
  };
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
  // Issue #436: the exact text `typed` was seeded with at open, but ONLY
  // when that seed came from `dateDay` (a Task's own plain date, formatted
  // via `formatScheduleInputText`) rather than from an existing
  // `dateString` (Recurrence) or an empty field — `null` in both of those
  // other cases. Read once, in the preview computation below: as long as
  // `typed` still equals this ref's own value, the field reads as "the
  // reader hasn't touched the pre-filled text yet", which is the one state
  // Todoist's own screenshot shows with NO preview row underneath the
  // input (just the quick options, immediately) — unlike a Recurrence
  // seed, which has always shown its own preview immediately on open (the
  // suite's own pre-existing "hides the Repeat entry point..." test), a
  // contract this ref deliberately leaves alone. Cleared to `null` the
  // moment the input's own `onChange` fires, so any real edit — even
  // retyping the identical text — starts resolving a preview again.
  const plainDateSeedRef = useRef<string | null>(null);
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
  // `null` until the card has actually been measured post-mount — the
  // *displayed* placement (`displayPlacement` below) falls back to a
  // synchronous, pre-mount estimate while this is still `null`, which is
  // what issue #440's own real-browser follow-up (this section's own
  // header comment) is about: this state alone is deliberately NOT what
  // decides what gets shown first.
  const [placement, setPlacement] = useState<SchedulePopoverPlacement | null>(null);
  // The card's own size, the one time to reach for the moment it's
  // actually known (`recomputePlacement` below sets it before every
  // `setPlacement`) — read back as this popover's own best *guess* the
  // next time it opens, before that open's own measurement has run yet.
  // Persists across a close/reopen (a plain `useRef`, not reset anywhere):
  // once this popover has been measured for real once, its own real size
  // is a better guess than the CSS tokens `cardSizeFromCssTokens` falls
  // back to for content that legitimately runs taller than the CSS
  // `min-height` (a long typed Recurrence preview, say).
  const lastMeasuredCardSize = useRef<PlacementSize | null>(null);

  // Issue #440, part two (found after this ticket's first real-browser
  // verification, itself fixing issue #440's own first defect — the below-
  // fits cases were already correct there): in every BESIDE case, the card
  // was still visible for one frame at the wrong, below-shaped position
  // before snapping to the correct one. The previous fix's own visibility
  // gate flips exactly in sync with `placement` (React guarantees that,
  // same commit), so that alone can't explain a visible wrong frame — the
  // actual cause is what Radix does with a *correct* `placement` once this
  // effect finally sets it: changing the `side`/`alignOffset` PROPS handed
  // to `PopoverContent` only changes floating-ui's OWN internal `placement`
  // OPTION, and floating-ui resolves that through its own promise-based
  // `computePosition()` (`@floating-ui/dom`, at least one microtask behind
  // the prop change) before its wrapper's `transform` — the thing that
  // actually moves the card on screen — catches up. Between the commit
  // that hands Radix the correct props and the LATER commit where Radix's
  // own async positioning has actually caught up to them, the card sat
  // wherever Radix's PREVIOUS `computePosition()` had already placed it —
  // the arbitrary `side="bottom"` this component used to start every open
  // with, painted for real in that gap.
  //
  // The fix is at the source, not in this effect: make the FIRST props
  // Radix ever sees for this open already the correct ones, so there is no
  // later prop change — and so no async catch-up — for it to lag behind.
  // `displayPlacement` (below, computed inline during render rather than
  // in an effect) is exactly that: synchronous, using the trigger's real
  // `getBoundingClientRect()` — already mounted, unlike the card — and a
  // *known-in-advance* card size (`lastMeasuredCardSize.current` from a
  // previous open, or `cardSizeFromCssTokens()` on the very first one),
  // before `PopoverContent` (so Radix's own `useFloating`) has mounted at
  // all. Radix's own `PopperContent` already keeps a freshly-mounted card
  // off-page (`translate(0, -200%)`, "keep off the page while measuring")
  // until ITS OWN first `computePosition()` resolves — with correct
  // `side`/`alignOffset` from the very first render, that first resolution
  // already lands on the right spot, so there is nothing left for this
  // component's own `visibility` gate below to hide: it stays only as a
  // defensive fallback for the one case `displayPlacement` still can't
  // estimate (the trigger itself somehow not yet mounted — practically
  // unreachable, since `trigger` renders unconditionally and has to
  // already exist for this popover to have been openable at all), not as
  // this fix's actual mechanism.
  //
  // This effect's own job, post-mount, is now the CORRECTION path, not the
  // first paint: it measures the card's own real, untransformed box
  // (`offsetWidth`/`offsetHeight` — never `getBoundingClientRect()`, which
  // reads the card's visual, post-transform box, and Radix's own
  // `PopperContent` wrapper is transformed exactly as described above) and
  // reconciles `placement` with reality — normally finding nothing to
  // change, since the render-time estimate is usually already right, but
  // still catching a genuinely wrong guess (the CSS `min-height` estimate
  // undershooting real content) or the card's own size changing later
  // (below) without a second wrong-frame flash, since Radix's own off-page
  // trick no longer applies once it has already positioned itself once.
  useLayoutEffect(() => {
    if (!open || triggerEl === null || contentEl === null) {
      setPlacement(null);
      return;
    }
    function recomputePlacement() {
      // Narrowed again inside the closure: TypeScript can't see that the
      // outer `null` checks still hold by the time a later event fires
      // this same function.
      if (triggerEl === null || contentEl === null) {
        return;
      }
      const cardSize = { width: contentEl.offsetWidth, height: contentEl.offsetHeight };
      lastMeasuredCardSize.current = cardSize;
      setPlacement(
        computeSchedulePopoverPlacement(triggerEl.getBoundingClientRect(), cardSize, {
          width: window.innerWidth,
          height: window.innerHeight,
        }),
      );
    }
    recomputePlacement();

    // Re-measures when the card's own size changes for any reason — the
    // typed-preview line appearing, the Repeat control's two-part layout
    // swapping in — not just at open. `ResizeObserver`'s own `observe()`
    // additionally fires its callback once, asynchronously, right after
    // this call, which is harmless here (a no-op re-measurement whenever
    // the size hasn't actually changed since the synchronous call above).
    const resizeObserver = new ResizeObserver(recomputePlacement);
    resizeObserver.observe(contentEl);

    // Re-measures on a page scroll while open too — the ticket's own
    // "space below" examples (Reschedule at scroll 0 vs. after 32px+) are
    // exactly this: the trigger's own position moves relative to the
    // viewport, which nothing else here watches for once the popover is
    // already open. rAF-throttled: a real scroll fires many "scroll"
    // events per frame on some inputs, and collapsing a burst to one
    // recompute per frame is what keeps this from fighting the browser's
    // own scroll handling rather than just following it. Capture phase, on
    // `window`: a "scroll" event never bubbles (it targets the scrolling
    // element itself), but it does fire on ancestors during the capture
    // phase, which is what lets one `window`-level listener see a scroll
    // on any scrollable ancestor between the trigger and the viewport, not
    // only the window's own scroll.
    let scrollFrame: number | null = null;
    function onScroll() {
      if (scrollFrame !== null) {
        return;
      }
      scrollFrame = requestAnimationFrame(() => {
        scrollFrame = null;
        recomputePlacement();
      });
    }
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.addEventListener("resize", recomputePlacement);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("scroll", onScroll, { capture: true });
      window.removeEventListener("resize", recomputePlacement);
      if (scrollFrame !== null) {
        cancelAnimationFrame(scrollFrame);
      }
    };
  }, [open, triggerEl, contentEl]);

  // Re-seed on every open, mirroring DatePickerSheet's own identical
  // reasoning (date-picker-sheet.tsx's header comment): a dismiss never
  // commits, so the next open shouldn't look like it remembers a typed
  // draft the reader never confirmed. Seeding `typed` from `dateString`
  // (not blank) is this file's own departure from that precedent — see
  // the header comment on why an existing Recurrence has to start
  // visible for "editable" to mean anything.
  //
  // Issue #436 adds a third seed: a Task with a plain `dateDay` and no
  // Recurrence gets `formatScheduleInputText`'s own rendering of it
  // ("19 Sep 21:00"/"19 Sep") instead of staying blank — the ticket's own
  // "Opened from a Task" state — with the WHOLE text selected
  // (`select()`, below `focus()`; Todoist's own screenshot shows it
  // highlighted, ready to be typed straight over). `plainDateSeedRef`'s
  // own header comment is what keeps that prefill from also showing a
  // preview row nobody asked for yet.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-seed only on the open/close transition, not on every `now` tick or `dateDay`/`dateString` change while already open — `now` in particular has no stable identity across renders (its own default-parameter `new Date()`), so including it here would re-run this effect on every render the popover is open for, not just at open.
  useEffect(() => {
    if (open) {
      let seed: string;
      if (dateString !== null) {
        seed = dateString;
        plainDateSeedRef.current = null;
      } else if (dateDay !== null) {
        seed = formatScheduleInputText(dateDay, dateTime);
        plainDateSeedRef.current = seed;
      } else {
        seed = "";
        plainDateSeedRef.current = null;
      }
      setTyped(seed);
      if (seed !== "") {
        // `typedInputRef` already points at the real, mounted `<input>` by
        // the time a `useEffect` (as against `useLayoutEffect`) fires, the
        // same ordering this file's own placement effect leans on for
        // `triggerEl`/`contentEl` above. But `setTyped` just above hasn't
        // reached the DOM yet — React processes a state update from inside
        // an effect on a LATER render, not before this same synchronous
        // call returns — so reading `.value`/calling `.select()` right
        // after it would still see whatever text was on screen before this
        // open (empty, or a previous session's abandoned draft), not
        // `seed`. Writing `el.value` directly first is what makes the
        // selection land on the text this popover is actually about to
        // show; the later re-render's own `value={typed}` reconciles to
        // the identical string, so nothing fights this write afterwards.
        const el = typedInputRef.current;
        if (el !== null) {
          el.value = seed;
          el.select();
        }
      }
    }
  }, [open]);

  const nowKey = localDayKey(now);
  const nowDateTimeKey = localDateTimeKey(now);
  // `null` while `typed` is still exactly the plain-date prefill this
  // popover seeded on open (`plainDateSeedRef`'s own header comment) —
  // Todoist's own screenshot shows no preview row under a freshly-opened,
  // untouched prefill. An existing Recurrence's own seed is NOT gated the
  // same way (`plainDateSeedRef` stays `null` for it), preserving this
  // suite's own pre-existing contract that a Recurrence's preview shows
  // immediately.
  const preview =
    typed === plainDateSeedRef.current
      ? null
      : resolveSchedulePreview(typed, nowDateTimeKey, dateDay);

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
  const tomorrowKey = localDayKey(tomorrow);
  const nextWeek = nextMonday(now);
  const thisWeekend = nextSaturday(now);
  const laterThisWeek = laterThisWeekDay(now);

  const todayOption = {
    key: "today",
    icon: CalendarDays,
    iconColorVar: "--td-schedule-today",
    label: "Today",
    hint: format(now, "EEE"),
    day: nowKey,
  };
  const tomorrowOption = {
    key: "tomorrow",
    icon: Sun,
    iconColorVar: "--td-schedule-tomorrow",
    label: "Tomorrow",
    hint: format(tomorrow, "EEE"),
    day: tomorrowKey,
  };
  const laterThisWeekOption = {
    key: "later-this-week",
    icon: CalendarClock,
    iconColorVar: "--td-schedule-later-this-week",
    label: "Later this week",
    hint: format(laterThisWeek, "EEE"),
    day: localDayKey(laterThisWeek),
  };
  const thisWeekendOption = {
    key: "this-weekend",
    icon: Sofa,
    iconColorVar: "--td-schedule-this-weekend",
    label: "This weekend",
    // Always a Saturday (`nextSaturday`), so `format`'s own weekday token
    // already renders the fixed "Sat" the ticket's own comment measured —
    // no separate literal needed.
    hint: format(thisWeekend, "EEE"),
    day: localDayKey(thisWeekend),
  };
  const nextWeekOption = {
    key: "next-week",
    icon: CalendarRange,
    iconColorVar: "--td-schedule-next-week",
    label: "Next week",
    hint: format(nextWeek, "EEE d MMM"),
    day: localDayKey(nextWeek),
  };

  /**
   * Issue #436's own comment correction (2026-09-21) replaces the old
   * "drop whatever quick option matches `dateDay`" rule entirely — Todoist
   * only ever elides Today, Tomorrow, or No Date, and only when each one
   * individually equals the CURRENT value, never This weekend or Next
   * week (a Task due next Monday still offers "Next week", unlike this
   * component's own pre-#436 behaviour). An elided Today or Tomorrow is
   * replaced by "Later this week" in the SECOND slot — the measured order
   * for both rows is `[the surviving one of Today/Tomorrow, Later this
   * week, This weekend, Next week, No Date]` — not by simply dropping
   * Today/Tomorrow's own first-or-second slot in place, which the
   * comment's own two example rows would not produce identically.
   *
   * "Later this week" is itself conditional (`laterThisWeekVisible`'s own
   * table above) — on the five weekdays that table infers rather than
   * measures, the replacement is dropped outright, leaving the surviving
   * Today/Tomorrow as the list's own first item with nothing after it
   * until This weekend, and the list one option shorter overall.
   */
  const otherVisibleDaysWhenToday = [tomorrowKey, thisWeekendOption.day, nextWeekOption.day];
  const otherVisibleDaysWhenTomorrow = [nowKey, thisWeekendOption.day, nextWeekOption.day];
  const leadingOptions =
    dateDay === nowKey
      ? laterThisWeekVisible(
          laterThisWeekOption.day,
          thisWeekendOption.day,
          otherVisibleDaysWhenToday,
        )
        ? [tomorrowOption, laterThisWeekOption]
        : [tomorrowOption]
      : dateDay === tomorrowKey
        ? laterThisWeekVisible(
            laterThisWeekOption.day,
            thisWeekendOption.day,
            otherVisibleDaysWhenTomorrow,
          )
          ? [todayOption, laterThisWeekOption]
          : [todayOption]
        : [todayOption, tomorrowOption];
  const quickOptionDefs = [...leadingOptions, thisWeekendOption, nextWeekOption];

  // One body, two shells. Everything below renders identically whichever
  // shell wraps it, so the anchored and bottom-sheet variants cannot drift
  // apart the way two copies of this tree would.
  // The scheduler's own fields, shared verbatim by both shells. Extracted
  // when the narrow variant landed (issue #282) so the anchored and
  // bottom-sheet forms render one tree rather than two copies that could
  // drift apart.
  const scheduleFields = (
    <>
      {/* Issue #436's own fixed 36px input row — `h-9` pins that height
          regardless of the placeholder/value text's own line box. */}
      <div className="relative h-9 shrink-0">
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
          onChange={(event) => {
            setTyped(event.target.value);
            // Any real edit — the reader retyping the identical prefilled
            // text included — ends the "untouched prefill" state
            // `plainDateSeedRef` tracks, so the preview starts resolving
            // again from here on (this ref's own header comment above).
            plainDateSeedRef.current = null;
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitPreview();
            }
          }}
          style={{ color: "var(--td-schedule-input-text)" }}
          className="h-9 w-full rounded-md border border-border bg-background px-2 py-1 pr-7 text-[14px] outline-none placeholder:text-[color:var(--td-schedule-input-placeholder)] focus-visible:ring-1 focus-visible:ring-ring"
        />
        {typed !== "" && (
          <button
            type="button"
            aria-label="Clear"
            onClick={() => {
              setTyped("");
              plainDateSeedRef.current = null;
            }}
            className="-translate-y-1/2 absolute top-1/2 right-1.5 rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>

      {/* Issue #436's own divider — between the input and whatever renders
          next (the typed preview when one resolves, otherwise the quick
          options directly, exactly as Todoist's own screenshots show). */}
      <div
        data-testid="schedule-divider"
        className="h-px shrink-0 bg-[color:var(--td-popover-divider)]"
      />

      {/*
          Issue #436's own real-browser follow-up: Todoist's own card
          pins ONLY the input (and its divider) above — everything below,
          quick options through Repeat, lives in ONE `overflow-y: auto`
          region (`.scheduler-scrollable`, that pass's own name for it).
          Two real bugs traced back to NOT having this: a 236px, `overflow-
          hidden` box around the calendar alone was clipping a 6-week
          month's own last row unreachably (Nov 2026 needs 268px), and the
          five-option/Time/Repeat combination laid out 2px over the card's
          own measured 555px cap with nothing to absorb the overflow. One
          scroll region fixes both at once: it can grow past 555 and
          scroll instead of clipping OR forcing the card taller.
          `min-h-0` is the standard flexbox fix for a `flex-1` child that
          also needs to shrink below its own content size — without it, a
          flex item's default `min-height: auto` would keep expanding this
          region (and so the card around it) past `max-height` instead of
          ever actually scrolling.
        */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {preview !== null && (
          <button
            type="button"
            data-testid="scheduler-date-preview"
            onClick={commitPreview}
            className="my-1 flex shrink-0 flex-col items-start gap-0.5 rounded-md border border-border px-2 py-1.5 text-left hover:bg-accent"
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

        {/* Issue #436's own 160px (five options) / 128px (four) quick-
            options block — no wrapper height of its own: each `QuickOption`
            is a fixed 32px (`h-8`) and they stack with no gap, so the
            block's real height already IS `optionCount * 32`. */}
        <div data-testid="quick-options" className="flex shrink-0 flex-col">
          {quickOptionDefs.map((option) => (
            <QuickOption
              key={option.key}
              icon={option.icon}
              iconColorVar={option.iconColorVar}
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
            Doubles as issue #436's own "current value is No Date" row of
            the elision table: an ordinary undated caller (no `dateDay`,
            no `alwaysDated`) drops this option and nothing else, landing
            the block at four options instead of five.
          */}
          {(dateDay !== null || alwaysDated) && (
            <QuickOption
              icon={CircleSlash}
              iconColorVar="--td-schedule-no-date"
              label="No Date"
              hint={null}
              onClick={() => commitDay(null)}
            />
          )}
        </div>

        <div
          data-testid="schedule-divider"
          className="h-px shrink-0 bg-[color:var(--td-popover-divider)]"
        />

        {/* Issue #439: Todoist web's own endless month list, replacing
            the fixed month-grid `<Calendar>` this popover used to render
            here (`month-list-calendar.tsx`'s own header comment has the
            full design). `initialDay` is deliberately omitted — a Task
            opened with a FUTURE date does not auto-scroll to it; the list
            always opens at its own natural top, `minDay`'s own week (this
            file's own ticket: "pick 'start at the current week' ... unless
            the date is in the current view," which nothing here needs to
            special-case when the list already starts there by default). A
            PAST date needs no handling either: `selectedDay` below simply
            never appears in the rendered list at all when it's before
            `minDay`, the same "not reachable" contract this popover's own
            props already lean on elsewhere. */}
        <MonthListCalendar
          now={now}
          selectedDay={dateDay}
          datesWithTasks={datesWithTasks}
          onPickDay={commitDay}
        />

        <div
          data-testid="schedule-divider"
          className="h-px shrink-0 bg-[color:var(--td-popover-divider)]"
        />

        {/* Issue #436's own stacked Time/Repeat rows — each 40px
          (`h-10`), Time's own 226×32 button first and Repeat's own
          directly below it, no divider between the two (Todoist's own
          screenshot shows none), replacing the old side-by-side row. */}
        <div className="flex shrink-0 flex-col">
          {/*
            Gated on `dateDay !== null` for the identical reason the
            former inline checkbox was: there is no time-of-day to attach
            to an unset date. `alwaysDated` (this popover's own doc
            comment above) is the one deliberate escape hatch — Reschedule
            has no single `dateDay` of its own to gate on, but every
            Overdue Task it applies to already carries a real day.
          */}
          {(dateDay !== null || alwaysDated) && (
            <div className="relative flex h-10 shrink-0 items-center">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setTimeDialogOpen(true)}
                // `aria-label` pins the accessible name to "Time" even once
                // the visible text becomes the value ("21:00") below —
                // every existing Time-dialog test in this file finds this
                // button `{ name: "Time" }` regardless of whether a value is
                // set, and Todoist's own picker keeps the identical control
                // labelled "Time" either way (the value augments it, the
                // clear button below removes the value, neither renames the
                // control itself).
                aria-label="Time"
                className="h-8 w-[226px] justify-start gap-2 rounded-[5px] border px-2 font-normal"
                style={{
                  borderColor: "var(--td-schedule-field-border)",
                  color: "var(--td-schedule-field-text)",
                }}
              >
                <Clock className="size-4" />
                {dateTime ?? "Time"}
              </Button>
              {dateTime !== null && (
                <button
                  type="button"
                  aria-label="Clear time"
                  onClick={(event) => {
                    // Stops the click from also reaching the Time button
                    // underneath it (they overlap at this corner) and
                    // opening the dialog it exists to avoid — clearing is
                    // meant to be a one-click affordance, not a shortcut
                    // into the dialog it also happens to be inside of.
                    event.stopPropagation();
                    onSetTime(null);
                  }}
                  className="-translate-y-1/2 absolute top-1/2 right-2 rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
                >
                  <X className="size-3.5" />
                </button>
              )}
            </div>
          )}

          {showRepeatControl && (
            <div className="flex h-10 w-fit shrink-0 items-center gap-0.5">
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
                    className={cn(
                      "h-8 justify-start gap-2 rounded-[5px] border px-2 font-normal",
                      // Issue #436's own measured empty-state width (226px) —
                      // widened to fit content (`w-fit`) instead once a rule
                      // is active, so the standalone `Clear recurrence`
                      // button below still has the two-part control's own
                      // pre-#436 room to sit beside it rather than wrap or
                      // overflow the card. Todoist's own active-recurrence
                      // frame was never measured for this ticket.
                      activeRecurrence === null ? "w-[226px]" : "w-fit",
                    )}
                    style={{
                      borderColor: "var(--td-schedule-field-border)",
                      color: "var(--td-schedule-field-text)",
                    }}
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

  // Computed inline, during render — not in an effect — so it is already
  // correct on the very first render `open` is ever `true` for, before
  // `PopoverContent` (so Radix's own `useFloating`) has mounted at all.
  // This is issue #440's own real-browser fix, not a defensive extra: see
  // this file's own header comment above `useLayoutEffect` for why a LATER
  // prop change can't be relied on to reach the screen without a frame's
  // worth of lag. Reading `triggerEl.getBoundingClientRect()` here, during
  // render rather than in an effect, is deliberate and safe: it's a pure
  // read (nothing here writes to the DOM), so a render React throws away
  // without committing (Strict Mode's double-invoke, an interrupted
  // concurrent render) costs nothing beyond the read itself, and `open`
  // can only ever become `true` from a `trigger` that's already on screen
  // — `trigger` renders unconditionally, above, so there is no "too early"
  // case where this reads a trigger that doesn't exist yet.
  const displayPlacement =
    placement ??
    (open && triggerEl !== null
      ? computeSchedulePopoverPlacement(
          triggerEl.getBoundingClientRect(),
          lastMeasuredCardSize.current ?? cardSizeFromCssTokens(),
          { width: window.innerWidth, height: window.innerHeight },
        )
      : null);

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
        // intervening `await`) never observes resolve; `displayPlacement`
        // above has no such lag, so asserting against these two attributes
        // instead is what actually lets a test see this component's own
        // choice rather than racing floating-ui's.
        data-side={displayPlacement === null ? undefined : displayPlacement.side}
        data-align-offset={displayPlacement === null ? undefined : displayPlacement.alignOffset}
        side={displayPlacement?.side ?? "bottom"}
        align="start"
        sideOffset={displayPlacement?.sideOffset ?? 0}
        alignOffset={displayPlacement?.alignOffset ?? 0}
        avoidCollisions={false}
        // Issue #436's own fixed frame: no `gap-*` between children — the
        // dividers between sections (`bg-[color:var(--td-popover-divider)]`
        // 1px strips, inline in `scheduleFields`) supply the visual
        // separation Todoist's own screenshots show, so a flex gap on top
        // of them would double it. `px-3 py-5` is what turns the measured
        // 250×555 card into exactly that: 12px of horizontal padding each
        // side leaves 226px of content width — the same 226px Time/Repeat
        // are measured at — and 20px top/bottom padding is what the
        // section heights below (36 input + 3×1 dividers + 160 five-option
        // quick options + 236 calendar + 40 Time + 40 Repeat = 515) need
        // added to reach 555. `flex-col` is also load-bearing for
        // `min-h-0 flex-1 overflow-y-auto` below (`scheduleFields`'s own
        // comment on that scroll region): a `flex-1` child only actually
        // shrinks to make its parent's `max-height` real, rather than
        // pushing that parent taller, inside a flex container.
        className="flex flex-col px-3 py-5 text-sm"
        style={{
          width: "var(--td-popover-width)",
          // Issue #436's own real-browser follow-up (`--td-popover-max-
          // height`'s own comment in index.css): a CEILING the card's real
          // content — pinned input above, one scrolling region below —
          // sizes under, not a floor forcing every state to 555 regardless
          // of how many quick options are actually showing.
          maxHeight: "var(--td-popover-max-height)",
          borderRadius: "var(--td-popover-radius)",
          background: "var(--td-popover-background)",
          border: "1px solid var(--td-popover-border)",
          boxShadow: "var(--td-popover-shadow)",
          // Defensive only, at this point — `displayPlacement`'s own
          // comment above: with the first `side`/`alignOffset` Radix ever
          // sees already correct, its own off-page trick (`components/ui/
          // popover.tsx`'s own header comment) is what actually keeps a
          // freshly-mounted card from ever being seen in the wrong spot,
          // not this. Kept anyway for the one case `displayPlacement` still
          // can't estimate (`displayPlacement`'s own comment on why that's
          // practically unreachable) — hidden, not `display: none` (which
          // would make `offsetWidth`/`offsetHeight` read 0 and defeat the
          // very measurement this gates), for exactly as long as there is
          // no placement at all yet to show, estimated or measured.
          visibility: displayPlacement === null ? "hidden" : "visible",
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
  iconColorVar,
  label,
  hint,
  onClick,
}: {
  icon: typeof CalendarDays;
  /** A bare `--td-schedule-*` custom-property name (no `var(...)` wrapper) — read via `style`, not a class, the same convention `overdue-reschedule-action.tsx`'s own header comment already documents for this app's `--td-*` colour consumers. */
  iconColorVar: string;
  label: string;
  hint: string | null;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={onClick}
      // `rounded-none`: Todoist's own measured row has no radius, unlike
      // `ghost`'s default. `hover:bg-*` is repeated under `dark:` for the
      // identical reason the calendar day button's own override needs
      // it (that call site's own comment, above): `ghost`'s own
      // `dark:hover:bg-muted/50` (button.tsx) is a two-class selector
      // that outranks a bare `hover:` override by specificity regardless
      // of source order, so only an explicit `dark:` twin actually wins
      // in dark theme.
      className="h-8 w-full justify-between rounded-none px-2 font-normal hover:bg-[color:var(--td-schedule-option-hover)] dark:hover:bg-[color:var(--td-schedule-option-hover)]"
      // Explicit, rather than left to the browser's own name-from-content
      // algorithm: the label and hint sit in two sibling `<span>`s with no
      // literal whitespace between them in the DOM, which concatenates to
      // "TodayThu" (verified against this file's own test suite) instead
      // of the visually-obvious "Today Thu" a sighted reader sees.
      aria-label={hint === null ? label : `${label} ${hint}`}
    >
      <span className="flex items-center gap-2">
        <Icon className="size-4" style={{ color: `var(${iconColorVar})` }} />
        <span
          className="text-[13px] font-medium leading-6"
          style={{ color: "var(--td-schedule-option-label)" }}
        >
          {label}
        </span>
      </span>
      {hint !== null && (
        <span className="text-[13px]" style={{ color: "var(--td-schedule-option-hint)" }}>
          {hint}
        </span>
      )}
    </Button>
  );
}
