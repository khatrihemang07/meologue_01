# Obsidian editor behaviour — observed reference

Obsidian 1.13.7 (Electron 43.1.1), CodeMirror 6 (`@codemirror/view` ≥ 6.35; exact version not
determinable — CM6 is minified into `app.js` with no version constant). CodeMirror **5.64.0** also
ships separately for legacy language modes and Vim mode.

Obsidian stores plain Markdown files, so ground truth here is the **exact bytes on disk**, read with
`od -c` after each case. Secondary reference only — UpNote is the primary one.

## Block model (verified)

| Keys | Bytes written |
|---|---|
| `alpha` ⏎ `bravo` | `alpha\nbravo` |
| `alpha` ⇧⏎ `bravo` | `alpha\nbravo` — **identical to Enter** |
| `alpha` ⏎ ⏎ `bravo` | `alpha\n\nbravo` |

**Obsidian's Enter writes a single `\n`.** In CommonMark that is a *soft* break — a standard
renderer joins those two lines into one paragraph — but Obsidian's Live Preview draws them as two
visual lines. Obsidian buys "one Enter looks like one line" by rendering **non-standard**, and
exposes a "Strict line breaks" setting to opt back into CommonMark's reading.

Shift+Enter is not distinguished from Enter in the default configuration.

## Lists (verified)

`- one` ⏎ ⇥ `two` ⏎ ⇥ `three` writes:

```
- one\n\t- two\n\t\t- three
```

**Nesting is emitted as TAB characters, one per level** — not spaces. (Obsidian exposes a "Use tabs"
/ indent-size setting; tabs are the default here.) This repo's serializer emits spaces
(`" ".repeat(marker.length)`), which is equally valid CommonMark. Both must be *accepted* on input.

## Why this matters for the three-way decision

Three coherent models exist for "what does one Enter mean", and they trade off differently:

| | Enter | Shift+Enter | Standards-clean? | Looks like one line? |
|---|---|---|---|---|
| **UpNote** | new block (`<div>`, zero margin) | `<br>` in same block | n/a — it is HTML | yes |
| **Obsidian** | single `\n` | single `\n` (same) | **no** — a lone `\n` is a soft break | yes, via non-standard rendering |
| **meologue today** | paragraph → `\n\n`, then merged on read and rendered under `pre-wrap` | same as Enter | yes | **no — renders a blank line** |

The recommended target adopts UpNote's *distinctions* while keeping Markdown honest: Enter →
paragraph → `\n\n` rendered at zero margin; Shift+Enter → soft break → a single `\n` inside the
paragraph. That is visually identical to UpNote, standards-correct in CommonMark unlike Obsidian,
and it round-trips.

A pleasing consequence: under that scheme meologue's `\n\n` matches Obsidian's double-Enter and
meologue's soft-break `\n` matches Obsidian's single Enter — so a body written in meologue opens in
Obsidian looking the way it did here.

## Vault side effect (disclosure)

Testing was done in a single scratch file inside the user's real vault, then deleted. The vault runs
the **obsidian-git** plugin, which auto-committed and pushed the (empty, 0-byte) scratch file as
`ee54900 "vault backup: 2026-09-06 14:03:53"` before it could be removed. No test content was
captured — the commit records a 0-byte file plus a `workspace.json` line change.
