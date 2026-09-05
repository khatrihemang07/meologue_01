import { Button } from "@/components/ui/button";

/**
 * The "Smart date recognition" row (issue #170) — a single independent
 * on/off fact, the same shape `DestinationVisibilityRow`
 * (destination-visibility-row.tsx) is, so it reuses that control's exact
 * `role="switch"`/`aria-checked` pattern rather than `ChoiceRow`'s
 * mutually-exclusive-options one. Not built on `DestinationVisibilityRow`
 * itself: that component's own copy ("Hidden"/"Visible", "`${label}` in the
 * chat list") is specific to hiding a Destination's row, and bending it to
 * a second, unrelated on/off setting via extra props would cost more
 * legibility than the few duplicated lines below save.
 *
 * Extracted from settings-page.tsx (#202), unchanged.
 */
export function SmartDatesRow({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-sm">Smart date recognition</span>
      <Button
        type="button"
        size="touch"
        variant={enabled ? "default" : "outline"}
        role="switch"
        aria-checked={enabled}
        aria-label="Smart date recognition"
        onClick={onToggle}
      >
        {enabled ? "On" : "Off"}
      </Button>
    </div>
  );
}
