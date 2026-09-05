import { Button } from "@/components/ui/button";
import type { CompletedStyleId } from "@/lib/settings";

/**
 * One row of the "Completed checklist item" section (issue #163) — a full
 * width `aria-pressed` toggle, not a `ChoiceRow` (choice-row.tsx): that
 * control's own doc comment fixes its grid at three or five even columns,
 * sized for a short word or a swatch, and "Grayed out and strikethrough"
 * truncates badly at either width on a phone. A stacked row can be as wide
 * as the whole section instead.
 *
 * The point of this control is "choose by looking," not "choose by
 * reading" — so each row renders a real sample checklist item in its own
 * style below the label, rather than describing the style in more words.
 * That sample wears the exact markup shape a real checked task item has in
 * both render paths (a `<li class="... list-none ...">` holding a checked
 * `<input type="checkbox">` beside a sibling `<div>` — see
 * `entry-prose.tsx`'s `renderListItem` and `composer-editor.ts`'s
 * `listItemNodeView`), which is what lets `index.css`'s one shared rule
 * (`li.list-none input[type="checkbox"]:checked ~ div`) style this sample
 * too, with no second, hand-written mapping of style id to colour and
 * decoration living here. `data-completed-style={option.id}` on the small
 * wrapper around the sample is what feeds that rule THIS row's own option
 * rather than whichever one is actually selected right now — the two
 * custom properties the rule reads resolve from the nearest ancestor
 * carrying the attribute, and this wrapper sits closer to the sample than
 * `<html>` does.
 *
 * The sample is `aria-hidden` and its checkbox `disabled`: it exists to be
 * looked at, not tabbed to or announced twice on top of the row's own
 * label, which is already this `Button`'s full accessible name.
 *
 * Extracted from settings-page.tsx (#202), unchanged.
 */
export function CompletedStyleRow({
  option,
  selected,
  onSelect,
}: {
  option: { id: CompletedStyleId; label: string };
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <Button
      type="button"
      size="touch"
      variant={selected ? "default" : "outline"}
      aria-pressed={selected}
      onClick={onSelect}
      className="h-auto w-full flex-col items-start gap-1.5 px-4 py-3 text-left"
    >
      <span className="text-sm">{option.label}</span>
      <div data-completed-style={option.id} aria-hidden="true" className="pointer-events-none">
        <ul className="m-0 list-none p-0">
          <li className="flex list-none items-baseline gap-1.5">
            {/*
             * A drawn box, deliberately NOT an `<input type="checkbox">`.
             * This preview is decorative — it illustrates what a finished
             * item looks like; there is nothing here to tick. A real form
             * control was a genuine defect, and `settings.spec.ts` caught
             * it: that suite's touch-target sweep finds controls with the
             * CSS selector `fieldset input`, which `aria-hidden` does not
             * exclude, and reported a 13px-tall, unnamed, focusable,
             * tabbable checkbox in each of these four rows. Four extra tab
             * stops that announce nothing, inside a button that is itself
             * the control. A `<span>` cannot be focused, cannot be tabbed
             * to, and cannot be mistaken for something to click.
             *
             * `border-current` rather than a fixed colour: these rows
             * render on both the `default` and `outline` Button variants,
             * whose foregrounds differ, and the box has to stay visible on
             * each. The sample TEXT beside it deliberately does not inherit
             * that — it wears `.completed-sample`, which reads the same two
             * custom properties the real render paths read, so the preview
             * is showing the actual styling rather than an imitation of it.
             */}
            <span className="mt-[0.2em] flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border border-current text-[0.6rem] leading-none">
              ✓
            </span>
            <div className="completed-sample min-w-0 flex-1 text-sm">Buy milk</div>
          </li>
        </ul>
      </div>
    </Button>
  );
}
