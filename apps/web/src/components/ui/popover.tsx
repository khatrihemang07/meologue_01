/**
 * A thin wrapper over Radix's `Popover` (issue #227), modeled on
 * `sheet.tsx`'s identical wrapping of `Dialog` — one `data-slot`-tagged
 * function per primitive this repo actually uses, no behaviour added.
 * This repo's first anchored (non-centered, non-bottom-sheet) overlay:
 * `Sheet` is deliberately "anchored to the bottom, slides up" only (its
 * own header comment), and `AlertDialog`/`Dialog`-shaped confirms are
 * centered — neither primitive can become "positioned under the button
 * that opened it" without turning into something this file's callers
 * would be fighting rather than using. `task-schedule-popover.tsx` is the
 * one caller so far (the Todoist-parity scheduler, `docs/reference/
 * todoist/scheduler-and-priority.md` section 1: "anchored popover... not
 * a centered dialog") — and, since that scheduler opens from a button
 * that itself lives inside `Sheet`'s bottom sheet, `PopoverContent`'s
 * default `z-[60]` below matters immediately, not speculatively:
 * `sheet.tsx`'s own overlay and content both carry an explicit `z-50`,
 * and a Radix `Popover.Content` with no z-index of its own (`z-index:
 * auto`) paints in an EARLIER layer than any positive-z-index sibling
 * regardless of DOM order (CSS2.1 Appendix E's stacking order) — found
 * live, in a real browser, as a scheduler popover that rendered its
 * correct card, fully readable, while the Sheet's own modal overlay sat
 * on top of it and silently absorbed every click and keystroke aimed at
 * it. No jsdom test can catch this: `fireEvent.click` targets a node
 * directly and never asks "what's actually on top at these coordinates,"
 * which is exactly the question real hit-testing answers differently.
 * `z-[60]` reaches Radix's own `Popper` positioning wrapper too — it
 * reads `PopoverPrimitive.Content`'s computed z-index and copies it onto
 * that wrapper, which is the element real clicks actually land on.
 */
import { Popover as PopoverPrimitive } from "radix-ui";
import type * as React from "react";
import { cn } from "@/lib/utils";

function Popover({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

function PopoverTrigger({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

function PopoverAnchor({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />;
}

function PopoverContent({
  className,
  align = "start",
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        className={cn("z-[60]", className)}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}

export { Popover, PopoverAnchor, PopoverContent, PopoverTrigger };
