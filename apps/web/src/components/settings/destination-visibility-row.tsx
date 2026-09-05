import { Button } from "@/components/ui/button";

/**
 * One Destination's own on/off row in the "Chat list" section (issue #134).
 *
 * Not a `ChoiceRow` (choice-row.tsx): that control is a fixed-width group of
 * mutually exclusive options — exactly one Theme, one Text size — and its
 * own doc comment is explicit that `aria-pressed` toggles are standing in
 * for a radio group. A visibility switch is a different shape entirely:
 * three *independent* on/off facts, not one choice among several, so this
 * is a real `role="switch"` with `aria-checked` rather than a fourth
 * `aria-pressed` button pretending to be part of a choice it isn't.
 *
 * `size="touch"` on the switch itself, not just the row it sits in — ADR
 * 0036's 44px minimum is a property of the interactive element a thumb has
 * to land on, and this button already carries the `Button` component's
 * `touch` size for exactly that reason (button.tsx's own comment on why
 * Settings controls default away from the pointer-sized `h-8`).
 *
 * Extracted from settings-page.tsx (#202), unchanged. Deliberately kept a
 * separate component from `SmartDatesRow` (smart-dates-row.tsx) here rather
 * than unified with it — that component's own doc comment gives the
 * reasoning.
 */
export function DestinationVisibilityRow({
  label,
  hidden,
  onToggle,
}: {
  label: string;
  hidden: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-sm">{label}</span>
      <Button
        type="button"
        size="touch"
        variant={hidden ? "outline" : "default"}
        role="switch"
        aria-checked={!hidden}
        aria-label={`${label} in the chat list`}
        onClick={onToggle}
      >
        {hidden ? "Hidden" : "Visible"}
      </Button>
    </div>
  );
}
