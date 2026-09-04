import type { Entry } from "@meologue/core";
import { type ComponentProps, type MouseEvent, memo, type ReactNode, useState } from "react";
import { EntryHoverActions } from "@/components/entry-actions";
import {
  type EntryRowActions,
  entryBodyContent,
  handleRowContextMenu,
} from "@/components/entry-row";
import { SWIPE_TARGET_ATTRIBUTE } from "@/hooks/use-swipe-actions";
import { formatClockTime } from "@/lib/entry-day";
import { formatAbsoluteTime } from "@/lib/entry-time";
import { cn } from "@/lib/utils";

/**
 * A thread's bubble, and the Entry-shaped one built on it.
 *
 * Split out of `entry-row.tsx` rather than growing a `variant` prop on it.
 * That file argues History and Grounding must not drift visually, and that
 * was right while both were lists — an Entry shown as Grounding and the same
 * Entry in History were the same shape, so a difference between them was a
 * lie about the data. ADR 0036 makes one a thread and leaves the other a
 * list, and holding them identical then stops being honesty and becomes a
 * constraint neither wants. `EntryBody` is still shared, so the words
 * themselves cannot drift.
 */

export type BubbleSide = "out" | "in";

export interface BubbleProps {
  side: BubbleSide;
  /**
   * Whether the bubble immediately above is on the same side. Drives the gap
   * only: a run from one side reads as one turn of writing, and a change of
   * side is the boundary worth spacing apart.
   */
  groupedWithPrevious?: boolean;
  className?: string;
  children: ReactNode;
  /**
   * Attached to the bubble itself rather than the row around it. The row
   * spans the full width including its own inset, so a handler up there
   * would fire on the empty space beside the bubble too.
   */
  innerProps?: ComponentProps<"div">;
  /** Rendered in the row beside the bubble — the hover Edit/Delete buttons. */
  trailing?: ReactNode;
}

/**
 * The bubble shape, with no idea what is inside it.
 *
 * Shared so Reflect's Question and Answer render through the same component
 * as Composer's Entries. A Question is not an Entry and an Answer is not an
 * Entry (CONTEXT.md is explicit about both), so they cannot share
 * `EntryBubble` — but they are the same *shape*, and two hand-maintained
 * copies of a bubble are how a thread starts disagreeing with itself about
 * what "outgoing" looks like.
 *
 * Treatment F plus a side. F — flat, near-background fill, no tail — was
 * chosen on a device for raw density: at full width and with a muted fill an
 * Entry's own words carry the screen rather than the container competing for
 * it. What F dropped, and this puts back, is any asymmetry at all: with both
 * sides full-width and told apart only by tint, a Question and its Answer
 * are genuinely hard to scan apart. A ~12% inset on the opposite side costs
 * a little width and buys the strongest "who said what" cue there is,
 * without borrowing a tail's shape.
 */
export function Bubble({
  side,
  groupedWithPrevious = false,
  className,
  children,
  innerProps,
  trailing,
}: BubbleProps) {
  const { className: innerClassName, ...innerRest } = innerProps ?? {};
  return (
    <div
      data-slot="bubble"
      data-side={side}
      className={cn(
        "flex",
        side === "out" ? "justify-end pl-[12%]" : "justify-start pr-[12%]",
        groupedWithPrevious ? "mt-0.5" : "mt-3",
        className,
      )}
    >
      <div
        className={cn(
          // `overflow-hidden` clips content to the `rounded-2xl` corners —
          // an unbreakable long word or url in the body would otherwise
          // square off a corner rather than being clipped by it. (It used
          // to also contain `BubbleMeta`'s right float; issue #149 moved
          // that onto its own row, which needs no containment of its own.)
          "max-w-full overflow-hidden rounded-2xl px-3 py-2 text-sm",
          // The reader's chosen Accent (#128), mixed against the background
          // rather than laid over it — see index.css. Before this, "out" was
          // `bg-primary/10` and "in" was `bg-muted`, which in the light theme
          // are both near-grey: on Composer that costs nothing, since every
          // Entry is outgoing, but on Reflect it left a Question and its
          // Answer told apart by a tint neither of them really had.
          side === "out" ? "bg-[var(--entry-accent-fill)]" : "bg-muted",
          innerClassName,
        )}
        {...innerRest}
      >
        {children}
      </div>
      {trailing}
    </div>
  );
}

/**
 * The clock time, and the not-yet-synced marker when there is one.
 *
 * Its own row below the body (issue #149), not a right float sharing the
 * body's last line the way it used to. A float needs a line box to land
 * on, which is what forced the body to stay unwrapped inline content (see
 * `EntryBubble`'s own comment on the body `<p>` below) — a constraint an
 * Entry's coming block structure (a list) cannot live with, since a list
 * has no single line box to share a float with at all.
 *
 * Rendered as a block-level flex row (`display: flex` on this element
 * makes it block-level regardless of tag) so it stacks under the `<p>`
 * above it and needs no wrapping container of its own. `justify-end`
 * right-aligns its contents the way the float used to for free. The small
 * `mt-0.5` and the meta text's own `text-[10px]` are what keep this row
 * from reading as a second, wasted line under a short Entry — it costs a
 * sliver of height for the clock, not another full line.
 */
export function BubbleMeta({
  createdAt,
  showPendingMarker,
}: {
  createdAt: string;
  showPendingMarker: boolean;
}) {
  const time = formatClockTime(createdAt);
  const [absoluteTime, setAbsoluteTime] = useState<string | null | undefined>(undefined);
  const revealAbsoluteTime = () => {
    if (absoluteTime === undefined) setAbsoluteTime(formatAbsoluteTime(createdAt));
  };

  return (
    <span className="mt-0.5 flex items-center justify-end gap-1">
      {time !== null && (
        <time
          dateTime={createdAt}
          title={absoluteTime ?? undefined}
          onMouseEnter={revealAbsoluteTime}
          className="text-[10px] text-muted-foreground tabular-nums"
        >
          {time}
        </time>
      )}
      {showPendingMarker && (
        <span
          role="img"
          aria-label="Not yet synced"
          title="Not yet synced"
          className="text-[10px] text-muted-foreground"
        >
          ●
        </span>
      )}
    </span>
  );
}

export interface EntryBubbleProps {
  entry: Entry;
  query?: string;
  syncEnabled: boolean;
  /**
   * Composer passes `"out"` for every Entry, and that is not a placeholder:
   * CONTEXT.md's own "message" entry is explicit that an Entry has no
   * addressee, so Composer is all-outgoing because there is no other side,
   * not because the other side happens to be empty.
   */
  side: BubbleSide;
  groupedWithPrevious?: boolean;
  actions?: EntryRowActions;
  /**
   * Briefly flashes this bubble (issue #143) — history.tsx's own signal
   * that a followed Entry Reference's seek just landed here, so the reader
   * can see which row they arrived at. Defaults to false: every caller
   * except history.tsx's own seek effect has no seek in flight and never
   * has a reason to flash anything.
   */
  highlighted?: boolean;
  /**
   * Toggles one of this Entry's task checkboxes (issue #153). Takes the
   * whole Entry, not just the marker offsets, matching `EntryRowActions`'
   * callbacks above — history.tsx (via composer-page.tsx) needs `entry.id`
   * and `entry.body` to splice and commit the edit, and this bubble is
   * where both already live, so closing over them here rather than making
   * every caller thread the marker offsets back up to an id and a body it
   * would otherwise have to re-look-up.
   *
   * Undefined by default, the same "no actions" shape `actions` above
   * already follows: Grounding never renders `EntryBubble` at all (it
   * renders `EntryRow`/`EntryBody` instead — see that file's own comment),
   * so there is no read-only caller here that needs this explicitly
   * withheld; it is simply never supplied outside history.tsx's own
   * thread.
   */
  onToggleTask?: (entry: Entry, markerFrom: number, markerTo: number) => void;
  /**
   * Opens a referenced Task over the Composer (issue #181) — passed
   * straight through to `entryBodyContent`'s own `onOpenTask`, unwrapped:
   * unlike `onToggleTask`, opening needs only the Task's own id, never
   * this Entry's `id`/`body`, so there is nothing here to close over.
   * Undefined by default, the same "no door, no affordance" shape
   * `onToggleTask` above already follows.
   */
  onOpenTask?: (taskId: string) => void;
}

export const EntryBubble = memo(function EntryBubble({
  entry,
  query = "",
  syncEnabled,
  side,
  groupedWithPrevious = false,
  actions,
  highlighted = false,
  onOpenTask,
  onToggleTask,
}: EntryBubbleProps) {
  return (
    <Bubble
      side={side}
      groupedWithPrevious={groupedWithPrevious}
      className={cn(actions && "group")}
      innerProps={{
        // What a finger can pick up (#127). The attribute goes on the bubble
        // itself, so the element the recogniser translates is the one whose
        // fill and text the reader sees move — and `touch-action: pan-y` is
        // what lets it: the browser keeps carrying a vertical scroll, and
        // leaves the horizontal axis to `use-swipe-actions.ts`. It is the
        // deliberate opposite of `pane-divider.tsx`'s `touch-action: none`.
        //
        // No tap handler. A tap on a bubble does nothing now: it was an
        // unusual thing for a chat interface to spend a tap on, and the tap
        // is worth more free — placing a cursor, dismissing a selection.
        // Biome's a11y rules do not reach these because they arrive as an
        // object rather than JSX attributes; the bubble stays plain,
        // selectable text rather than becoming a control, and the real,
        // tabbable <button>s are EntryHoverActions.
        ...(actions ? { [SWIPE_TARGET_ATTRIBUTE]: "", "data-entry-id": entry.id } : {}),
        className: cn(
          actions && "touch-pan-y",
          // Issue #143: the flash a followed Entry Reference lands on. One
          // declaration covers both directions — the ring appears the
          // instant `highlighted` turns true, and `transition-shadow` fades
          // it back out over the same span once history.tsx's own timer
          // turns `highlighted` false again, with no separate fade-out
          // state needed here.
          "transition-shadow duration-700",
          highlighted && "ring-2 ring-primary/70",
        ),
        onContextMenu: actions
          ? (event: MouseEvent) => handleRowContextMenu(event, actions, entry)
          : undefined,
      }}
      trailing={
        actions ? (
          <EntryHoverActions
            entry={entry}
            onEdit={actions.onEdit}
            onDelete={actions.onDelete}
            onRefer={actions.onRefer}
          />
        ) : undefined
      }
    >
      {/*
        A block of its own now (issue #149) — the body used to be unwrapped
        inline content here, denied `EntryBody`'s own wrapper, because
        `BubbleMeta` below was a right float that needed a line box in the
        body to land on. With the clock on its own row instead, nothing
        here still requires the body to stay unwrapped.

        A `<div>`, not a `<p>` (issue #152): `entryBodyContent` can now
        render a `<ul>`/`<ol>` alongside its own `<p>`s when the body holds
        a list, and a list cannot validly nest inside a `<p>`. The
        `whitespace-pre-wrap` here is redundant with the one `entryProse`
        already puts on each generated `<p>` — kept anyway so nothing about
        this element's own behaviour depends on which of its children
        happens to carry it.
      */}
      {/*
        The one thing text size scales (#128). `BubbleMeta` below, the day
        pill above and the sync tick all carry their own fixed sizes and
        never read `--entry-text-scale`, which is what keeps the furniture
        still while the words the reader wrote grow. Reflect's Question and
        Answer deliberately do not scale: a Question is the reader's own
        words and an Answer is not, and scaling one without the other would
        put two sizes of prose in the same thread.
      */}
      <div
        data-slot="bubble-body"
        className="min-w-0 whitespace-pre-wrap text-[calc(0.875rem*var(--entry-text-scale,1))]"
      >
        {entryBodyContent(
          entry.body,
          query,
          onToggleTask === undefined
            ? undefined
            : (markerFrom, markerTo) => onToggleTask(entry, markerFrom, markerTo),
          entry.id,
          onOpenTask,
        )}
      </div>
      <BubbleMeta
        createdAt={entry.createdAt}
        showPendingMarker={syncEnabled && entry.seq === null}
      />
    </Bubble>
  );
});
