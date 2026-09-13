# Todoist capture — resolution on rename (2026-09-11)

Supplements `pass2-2026-09-11.md`. Captured to close a gap that programme had left open: **every
prior capture measured recognition in Quick Add only.** Nothing in `pass2-2026-09-11.md` or
`quick-add.md` recorded what Todoist does when a recognised phrase is typed while **renaming an
existing Task**, which is precisely the behaviour issue #247 builds. `task-detail-view.tsx`'s own
comment named that silence as its reason for committing a renamed title unparsed.

That silence is now closed by measurement rather than inference.

## Method

Driven against the real Todoist web app in `ego-browser`, on the user's own account, dark theme.

A **throwaway probe Task** was created in Inbox, renamed repeatedly, and deleted at the end. No
existing Task was renamed, rescheduled, completed or deleted, and **no Project was created** (the
account is on the free plan, capped at 5 — exceeding it turns one of the user's own Projects
view-only).

**Dark Reader is installed in this browser profile**, so every colour below was taken only after
confirming it was not restyling the page: `style.darkreader`, `[class*="darkreader"]` and
`[data-darkreader-inline-bgcolor]` each counted **0** at every measurement.

Colours were read from the **painted leaf `<span>`**, not the enclosing
`[data-testid="due-date-control"]` button — that button inherits white and contains a 1×1
visually-hidden label, the trap that made two earlier runs contradict each other.

## What was measured

Todoist has two rename surfaces, and **both resolve**. In every case the recognised phrase was
**stripped from the stored title**, exactly as Quick Add strips it.

| Surface | Typed | Stored title afterwards | Field set |
|---|---|---|---|
| Inline row rename (hover **Edit** pencil) | `meologue parity probe tom` | `meologue parity probe` | Date = "Tomorrow", `class="date date_tom"`, `rgb(255, 154, 20)` |
| Detail dialog title | `meologue parity probe tom` | `meologue parity probe` | Date = "Tomorrow"; a toast reads **"Date updated to Tomorrow"** with Undo/Close |
| Inline row rename | `meologue parity probe p1` | `meologue parity probe` | Priority P1 — `priority_4` class, flag SVG `rgb(255, 112, 102)`; the row re-sorted upward |
| Detail dialog title | `meologue parity probe p1` | `meologue parity probe` | Priority field reads "P1" |

### Notes that matter for the build

- **Both surfaces behave identically.** There is no Todoist-side distinction between renaming in
  the row and renaming in the detail dialog — which is the reference for #247's requirement that
  both go through one shared door rather than two implementations.
- **Todoist announces the side effect.** The detail-dialog rename raised a toast naming the field
  it changed, with an Undo. meologue has no equivalent; this is an observed divergence, not
  something #247 is required to build, and is recorded here so it reads as known.
- **`priority_4` is Todoist's storage numbering for UI "P1"** — the same inversion meologue's own
  `storedPriorityOf` applies (ui 1 ↔ stored 4). This capture independently corroborates that
  inversion from the other side of the wire; see issue #251, where meologue's recognition code
  reads the stored number without crossing it and emits `P4` for a typed `p1`.
- **Tomorrow's orange `rgb(255, 154, 20)` matches `pass2-2026-09-11.md`'s own measurement** (its
  §1 table, re-read four times across separate browser processes), taken in a separate session
  against a different surface. Two independent captures agreeing is the strongest evidence in this
  corpus for that value, and it is the colour issue #250 builds.
  **But it is a Dark-theme value only.** `pass2` §1 also records that these colours are not fixed
  across themes: under Todoist's own named theme the same Tasks read `rgb(113,250,149)` (today) and
  `rgb(255,180,83)` (tomorrow). This capture was taken in **Dark**, as the whole corpus is, so a
  replica built to these numbers matches Dark and nothing else. Issue #250 states its target
  colours without naming a theme; that omission is the ticket's, not the corpus's, and the
  constraint belongs in whatever ledger row #250 restatuses.
- **Not captured:** whether a phrase that fails to resolve clears an existing Date, and whether a
  rename containing no phrase at all leaves Date/Deadline/Priority/Labels untouched. Neither was
  exercised, so meologue's conservative rule — only ever *set* a field when a phrase actually
  resolved, never clear one the reader didn't touch — remains an unevidenced choice rather than a
  measured match. It is the safe direction, but it is not parity-proven.

## Account state afterwards

- Probe Task deleted through More actions → Delete, confirmed on the "Delete task?" dialog, which
  named the probe explicitly.
- Inbox verified back to its pre-session baseline: 14 active Tasks, same titles, dates and order;
  Inbox badge back to 7. One Project ("Getting Started 👋"), unchanged.
- **One near-miss, recorded rather than omitted:** a stale element reference put a single click on
  an existing Task's Date-picker button. It was dismissed with Escape without selecting a date, and
  that Task's title, Date ("Tomorrow") and Priority ("P4") were then read back directly and
  confirmed unchanged. This is the same live-sync re-render hazard that completed a real Task
  during an earlier programme's capture — the reason captures run one browser agent at a time.
