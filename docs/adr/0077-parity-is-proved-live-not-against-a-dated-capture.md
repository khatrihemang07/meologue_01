# 0077: Parity is proved live against Todoist, not against a dated capture

## Status

Accepted. **Reverses the "What a status is pinned to" section of
`meologue-reference/todoist/parity-ledger.md`**, which is amended to point here rather than to keep
asserting the rule this ADR overrides. Does not touch that file's status vocabulary
(`todoist-captured` / `built` / `matched` / `divergent` / `blocked`), nor its three axes for what
`matched` requires — only the question of *what a row is measured against*.

## Context

The ledger's own rule was explicit: **rows pin to a dated capture, never to the live product.** The
argument was good. A definition-of-done cannot chase a moving target, or "done" is never reachable;
Todoist ships changes on its own schedule, and a row silently going wrong because someone else
deployed is not a defect in this repo. `SCHED-02` is the worked example the rule was written for —
the scheduler's quick options read `Today · Tomorrow · This weekend · Next week` on 10 Sep and
`Today · Tomorrow · Next week · Next weekend` on 11 Sep. Nothing here broke; the reference moved.

The stated cost was accepted openly: the ledger is knowingly behind whatever Todoist shipped most
recently, and drift is reconciled by a full re-capture at the start of each parity programme.

**What changed is not the strength of that argument but the discovery of what pinning actually
bought.** A pin is only as good as the evidence behind it, and the most-cited captures had none that
survived. `pass2-2026-09-11.md`, `rename-capture-2026-09-11.md`, `verification-2026-09-11.md` and
`audit-2026-09-11.md` are all detailed, driven measurements whose raw artifacts were left in a
session scratchpad and never committed — recoverable only by accident, and only for as long as
`/tmp` survives. A future reader could not check any of them.

That is not hypothetical. Two wrong claims propagated out of exactly that gap:

- `verification-2026-09-11.md` explained a chip-width miss as "meologue renders Geist; Todoist
  renders its own stack," and a session handoff carried it forward as a "big decision" about
  matching font stacks. It is false. `[data-surface="todo"]` declares the system stack and applies
  `font-family` **unlayered** on `documentElement`, which beats the layered `html{font-family:Geist}`
  on both layer order and specificity; neither `EDITOR_BOX_CLASSES`, `.tiptap` nor
  `.td-recognition-match` sets a font. `THEME-05` — already reading `matched` — was right all along.
- The two numbers being compared were measured on **different strings**: Todoist's 32.31px was read
  with `tod` typed, meologue's 36.14px with `tom`. At 16px, substituting `m` for `d` accounts for
  very close to the entire +3.83px "residue" the document attributed to typeface, and explains why
  it was constant across both the recognised and withdrawn states.

A pinned row whose evidence cannot be re-opened is not a stable reference. It is an assertion with a
date on it, and it decays exactly like the thing pinning was supposed to protect against — worse,
because it reads as settled.

## Decision

**A row is established by driving both applications in the same session and reading both sides then.
Todoist's live behaviour at that moment is the reference, and the row's evidence names the date it
was driven.**

Raw artifacts — the computed-style reads and the screenshots — are committed into the corpus
alongside the prose. A measurement whose artifact is not in the repo is not finished.

## Consequences

**The ledger now tracks a moving target, and that is the trade this ADR accepts.** A row can go
stale because Todoist shipped, not because meologue regressed, and the two look identical from
inside this repo until someone re-drives. The defence is no longer a pin date; it is that every row
carries evidence a reader can re-open and check against the live product in minutes.

Re-driving is therefore an ongoing cost rather than a once-per-programme one. The eight distinct
Todoist flows the 125 rows collapse into make that tractable — it is roughly eight sessions of
driving, not 125.

**Rows blocked by plan tier are unaffected.** Deadline, Duration and the Deadline picker are behind
Todoist's Pro paywall and light theme was shown unreachable on this account; those are blocked on
product access, not on capture date, and no amount of live driving reaches them. They stay
`blocked`, with the reason recorded — which the matched-or-divergent rule this programme works under
explicitly permits.

**`SCHED-02` is the first row this changes.** Under the old rule it kept its 10 Sep status with a
note; under this one it is restatused against what Todoist renders now.

## Alternatives considered

- **Keep pinning to a dated capture.** Rejected, but not because the reasoning was wrong — it is
  still the better argument in the abstract. It was rejected because the failures this programme
  actually suffered came from unverifiable pinned prose, not from drift. Pinning defended against a
  risk that never materialised while the real one went unguarded.
- **Pin, but commit the raw artifacts.** The honest middle, and genuinely tempting: it fixes the
  defect above without taking on a moving target. Rejected because it still answers "is meologue at
  parity?" with "against something Todoist no longer does," and the question this rebuild exists to
  answer is about the product as it ships.
- **Hybrid — pin dimensional rows, drive behavioural ones live.** Rejected: it reintroduces the
  ambiguity the status vocabulary was written to remove, since a reader must then also know *which
  kind* of row they are looking at before they know what its status means.
