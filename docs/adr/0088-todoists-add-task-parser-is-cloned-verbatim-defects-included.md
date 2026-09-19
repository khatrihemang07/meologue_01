# 0088: Todoist's add-task parser is cloned verbatim, defects included

## Status

Accepted. Builds on [0053](0053-every-checkbox-is-a-task-and-existing-history-is-backfilled.md),
which already named the quick-add parser "deliberately over-eager" and explained why that's safe
in the add field specifically (a human watches a live highlight and can demote it) — this ADR
generalises that observation from a single design property into the governing standard for the
whole Stage A add-field revamp, of which issue #367 ("last monday reproduces Todoist's bug, on
purpose and on the record") is one instance. Closes issue #258 ("Shift+Enter in the Add task
composer submits — parity says keep it, the owner says it's wrong"), left open on 2026-09-13
specifically so the question could be decided on its own merits later — this is that decision.
Supersedes nothing; the "parity programme" issue #258 itself cites (the `meologue-parity-docs`
ledger, `QA-19`) was retired on 2026-09-18 and no longer exists — the standard this ADR states
replaces it, on different evidence (a measured corpus fixture, not a ledger of narrative rows).

## Context

Stage A is a from-scratch revamp of meologue's add-task composer, driven by a full measurement
pass against the live Todoist app on 2026-09-19: a 117-string detection corpus (web, both
themes), 65 Android screenshots, and meologue's own parser read line by line. The owner's
decisions from that session are recorded in `.scratch/todoist-add-todo/DECISIONS.md` (D1–D17) —
this ADR exists because two of those decisions need to be on the record in the codebase itself,
not just in a scratch file that dies with the working directory, so a future reader hits the
reasoning at the point where they'd otherwise "fix" it away:

- **D1** — the governing standard: clone Todoist exactly, "interaction, grammar, resolution
  values, and known defects — pixel-for-pixel and nuance-for-nuance." The owner's own correction
  that shaped it, recorded verbatim in D1: eager detection (`Pay for the weekend trip` scheduling
  "the weekend") is not a defect to filter, because one click or one Backspace at the trailing
  boundary rejects an entire wrong match — measured on 2-, 3- and 4-word spans, text left
  byte-for-byte intact. **Non-detection is the unrecoverable state**: a user who meant something
  and got nothing has no gesture to recover with. This is the same shape of argument 0053 already
  made about the add field specifically; D1 makes it the standard for the whole surface,
  including matches that are demonstrably *wrong*, not just matches a filter would have called
  false positives.
- **D2** — `last monday` resolves to **28 Sep**, identical to `next monday`, while `this monday`
  and bare `monday` correctly give 21 Sep (reference date 19 Sep 2026, a Saturday). Reproduced
  independently on Todoist web *and* Android, which is what rules out "one platform's rendering
  bug" and confirms it lives in their **shared parser**. It is a genuine bug — the user gets a
  silently *wrong* date, not merely an unwanted one, and eager detection's own escape hatch (a
  click, a Backspace) doesn't help, because nothing about the result looks wrong.
- **D6** — the corpus becomes an executable fixture (issue #364,
  `packages/core/src/quick-add/detection-corpus.json` +
  `packages/core/src/quick-add/detection-corpus.test.ts`), not a ledger. Each row traces to
  Todoist's own `data-match-id` — what Todoist wrote down about itself, read off the live DOM.
  Rows this parser doesn't satisfy yet sit in a `PENDING` list that a guard test enforces **can
  only shrink**: the moment a listed row starts passing, the guard fails until it's removed from
  the list. This is the mechanism that makes "known-wrong, reproduced on purpose" falsifiable
  rather than a claim nobody checks.
- **D13** — Shift+Enter keeps submitting. Todoist submits on Shift+Enter (confirmed in the
  2026-09-19 measurement pass); meologue's `task-title-editor.tsx` keymap already binds
  `Shift-Enter` to `commit()`. Issue #258 recorded the owner's own prior objection, verbatim, from
  a task written in their own Todoist Inbox: *"Shift enter is also counting just like enter.
  Wrong."* That issue was deliberately left open on 2026-09-13 rather than resolved either way,
  so the question wouldn't be folded into a parity programme that has since been retired. Under
  D1, it's resolved now: parity wins, and the objection is knowingly overridden, not silently
  dropped — this ADR is the record of that override, so #258 doesn't reopen as a "still
  unaddressed" loose end.

## Decision

**Todoist's add-task parser — its interaction model, its grammar, its resolution values, and its
known defects — is cloned verbatim. A divergence from a *bug* is still a divergence, and needs the
same evidence bar as any other divergence: reproduced independently on two of Todoist's own
clients, or it isn't trusted as a real fact about the shared parser rather than one platform's
quirk.**

Concretely, for this issue:

- **`last monday` resolves identically to `next monday`.** `matchWeekday`
  (`packages/core/src/quick-add/date-rules.ts`) grows a `last` modifier, alongside the existing
  `this`/`next`, that computes the exact same `bareDaysAhead + 7` as `next` — not the
  chronologically-correct "the Monday that already passed" a reader would expect. It sits behind
  `LAST_WEEKDAY_REPRODUCES_TODOIST_BUG`, a named constant with a doc comment pointing back at this
  ADR, specifically so the wrongness is unmissable at the call site rather than buried in a
  one-line diff. `this monday` and bare `monday` are untouched — both still resolve to the coming
  Monday, correctly, because that's what Todoist itself does for those two forms.
- **Shift+Enter keeps submitting**, formally, as a decision rather than an oversight. The owner's
  own recorded objection (#258) is overridden by the clone standard: Todoist submits on
  Shift+Enter, so meologue does too, and no further work is scoped against #258.
- **The corpus fixture (#364) is the enforcement mechanism**, not a second thing this ADR asks
  for. `last monday`'s corpus row moves out of `detection-corpus.test.ts`'s `PENDING` list as part
  of this same change — the guard test (`"no PENDING row has started passing"`) is what would
  catch a future PR that "fixes" this branch back to the correct reading without updating this
  ADR: the row would start passing under the *old* `matchId` expectation only if the fix also
  happened to reproduce Todoist's actual (wrong) value, which a correct fix, by definition, would
  not — a correctness fix would make the row fail differently, not silently pass.

## Why known-wrong rows are reproduced, stated plainly

Two things can both be true: Todoist's `last monday` resolution is a bug, and meologue reproducing
it is not a bug in meologue. The distinguishing fact is what a diverging behaviour would cost:

- If meologue "fixed" `last monday` to the chronologically correct reading while Todoist's own
  parser stays broken, meologue would be **less predictable to a Todoist user**, not more correct
  in any way that user could act on — they'd type the same phrase into two apps they use side by
  side and get two different dates, with no visible signal telling them which one to trust. D1's
  own framing (non-detection, or in this case *mis*-detection, is unrecoverable) applies here too:
  a silently different answer is worse than a silently identical one, because at least the
  identical one is what the user has already learned to expect and correct for by hand.
- Reproducing it is cheap and reversible. It costs one modifier branch behind one named constant.
  If Todoist ever fixes its own parser, or if the owner decides parity no longer serves this
  surface, the fix is flipping `LAST_WEEKDAY_REPRODUCES_TODOIST_BUG` to `false` and updating the
  one corpus row and this ADR's Status section — not unwinding a design assumption baked in
  elsewhere.

So the rule this ADR states for the rest of the revamp: **a future contributor who finds another
Todoist row that looks wrong does not get to silently "improve" it.** Either it stays exactly as
measured (the default, per D1), or departing from it is a new decision, made on its own merits,
recorded the way this ADR records departing from #258's objection — not a drive-by fix that quietly
turns a clone into a divergent product nobody chose.

## Alternatives considered

- **Fix `last monday` to the chronologically correct reading, on the theory that a "bug" should
  never be shipped on purpose.** Rejected: this is the alternative D1 itself already weighs and
  rejects, generalised from eager-detection false positives to a *resolution* bug specifically.
  The cost isn't hypothetical — it was measured on two independent Todoist clients, which is
  stronger evidence than an assumption that "correct" is self-evidently better for a clone.
- **Make the `last`-reproduces-`next` behaviour a Settings toggle**, so a user who wants the
  correct reading can have it. Rejected as scope creep for this ticket, and more importantly as a
  precedent: it would turn every future "known-wrong, reproduced" row into a candidate for its own
  toggle, which is a maintenance burden D1 doesn't ask for and nothing in the corpus fixture's own
  design (D6) anticipates. The named constant already gives a future ADR the one flip point it
  would need if this were ever revisited.
- **Leave issue #258 open indefinitely**, since "the owner disagrees with Shift+Enter" hasn't
  changed. Rejected: #258 was explicitly deferred, not undecided — the owner's own words were
  "keep parity for now and track the complaint," and D13 already settled it in the same grilling
  session that produced D1. Leaving it open past that point would misrepresent an aging-out
  loose end as a live one.

## Consequences

A reader who hits `LAST_WEEKDAY_REPRODUCES_TODOIST_BUG` and is tempted to "fix" the obvious bug
now has the ADR the comment points at, and the corpus row the guard test protects, standing between
that impulse and a silent parity break. The same protection now covers every other row still in
`detection-corpus.test.ts`'s `PENDING` list and every row already passing: this ADR is the standing
answer to "why does this match a value I know to be wrong," for the whole surface, not just this
one weekday modifier.

Issue #258 is closed with no code change of its own — the keymap already did the right thing under
this standard; what was missing was the record saying so on purpose, which this ADR is.

The corpus fixture (#364) remains the mechanism that makes this ADR falsifiable rather than
aspirational: `pnpm vitest run` in `packages/core` is what actually enforces "known-wrong rows
don't regress toward correctness by accident," not this document alone.
