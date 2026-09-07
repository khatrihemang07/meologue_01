# UpNote editor behaviour — observed reference

Every row marked **verified** was produced by driving the shipped applications by hand and reading
back ground truth, not by reasoning about them:

- **macOS** — UpNote 9.22.2 (Electron 43.4.1), Mac App Store build. Keystrokes driven with
  `cliclick`; the resulting document read from `notes.html` in
  `~/Library/Containers/com.getupnote.desktop/Data/Library/Application Support/UpNote/upnote.sqlite3`
  (WAL-inclusive copy). UpNote stores each note as **HTML**, so the table below is the literal DOM
  UpNote built, not an interpretation of pixels.
- **Android** — UpNote `com.getupnote.android`, driven with `adb input`, observed on screen.

Anything not verified is labelled as such. Where UpNote and this repo's dialect cannot agree, that
is called out rather than smoothed over.

## The one fact that explains the reported defect

UpNote's block element is a bare **`<div>`**, whose default margin is **zero**. Its inter-block gap
is therefore exactly one line-height. One Enter looks like one new line because the block separator
contributes no space of its own.

## Block model (macOS, verified)

| Keys | Stored DOM |
|---|---|
| `alpha` ⏎ `bravo` | `<div>alpha</div><div>bravo</div>` |
| `alpha` ⇧⏎ `bravo` | `alpha<br>bravo` |
| `alpha` ⏎ ⏎ `bravo` | `<div>alpha</div><div><br></div><div>bravo</div>` |
| empty note | `<br>` |

So: **Enter = new sibling block. Shift+Enter = `<br>` inside the current block. An empty line is a
block containing only `<br>`.** All three are distinct and all three survive a round trip.

Note the first block is left as bare inline content at the root until a second block exists.

## Lists (macOS, verified)

| Action | Result |
|---|---|
| `- ` at block start | `<ul><li>…</li></ul>`, the `- ` characters consumed |
| `1. ` at block start | `<ol><li>…</li></ol>` |
| `[] ` at block start | `<ul><li data-checked="false">…</li></ul>` |
| `- ` **mid-line** | inert — stays literal text |
| ⏎ on a non-empty item | new sibling item |
| ⏎ on an empty **nested** item | outdents **one level**; does not exit the list |
| ⏎ after a **checked** item | new item, `data-checked="false"` — completion is **not** inherited |
| ⇥ on a non-first item | nests one level |
| ⇥ on the **first** item of a list | **also nests**, producing `<ul><ul><li>…` |
| ⌫ at start of an item | **unwraps that item to a plain block**; does not merge into the item above |
| repeated ⌫ at start | outdents one level per press, nested → level 1 → plain block |

A checklist is not a separate structure: it is a `<ul>` whose `<li>` carries `data-checked`.

**Nesting is emitted as a `<ul>` that is a *sibling* of the `<li>`, not a child of it** —
`<ul><li>one</li><ul><li>two</li></ul></ul>`. This is invalid per the HTML spec; it is what UpNote
writes.

Bullet glyph cascade: level 1 `•`, level 2 `○`, level 3 `▪` (matches this repo's existing cascade).

## Toolbar (macOS, verified)

22 controls: `+` · H · **B** · *I* · U · S · text-colour · highlighter · align · checklist · bullet ·
numbered · undo · redo · indent · quote · inline-code · code-block · link · divider · f(x) · `…`

The toolbar **continuously reports the active block type and marks** — the bullet button is lit with
a rounded accent background whenever the caret sits in a bullet list.

Conversions, all verified:

| From | Button | To |
|---|---|---|
| plain line | bullet | `<ul><li>` |
| bullet item | bullet | unwrapped to bare text (toggle off) |
| bullet item | numbered | `<ol><li>` — converts in place |
| bullet item | checklist | `data-checked="false"` — converts in place |
| **nested** item | bullet | **lifts one level**, does not flatten to a paragraph |

## Android (verified on device)

The toolbar is a **different, reduced, horizontally scrollable** set — not the desktop toolbar:

- page 1: `+` · `/` · checklist · image · H · undo · redo
- page 2: undo · redo · text-colour · highlighter · `#` tag · date · **B**
- page 3: **indent · outdent · soft-line-break** · move-line-up · move-line-down · align · block-indent

This is the important mobile finding: a soft keyboard has no Tab and no Shift+Enter, so UpNote
promotes **indent, outdent and soft break to explicit toolbar buttons**. Verified: the indent button
nests an item; the soft-break button starts a new line inside the same `<li>` with no bullet marker.

Also observed on Android and not on macOS:

- The platform IME **auto-capitalises at block start** — typing `bravo` after Enter stores `Bravo`.
  What is stored is not what was typed.
- The first line renders in title type. This is UpNote's *note title* concept and deliberately does
  not transfer to an Entry, which has no title.
- The `- ` input rule does fire from IME text input.

## Where this repo cannot copy UpNote

- UpNote stores HTML and can express anything the DOM can. This repo stores Markdown, and Export,
  Sync and the Digest all read those same characters.
- UpNote's toolbar includes headings, quote, code block, divider, colours and highlight. ADR 0043
  removed those *parsers* deliberately, and `CONTEXT.md` states an Entry stays untitled.
- UpNote's sibling-`<ul>` nesting has no Markdown spelling and should not be reproduced.
