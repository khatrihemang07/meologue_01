import { Button } from "@/components/ui/button";

/**
 * The button pair for `use-timeline-zoom.ts`'s step zoom (issue #418).
 *
 * `aria-label`s are "Zoom out"/"Zoom in" rather than anything naming what is
 * being zoomed: Playwright matches accessible names by *substring*
 * (`docs/agents/…` — captured in memory as `playwright-name-matches-by-
 * substring`), and this page already has controls named "Today", "Refresh
 * now", "Search this day's activity", "Previous day" and "Next day" — a
 * label containing any of those words, or "Time" itself (the root
 * Destination's own name, read off the Shell banner), would make an existing
 * locator ambiguous without a single existing test changing.
 */
export function ZoomControls({
  levelLabel,
  canZoomOut,
  canZoomIn,
  onZoomOut,
  onZoomIn,
}: {
  /** e.g. "100%" — read from the live px-per-hour, not restated here. */
  levelLabel: string;
  canZoomOut: boolean;
  canZoomIn: boolean;
  onZoomOut: () => void;
  onZoomIn: () => void;
}) {
  return (
    // `pointer-events-none` on the full-width row and `-auto` on the group:
    // the row spans the lane area while it floats, and only the group itself
    // should take a tap — the rest of the row must let taps through to the
    // records underneath it.
    <div
      className="pointer-events-none sticky z-20 flex justify-end"
      // Clear of Android's navigation bar: the WebView draws edge to edge, so
      // a plain 1rem from the bottom put the buttons underneath it (the inset
      // measured 48px on the device) where no tap could reach them.
      style={{ bottom: "calc(1rem + env(safe-area-inset-bottom))" }}
    >
      <div className="pointer-events-auto flex items-center gap-1 rounded-full border border-border bg-background/95 p-1 shadow-md">
        <Button
          type="button"
          size="touch"
          variant="outline"
          aria-label="Zoom out"
          disabled={!canZoomOut}
          onClick={onZoomOut}
        >
          −
        </Button>
        <span className="min-w-[6ch] text-center text-muted-foreground text-xs tabular-nums">
          {levelLabel}
        </span>
        <Button
          type="button"
          size="touch"
          variant="outline"
          aria-label="Zoom in"
          disabled={!canZoomIn}
          onClick={onZoomIn}
        >
          +
        </Button>
      </div>
    </div>
  );
}
