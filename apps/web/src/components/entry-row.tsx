/**
 * Renders one Entry's body and metadata — its clock time, its not-yet-synced
 * marker. Extracted out of history.tsx (ticket 7) because Reflection's
 * Grounding disclosure needs to render an Entry too, and an Entry shown as
 * Grounding and the same Entry shown in History are the same thing: any
 * visual drift between the two would be a lie about the data. History and
 * Reflection both import from here rather than each keeping their own copy.
 */
import type { Entry } from "@meologue/core";
import { type MouseEvent, memo, useState } from "react";
import { EntryHoverActions, hoverCapable } from "@/components/entry-actions";
import { formatClockTime } from "@/lib/entry-day";
import { formatAbsoluteTime } from "@/lib/entry-time";
import { highlightMatches } from "@/lib/highlight-match";
import { cn } from "@/lib/utils";

export function EntryBody({ body, query }: { body: string; query: string }) {
  if (query.trim() === "") {
    return <p className="min-w-0 flex-1 whitespace-pre-wrap">{body}</p>;
  }
  return (
    <p className="min-w-0 flex-1 whitespace-pre-wrap">
      {highlightMatches(body, query).map((segment, index) =>
        segment.matched ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are a stable, ordered split of one Entry's body for one render.
          <mark key={index} className="rounded-sm bg-primary/30 text-inherit">
            {segment.text}
          </mark>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are a stable, ordered split of one Entry's body for one render.
          <span key={index}>{segment.text}</span>
        ),
      )}
    </p>
  );
}

/**
 * Edit/Delete, wired onto a row by history.tsx (ADR 0028 — see EntryRowProps'
 * own `actions` comment for who gets this and who deliberately doesn't).
 * Both callbacks take the whole Entry, not just its id: Delete's Undo (see
 * use-history.ts) needs the pre-delete body, and the simplest way to get
 * that to the caller is to hand over what this row already has in full,
 * rather than making every caller re-fetch it by id.
 */
export interface EntryRowActions {
  onEdit: (entry: Entry) => void;
  onDelete: (entry: Entry) => void;
  /**
   * Opens history.tsx's single shared EntryActionsSheet for this Entry
   * (issue #78) — history.tsx's own sheet-open setter, assembled onto this
   * bundle alongside onEdit/onDelete rather than being a fourth prop a
   * caller has to know to pass. composer-page.tsx, the only outside
   * caller, still only ever supplies onEdit and onDelete; both-or-neither
   * (see EntryRowProps' `actions` comment) governs that external pair
   * exactly as before, and history.tsx fills in this third field itself
   * once both are present.
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
 * Opens history.tsx's shared sheet for a tap on this row, but only on a
 * device without hover — issue #78's split is on hover-capability, not on
 * pointer type or build target. On a hover-capable device the row's own
 * EntryHoverActions buttons are the way to reach Edit/Delete, and this
 * simply does nothing, leaving an ordinary click on the row body free to
 * do what clicking text anywhere else does (place a selection), rather
 * than popping a sheet over it.
 */
function handleRowTap(actions: EntryRowActions | undefined, entry: Entry) {
  if (!actions || hoverCapable()) {
    return;
  }
  actions.onOpenSheet(entry);
}

/**
 * The optional half of "Right-click on a pointer device may open the same
 * sheet/menu if that falls out cheaply" — cheap here because it's just
 * `handleRowTap`'s own hover check, reused. `preventDefault` only runs
 * behind that same hoverCapable() gate, so a touch device's long-press
 * (which also dispatches `contextmenu` in most mobile browsers) is never
 * intercepted: this handler simply returns, its default action runs
 * unprevented, and that default action is exactly what starts native text
 * selection. Long-press is left alone on every platform, per the ticket —
 * this is what makes that true here specifically for a right-click-shaped
 * event, not just for the removed long-press timer.
 */
function handleRowContextMenu(
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
    // biome-ignore lint/a11y/noStaticElementInteractions: onClick here is a touch-only progressive enhancement (handleRowTap no-ops on a hover-capable device — see its own comment) layered on a row that must stay plain, selectable text, not a control; giving it an interactive role would contradict that and would duplicate the two real <button>s below.
    // biome-ignore lint/a11y/useKeyWithClickEvents: no keyboard equivalent is needed for the same reason — "reachable without a pointer" (the ticket's own requirement) is satisfied by EntryHoverActions' real, tabbable <button>s, not by this row.
    <div
      data-slot="entry-row"
      className={cn("flex items-baseline gap-3 py-1.5 text-sm text-foreground", actions && "group")}
      onClick={actions ? () => handleRowTap(actions, entry) : undefined}
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
        <EntryHoverActions entry={entry} onEdit={actions.onEdit} onDelete={actions.onDelete} />
      )}
    </div>
  );
});
