import { Button } from "@/components/ui/button";

/**
 * One independent on/off fact, rendered as a real `role="switch"` with
 * `aria-checked` — not a `ChoiceRow` (choice-row.tsx): that control is a
 * fixed-width group of *mutually exclusive* options, and its own doc
 * comment is explicit that `aria-pressed` toggles there are standing in
 * for a radio group. A switch names one fact that is simply true or false
 * on its own, with no sibling option it's chosen over.
 *
 * This used to be two components — `DestinationVisibilityRow` (the "Chat
 * list" section's own "Hidden"/"Visible" copy and `"${label} in the chat
 * list"` aria-label) and `SmartDatesRow` ("Smart date recognition", plain
 * "On"/"Off") — kept apart on purpose. `SmartDatesRow`'s own doc comment
 * said building it on `DestinationVisibilityRow` "would cost more
 * legibility than the few duplicated lines below save," and that was the
 * right call at the two switch rows this repo had when both were written:
 * two near-identical fifteen-line components are easy to read side by
 * side, and a shared one would have needed copy props for a shape used in
 * exactly one place each.
 *
 * Issue #202 promotes a third switch — Composer's own format toolbar
 * visibility (`composer-section.tsx`) — onto this page, on top of the four
 * "Chat list" rows and the one "Smart date recognition" row already here.
 * Six render sites across three near-identical fifteen-line components is
 * where the old argument flips: reading three copies that differ only in
 * their on/off copy and their `aria-label` shape now costs more than the
 * two optional props (`onLabel`/`offLabel`, defaulting to "On"/"Off";
 * `ariaLabel`, defaulting to `label` itself) it takes to fold them into
 * one. This says so rather than silently overriding what the old comment
 * argued, because the old comment wasn't wrong — it was scoped to a
 * caller count this ticket outgrew.
 */
export function SwitchRow({
  label,
  checked,
  onToggle,
  onLabel = "On",
  offLabel = "Off",
  ariaLabel,
}: {
  label: string;
  checked: boolean;
  onToggle: () => void;
  /** Visible copy on the button while `checked` is true. Defaults to "On". */
  onLabel?: string;
  /** Visible copy on the button while `checked` is false. Defaults to "Off". */
  offLabel?: string;
  /** The switch's full accessible name. Defaults to `label` itself — pass this when the visible label alone would be ambiguous out of context, the way "Chat list"'s own rows need `"${label} in the chat list"` to say which list a bare Destination name refers to. */
  ariaLabel?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-sm">{label}</span>
      {/*
        `size="touch"` on the switch itself, not just the row it sits in —
        ADR 0036's 44px minimum is a property of the interactive element a
        thumb has to land on, and this button already carries the `Button`
        component's `touch` size for exactly that reason (button.tsx's own
        comment on why Settings controls default away from the
        pointer-sized `h-8`).
      */}
      <Button
        type="button"
        size="touch"
        variant={checked ? "default" : "outline"}
        role="switch"
        aria-checked={checked}
        aria-label={ariaLabel ?? label}
        onClick={onToggle}
      >
        {checked ? onLabel : offLabel}
      </Button>
    </div>
  );
}
