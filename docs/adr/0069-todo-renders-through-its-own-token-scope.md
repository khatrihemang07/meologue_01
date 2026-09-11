# 0069: Todo renders through its own token scope

## Status

Accepted. Narrows the palette rule stated in `index.css`'s own `--entry-accent` comment — grayscale
plus one reserved accent — to everywhere *except* `/todo/*`. Depends on
[0005](0005-one-vite-application-build-time-platform-seam.md), since one Vite application means one
stylesheet and therefore one place this carve-out can live. Read alongside
[0076](0076-todos-navigation-is-what-the-shells-existing-pane-renders.md), which takes the same
destination further.

## Context

Todo exists to be Todoist. `CONTEXT.md` already commits this repo to that in writing, in the one
glossary entry admitted on a different ground than every other — *"Project" — admitted, with a
note* — whose whole argument is that parity with Todoist is a source this build will be read
against for years.

An audit of the shipped Todo against the real application (`docs/reference/todoist/`) found the
divergence was not a handful of details. Dates render in one grey where Todoist carries a tone;
the row omits labels, project and a description indicator entirely; the type scale, the density and
the palette are this app's own throughout. The instruction was to make Todo an exact clone,
visually and functionally.

That collides with a rule the rest of the app is built on. `index.css` reserves a single accent hue
— user-selectable in Settings, defaulting to blue — and every other colour in the application is
achromatic. It is a real design position, not an accident, and it is why the Composer, Reflect and
Digest look like one product.

Three ways to hold both:

1. Repaint the whole application in Todoist's palette. Rejected outright: it would make the
   Composer look like a task manager, which is the opposite of what this app is.
2. Give Todo's components their own colour literals, inline. This is what
   `task-priority-colors.ts` already did — four hard-coded `rgb()` values sitting outside the token
   system, sampled from a live Todoist and slowly drifting from it. It works until a second
   component needs the same colour, and then there are two copies.
3. Scope the tokens themselves.

## Decision

**Todo renders inside a token scope keyed off `data-surface="todo"`, and the scope is a real,
checkable mechanism rather than a convention.**

The attribute is set in `chat-shell-layout.tsx`, on the one element that is an ancestor of both the
open destination *and* the left pane. That placement is load-bearing: ADR 0076's sidebar renders in
that pane, outside `Shell`, and must inherit the identical palette. One attribute reaches both; an
attribute on `Shell` would have reached only the page.

Two rules make the scope safe to add without auditing every component that already exists:

**Re-point, don't rename.** `--background`, `--foreground`, `--border`, `--muted`,
`--muted-foreground`, `--radius` and `--font-sans` are the names shadcn's primitives already read.
Overriding their *values* inside the attribute selector repaints every existing control with no
component edit at all. This is the same mechanism `[data-accent]` and `[data-completed-style]`
already use for narrower questions; it is not a new idea, only a wider application of one.

**A new `--td-*` prefix for what Todoist has and this palette has no token for**: a second,
deliberately different priority red, the Date family's tones, the recognition highlight, calendar
and composer chrome. Custom properties inherit, so a distinct prefix is what stops one leaking
outside the scope by accident — nothing outside `[data-surface="todo"]` ever sets a `--td-*` name,
so a component reading one elsewhere gets nothing rather than a silently-borrowed Todoist colour.

**`--entry-accent` is untouched.** It stays at `:root`, the five choices stay in Settings, and every
non-Todo surface keeps reading it. The three `--quick-add-*` tokens are re-pointed inside the scope
but never redefined, because `quick-add-highlight.ts` is shared with the Composer's checklist
rendering — a destination this ADR explicitly does not touch.

## Consequences

The palette rule now has a stated exception rather than an implicit one. A reader who finds a
Todoist red in this codebase can see where it is allowed to apply and where it is not, which was
not true of the four literals this replaces.

**Light theme is unverified.** Todoist was only ever observed in dark theme, so every measured value
here is a dark value. The light block is a derivation, commented as such, and recorded as `THEME-01`
in the parity ledger with status `blocked`. It will stay that way until either a light-theme capture
pass happens or the product decides Todo is dark-accurate and light-approximate. Shipping a guess
that reads as a measurement is the one outcome this ADR refuses.

**Two reds stay two reds.** The priority picker's swatch and the row's checkbox ring were measured
as genuinely different values. They are two tokens, and `task-priority-colors.ts` carries a comment
saying so, because unifying them is the obvious "cleanup" a future reader will otherwise perform.

## Alternatives considered

- **A second stylesheet, or a Tailwind config fork.** There is no Tailwind config file — v4 is
  configured in CSS — so a fork would have meant inventing a build seam that does not otherwise
  exist, to solve a problem one selector already solves.
- **Class names instead of a data attribute.** A class would have to be applied by every Todo
  component, which is exactly the per-component edit this design exists to avoid. The attribute is
  set once, on an ancestor both the pane and the page already share.
