/**
 * Todoist's **current** label/project/filter palette — twenty named
 * swatches, verified against a live source rather than any package that
 * happened to come up first in a search (issue #170's brief names this
 * trap explicitly: the palette most npm packages and gists still ship is
 * the *pre-2024* one, where `red` is `#DB4035`. Todoist repainted the
 * whole palette for dark-theme contrast in 2024 and `red` became
 * `#DC4C3E` — one letter away from the old value, which is exactly why a
 * stale copy is so easy to ship by accident and so hard to notice in
 * review). Every hex below was cross-checked against the current API's
 * `id`s (30-49) reported by a source dated after that repaint, not copied
 * from the first plausible-looking table found.
 *
 * Kept as a flat, ordered array rather than a `Record<name, hex>` because
 * the numeric `id` matters too: it's the value Todoist's own API still
 * uses on the wire, so a future sync integration for Labels (out of this
 * ticket's scope — see label-store.ts's own header comment on why Labels
 * don't sync yet) has a stable foreign value to map onto without this
 * module changing shape.
 */
export interface LabelColour {
  id: number;
  name: string;
  hex: string;
}

export const LABEL_COLOURS: readonly LabelColour[] = [
  { id: 30, name: "berry_red", hex: "#B8255F" },
  { id: 31, name: "red", hex: "#DC4C3E" },
  { id: 32, name: "orange", hex: "#C77100" },
  { id: 33, name: "yellow", hex: "#B29104" },
  { id: 34, name: "olive_green", hex: "#949C31" },
  { id: 35, name: "lime_green", hex: "#65A33A" },
  { id: 36, name: "green", hex: "#369307" },
  { id: 37, name: "mint_green", hex: "#42A393" },
  { id: 38, name: "teal", hex: "#148FAD" },
  { id: 39, name: "sky_blue", hex: "#319DC0" },
  { id: 40, name: "light_blue", hex: "#6988A4" },
  { id: 41, name: "blue", hex: "#4180FF" },
  { id: 42, name: "grape", hex: "#692EC2" },
  { id: 43, name: "violet", hex: "#CA3FEE" },
  { id: 44, name: "lavender", hex: "#A4698C" },
  { id: 45, name: "magenta", hex: "#E05095" },
  { id: 46, name: "salmon", hex: "#C9766F" },
  { id: 47, name: "charcoal", hex: "#808080" },
  { id: 48, name: "grey", hex: "#999999" },
  { id: 49, name: "taupe", hex: "#8F7A69" },
] as const;

// A Label needs *some* colour the moment it's created, before the user
// has picked one — `charcoal` (id 47) is a neutral mid-grey rather than
// any of the palette's more opinionated hues, and matches the default a
// third-party Todoist automation tool (independently) falls back to for
// the same reason: it reads as "no colour chosen yet," not as an
// accidental pick from the coloured end of the palette.
export const DEFAULT_LABEL_COLOUR = "#808080";

const HEX_BY_VALUE = new Set(LABEL_COLOURS.map((c) => c.hex));

/** True when `hex` is one of the twenty palette values above, case-sensitive (they're stored upper-case). */
export function isValidLabelColour(hex: string): boolean {
  return HEX_BY_VALUE.has(hex);
}
