import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A row of mutually exclusive choices, laid out as an even grid rather than
 * a wrapping flex row.
 *
 * The grid is what stops the fifth Accent swatch from orphaning onto a row
 * of its own: a `flex-wrap` row breaks wherever it runs out of width, which
 * on a phone is after four. `grid-cols-5` is five even columns at every
 * width the app supports — 5 x 44px plus four 8px gaps is 252px, inside the
 * content width of the narrowest Device this runs on.
 *
 * `aria-pressed` toggles rather than real radios, matching what the Theme
 * control on this page already did before there were three of these: one
 * pattern for all three groups is worth more here than the marginally
 * better semantics of a radio group in one of them and not the others. The
 * group's own name comes from `SettingsSection`'s `<legend>`, not from here.
 *
 * Extracted from settings-page.tsx (#202), unchanged.
 */
export function ChoiceRow({ columns, children }: { columns: 3 | 5; children: ReactNode }) {
  return (
    <div className={cn("grid gap-2", columns === 3 ? "grid-cols-3" : "grid-cols-5")}>
      {children}
    </div>
  );
}
