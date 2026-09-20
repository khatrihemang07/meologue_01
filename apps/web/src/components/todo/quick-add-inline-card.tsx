import type * as React from "react";
import { cn } from "@/lib/utils";

export interface QuickAddInlineCardProps extends React.ComponentPropsWithoutRef<"div"> {
  children: React.ReactNode;
}

// 580px at every width `web/01-anatomy.md` measured (confirmed at
// 1600px, so it's not a narrow-window artifact), no `max-w` guard beyond
// leaving room for the viewport gutter. Colour/radius/shadow read off
// `web/07-native-colours.md`'s own "Todoist" (light) table via the
// `--td-quick-add-*` tokens (`index.css`), not the earlier, Dark-Reader-
// tinted `01-anatomy.md`/`04-interaction.md` numbers.
const INLINE_CARD_CLASSES =
  "w-[580px] max-w-[calc(100%-2rem)] rounded-[length:var(--td-quick-add-radius)] border border-[color:var(--td-quick-add-border)] bg-[color:var(--td-quick-add-background)] p-4 text-foreground shadow-[var(--td-quick-add-shadow)]";

/**
 * Non-touch's own shell (issue #374/D16) — Todoist web's Surface A and
 * Surface B are byte-for-byte the same subtree (`web/01-anatomy.md`'s own
 * key finding), and both are measured `position: static` with **no
 * backdrop/overlay/scrim** — the card just lays out in normal document
 * flow wherever its caller places it.
 *
 * Deliberately NOT built on `Dialog`/Radix: Surface B (`add-task-form.tsx`'s
 * inline "+ Add task" row) genuinely has no `role="dialog"` wrapper at all
 * (`web/01-anatomy.md`'s own control inventory — only Surface A carries
 * one) and, more importantly, has to stay a real in-flow sibling of the
 * task list it's part of; a Radix `Dialog.Portal` renders to
 * `document.body`, which would silently relocate it out of the list.
 * `quick-add-dialog.tsx` (Surface A) still wants Escape/outside-click/
 * focus-restore, so it wraps its OWN `Dialog`/`DialogContent`
 * (`@/components/ui/dialog`) around this component instead of this
 * component owning that machinery itself.
 */
export function QuickAddInlineCard({ children, className, ...props }: QuickAddInlineCardProps) {
  return (
    <div className={cn(INLINE_CARD_CLASSES, className)} {...props}>
      {children}
    </div>
  );
}
