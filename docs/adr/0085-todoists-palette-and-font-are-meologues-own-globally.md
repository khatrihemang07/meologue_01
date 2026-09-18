# 0085: Todoist's palette and font are meologue's own, globally

## Status

Accepted. **Supersedes [0069](0069-todo-renders-through-its-own-token-scope.md)** — the
`[data-surface="todo"]` token scope that ADR built is deleted, not narrowed. Reverses 0069's own
rejected alternative #1 ("repaint the whole application in Todoist's palette") deliberately, with
its stated cost now accepted rather than refused. Also retires the four-value "completed checklist
item" Settings option (issue #163), and corrects `THEME-01`'s status in the parity ledger from
`blocked` to `divergent` (closed by decision on 2026-09-11).

## Context

Issue #223 (ADR 0069) gave Todo its own palette and font, scoped to `data-surface="todo"` on
`documentElement` — claimed while on a `/todo/*` route, and a second time by `composer-page.tsx`
while its Task detail overlay was open, since that overlay is the real `TaskDetailView` rendered
over `/composer`, outside the route's own claim. Two independent claimants meant a ref count, and a
ref count meant the attribute was added and removed at runtime, every time a Task detail opened or
closed.

Opening a Task detail from a checkbox in an Entry made the whole screen behind it visibly jitter for
a frame: the neutral tokens re-pointed, and the font re-pointed with them, because `--font-sans` sat
inside `@theme inline` — Tailwind bakes that token's literal value into the compiled `font-sans`
utility at build time, so the scope's runtime override of the *token* was inert, and needed a bare
`font-family: var(--font-sans)` declaration riding alongside it to actually take effect. That bare
declaration is what recomputed every text node's font the instant the attribute landed, one frame
after the dialog itself had already painted. The visible jitter was largely this reflow, not the
dialog opening.

Two ways to close it:

1. Make the claim land before paint, avoiding the one-frame gap. This does not touch the reflow
   itself — every text node still re-fonts and every neutral still re-paints, just without the
   visible delay before it does. The jitter would soften, not disappear, and the mechanism (two
   claimants, a ref count, an attribute that comes and goes) stays exactly as complex as it is
   today.
2. Delete the switch. If Todoist's palette and font are the app's own, unconditionally, there is
   nothing left to claim, release, or race, and nothing left to reflow — the tokens never change
   value while a Task detail is open, because they never change value at all.

## Decision

**Todoist's re-pointed neutrals, its font, and its `--td-*` tokens move into `index.css`'s plain
`:root` and `.dark` — global and unconditional. The `data-surface="todo"` mechanism is deleted:
`lib/todo-surface.ts`, both `useTodoSurface` call sites (`chat-shell-layout.tsx`,
`composer-page.tsx`), the two JSX sites in `task-schedule-popover.tsx` that re-declared the
attribute on a portalled node, and every test asserting on the document root's attribute.**

`--font-sans` is set once, at its real source — the `@theme inline` literal in `index.css` — rather
than re-pointed as a custom property with a bare `font-family` declaration alongside it. There is no
second value competing with it any more, so the workaround that made the token-and-property split
necessary is gone with the scope that needed it.

Two of the scope's overrides are dropped rather than carried across, because measurement shows they
never changed anything:

- **`--radius`.** The scope set it to `10px`; the base `:root` already carries `0.625rem`, which is
  exactly `10px` at the default root font-size this app never overrides. The override was inert from
  the day it shipped.
- **Dark `--muted`.** The scope set it to `rgb(38, 38, 38)`; the base dark block already carries
  `oklch(0.269 0 0)`, which is the identical colour. Same story.

Everything else the scope re-pointed — `--background`, `--foreground`, `--border`,
`--muted-foreground`, `--card`, `--card-foreground`, `--popover`, `--popover-foreground`, all 45
`--td-*` tokens, and `--checked-list-text-decoration`/`--checked-list-text-color` — carries across
unchanged in value, just unconditional now instead of attribute-gated.

**The four-value "completed checklist item" Settings option (issue #163) is retired.** It offered a
choice between UpNote's four looks for a ticked checklist item; Todo's own rows never obeyed it
(ROW-15 pinned them to Todoist's always-struck-through grey regardless), so once the rest of the app
adopts Todoist's palette wholesale, carrying a Settings option that Todo itself never listened to
stops making sense as a separate axis. `lib/settings.ts`'s `CompletedStyleId`, `COMPLETED_STYLES`,
`DEFAULT_COMPLETED_STYLE` and their storage helpers are deleted; `lib/theme.ts`'s
`applyCompletedStyle` is deleted; the picker (`composer-section.tsx`, `completed-style-row.tsx`) is
deleted; `apps/e2e/tests/completed-style.spec.ts` is deleted. `--checked-list-text-decoration` and
`--checked-list-text-color` become fixed `:root` values — line-through, Todoist's own grey — so
History, the Composer and Todo render a completed item identically, everywhere, always. ROW-15 stays
`matched`: it was already asking for exactly this look on Todo's own rows.

A stored `meologue.completed-style` value is tolerated, not migrated. `lib/settings.ts`'s generic
`applyDeviceSettings` writes any `meologue.*` key through unconditionally on a Restore, with no
per-key allowlist — a Device that restores an old backup, or one that simply still has the key from
before this change, keeps it sitting in `localStorage`. Nothing reads it any more, so nothing needs
to guard against it: silence is the whole of the tolerance.

**`THEME-01`'s stale status is corrected.** ADR 0069 and `index.css` both recorded it as `blocked`,
pending a light-theme capture pass. The ledger has recorded it as `divergent` since 2026-09-11, on
the owner's decision that "meologue's light theme is its own design, not a replica, and light-mode
parity rows are no longer tracked" — no capture pass was ever coming, and this decision predates
this ADR by a week. Both in-repo references are corrected to match; the ledger itself is untouched
here.

## Consequences

**What this buys:** opening a Task detail over the Composer, or entering and leaving Todo, changes
nothing about the screen behind or around it — no recolour, no re-font, no layout movement, because
there is no longer a switch whose position that screen ever depended on. The two-claimant ref-count
mechanism, and the risk of the two claims disagreeing that came with it, is gone along with the
scope it protected. `task-priority-colors.ts`'s two-mapping design (row ring vs. picker swatch) is
unaffected — that split was never about the scope, only about two independently measured surfaces.

**What this costs:** meologue no longer has a visual identity distinct from Todoist's inside this
app. Every neutral surface, every text node's font, and 45 named accents are Todoist's own,
everywhere — the Composer, Reflect, Digest and History all render in the palette ADR 0069 confined
to `/todo/*`. This is the cost ADR 0069 weighed and refused under its rejected alternative #1: "it
would make the Composer look like a task manager, which is the opposite of what this app is." That
argument is not wrong; it is outweighed here by the reflow the switch itself was causing, and by the
judgment that one consistent look costs less than a mechanism built to prevent recolouring the app
while still recolouring it, briefly, every time a Task detail opened.

The four-value completed-style choice is also gone. A reader who picked "Strikethrough" or "None" in
Settings loses that choice; every completed checklist item everywhere now renders Todoist's own
always-struck-through grey. This was accepted because Todo — increasingly the majority of what a
completed checklist item renders as, and the one surface the option never applied to — already
disagreed with whatever the other three surfaces had chosen, and issue #351 does not add a second
switch to close that gap when the alternative is removing the switch entirely.

**Light theme stays an unverified approximation**, exactly as ADR 0069 shipped it — this ADR moves
where those values live, not what they are — but it is no longer tracked as an open gap. `THEME-01`
is closed `divergent`; there will be no future light-theme capture pass to close it further.

## Alternatives considered

- **Land the claim before paint (option 1 above).** Rejected: it treats the symptom (a visible delay
  before the reflow) rather than the cause (a reflow happens at all), and keeps the two-claimant
  ref-count mechanism, and its failure mode if the two claims ever disagree, fully in place for no
  reason once the reflow itself is gone.
- **Keep the scope, fix only the font's bare-declaration workaround.** This would have stopped the
  re-font half of the jitter while leaving the neutral re-paint half untouched, and kept every
  claim/release/portal-re-declaration mechanism this ADR deletes. A partial fix to a mechanism this
  ADR concludes should not exist at all.
- **Keep the four-value completed-style option, make it apply to Todo too.** Rejected: ROW-15 is a
  parity row, not a preference — Todoist's own completed rows are not optional, so making Todo obey
  a fifth, "Todoist" completed-style value would have meant either breaking parity when a reader
  picked one of the other four, or a fifth choice that always just re-selected itself back to what
  Todo already did unconditionally. Deleting the choice is simpler and matches what Todo already
  enforced.
