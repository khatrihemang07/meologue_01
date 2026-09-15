/**
 * Renders one Entry's body and metadata — its clock time, its not-yet-synced
 * marker. Extracted out of history.tsx (ticket 7) because Reflection's
 * Grounding disclosure needs to render an Entry too, and an Entry shown as
 * Grounding and the same Entry shown in History are the same thing: any
 * visual drift between the two would be a lie about the data. History and
 * Reflection both import from here rather than each keeping their own copy.
 */
import type { Entry } from "@meologue/core";
import { type MouseEvent, memo, type ReactNode, useState } from "react";
import { Link } from "react-router";
import { EntryHoverActions } from "@/components/entry-actions";
import { entryProse } from "@/components/entry-prose";
import { TaskScheduleChips } from "@/components/task-schedule-chips";
import { useDayHasEntries } from "@/hooks/use-day-has-entries";
import { useEntryReference } from "@/hooks/use-entry-reference";
import {
  deviceUtcOffsetMinutes,
  entryDayKey,
  formatClockTime,
  formatDaySeparator,
} from "@/lib/entry-day";
import { formatAbsoluteTime } from "@/lib/entry-time";
import { entryBlocksToText, parseEntryMarkdown } from "@/lib/inline-markdown";
import { hoverCapable } from "@/lib/pointer";
import { cn } from "@/lib/utils";
import { useEntryStore } from "@/pages/entry-store-layout";

/**
 * One `[[YYYY-MM-DD]]` date Reference (issue #142), rendered by
 * `entryBodyContent` below wherever `entryProse` (entry-prose.tsx) finds
 * one — `entryProse` is an Entry's own path onto `inlineProse`'s walker
 * (issue #148), which is what actually parses the mark.
 *
 * A component of its own, not a plain render callback: `useDayHasEntries`
 * needs its own hook state per Reference, and a body can carry more than
 * one date Reference to different days at once. Giving each occurrence its
 * own component instance — one `refs.date` invocation per node,
 * inline-prose.tsx's own contract — is what keeps that state properly
 * isolated per Reference regardless of how many appear in one Entry.
 *
 * Reads `dayHasEntries` off `useEntryStore()` rather than taking it as a
 * prop threaded down through EntryRow/EntryBubble/History: every renderer
 * of an Entry's body (History's thread, Grounding's list) already sits
 * inside EntryStoreLayout's outlet (entry-store-layout.tsx's own routes
 * comment), so the context is always there to read, and threading it as a
 * prop would touch every caller between here and there for a concern only
 * this one node type has.
 */
function DateReferenceLink({ date, raw }: { date: string; raw: string }) {
  const { dayHasEntries } = useEntryStore();
  const hasEntries = useDayHasEntries(dayHasEntries, date);

  // Both "still resolving" (`undefined`) and "confirmed empty" (`false`)
  // render the same way: the literal text a Reference to an unresolvable
  // day always was, before this ticket existed. Only a confirmed `true`
  // upgrades it to a link — see use-day-has-entries.ts's own comment for
  // why flashing a link into existence before that would be worse than
  // waiting for it.
  if (hasEntries !== true) {
    return raw;
  }

  return (
    // The visible text stays the literal mark the user typed — the
    // decision every unresolved-or-resolved Reference alike follows
    // (inline-prose.tsx) — while the accessible name says where the link
    // actually goes, since "[[2026-08-28]]" read aloud names a mark, not a
    // destination.
    <Link
      to={`/composer?d=${date}`}
      aria-label={`Open ${date} in History`}
      className="underline underline-offset-2"
    >
      {raw}
    </Link>
  );
}

/** How much of a chip's target's opening survives before it is cut off with an ellipsis (issue #143). */
const ENTRY_SNIPPET_MAX_LENGTH = 40;

/**
 * The opening of an Entry's text, flattened to one line with no formatting
 * and no list structure — a chip has room for a preview, not the whole
 * shape of the target's own prose.
 *
 * Goes through `parseEntryMarkdown`/`entryBlocksToText` (inline-markdown.ts)
 * rather than `entryBodyContent`/`entryProse` below: those render the
 * target's own marks and lists — bold text stays bold, a nested Reference
 * resolves to its own chip, `- milk` becomes a real bullet — which is right
 * for reading that Entry on its own terms, but wrong for a two-line preview
 * sitting inside a Reference already carrying its own formatting (the day
 * label, the chip's border), and `entryBlocksToText` is what keeps a `- `/
 * `1. ` marker from leaking into that preview as a literal character
 * instead of becoming space-joined words like the rest of the flattened
 * text. Collapsing to plain text here also means a Reference nested inside
 * the target's body never recurses into a second live lookup just to build
 * a preview of the first one.
 *
 * Exported for `composer.tsx`'s own inline `[[` picker (issue #144): the
 * same "an Entry's id names nothing a reader can use" reasoning that keeps
 * this out of `EntryReferenceLink`'s rendered chip also keeps it out of the
 * picker's list of candidates a reader is choosing *from* — a preview of
 * the target's opening words, never its uuid, either place.
 */
export function entrySnippet(body: string): string {
  const flat = entryBlocksToText(parseEntryMarkdown(body)).replace(/\s+/g, " ").trim();
  if (flat.length <= ENTRY_SNIPPET_MAX_LENGTH) {
    return flat;
  }
  return `${flat.slice(0, ENTRY_SNIPPET_MAX_LENGTH).trimEnd()}…`;
}

/**
 * One `[[e:<uuid>]]` Entry Reference (issue #143), rendered by
 * `entryBodyContent` below wherever `entryProse` (entry-prose.tsx) finds
 * one — the Entry chip's own analogue of `DateReferenceLink` just above,
 * following the same shape for the same reasons (see that component's own
 * comment for why this needs to be a component of its own, and why it
 * reads its probe off `useEntryStore()` instead of taking it as a prop).
 *
 * Resolves live, through `useEntryReference` (a TanStack Query keyed on the
 * target's id — see that hook and `entryReferenceQueryKey`'s own comments),
 * rather than from a snapshot taken when this Entry was captured: ADR 0042's
 * "editing a referred-to Entry updates every chip pointing at it." `target
 * === undefined` folds together every unresolvable cause the chip can't
 * tell apart — removed, not yet Synced to this Device, or the probe hasn't
 * settled yet — into the one rule a date Reference already follows: the
 * literal text the user typed, not interactive.
 *
 * The chip itself is an inline `<a>`, `inline-flex` (never `display:block`)
 * — it renders inline, wherever the parse finds the mark, inside whichever
 * body element the caller supplies (`EntryBody`'s `<p>` in the list,
 * `EntryBubble`'s own `<p>` in the thread — see that file's own comment for
 * why `BubbleMeta` no longer needs the body to stay one line box; issue
 * #149 moved its clock off the float that used to require that).
 *
 * Deliberately renders the target's own snippet through `entrySnippet`
 * above rather than `entryBodyContent`'s `query`-aware highlighting: the
 * Search match that produced `query` matched THIS Entry's body, never the
 * target's, and this component is never even handed `query` (inline-
 * prose.tsx's `ReferenceRenderers.entry` signature carries only `entryId`
 * and `raw`) — so a match inside the target's own words structurally cannot
 * paint a `<mark>` in here.
 */
function EntryReferenceLink({ entryId, raw }: { entryId: string; raw: string }) {
  const { getEntry } = useEntryStore();
  const target = useEntryReference(getEntry, entryId);

  if (target === undefined) {
    return raw;
  }

  const offsetMinutes = deviceUtcOffsetMinutes();
  const dayKey = entryDayKey(target.createdAt, offsetMinutes);
  const todayKey = entryDayKey(new Date().toISOString(), offsetMinutes) ?? "";
  const dayLabel = dayKey === null ? null : formatDaySeparator(dayKey, todayKey);
  const snippet = entrySnippet(target.body);

  return (
    // The visible content is the target's day and a snippet of its words,
    // not the literal `[[e:...]]` mark — unlike a date Reference, which
    // keeps its mark visible and only changes what it links to. A day
    // Reference's own text (`2026-08-28`) already tells the reader where it
    // goes; an Entry's id is opaque, so showing it verbatim would say
    // nothing a reader could use, and the whole point of a chip is to show
    // what's actually over there instead.
    <Link
      to={`/composer?e=${entryId}`}
      aria-label={`Open Entry from ${dayLabel ?? "an earlier day"} in History`}
      // `max-w` bounds the chip so `truncate` on its snippet span has a
      // width to truncate against, rather than growing to whatever the
      // target's snippet measures. It used to carve out an extra 4.5rem to
      // leave room for `BubbleMeta`'s right-floated clock on the same line
      // (issue #149's own float removed that need): an inline-flex box is
      // atomic and cannot be broken across lines, so with the clock still
      // sharing the line, letting the chip grow to the body's full width
      // left the float no room and dropped the clock to a line of its own —
      // ADR 0036's defect exactly. The clock now sits on its own row below
      // the body (`BubbleMeta`'s own comment), so nothing on the chip's own
      // line still needs to be shared with it.
      className="mx-0.5 inline-flex max-w-full items-baseline gap-1.5 rounded-full border border-border bg-background/60 px-2 align-baseline text-xs leading-normal underline decoration-dotted underline-offset-2"
    >
      {dayLabel !== null && <span className="shrink-0 font-medium">{dayLabel}</span>}
      <span className="truncate">{snippet}</span>
    </Link>
  );
}

/**
 * One referenced checkbox line (issue #173, ADR 0048) — `entryBodyContent`
 * below wherever `entryProse` (entry-prose.tsx) finds a checkbox item whose
 * entire content is one `[[task:id|label]]` mark, Promotion's own output
 * shape. The checklist's own analogue of `DateReferenceLink`/
 * `EntryReferenceLink` just above, for the same reason those are
 * components of their own rather than plain render callbacks: reading a
 * live Task means reading `useEntryStore()`, and a Hook needs a component
 * to run inside.
 *
 * Unlike an Entry Reference, resolving a Task needs no probe, no query key,
 * and no "still in flight" state at all — `useEntryStore()`'s own `tasks`/
 * `completedTasks` (ADR 0047's `useTasks`, already loaded above every route
 * this component renders under) are the live set of every Task this Device
 * has Synced, so finding one by id is a lookup, not a fetch. `live ===
 * undefined` is this component's one "unresolvable" case, folding together
 * ADR 0048's two real causes — a Task not yet Synced to this Device, and
 * one that was deleted (#174's backfill; `list()`/`listCompleted()` both
 * already exclude a tombstone), into the same rule ADR 0042 already gives a
 * date/Entry Reference: render the cached words, and stay inert. That
 * inertness IS the asymmetric-deletion rule ADR 0048 asks for — deleting a
 * Task leaves this line exactly where it was, as the plain words the
 * reader typed, never silently rewritten or removed on their behalf.
 *
 * **Interactive only where `interactive` says so** — `entryBodyContent`
 * below passes its own `interactive` argument straight through: Grounding
 * (`EntryBody`, which never passes `true`) must stay read-only, and this is
 * the one place that rule has to be enforced for a *referenced* line too,
 * since `renderTaskReference` — unlike `interactive` itself — is always
 * supplied regardless (this component's own read side has nothing to do
 * with editing a past Answer, only the write side does).
 *
 * **Recurring reads the Entry's own cached marker for `checked`, never
 * `live.completedAt`.** A recurring Task's own `completedAt` never becomes
 * non-null (CONTEXT.md's Recurrence entry: the checkbox never "un-ticks
 * itself," and the Task never enters `completedTasks`) — so for a
 * recurring Task, `live.completedAt` can never be the right source for
 * THIS line's own checked state, because every Entry that references the
 * same recurring Task would then read identically regardless of which
 * occurrence was actually finished. The Entry's own cached marker is
 * what's authoritative there instead, exactly because it is pinned to the
 * one moment this Entry was written (ADR 0048's own words: "An Entry line
 * is pinned to a moment, which is exactly what an occurrence record is").
 * Unlike before issue #231 (ADR 0074), this checkbox never writes that
 * pin itself any more — see `handleCheckboxClick` below — so there is no
 * "cannot be reopened" refusal left to make here either: a finished
 * occurrence's own checkbox stays exactly as openable as an unfinished
 * one, because opening was never the thing ADR 0048's "cannot be
 * reopened, rescheduled or reordered" (CONTEXT.md's Occurrence entry) was
 * ever about.
 *
 * **Date, Priority and Project (issue #181, criteria 1/2) read off `live`
 * — but Date gets the identical recurring exception `resolvedChecked`
 * already needs, Priority and Project don't.** `resolvedChecked` above
 * prefers the Entry's own cached marker for a recurring Task, because the
 * checked bit answers "was THIS occurrence finished" and only the Entry
 * pins which occurrence that was. Priority and Project have no such
 * question to answer — they are attributes of the Task's current series,
 * not of one past occurrence, so the live value is simply correct
 * (ADR 0048 mints the mark with a cached `label`/`checked` and nothing
 * else — see inline-markdown.ts's `EntryTaskMarker` — so there is no
 * second, historical copy of either for a cached mark to have carried in
 * the first place). Date is NOT in that category: `advanceRecurringTask`
 * (use-tasks.ts, still fired from Todo/the Composer's own Task overlay —
 * see `composer-page.tsx`'s `handleCompleteTask`, not from here any more)
 * moves `date` on to the NEXT occurrence the instant a recurring Task
 * completes, so once `recurring && resolvedChecked` (this line already
 * reads as a finished record), `live.date` answers "when is this series
 * next due," never "when was THIS occurrence" — `TaskScheduleChips`'s own
 * `hideDate` is passed `true` exactly then, suppressing the one chip that
 * would otherwise claim a day that isn't this occurrence's own.
 * `TaskScheduleChips` is only ever handed `live`, and only once
 * `live !== undefined` — criterion 5's "leads nowhere" extends to the
 * chips too: an unresolved reference shows no chips at all, exactly as it
 * shows no live label.
 *
 * **Clicking the words — or, since issue #231 (ADR 0074), the checkbox
 * beside them — opens the Task, only where `onOpenTask` says so.**
 * Threaded through unwrapped from `entryBodyContent` below, `onOpenTask`
 * is only ever supplied by History's own call (composer-page.tsx), never
 * by `EntryBody` (Grounding): Grounding must stay a read-only view of
 * what an Answer was based on, and a door onto a Task's own detail view
 * would let that look negotiable. Gated additionally on
 * `live !== undefined` — criterion 5's own words, "a reference to a Task
 * this Device does not have shows its words and leads nowhere," meant
 * literally: no link, not a link to nothing, on the one row type
 * composer-page.tsx's activity log exists to show correctly (a prior
 * ticket in this arc left exactly that gap for a different row type; this
 * component does not repeat it here). Deliberately NOT also gated on
 * `interactive` — opening was never that flag's concern even before issue
 * #231 (it only ever gated ticking, `canToggle`'s own job below, which
 * this ticket retired entirely), and a checkbox that now does the
 * identical thing the words already do has no reason to answer to a
 * different flag than they do.
 */
function TaskReferenceItem({
  taskId,
  label,
  checked,
  content,
  onOpenTask,
}: {
  taskId: string;
  label: string;
  checked: boolean;
  content: ReactNode;
  /**
   * `TaskReferenceProps` (entry-prose.tsx) still promises every renderer
   * these two offsets, and `entryBodyContent` below still passes them
   * straight through (via `{...node}`) along with `body`/`entryId`/
   * `interactive` — this component simply has nothing left to do with any
   * of the four. Issue #231 (ADR 0074) retired the one thing it ever used
   * them for: splicing a recurring Task's own occurrence marker in place
   * (`setTaskMarkerChecked`, toggle-task.ts) from a now-deleted
   * `handleChange`. Left in this type, and in `entryBodyContent`'s own
   * call below, rather than threaded out of the shared contract — the
   * same "kept, not ripped out" call `EntryBubbleProps.onToggleTask`
   * already makes (entry-bubble.tsx's own doc comment) for the identical
   * reason: narrowing a contract several callers share because its one
   * current consumer stopped needing part of it is a bigger, riskier
   * change than this ticket asks for.
   */
  markerFrom: number;
  markerTo: number;
  body: string;
  entryId: string | undefined;
  interactive: boolean;
  /** Opens the Task over the Composer (issue #181), and — since issue #231 (ADR 0074) — is what a click on this line's own checkbox does too. See this function's own doc comment for the full gating rule. */
  onOpenTask: ((taskId: string) => void) | undefined;
}) {
  const { tasks, completedTasks, projects } = useEntryStore();
  const live =
    tasks.find((task) => task.id === taskId) ?? completedTasks.find((task) => task.id === taskId);
  const recurring = live !== undefined && live.dateString !== null;
  const resolvedChecked = live === undefined || recurring ? checked : live.completedAt !== null;
  const resolvedLabel = live !== undefined ? live.content : label;
  // The one door left onto this line at all (issue #231, ADR 0074) — see
  // this function's own doc comment for the full rule this mirrors from
  // the label button just below.
  const canOpen = live !== undefined && onOpenTask !== undefined;

  function handleCheckboxClick(event: MouseEvent<HTMLInputElement>) {
    // A checkbox `<input>` ticks itself natively the instant a click
    // lands, before React (or this handler) ever runs — `preventDefault`
    // is what stops that native check/uncheck, so the box never visibly
    // flips before snapping back to whatever `resolvedChecked` says a
    // moment later. What a click does instead — the only thing it does
    // now — is open the Task, identically to a click on the words.
    // `canOpen` isn't relied on directly here (TypeScript can't carry a
    // `const` boolean's narrowing of `onOpenTask` into a nested function
    // — the same reason the retired `handleChange` rechecked `entryId`
    // explicitly rather than trusting `canToggle`), so this re-checks the
    // same two conditions `canOpen` is built from.
    event.preventDefault();
    if (live === undefined || onOpenTask === undefined) {
      return;
    }
    onOpenTask(taskId);
  }

  return (
    // Issue #242's decision, recorded here rather than only in the commit
    // message: a Task's schedule chip is metadata ABOUT the Task, not part
    // of its own words, so it must never sit inside the `<div>` that
    // `index.css`'s completed-checklist-item rule decorates (the comment
    // above that rule explains why that rule strikes every descendant of
    // that `<div>` unconditionally — it has no way to carve out one
    // descendant, so the only way to exempt the chip is to keep it out of
    // that `<div>`'s subtree entirely). A `flex` row can't do that AND keep
    // the chips visually under the label — a second flex child sits beside
    // the first, not below it — so this is a two-row `grid` instead:
    // column 1 is the checkbox (row 1 only), column 2 carries the label
    // `<div>` in row 1 (still the exact `<div>` the structural selector
    // reaches, still decorated, still catches bold/italic/a Reference
    // chip/Search highlighting inside `content` exactly as before) and
    // `TaskScheduleChips` in row 2 — its own root is a `<span>`, which the
    // selector's `~ div` never matches regardless of position, so no
    // `:not()` escape hatch is needed. History's `DayTasksRow` reaches the
    // same outcome by keeping its own wrapper a `<span>` and opting the
    // title in explicitly with `.completed-task-text`; this is the
    // equivalent move for a shape that has no such wrapper to repurpose.
    <li className="-ml-5 grid list-none grid-cols-[auto_1fr] items-baseline gap-x-1.5 gap-y-0.5">
      <input
        type="checkbox"
        checked={resolvedChecked}
        disabled={!canOpen}
        // Controlled by `checked` above with no `onChange` — `readOnly`
        // is what tells React that's deliberate rather than a missing
        // handler (the same warning `disabled` alone already suppresses
        // for entry-prose.tsx's own bare checkbox; this one isn't always
        // disabled, so it needs the flag explicitly). `onClick`, not
        // `onChange`: this box no longer has a checked *value* of its own
        // to change, only a click to react to.
        readOnly
        onClick={canOpen ? handleCheckboxClick : undefined}
        aria-label={resolvedLabel || (resolvedChecked ? "Checked" : "Unchecked")}
        className="col-start-1 row-start-1 mt-[0.2em] shrink-0 accent-current"
      />
      <div className="col-start-2 row-start-1 min-w-0">
        {/*
          No `whitespace-pre-wrap` on either element below (ADR 0069's
          prefactor) — `EntryBody`'s own wrapper (below) and
          entry-bubble.tsx's bubble body both already set it, and
          `white-space` inherits, so this is one caller fewer that would
          otherwise need to remember to carry it. `mt-0`, not `first:mt-0
          mt-1`: a block boundary contributes no margin of its own now
          (entry-prose.tsx's `BLOCK_SPACING`, same reasoning, same value) —
          this label sits in exactly the position a `"prose"` block would.
        */}
        {canOpen ? (
          <button
            type="button"
            onClick={() => onOpenTask(taskId)}
            className="block w-full text-left mt-0 hover:underline"
          >
            {resolvedLabel}
          </button>
        ) : (
          <p className="mt-0">{resolvedLabel}</p>
        )}
        {content}
      </div>
      {live !== undefined && (
        <TaskScheduleChips
          task={live}
          projects={projects}
          hideDate={recurring && resolvedChecked}
          className="col-start-2 row-start-2"
        />
      )}
    </li>
  );
}

/**
 * An Entry's words with the Search query highlighted, and — since issue
 * #152 — its own block structure (a list) when it has one. No wrapper of
 * its own here either way; the caller still supplies the box.
 *
 * Split out of `EntryBody` for `entry-bubble.tsx`, whose own wrapper needs a
 * different className than `EntryBody`'s (the text-size scale variable,
 * not `EntryBody`'s `flex-1`) — the split is about the wrapper each surface
 * supplies, not about staying unwrapped. (Before issue #149 it *was* the
 * latter: a bubble's clock was a right float sharing the body's last line,
 * which needs a line box to land on, so the body had to stay unwrapped
 * there specifically. `BubbleMeta`'s own comment has the current shape.)
 *
 * Shared rather than reimplemented so the *words* still cannot drift between
 * History and Grounding, which is what `EntryBody`'s own extraction was for
 * — including inside a list item: `refs.date`/`refs.entry` below reach a
 * Reference wherever `entryProse`'s walk finds one, list item or not.
 *
 * Renders through `entryProse` (entry-prose.tsx), an Entry's own path onto
 * the shared parser (issue #148) — every other prose surface still calls
 * `inlineProse` directly, and stays inline-only. `entryProse` used to be a
 * pure pass-through; issue #152 is the divergence issue #148 built this
 * seam for.
 *
 * `interactive` (issue #153, retired to a plain boolean by issue #231/ADR
 * 0074) no longer reaches a *bare* checkbox at all — `entry-prose.tsx`'s
 * own `renderListItem` renders one permanently disabled now, since a bare
 * checkbox has no Task to open (that file's own module comment has the
 * full argument). This parameter's one remaining job is gating a
 * *referenced* line's own interactivity, just below.
 *
 * The fourth argument (issue #173) is always `TaskReferenceItem` above,
 * regardless of `interactive` — unlike a bare checkbox, a referenced
 * line's own read side (the live label/checked state `TaskReferenceItem`
 * resolves) is not the write-gated half of this feature, so both of
 * `entryBodyContent`'s callers get it: Grounding sees a referenced
 * checkbox's true, current state exactly as it already sees a renamed
 * Entry Reference's target update live. Whether it can also be TICKED is
 * gated separately, by `entryId`/`interactive` below — `TaskReferenceItem`
 * itself reads `interactive` as "the same permission a bare checkbox used
 * to have," so Grounding (which never passes `true`) stays exactly as
 * read-only for a referenced line as it already is for a bare one, with no
 * second flag for a caller to remember to withhold.
 *
 * `entryId` (issue #173) is the Entry `body` belongs to — threaded through
 * only so `TaskReferenceItem` can splice `body` back via `editEntry` when
 * ticking a *recurring* Task's own occurrence (see that component's own
 * doc comment for why that one case writes the Entry directly rather than
 * going through `completeTask`/`uncompleteTask`'s fan-out). `undefined`
 * for `EntryBody`'s own call below, which never passes `interactive`
 * either — neither flows independently of the other in practice, but they
 * are two separate parameters rather than one, since `interactive`
 * (whether ticking is permitted at all) and `entryId` (what to splice if
 * it is) are two different questions a caller could in principle answer
 * separately.
 *
 * `onOpenTask` (issue #181) passes straight through to `TaskReferenceItem`,
 * unwrapped — it needs no per-marker offsets, only a Task id, so there is
 * nothing for this function to adapt between its own signature and
 * `TaskReferenceItem`'s. `undefined` for every caller that doesn't supply
 * one (`EntryBody`'s own call below, and every test in this file's own
 * suite), which is what keeps a referenced Task's words unclickable — see
 * `TaskReferenceItem`'s own doc comment for why that's gated independently
 * of `interactive`.
 */
export function entryBodyContent(
  body: string,
  query: string,
  interactive = false,
  entryId?: string,
  onOpenTask?: (taskId: string) => void,
): ReactNode {
  return entryProse(
    body,
    query,
    {
      date: (node, key) => <DateReferenceLink key={key} date={node.date} raw={node.raw} />,
      entry: (node, key) => <EntryReferenceLink key={key} entryId={node.entryId} raw={node.raw} />,
    },
    (node, key) => (
      <TaskReferenceItem
        key={key}
        {...node}
        body={body}
        entryId={entryId}
        interactive={interactive}
        onOpenTask={onOpenTask}
      />
    ),
  );
}

/**
 * A `<div>`, not a `<p>` (issue #152): `entryBodyContent` can render a
 * `<ul>`/`<ol>` alongside its own `<p>`s when the body holds a list, and a
 * list cannot validly nest inside a `<p>`. `whitespace-pre-wrap` lives here
 * — this wrapper's own root, not on any `entryProse`-generated child (ADR
 * 0069's prefactor collapsed what used to be three separate copies of this
 * class — this one, one on `entryProse`'s own `<p>`, and one on
 * `entry-bubble.tsx`'s bubble body — down to one owner per surface;
 * `entry-bubble.tsx`'s own wrapper is the other, since the two never wrap
 * the same tree at once). `white-space` inherits, so every `<p>`/`<button>`
 * underneath — a `"prose"` block, a referenced Task's own label
 * (`TaskReferenceItem`, above) — still preserves the words exactly as
 * typed (multiple spaces, and a soft break's own literal `\n`,
 * `inline-markdown.ts`'s `walkEntryInline` "HardBreak" case) with nothing
 * further to set.
 *
 * `EntryBody` is `EntryRow`'s own body, and `EntryRow`'s one remaining
 * caller is `grounding-disclosure.tsx` — Reflection's Grounding, which
 * CONTEXT.md requires to stay a read-only view of what an Answer was based
 * on (the same reason `EntryRowProps.actions` above is never wired for
 * it). Passing no `interactive` here is what keeps a *referenced* checkbox
 * rendered in Grounding disabled (issue #153) — a *bare* one renders
 * disabled unconditionally now regardless of any caller (issue #231, ADR
 * 0074; entry-prose.tsx's own module comment). A tickable/openable box in
 * Grounding would let editing a past Answer relied on look possible, which
 * must not be true. History's own thread renders through `EntryBubble`
 * instead, not `EntryBody`, so this decision only ever governs Grounding.
 */
export function EntryBody({ body, query }: { body: string; query: string }) {
  return <div className="min-w-0 flex-1 whitespace-pre-wrap">{entryBodyContent(body, query)}</div>;
}

/**
 * Edit/Delete/Refer, wired onto a row by history.tsx (ADR 0028 for
 * Edit/Delete, issue #144 for Refer — see EntryRowProps' own `actions`
 * comment for who gets this and who deliberately doesn't). The callbacks
 * that act on the Entry itself take the whole thing, not just its id:
 * Delete's Undo (see use-history.ts) needs the pre-delete body, and the
 * simplest way to get that to the caller is to hand over what this row
 * already has in full, rather than making every caller re-fetch it by id.
 */
export interface EntryRowActions {
  onEdit: (entry: Entry) => void;
  onDelete: (entry: Entry) => void;
  /**
   * Puts a Reference to this Entry into the Composer (issue #144). Required
   * alongside onEdit/onDelete, not a fourth independently-optional field:
   * composer-page.tsx is this bundle's one real source (through
   * history.tsx's own `actions` assembly — see its comment) and always has
   * all three to give, and a caller that forgot one is a type error here
   * rather than a Refer button that silently does nothing.
   */
  onRefer: (entry: Entry) => void;
  /**
   * Opens history.tsx's single shared EntryActionsSheet for this Entry
   * (issue #78) — history.tsx's own sheet-open setter, assembled onto this
   * bundle alongside the callbacks above rather than being a separate prop
   * a caller has to know to pass. composer-page.tsx, the only outside
   * caller, still only ever supplies onEdit, onDelete and onRefer;
   * all-or-nothing (see EntryRowProps' `actions` comment) governs that
   * external trio exactly as before, and history.tsx fills in this last
   * field itself once all three are present.
   *
   * What reaches it changed in #127: a touch device gets there by swiping a
   * bubble left (`use-swipe-actions.ts`), not by tapping one. A tap does
   * nothing now, which is what leaves it free to place a cursor or dismiss a
   * selection the way tapping text anywhere else does — and the
   * tap-vs-long-press timing this file used to carry went with it, because
   * nothing has to tell a quick tap from the click Android's WebView fires
   * at the end of a long-press when neither one opens anything.
   */
  onOpenSheet: (entry: Entry) => void;
}

export interface EntryRowProps {
  entry: Entry;
  /**
   * The active Search query (ticket 39), for highlighting matched terms in
   * this Entry's body. Optional, defaulting to "" — History's own search box
   * is the only caller that ever has one; the Composer footer and
   * Reflection's Grounding disclosure (ticket 7) render this same component
   * with no query of their own and shouldn't have to pass a meaningless one.
   */
  query?: string;
  syncEnabled: boolean;
  /**
   * Wires Edit/Delete onto this row — hover buttons on a hover-capable
   * device, a shared bottom sheet on a touch one (issue #78; ADR 0028 is
   * why Edit/Delete exist on an Entry at all, not how they're exposed
   * here). Undefined by default — deliberately "no actions" rather than
   * "actions, disabled" — so every existing caller of EntryRow is
   * unaffected by this prop's existence: grounding-disclosure.tsx renders
   * Reflection's Grounding, which CONTEXT.md requires to stay a read-only
   * view of what an Answer was based on (offering to edit or delete an
   * Entry from inside that disclosure would let editing a past Answer
   * relied on look possible, and it must not be). Only history.tsx — which
   * the Composer page's own footer History renders through (issue #75
   * removed `/history`'s own page, once the only other caller) — ever
   * passes this, on rows it knows are real History, never Grounding.
   */
  actions?: EntryRowActions;
}

/**
 * The optional half of "Right-click on a pointer device may open the same
 * sheet/menu if that falls out cheaply" — cheap here because `hoverCapable()`
 * is the one check it needs. `preventDefault` only runs behind that gate, so
 * a touch device's long-press (which also dispatches `contextmenu` in most
 * mobile browsers) is never intercepted: this handler simply returns, its
 * default action runs unprevented, and that default action is exactly what
 * raises the platform's own selection handles and system Copy toolbar.
 * Long-press is left alone on every platform, and #127 left it alone again
 * — it is the one gesture the swipe recogniser bails out of rather than
 * competes with.
 */
export function handleRowContextMenu(
  event: MouseEvent,
  actions: EntryRowActions | undefined,
  entry: Entry,
) {
  if (!actions || !hoverCapable()) {
    return;
  }
  event.preventDefault();
  actions.onOpenSheet(entry);
}

// One full-width row (ticket 52, #49's "Discord" variant — no bubble, no
// tails, no left/right split). Each Entry carries its own clock time
// because timestamps are per-Entry rather than clustered (#49); the date
// that time belongs to lives on the day separator above, not here.
//
// No `select-none` anywhere here (issue #78) — that's precisely what the
// old ContextMenuTrigger's `asChild` merged onto this same `<div>`, and
// why Entry text couldn't be dragged to select on any platform. `group` is
// only added when `actions` is present: EntryHoverActions' `group-hover`
// styling needs an ancestor to watch, and a bare row (grounding-
// disclosure.tsx's caller) has nothing depending on it.
//
// No swipe here, and no tap either (#127). This component is what the one
// surface that stayed a LIST renders — Reflection's Grounding disclosure —
// and it deliberately wires no `actions` at all, so a touch affordance here
// would be one nothing can reach. The thread's own bubbles
// (entry-bubble.tsx) are where the gesture lives; what survives here is the
// right-click a mouse already had.
//
// Wrapped in `React.memo` (issue #81): History can render hundreds of
// these, and most re-renders of History itself (a Search keystroke
// narrowing the list, an unrelated Entry's Edit/Delete) leave any given
// row's own props untouched. That only pays off because every prop below
// is now referentially stable across such a render — `entry` and `query`
// come straight through from History's own memoised `groups`/`query`,
// `syncEnabled` is a primitive, and `actions` is history.tsx's own
// `useMemo` (see its comment) rather than an object literal rebuilt per
// render; memoising this component alone, without that, would compare a
// fresh `actions` object against the last one on every single render and
// never actually skip anything.
export const EntryRow = memo(function EntryRow({
  entry,
  query = "",
  syncEnabled,
  actions,
}: EntryRowProps) {
  const time = formatClockTime(entry.createdAt);

  // The hover tooltip's absolute timestamp (ticket 52) is computed lazily,
  // on first hover, rather than for every row on every render (issue #81)
  // — almost no row's tooltip is ever actually shown, so doing this eagerly
  // meant paying for hundreds of `formatAbsoluteTime` calls (a `Date.parse`
  // plus an `Intl.DateTimeFormat#format`, post-fix-1 above) per History
  // render for a value nearly all of them throw away unread. `undefined`
  // means "not computed yet"; once hovered it holds `formatAbsoluteTime`'s
  // real result (including `null`, for the — here unreachable, since `time`
  // above already gates on the same parse succeeding — case of an
  // unparseable `createdAt`), so a second hover doesn't recompute it.
  //
  // This only costs the mouse-hover path anything to compute, which is
  // exactly who reads a `title` tooltip: no keyboard-only or
  // screen-reader-only path relied on this attribute before this change
  // either, since a bare `title` was never announced or focusable to begin
  // with — nothing accessible is lost by deferring the *value* behind it.
  const [absoluteTime, setAbsoluteTime] = useState<string | null | undefined>(undefined);
  const revealAbsoluteTime = () => {
    if (absoluteTime === undefined) {
      setAbsoluteTime(formatAbsoluteTime(entry.createdAt));
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: onContextMenu here is a pointer-only progressive enhancement (handleRowContextMenu no-ops without hover — see its own comment) layered on a row that must stay plain, selectable text, not a control; giving it an interactive role would contradict that and would duplicate the two real <button>s below.
    <div
      data-slot="entry-row"
      className={cn("flex items-baseline gap-3 py-1.5 text-sm text-foreground", actions && "group")}
      onContextMenu={actions ? (event) => handleRowContextMenu(event, actions, entry) : undefined}
    >
      <EntryBody body={entry.body} query={query} />
      <div className="flex shrink-0 items-center gap-2">
        {time !== null && (
          <time
            dateTime={entry.createdAt}
            title={absoluteTime ?? undefined}
            onMouseEnter={revealAbsoluteTime}
            className="shrink-0 text-xs text-muted-foreground tabular-nums"
          >
            {time}
          </time>
        )}
        {syncEnabled && entry.seq === null && (
          <span
            role="img"
            aria-label="Not yet synced"
            title="Not yet synced"
            className="text-muted-foreground"
          >
            ●
          </span>
        )}
      </div>
      {actions && (
        <EntryHoverActions
          entry={entry}
          onEdit={actions.onEdit}
          onDelete={actions.onDelete}
          onRefer={actions.onRefer}
        />
      )}
    </div>
  );
});
