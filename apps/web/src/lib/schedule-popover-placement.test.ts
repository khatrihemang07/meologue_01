import { describe, expect, it } from "vitest";
import {
  computeSchedulePopoverPlacement,
  SCHEDULE_POPOVER_TOP_PADDING,
} from "./schedule-popover-placement";

/**
 * `DOMRect` has more fields than this function reads — building the literal
 * by hand (rather than via a real `getBoundingClientRect()`, unavailable
 * outside a browser) keeps every test's input to exactly what the function
 * consumes: `top`/`bottom`/`left`/`right`/`width`/`height`.
 */
function rect(top: number, left: number, width: number, height: number) {
  return { top, left, bottom: top + height, right: left + width, width, height };
}

// Todoist's own measured card, issue #440's own reference size — a
// component-level caller measures the *real* rendered card instead (this
// function's own doc comment), but a fixed size here is what lets every
// example below be checked against the ticket's literal numbers.
const CARD = { width: 250, height: 555 };
const VIEWPORT_1260x696 = { width: 1260, height: 696 };

describe("computeSchedulePopoverPlacement", () => {
  it("opens below, centred, zero gap, when the whole card fits below the trigger", () => {
    // After 32px+ of scroll the ticket measured space below the Reschedule
    // button as >=555 — represented here as a trigger whose bottom (140)
    // leaves exactly 556px of the 696px-tall viewport below it.
    const trigger = rect(100, 600, 80, 40);
    const placement = computeSchedulePopoverPlacement(trigger, CARD, VIEWPORT_1260x696);
    expect(placement.side).toBe("bottom");
    expect(placement.sideOffset).toBe(0);
    // Centred on the trigger horizontally: card left = trigger centre (640)
    // minus half the card width (125) = 515, i.e. 85px left of the
    // trigger's own left edge (600).
    expect(placement.align).toBe("start");
    expect(placement.alignOffset).toBe(-85);
  });

  it("opens above, centred, card bottom flush on the trigger top, when below doesn't fit but above does", () => {
    // A last-row Date button near the window bottom (the ticket's own
    // example): plenty of room above, none below.
    const trigger = rect(650, 600, 80, 30);
    const placement = computeSchedulePopoverPlacement(trigger, CARD, VIEWPORT_1260x696);
    expect(placement.side).toBe("top");
    expect(placement.sideOffset).toBe(0);
    expect(placement.alignOffset).toBe(-85);
  });

  it("falls back beside — to the left, top clamped to 48px — when neither below nor above fits", () => {
    // The ticket's own Reschedule-at-scroll-0 example: button bottom 172,
    // near the top of the page, so neither the 555px card fits below
    // (172+555=727 > 696) nor above (top ~140 - 555 < 0). Todoist's own
    // outcome: left side, top clamped to 48. `left: 280` only says "there
    // is room to the left of this trigger" (the ticket gives no left px for
    // the real button) — the case for "no room on the left" is its own
    // test below.
    const trigger = rect(140, 280, 80, 32);
    const placement = computeSchedulePopoverPlacement(trigger, CARD, VIEWPORT_1260x696);
    expect(placement.side).toBe("left");
    expect(placement.sideOffset).toBe(0);
    // top = trigger.top (140) + alignOffset should equal 48.
    expect(placement.alignOffset).toBe(SCHEDULE_POPOVER_TOP_PADDING - 140);
  });

  it("uses the right side, flush on the trigger's right edge, when there's no room on the left", () => {
    const trigger = rect(140, 100, 80, 32); // left edge at 100 < card width 250
    const placement = computeSchedulePopoverPlacement(trigger, CARD, VIEWPORT_1260x696);
    expect(placement.side).toBe("right");
    expect(placement.sideOffset).toBe(0);
  });

  it("clamps the beside placement's bottom to the viewport bottom rather than letting it overflow", () => {
    // The macOS app's default 800x600 window: a card that's 555 tall
    // centred on a mid-page trigger would push far past the 600px window —
    // the old behaviour's own regression (Time/Repeat pushed off-screen).
    const viewport = { width: 800, height: 600 };
    const trigger = rect(300, 100, 80, 32); // neither below nor above fits
    const placement = computeSchedulePopoverPlacement(trigger, CARD, viewport);
    expect(placement.side).toBe("right");
    // top = trigger.top (300) + alignOffset must land the card's bottom
    // exactly on the viewport's own bottom: top = 600 - 555 = 45.
    const top = trigger.top + placement.alignOffset;
    expect(top).toBe(45);
    expect(top + CARD.height).toBe(600);
  });

  it("pins the beside placement to the top padding, letting the bottom overflow, when the card is taller than the viewport", () => {
    const viewport = { width: 800, height: 400 }; // shorter than the 555px card
    const trigger = rect(150, 100, 80, 32);
    const placement = computeSchedulePopoverPlacement(trigger, CARD, viewport);
    const top = trigger.top + placement.alignOffset;
    expect(top).toBe(SCHEDULE_POPOVER_TOP_PADDING);
  });

  it("clamps the below placement horizontally so the card never overflows the right viewport edge", () => {
    const trigger = rect(0, 1200, 40, 30); // near the right edge of a 1260-wide viewport
    const placement = computeSchedulePopoverPlacement(trigger, CARD, VIEWPORT_1260x696);
    expect(placement.side).toBe("bottom");
    const left = trigger.left + placement.alignOffset;
    expect(left).toBe(VIEWPORT_1260x696.width - CARD.width);
  });

  it("clamps the above placement horizontally so the card never overflows the left viewport edge", () => {
    const trigger = rect(650, 5, 40, 30); // near the left edge; fits above, not below
    const placement = computeSchedulePopoverPlacement(trigger, CARD, VIEWPORT_1260x696);
    expect(placement.side).toBe("top");
    const left = trigger.left + placement.alignOffset;
    expect(left).toBe(0);
  });
});
