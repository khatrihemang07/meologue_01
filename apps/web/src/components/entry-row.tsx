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
import { EntryHoverActions, hoverCapable } from "@/components/entry-actions";
import { entryProse } from "@/components/entry-prose";
import { useDayHasEntries } from "@/hooks/use-day-has-entries";
import { useEntryReference } from "@/hooks/use-entry-reference";
import {
  deviceUtcOffsetMinutes,
  entryDayKey,
  formatClockTime,
  formatDaySeparator,
} from "@/lib/entry-day";
import { formatAbsoluteTime } from "@/lib/entry-time";
import { inlineNodesToText, parseInlineMarkdown } from "@/lib/inline-markdown";
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
 * — a chip has room for a preview, not the whole shape of the target's own
 * prose.
 *
 * Goes through `parseInlineMarkdown`/`inlineNodesToText` (inline-markdown.ts)
 * rather than `entryBodyContent`/`entryProse` below: those render the
 * target's own marks — bold text stays bold, a nested Reference resolves to
 * its own chip — which is right for reading that Entry on its own terms, but
 * wrong for a two-line preview sitting inside a Reference already carrying
 * its own formatting (the day label, the chip's border). Collapsing to
 * plain text here also means a Reference nested inside the target's body
 * never recurses into a second live lookup just to build a preview of the
 * first one.
 *
 * Exported for `composer.tsx`'s own inline `[[` picker (issue #144): the
 * same "an Entry's id names nothing a reader can use" reasoning that keeps
 * this out of `EntryReferenceLink`'s rendered chip also keeps it out of the
 * picker's list of candidates a reader is choosing *from* — a preview of
 * the target's opening words, never its uuid, either place.
 */
export function entrySnippet(body: string): string {
  const flat = inlineNodesToText(parseInlineMarkdown(body)).replace(/\s+/g, " ").trim();
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
 * An Entry's words with the Search query highlighted, as inline content and
 * nothing else — no block wrapper of its own.
 *
 * Split out of `EntryBody` for `entry-bubble.tsx`, whose own `<p>` needs a
 * different className than `EntryBody`'s (the text-size scale variable,
 * not `EntryBody`'s `flex-1`) — the split is about the wrapper each surface
 * supplies, not about staying unwrapped. (Before issue #149 it *was* the
 * latter: a bubble's clock was a right float sharing the body's last line,
 * which needs a line box to land on, so the body had to stay unwrapped
 * there specifically. `BubbleMeta`'s own comment has the current shape.)
 *
 * Shared rather than reimplemented so the *words* still cannot drift between
 * History and Grounding, which is what `EntryBody`'s own extraction was for.
 *
 * Renders through `entryProse` (entry-prose.tsx), an Entry's own path onto
 * the shared walker (issue #148) — every other prose surface still calls
 * `inlineProse` directly. `entryProse` is a pure pass-through today; the
 * seam exists so an Entry's body can later gain block structure a Digest
 * must never see, without touching what any other surface renders through.
 */
export function entryBodyContent(body: string, query: string): ReactNode {
  return entryProse(body, query, {
    date: (node, key) => <DateReferenceLink key={key} date={node.date} raw={node.raw} />,
    entry: (node, key) => <EntryReferenceLink key={key} entryId={node.entryId} raw={node.raw} />,
  });
}

export function EntryBody({ body, query }: { body: string; query: string }) {
  return <p className="min-w-0 flex-1 whitespace-pre-wrap">{entryBodyContent(body, query)}</p>;
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
