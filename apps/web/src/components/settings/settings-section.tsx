import type { ReactNode } from "react";

/**
 * One section's shape, so every section on this page has the same one
 * (#128). The label, the optional line explaining what the control does,
 * and the control itself sit at fixed gaps here rather than being written
 * out five times — which is how a page ends up pairing its tightest gap
 * with its heaviest control and nobody notices.
 *
 * A `<fieldset>` with a real `<legend>`, so the visible label IS the group's
 * accessible name. Three of these five sections are genuinely groups of
 * mutually exclusive choices; naming them with a `<span>` and then adding
 * `role="group"` plus an `aria-label` elsewhere would say the same word
 * twice, once to a reader's eyes and once to their screen reader.
 *
 * `mb-2` on the legend rather than a gap: a `<legend>` is laid out specially
 * by the UA and is not a flex item of its own fieldset, so a `gap` on the
 * fieldset would silently not apply to the one place this page most needs it
 * to. The margin and the inner `gap-2` are deliberately the same number.
 *
 * Extracted from settings-page.tsx (#202), unchanged: this is still the one
 * shape every individual setting's own group renders inside, whichever of
 * the five topic sections (settings/*-section.tsx) happens to contain it.
 */
export function SettingsSection({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    // `min-w-0` fights the UA's own `min-inline-size: min-content` on a
    // fieldset, which would otherwise let a long status line push this
    // section wider than the column it sits in.
    <fieldset className="min-w-0">
      <legend className="mb-2 font-medium text-sm">{label}</legend>
      {hint && <p className="mb-2 text-muted-foreground text-xs">{hint}</p>}
      <div className="flex flex-col gap-2">{children}</div>
    </fieldset>
  );
}
