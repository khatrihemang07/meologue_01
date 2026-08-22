/**
 * Renders one Entry's body and metadata — its clock time, its not-yet-synced
 * marker. Extracted out of history.tsx (ticket 7) because Reflection's
 * Grounding disclosure needs to render an Entry too, and an Entry shown as
 * Grounding and the same Entry shown in History are the same thing: any
 * visual drift between the two would be a lie about the data. History and
 * Reflection both import from here rather than each keeping their own copy.
 */
import type { Entry } from "@meologue/core";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { formatClockTime } from "@/lib/entry-day";
import { formatAbsoluteTime } from "@/lib/entry-time";
import { highlightMatches } from "@/lib/highlight-match";

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
   * Wires an Edit/Delete context menu onto this row (ADR 0028). Undefined
   * by default — deliberately "no menu" rather than "menu, disabled" — so
   * every existing caller of EntryRow is unaffected by this prop's
   * existence: grounding-disclosure.tsx renders Reflection's Grounding,
   * which CONTEXT.md requires to stay a read-only view of what an Answer
   * was based on (offering to edit or delete an Entry from inside that
   * disclosure would let editing a past Answer relied on look possible, and
   * it must not be). Only history.tsx — which the Composer page's own
   * footer History renders through (issue #75 removed `/history`'s own
   * page, once the only other caller) — ever passes this, on rows it knows
   * are real History, never Grounding.
   */
  actions?: EntryRowActions;
}

// One full-width row (ticket 52, #49's "Discord" variant — no bubble, no
// tails, no left/right split). Each Entry carries its own clock time
// because timestamps are per-Entry rather than clustered (#49); the date
// that time belongs to lives on the day separator above, not here.
export function EntryRow({ entry, query = "", syncEnabled, actions }: EntryRowProps) {
  const time = formatClockTime(entry.createdAt);
  const row = (
    <div className="flex items-baseline gap-3 py-1.5 text-sm text-foreground">
      <EntryBody body={entry.body} query={query} />
      <div className="flex shrink-0 items-center gap-2">
        {time !== null && (
          <time
            dateTime={entry.createdAt}
            title={formatAbsoluteTime(entry.createdAt) ?? undefined}
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
    </div>
  );

  if (!actions) {
    return row;
  }

  return (
    // Radix's ContextMenu (ADR 0028): right-click on a pointer device,
    // long-press on a touch device, with zero extra code for either — the
    // exact behaviour ADR 0028 asks for across Android, macOS and web, and
    // zero pixels at rest since nothing renders until it's triggered.
    // `asChild` on the Trigger below is what keeps `row`'s own <div> as the
    // DOM node History's `divide-y` sibling styling depends on, rather than
    // Radix wrapping it in a <span> of its own.
    <ContextMenu>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => actions.onEdit(entry)}>Edit</ContextMenuItem>
        <ContextMenuItem variant="destructive" onSelect={() => actions.onDelete(entry)}>
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
