# 0084: The phone bar is four destinations and a Browse hub

## Status

Accepted. Ratified by the owner 2026-09-16.

**Resolves the phone-bar fork**, which a since-retired ADR named as an
open fork and explicitly assigned to the owner rather than to whoever drove next: *"whether
meologue's phone adopts a `Browse` hub and drops from six destinations to four — is the largest of
these and has no issue of its own yet."* It is applied under that ADR's own per-platform rule, and
takes nothing from it.

Amends the destination set of [0049](0049-todo-is-the-first-destination-with-internal-navigation.md)
without touching its argument, and depends on
[0083](0083-todo-renders-inside-the-shell-like-every-other-destination.md) for the breakpoint the bar
now renders below.

## Context

`TodoNav` carried six destinations — Inbox, Today, Upcoming, Filters, Activity, Projects — flattened
into one bar. Todoist Android carries four: Inbox, Today, Upcoming, and **Browse**, with Search,
Filters & Labels, Reporting and Projects consolidated behind that fourth tab. Read live on the device
2026-09-16 against Todoist v12278.

**Two independent arguments point the same way, and only one of them is about Todoist.**

The first argument is that meologue's Android build follows Todoist Android, and this is the largest
structural disagreement between them.

The second argument is accessibility, and it would hold even if Todoist did not exist. A live
measurement puts meologue's tab target at 68.1 x 46 CSS px against Todoist's 100.6 x 80.0, and
names the cause: *"meologue's tab target is 46 CSS px — under the 48dp minimum, and 34px shorter than
Todoist's. Six tabs in 426px is what forces it."* Six tabs across a 426px phone cannot be given a
48dp target; four can. `todo-nav.tsx`'s own `min-w-0` comment already records the earlier stage of
this same squeeze — at 320px the six-tab bar overflowed its own container, `scrollWidth` 369 against
`clientWidth` 320, pushing Filters clean off the viewport.

This is recorded because a future reader will otherwise read the change as pure mimicry and may
undo it on the grounds that meologue need not look like Todoist. The tap target is the part that
does not depend on that premise.

## Decision

**The bar carries Inbox, Today, Upcoming and Browse. Search, Filters & Labels, Reporting and Projects
move behind Browse. The bar's items are 80 CSS px tall, and the active indicator is a pill behind the
icon alone.**

**The bar list is derived from the full destination list, not typed a second time.** This is the one
implementation detail the ADR fixes rather than leaves free, because
`todo-nav-destinations.ts`'s own header records the defect it exists to prevent: two hand-maintained
lists produced an unreachable destination twice — `/todo/upcoming` (issue #223) and `/todo/projects`
(defect 33) — each shipping because one list was updated and the other was not.

The invariant that file protected was *identity*: every destination appears in both navigations. That
invariant is now false by construction, since the bar deliberately carries four of six. **It is
replaced by reachability**: every destination in the full list is reachable from the bar or from
Browse. A weaker claim, and the strongest one still true — an invariant that merely restates the
code would not have caught either original defect.

**Width-gated, not platform-branched.** The bar renders below 1200px on every target, so a narrow
desktop window gets Browse too. No Todo component is branched by build target, and that is
load-bearing evidence here — `vite.config.ts` resolves six aliases per target and every one
is a platform shim, never a UI component. Branching here to keep six tabs on narrow web would have
been the first exception, bought for a shell nobody has measured against either reference.

**meologue's Browse is four rows, not Todoist's eleven.** Todoist's screen also carries a profile
header, a "Try Pro for free" promo, Add a team, Browse templates and Help & resources. Those are
product surfaces meologue has no equivalent for, and inventing rows to fill a hub would be copying a
shape rather than matching a behaviour.

**Search keeps both doors, and this is a deliberate divergence.** Todoist Android reaches Search only
through the Browse row — confirmed on the device: no toolbar icon, Today's overflow menu offers only
"Select tasks" and "View activity", and a pull-down gesture surfaces nothing. meologue keeps
`todo-page.tsx`'s existing in-column Search link (issue #307) **and** gains the Browse row. The owner
chose reachability over fidelity here. It is recorded as a divergence rather than left to look like
an oversight, and it carries a cost: two elements named "Search" can be on screen at once, so
locators in this area must be scoped to a named landmark or they break on strict-mode ambiguity.

### What was measured and what was approximated

The active indicator was measured, not eyeballed. The pill sits behind the icon alone — the label's
box begins 13-23 device px below the pill's lowest painted pixel, with no overlap. Its painted
profile is **elliptical**: 90px wide at the top, 158px flat across the centre, 96px at the bottom.
That cannot be expressed as a single `border-radius`, which describes a stadium with constant-width
sides. **meologue builds a stadium and accepts the difference** rather than reproducing an ellipse;
chasing it would be pixel devotion with no behavioural content.

Colours were sampled from screenshot pixels on two tabs across two screenshots, since a
`uiautomator` dump carries no colour at all: active pill `rgb(71,37,37)` on a `rgb(38,38,38)` bar,
active icon `rgb(222,76,74)`, active label `rgb(240,127,117)`, both inactive inks `rgb(179,179,179)`.
The icon and label inks **differ when active and match when inactive** — an asymmetry that reads as
an accident until measured, which is the reason it is written down.

**Those values are not copied into meologue.** They are a dark-theme reading of a different product,
and Todo renders through its own token scope (ADR 0069) in two themes. The structure is adopted —
pill behind the icon, label taking its own colour distinct from the icon's — and bound to meologue's
existing `--td-*` tokens.

## Alternatives considered

- **Cut to four tabs and file Browse separately.** Fixes the tap target immediately and is a much
  smaller change. Rejected: it would ship Filters, Reporting and Projects with no phone-reachable
  route at all, which is the "a feature nobody finds" outcome 0049 already rejected by name.
- **Keep six tabs and fix the tap target another way.** There is no other way at 426px; the width is
  the constraint. Scrolling the bar hides destinations behind a gesture with no affordance, which is
  the same defect in a new costume.
- **Branch by build target so only Android changes.** Rejected above: it buys a narrow-web shell
  nobody measures against, at the cost of the first target-branched UI component in Todo.
- **Reproduce Todoist's Browse screen in full.** Rejected: most of its rows are Todoist product
  surfaces, and a hub padded with invented rows matches a silhouette rather than a behaviour.

## Consequences

**Two measurements sit next to a changed bar and must be re-driven, not assumed.** The Quick Add
FAB (56 CSS px, 16 CSS px above the bar) and the status-bar inset. Reading the source says
`floatingAction` is anchored to a wrapper whose bottom edge is `TodoNav`'s top edge regardless of
the bar's height, so neither should move — but that is a source fact, not a reading, and those are
different claims with different failure modes.

**The 900-1199px band gains its load-bearing role from this ADR.** 0083 created a band where the
chat list and the bar are both on screen and `TodoSidebar` is not. In that band Browse is the *only*
route to Search, Filters, Reporting and Projects. A future change that restores six tabs, or moves
Browse behind a width gate, silently strands four destinations at exactly those widths — and
the suite will not necessarily catch it, since that band shipped two separate defects already and
stayed green through both.
