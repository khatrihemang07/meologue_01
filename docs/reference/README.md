# Reference

## The observed-reference corpus is not here any more

What Todoist and UpNote actually do — the ledger, the driven flows, the DOM captures, the
screenshots — lives in its own repo, **`meologue-reference`**, checked out beside this one:

```
Code/
  meologue_01/          this repo
  meologue-reference/   the corpus — all of it, in one folder
```

It moved with its history on 2026-09-13. See
[ADR 0078](../adr/0078-the-observed-reference-corpus-lives-in-its-own-repo.md) for why, and
[ADR 0077](../adr/0077-parity-is-proved-live-not-against-a-dated-capture.md) for the rule that still
governs it: a driven measurement is finished when its artifact is committed beside the prose that
cites it — now in that repo.

**One folder, whatever is recorded next.** `meologue-reference` is not "the Todoist repo" — it is
where every observed reference lives, Todoist and UpNote and Obsidian today and whatever is driven
next. A second application does not get a second folder in `Code/`; it gets a directory inside this
one.

**Citations in this repo name it directly.** A comment reading
`meologue-reference/todoist/parity-ledger.md` means that path in that repo. Paths there are
hoisted to its root, so what used to be `docs/reference/todoist/keyboard.md` is now
`todoist/keyboard.md`.

| Was here | Is now |
|---|---|
| `docs/reference/todoist/` | `meologue-reference/todoist/` |
| `docs/reference/screenshots/` | `meologue-reference/screenshots/` |
| `docs/reference/upnote-*.md` | `meologue-reference/upnote-*.md` |
| `docs/reference/obsidian-editor-behaviour.md` | `meologue-reference/obsidian-editor-behaviour.md` |

Between 2026-09-13 and 2026-09-16 that repo's directory was called `meologue-parity-docs`. Commits,
branches and worktrees from that window cite `meologue-parity-docs/…`; it is the same corpus and the
same path below the root, so read the prefix as `meologue-reference/`.

## What is still here

- **`composer-parity.md`** — and only this. It is not an observation of another application: it is
  generated from `apps/web/src/lib/parity/parity-fixture.ts` by
  `apps/web/scripts/generate-parity-doc.mjs`, the same fixture
  `apps/e2e/tests/composer-parity.spec.ts` replays, so the document cannot drift from what the suite
  asserts ([ADR 0073](../adr/0073-editor-parity-is-proved-by-a-generated-matrix.md)). Do not edit it
  by hand — run `pnpm --filter web generate:parity-doc`.
