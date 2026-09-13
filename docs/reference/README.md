# Reference

## The observed-reference corpus is not here any more

What Todoist and UpNote actually do — the ledger, the driven flows, the DOM captures, the
screenshots — lives in its own repo, **`meologue-parity-docs`**, checked out beside this one:

```
Code/
  meologue_01/            this repo
  meologue-parity-docs/   the corpus
```

It moved with its history on 2026-09-13. See
[ADR 0078](../adr/0078-the-observed-reference-corpus-lives-in-its-own-repo.md) for why, and
[ADR 0077](../adr/0077-parity-is-proved-live-not-against-a-dated-capture.md) for the rule that still
governs it: a driven measurement is finished when its artifact is committed beside the prose that
cites it — now in that repo.

**Citations in this repo name it directly.** A comment reading
`meologue-parity-docs/todoist/parity-ledger.md` means that path in that repo. Paths there are
hoisted to its root, so what used to be `docs/reference/todoist/keyboard.md` is now
`todoist/keyboard.md`.

| Was here | Is now |
|---|---|
| `docs/reference/todoist/` | `meologue-parity-docs/todoist/` |
| `docs/reference/screenshots/` | `meologue-parity-docs/screenshots/` |
| `docs/reference/upnote-*.md` | `meologue-parity-docs/upnote-*.md` |
| `docs/reference/obsidian-editor-behaviour.md` | `meologue-parity-docs/obsidian-editor-behaviour.md` |

## What is still here

- **`composer-parity.md`** — and only this. It is not an observation of another application: it is
  generated from `apps/web/src/lib/parity/parity-fixture.ts` by
  `apps/web/scripts/generate-parity-doc.mjs`, the same fixture
  `apps/e2e/tests/composer-parity.spec.ts` replays, so the document cannot drift from what the suite
  asserts ([ADR 0073](../adr/0073-editor-parity-is-proved-by-a-generated-matrix.md)). Do not edit it
  by hand — run `pnpm --filter web generate:parity-doc`.
