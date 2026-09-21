/**
 * Where `TaskSchedulePopover`'s desktop popover opens (issue #440),
 * following Todoist web's own measured rule: below, centred, zero gap, if
 * the whole card fits below the trigger; otherwise above, centred, flush on
 * the trigger's top; otherwise beside — left of the trigger (right when
 * there's no room on the left), flush, then slid vertically to stay inside
 * the window.
 *
 * A plain function rather than a Radix/floating-ui `side`+`align`
 * combination for the reason `task-schedule-popover.tsx`'s own caller
 * comment gives: Radix's `side`/`align`/`avoidCollisions` can express a
 * single flip order and a single alignment, not "below→above→beside with a
 * *different* alignment (centred vs flush) per branch and a hand-rolled
 * vertical clamp only the beside branch needs." The caller still hands the
 * result to Radix — `align: "start"` plus `alignOffset` is exactly
 * expressive enough to place the card at an arbitrary absolute position
 * along the cross axis regardless of `side` (`align: "start"` anchors the
 * card's start edge to the trigger's own start edge on that axis, with no
 * dependency on the card's own size, so `alignOffset` alone reaches any
 * target coordinate) — it just isn't expressive enough to *choose* that
 * position, which is what this function is for.
 */

/** Only the four fields this function reads off a real `getBoundingClientRect()`, plus the two it's redundant with (`width`/`height`) — kept because callers already have a real `DOMRect` to hand, not because this function needs both forms. */
export interface PlacementRect {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
  readonly width: number;
  readonly height: number;
}

export interface PlacementSize {
  readonly width: number;
  readonly height: number;
}

export type SchedulePopoverSide = "bottom" | "top" | "left" | "right";

/**
 * Feeds straight into `PopoverContent`'s own `side`/`align`/`sideOffset`/
 * `alignOffset` props (`components/ui/popover.tsx`, itself
 * `@radix-ui/react-popover` over floating-ui) — `align` is always `"start"`
 * here, never `"center"`, for the reason this file's header comment gives.
 */
export interface SchedulePopoverPlacement {
  readonly side: SchedulePopoverSide;
  readonly align: "start";
  readonly sideOffset: number;
  readonly alignOffset: number;
}

/**
 * Todoist's own measured beside-placement top clamp (issue #440's own
 * ticket: "Todoist's top clamp was ≈48px from the viewport top").
 */
export const SCHEDULE_POPOVER_TOP_PADDING = 48;

function clamp(value: number, min: number, max: number): number {
  // `Math.min` applied last: when `max < min` (the card doesn't leave room
  // for both the top-padding preference and the viewport-bottom limit),
  // the bottom limit wins — see this function's own "pin to the top
  // padding" branch below for the one case that overrides even that.
  return Math.min(Math.max(value, min), max);
}

export function computeSchedulePopoverPlacement(
  trigger: PlacementRect,
  card: PlacementSize,
  viewport: PlacementSize,
): SchedulePopoverPlacement {
  const fitsBelow = trigger.bottom + card.height <= viewport.height;
  const fitsAbove = trigger.top - card.height >= 0;

  if (fitsBelow || fitsAbove) {
    // Rule 4: horizontal clamping for below/above, so a card centred on a
    // trigger near either edge never overflows it.
    const centredLeft = trigger.left + trigger.width / 2 - card.width / 2;
    const left = clamp(centredLeft, 0, viewport.width - card.width);
    const alignOffset = left - trigger.left;
    return fitsBelow
      ? { side: "bottom", align: "start", sideOffset: 0, alignOffset }
      : { side: "top", align: "start", sideOffset: 0, alignOffset };
  }

  // Rule 3: beside. Left of the trigger, right edge flush on the trigger's
  // left edge — unless there's no room on the left, in which case the
  // right side, flush on the trigger's right edge instead.
  const side: SchedulePopoverSide = card.width <= trigger.left ? "left" : "right";

  // Slid vertically to stay inside the window: centred on the trigger by
  // default, then clamped. A card taller than the viewport can't satisfy
  // both "top >= the padding" and "bottom <= the viewport bottom" at once —
  // Todoist keeps the top (and the fields that live there, "Type a date"
  // included) on-screen in that case rather than the bottom, so it's pinned
  // to the padding and let the bottom run off, instead of `clamp` below
  // ordinarily preferring the bottom-not-past-viewport constraint.
  const centredTop = trigger.top + trigger.height / 2 - card.height / 2;
  const top =
    card.height > viewport.height
      ? SCHEDULE_POPOVER_TOP_PADDING
      : clamp(centredTop, SCHEDULE_POPOVER_TOP_PADDING, viewport.height - card.height);
  const alignOffset = top - trigger.top;

  return { side, align: "start", sideOffset: 0, alignOffset };
}
