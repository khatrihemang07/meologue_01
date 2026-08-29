import type { Entry } from "@meologue/core";
import {
  type ComponentProps,
  type MouseEvent,
  memo,
  type ReactNode,
  useRef,
  useState,
} from "react";
import { EntryHoverActions } from "@/components/entry-actions";
import {
  type EntryRowActions,
  entryBodyContent,
  handleRowContextMenu,
  handleRowTap,
} from "@/components/entry-row";
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
          // `overflow-hidden` establishes a block formatting context, so a
          // floated meta line is contained by the bubble rather than
          // escaping it.
          "max-w-full overflow-hidden rounded-2xl px-3 py-2 text-sm",
          side === "out" ? "bg-primary/10" : "bg-muted",
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
 * Floated right and rendered AFTER the body, which gives it WhatsApp's own
 * behaviour for free: a float is placed on the current line when there is
 * room and pushed to the next when there is not. So it reflows onto the end
 * of a long Entry's last line and drops to its own right-aligned line under
 * a short one — instead of always taking a whole line, which is what made a
 * one-word Entry cost two.
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
    <span className="float-right ml-2 inline-flex translate-y-1 items-center gap-1">
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
}

export const EntryBubble = memo(function EntryBubble({
  entry,
  query = "",
  syncEnabled,
  side,
  groupedWithPrevious = false,
  actions,
}: EntryBubbleProps) {
  // When the current press began, so a click can tell a tap from the tail end
  // of a long-press. A ref, not state: nothing renders from it.
  const pressStartedAtRef = useRef<number | null>(null);

  return (
    <Bubble
      side={side}
      groupedWithPrevious={groupedWithPrevious}
      className={cn(actions && "group")}
      innerProps={{
        // The touch-only progressive enhancement `entry-row.tsx` documents:
        // a bubble stays plain, selectable text rather than becoming a
        // control, and the real, tabbable <button>s are EntryHoverActions.
        // Biome's a11y rules do not reach these because they arrive as an
        // object rather than JSX attributes — the reasoning is recorded here
        // rather than as a suppression it would now call unused.
        onPointerDown: actions
          ? () => {
              pressStartedAtRef.current = Date.now();
            }
          : undefined,
        onClick: actions
          ? () => handleRowTap(actions, entry, pressStartedAtRef.current)
          : undefined,
        onContextMenu: actions
          ? (event: MouseEvent) => handleRowContextMenu(event, actions, entry)
          : undefined,
      }}
      trailing={
        actions ? (
          <EntryHoverActions entry={entry} onEdit={actions.onEdit} onDelete={actions.onDelete} />
        ) : undefined
      }
    >
      {/*
        Inline, not `EntryBody`'s `<p>`: `BubbleMeta` below is a right float,
        and a float can only be placed on a line box it is in. Wrapped in a
        block, it has no line to join and drops beneath the whole thing —
        which is exactly what made a one-word Entry cost two lines.
      */}
      <span data-slot="bubble-body" className="whitespace-pre-wrap">
        {entryBodyContent(entry.body, query)}
      </span>
      <BubbleMeta
        createdAt={entry.createdAt}
        showPendingMarker={syncEnabled && entry.seq === null}
      />
    </Bubble>
  );
});
