# 0078: The observed-reference corpus lives in its own repo

## Status

Accepted. **Amends [ADR 0077](0077-parity-is-proved-live-not-against-a-dated-capture.md)'s
"committed into the corpus alongside the prose"** — the corpus is still committed, but into
`meologue-reference`, a sibling repository, not this one. 0077's rule is otherwise untouched: a
measurement whose artifact is not committed is still not finished, and a row is still established by
driving both applications in one session.

Does not change the ledger, the status vocabulary, or what `matched` requires.

**Renamed 2026-09-16.** That repo's directory was called `meologue-parity-docs` when this ADR was
written; it is `meologue-reference` now, and the ~108 citations here were rewritten with it. The
owner's ask was that `Code/` hold *one* reference folder rather than one per recorded application, so
the name stops describing the first corpus in it. The decision below is otherwise untouched — same
repo, same history, same sibling checkout, same repo-relative citations. Text in this repo's older
commits and in unmerged branches still reads `meologue-parity-docs/…`; that is the same path.

## Context

`docs/reference/` had grown to 47MB across 889 tracked files: 37MB of UpNote and Todoist screenshots,
10MB of Todoist DOM captures and computed-style reads, and the prose documents and ledger that cite
them. None of it is meologue. It is a recording of what two other applications do, kept so that a
parity claim can be checked by a reader instead of believed.

That corpus was never the product's, and it grows on a different curve. ADR 0077 made every future
row carry committed artifacts, which is correct and is exactly why the directory will keep growing —
each driven flow adds JSON and screenshots forever, while the code the flow verifies changes by a few
hundred lines. A `git clone` of the application was becoming mostly evidence about other people's
software.

The owner's decision was direct: the parity docs should not be in the product repo.

## Decision

**The observed-reference corpus moves to `meologue-reference`, a repo of its own, with its history.**

Seven paths left, hoisted to that repo's root: `docs/reference/todoist/` (the whole Todoist corpus,
including the ledger and every `*-dom`/`*-shots` directory), `docs/reference/screenshots/`, the four
`upnote-*.md` documents and `obsidian-editor-behaviour.md`. It was extracted with `git filter-repo`
rather than copied, so each capture keeps the commit that produced it — provenance is the corpus's
whole value, and a fresh `git init` would have thrown it away.

**`docs/reference/composer-parity.md` stays.** It is not an observation of another application; it is
a build artifact of this repo, generated from `apps/web/src/lib/parity/parity-fixture.ts` by
`apps/web/scripts/generate-parity-doc.mjs` and read by `apps/e2e/tests/composer-parity.spec.ts`
(ADR 0073). Moving it would have put a generator's output outside its own repo.

**Citations are repo-relative and cross the boundary by name.** The ~98 comments that cited
`docs/reference/todoist/parity-ledger.md` and its siblings now read
`meologue-reference/todoist/parity-ledger.md`. Nothing in this repo reads those paths at build or
test time — they are for humans — so the rewrite changed no behaviour.

This repo's history was **not** rewritten. The old blobs stay reachable in it. Purging them would
have meant a force-push across a checkout that several sessions and worktrees share, to save disk
nobody is short of.

## Consequences

**Evidence no longer travels with the code.** Someone who clones meologue and reads
`task-row-content.tsx`'s citation of a flow-6 artifact cannot open it without also cloning
`meologue-reference`. That is the real cost of this decision and there is no version of it that
avoids the cost — the corpus is either in the clone or it is not.

**ADR 0077's "in the repo" now means "in the corpus repo."** A driven measurement is finished when
its artifact is committed to `meologue-reference`, beside the prose that cites it. A flow that
lands code here while leaving its JSON on a session scratchpad is unfinished in exactly the way 0077
describes, and the two-repo split makes that easier to do by accident, not harder. Whoever drives a
flow commits both halves.

**The lint-gate coupling is gone with the files.** `biome.json`'s `files.includes` carried four
excludes — `!docs/reference/**/*-dom`, `**/*-shots`, `**/drivers`, `**/logs` — because scratch capture
scripts are not written to this repo's lint standards and committing `drivers/` once turned a clean
gate into 70 errors. Those excludes are deleted here: nothing they named is in this repo any more.
The corpus repo has no lint gate, which is the right answer for a directory of recordings.

**The ledger is no longer this repo's definition of done, mechanically.** It still is in substance —
a parity ticket lands when its rows read `matched` or `divergent` — but the checklist and the code it
checks are now two `git log`s. Reconciling them is a reader's job, which it always was; nothing
automated ever enforced it.

## Alternatives considered

- **Move everything, `composer-parity.md` included.** Rejected: `generate-parity-doc.mjs` would write
  outside its own repo, and ADR 0073 calls that file a build artifact of this one. A generated file
  belongs with its generator.
- **A git submodule.** Rejected. It would keep citations resolving inside one clone, which is the real
  cost above — but at the price of pinning the corpus to a SHA the product repo has to bump. The
  corpus is appended to almost every driving session; a submodule would either sit stale or add a bump
  commit here for every capture there, and the owner asked for the docs to be *out*, not vendored.
- **Purge the blobs from this repo's history too.** Rejected as asked: a force-push invalidating every
  shared worktree and clone, to reclaim 47MB.
- **Keep it, and just stop growing it.** Not a real option. ADR 0077 requires artifacts per driven row,
  so the corpus grows for as long as parity is pursued.
