## What to build

Two small, independent defects in Quick Add.

**1. The field renders at the wrong size.** Todoist's Quick Add title is **16px with a 23px line
height**. meologue's drops to 14px at desktop width. This is not cosmetic trivia: it is why the
recognition chip measures 29.41px here against Todoist's 32.31px. The horizontal padding matches
exactly; the glyphs inside it don't, because the font is smaller.

The correct values are **already declared** as design tokens for this surface — `16px` and `23px` —
with **zero consumers anywhere in the repo**. The component hardcodes the wrong values beside them.
A declared token that nothing reads is not an implementation, and this is the clearest example of
that trap in the codebase.

**2. A recognised priority emits the wrong identifier.** Typing `p1` — Todoist's most urgent —
produces a match identifier of **`P4`**. The recognition code reads the *stored* priority number,
and storage inverts the scale (ui 1 ↔ stored 4). The type definition explicitly warns against
using the stored number without crossing that inversion, and this is a place that never crosses it.

This is invisible today, because nothing renders a priority chip from that identifier yet — but the
existing test **pins the wrong answer**, so it will stay wrong until something displays it. Fix the
inversion and correct the test.

## Acceptance criteria

- [ ] Quick Add's title field renders at 16px / 23px line-height at all widths
- [ ] The existing unused type tokens for this surface are what the component reads — no hardcoded
      duplicates left beside them
- [ ] A recognised match chip measures 32.31px recognised and 24.31px withdrawn, matching Todoist
- [ ] Typing `p1` produces a match identifier of `P1`; `p4` produces `P4`
- [ ] The test asserting the inverted identifier is corrected rather than deleted
- [ ] Affected parity ledger rows restatused

## Blocked by

None — can start immediately.
