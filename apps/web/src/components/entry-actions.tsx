/**
 * Edit/Delete for an Entry row (issue #78), replacing the Radix
 * ContextMenu `entry-row.tsx` used to wrap every row in. That trigger put
 * `select-none` on the row itself (its own `select-none`, merged onto the
 * row's `<div>` by Radix's `asChild` Slot) — which is why Entry text
 * couldn't be dragged to select on any platform. ADR 0028 still governs
 * *why* Edit/Delete exist on a row at all; it says nothing about which
 * widget exposes them, and this file is what replaces that choice.
 *
 * Two pieces live here, matching the design's hover-vs-touch split:
 *
 * - `EntryHoverActions`: two plain `<button>`s revealed on hover or focus,
 *   rendered once per row. Deliberately NOT a Radix menu root — see its
 *   own comment for why per-row cost has to stay plain DOM.
 * - `EntryActionsSheet`: the ONE bottom sheet `history.tsx` renders
 *   regardless of how many rows exist, driven by "which Entry is open"
 *   state that lives in `history.tsx`, not here and not per-row.
 *
 * `hoverCapable()` is what lets both `entry-row.tsx` (deciding whether a
 * tap should open the sheet) and this file split on "can this device
 * hover a pointer", rather than on which build (web/android/macos) is
 * running — the ticket's own instruction, since a build target says
 * nothing about whether the particular device running it has a mouse (a
 * touchscreen Windows laptop and a phone can both run the "web" build).
 */
import type { Entry } from "@meologue/core";
import { PencilIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

/**
 * True when this device can hover a pointer over content. Re-read at the
 * moment of each tap/render rather than cached in state: hover capability
 * can change mid-session (a mouse plugged into a tablet), there is no
 * event to subscribe to that fires only when it does, and a stale cached
 * value would be wrong for exactly as long as it was cached.
 *
 * `window.matchMedia` is guarded rather than assumed, matching this
 * repo's own precedent in `lib/theme.ts` — unlike that module's
 * `(prefers-color-scheme: dark)`, nothing here needs to react to the
 * value changing, so a plain read (no `addEventListener`) is enough.
 */
export function hoverCapable(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(hover: hover)").matches;
}

export interface EntryHoverActionsProps {
  entry: Entry;
  onEdit: (entry: Entry) => void;
  onDelete: (entry: Entry) => void;
}

/**
 * Plain buttons, not a Radix menu root. `@radix-ui/react-menu` — what both
 * the old ContextMenu and any DropdownMenu are built on — registers one
 * document-level keydown-capture listener per mounted root. History can
 * render hundreds of EntryRows; hundreds of those listeners was the
 * dominant cost issue #78 exists to remove, and a per-row Radix root of
 * any kind (context, dropdown, or otherwise) would bring that straight
 * back even with the right-click/long-press trigger gone. Two `<button>`s
 * cost nothing beyond the DOM nodes already needed to show them.
 *
 * Hidden entirely outside `(hover: hover)`, not just faded: a touch
 * device gets the shared `EntryActionsSheet` instead (wired by
 * `entry-row.tsx`'s tap handler), and a pair of buttons that were merely
 * invisible would still occupy a place in the layout, and in the tab
 * order, on a phone that can never usefully reach them. `hidden` (i.e.
 * `display: none`) is the base state; `[@media(hover:hover)]:flex`
 * overrides it only on a device the media query itself reports as
 * hover-capable — deliberately not gated by `hoverCapable()` in JS, since
 * CSS media queries re-evaluate live (e.g. a mouse plugged in mid-session)
 * where a value read once at render would not.
 *
 * `opacity-0` plus `focus-within:opacity-100` /
 * `group-hover:opacity-100` (itself re-gated behind `(hover:hover)`,
 * since Tailwind's `group-hover` has no built-in hover-media guard the
 * way its plain `hover:` variant does) is what keeps the pair
 * invisible-but-present at rest on a hover-capable device: `display:flex`
 * (not `none`) is what keeps them in the tab order, so keyboard focus can
 * reach them, and `focus-within` is what reveals them once it does —
 * satisfying "reachable without a pointer" without needing separate
 * keyboard-only markup. `(hover: hover)` describes the *device*, not the
 * current input method, so this holds even for a keyboard-only user on an
 * ordinary mouse-equipped laptop.
 */
export function EntryHoverActions({ entry, onEdit, onDelete }: EntryHoverActionsProps) {
  return (
    <div
      className={cn(
        "hidden shrink-0 items-center gap-1 opacity-0 focus-within:opacity-100",
        "[@media(hover:hover)]:flex [@media(hover:hover)]:group-hover:opacity-100",
      )}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Edit"
        // Stops the click from also bubbling to the row's own onClick
        // (entry-row.tsx's tap-to-open-sheet handler): that handler
        // already no-ops on a hover-capable device, but a hidden,
        // non-interactive touch-device button can never be the origin of
        // a real click in the first place, so this only matters for a
        // hybrid hover-and-touch device — and there is nothing to gain
        // from letting the row's handler run a second time after this one
        // already acted.
        onClick={(event) => {
          event.stopPropagation();
          onEdit(entry);
        }}
      >
        <PencilIcon />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Delete"
        onClick={(event) => {
          event.stopPropagation();
          onDelete(entry);
        }}
      >
        <Trash2Icon />
      </Button>
    </div>
  );
}

export interface EntryActionsSheetProps {
  /**
   * The Entry the sheet is open for, or null when closed — the "which
   * Entry is open" state `history.tsx` owns (see its own comment), so
   * exactly one sheet exists no matter how many rows are rendered, rather
   * than each row owning its own open/closed flag.
   */
  entry: Entry | null;
  onOpenChange: (open: boolean) => void;
  onEdit: (entry: Entry) => void;
  onDelete: (entry: Entry) => void;
}

/**
 * The touch-device equivalent of `EntryHoverActions`: one instance,
 * rendered once by `history.tsx`, reused for whichever row was last
 * tapped. `SheetTitle` is `sr-only` rather than omitted — Radix's Dialog
 * warns (and screen readers need) an accessible name, but the visual
 * design here is Edit/Delete as the only two rows, with no heading of
 * its own.
 */
export function EntryActionsSheet({
  entry,
  onOpenChange,
  onEdit,
  onDelete,
}: EntryActionsSheetProps) {
  return (
    <Sheet open={entry !== null} onOpenChange={onOpenChange}>
      <SheetContent>
        <SheetTitle className="sr-only">Entry actions</SheetTitle>
        <Button
          type="button"
          variant="ghost"
          size="lg"
          className="justify-start gap-2"
          onClick={() => {
            if (entry) {
              onEdit(entry);
            }
            onOpenChange(false);
          }}
        >
          <PencilIcon />
          Edit
        </Button>
        <Button
          type="button"
          variant="destructive"
          size="lg"
          className="justify-start gap-2"
          onClick={() => {
            if (entry) {
              onDelete(entry);
            }
            onOpenChange(false);
          }}
        >
          <Trash2Icon />
          Delete
        </Button>
      </SheetContent>
    </Sheet>
  );
}
