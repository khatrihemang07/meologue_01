# UpNote internals — static analysis of the shipped renderer bundle

This document is derived entirely from **static analysis of UpNote's shipped JavaScript**
(`/Applications/UpNote.app`, Electron 43.4.1, UpNote 9.22.2, Mac App Store build). No instance of
UpNote was launched, clicked, or typed into to produce this document — everything below comes from
reading the `app.asar` contents on disk and, where noted, evaluating UpNote's own obfuscator-decoder
function in an isolated Node `vm` context to recover string literals (no application code, network
calls, or Electron/DOM code was ever executed).

It complements `docs/reference/upnote-editor-behaviour.md` (behavior observed by driving the live
app) with the *why* behind that behavior — the actual source-level logic, where it could be
recovered.

Every claim below is labeled:
- **certain** — a literal string decoded from the obfuscator's string array, or plain source text.
- **inferred** — reasoned from code shape/structure around certain evidence, but not itself a
  decoded literal (e.g., variable/function names remain minified and their *purpose* is inferred).
- **undecoded** — a spot where the string-array decoding did not resolve (see Methodology); reported
  honestly rather than guessed.

## Methodology

### Extracting the asar

`app.asar` (13.1MB) is a standard, unencrypted asar with a JSON header. All `.js`/`.css` entries were
extracted (skipping the handful of `unpacked` native-module entries already sitting in
`app.asar.unpacked/`) with a small Python script that parses the 16-byte asar header, reads the JSON
file-offset table, and copies each entry's byte range. The renderer bundle
(`dist/electron/renderer.js`, 1,647,939 bytes) is the file of interest — it contains essentially all
of Shine editor's logic. Sibling chunks (`282.js`, `195.js`, `948.js`, `879.js`, `109.js`, `154.js`,
`422.js`, `483.js`, `673.js`) and `main.js`/`preload.js`/`background.js` were also extracted.
**Correction to an initial assumption**: `background.js`, `195.js` (the bundled Firebase Firestore
SDK — its one `LIKE` hit is Firestore's own query evaluator, a red herring, not UpNote's search),
`948.js` (a fork of mark.js, see §6), `282.js` and `422.js` are plain, if minified, JS — not run
through UpNote's obfuscation pipeline. But `main.js` and `preload.js` **are** obfuscated (with their
own decoder pairs, `a0b`/`a0c` and a `cY`/`cZ`-aliased pair respectively) — this was only discovered
partway through the investigation, and only specific indices needed for §6 (Search) were decoded by
hand from them, not the whole files. `879.js`, `109.js`, `154.js`, `483.js`, `673.js` each carry
their own independent instance of the same string-array scheme; grepping their raw (still-encoded)
content for editor-setting names (`autoFormatMarkdownEnabled`, `slashMenuEnabled`, etc.) turned up
nothing — those live only in `renderer.js` — so four of the five were left fully obfuscated. The
fifth, `154.js`, was identified as the `node:worker_threads` worker that backs note search
(confirmed by webpack chunk-id arithmetic from `main.js`) and was partially decoded — see §6.

### Defeating the string-array obfuscation (javascript-obfuscator)

`renderer.js` is transformed by javascript-obfuscator with a single string-array + hex-index scheme:

- Near the top of the file, `function a0a(){const d1D=[...]; a0a=function(){return d1D;}; return a0a();}`
  defines a ~4,000-entry array of strings, some plain, most base64-encoded.
- `function a0c(a,b){a=a-0x8f; ... }` looks up `a0a()[a-0x8f]` and, on first access, base64-decodes
  it (standard base64 alphabet, decoded as UTF-8) and memoizes the result.
- `function a0b(a,b){a=a-0x8f; ...}` looks up the **same** array at the same computed index but
  returns it **raw, undecoded** — used for the array slots the obfuscator left as plain text rather
  than base64 (i.e. both accessors are "real"; which one a given call site uses simply tells you
  whether that slot was base64-wrapped or not).
- A self-executing "array-rotation" IIFE, invoked once as `(function(a,b){...}(a0a,0x883a6))`, shifts
  the array into its final runtime order before anything else in the file can use it (a standard
  obfuscator anti-tamper/self-defense step). This IIFE was extracted verbatim and evaluated in a
  bare Node `vm.createContext` sandbox (no `require`, no DOM, no network — pure arithmetic/string
  code) to obtain working `a0a`/`a0b`/`a0c` functions, then re-used to decode the rest of the file.
- Throughout the rest of `renderer.js`, `a0c`/`a0b` are re-exposed under **564 short local aliases**
  declared as plain assignments (e.g. `aso=a0b,ash=a0c;`), plus further **alias-of-alias** chains
  (resolved to a fixed point in 7 iterations, 6,384 names total). Every one of these 6,384 generated
  identifiers is used consistently for exactly one of `a0b`/`a0c` everywhere in the file (verified:
  zero collisions).
- Call sites pass the hex index either directly (`ash(0x587)`) or via an intermediate constant
  object literal declared earlier in the same scope (`ash(a0cZS.a8)` where
  `a0cZS={a8:0x1a2b, ...}` — 2,934 such objects were found and resolved, again with zero name
  collisions across the whole file).
- No "wrapper" functions that further offset the index were found (a common javascript-obfuscator
  option, `stringArrayWrappersCount`) — every alias is a direct, unmodified reference to `a0b` or
  `a0c`.

A script (`deobfuscate.js`, not checked into this repo) performs this whole pipeline and produces
`renderer.deob.js`: it resolved and inlined **30,041** decoder-call sites as plain quoted string
literals (both `a0c`- and `a0b`-backed), leaving **0** unresolved constant-object lookups. This
de-obfuscated copy — not the original — is what all offset citations in this document refer to,
except where stated otherwise. It is **not** a full deobfuscation: identifier names (`dj`, `dQ`,
`bU`, `cH`, `afL`, `afM`, …) remain exactly as minified by the build (unrelated to the string-array
scheme — they were never run through it), so class/function *purpose* below is inferred from
decoded string literals used inside them (event names, DOM tag checks, setting keys, method calls
like `toggleFormat('bold')`), not from their names.

The scratch files (extracted asar tree, `renderer.deob.js`, and the decode script) live outside the
repo in a session scratch directory and were not committed.

## 1. Keyboard binding table

### The keymap base classes and matcher (certain — fully read)

The real base class is `d9` (`renderer.deob.js` offset 445458). `dj` (offset 447321,
`class dj extends d9{['execute'](afL,afM){}}`) is a trivial one-line pass-through that exists only
so every concrete binding can share one `extends dj` shape.

`d9`'s constructor caches `cmd`, `shift`, `alt`, `appleCtrl` (each `{required, value}`, from the
four `*Props()` methods) and builds a `codeSet`/`keySet` from `eventCodes()`/`eventKeys()`. One
platform special-case is hard-coded: **on Windows, any binding whose Alt is mandatory drops its
Cmd/Ctrl requirement** (`isWindows() && alt.required && alt.value===true ⇒ cmd.required=false`) —
this explains several rows below marked "Ctrl req. dropped on Windows."

The matcher, `runIfNeeded(event, editor)`, evaluates in order and requires **all** of the following
that apply (independent AND-gated exact-matches, never OR'd against each other):

1. If `cmd.required`: `cmd.value` must equal `isApple() ? event.metaKey : event.ctrlKey`.
2. If `shift.required`: `shift.value` must equal `event.shiftKey`.
3. If `alt.required`: `alt.value` must equal `event.altKey`.
4. If `isApple() && appleCtrl.required`: `appleCtrl.value` must equal `event.ctrlKey` — a *separate*,
   physical-Control check, meaningful only on Apple platforms where `ctrlKey` ≠ `metaKey` (used by
   the two classic Cocoa/Emacs bindings, Control+L and Control+O, below).
5. Key/code matching is **key-first, code as fallback — not an OR of both**: try
   `keySet.has(event.key.toLowerCase())` first; only fall back to `codeSet.has(event.code)`
   (excluding `Numpad*` codes unless NumLock is on) if that fails *and* either there's no `keySet`,
   or the physical key produced a non-Latin/dead-key character (Cyrillic/Hebrew/Greek/Arabic/
   Armenian/Thai/Lao/`'Dead'`).
6. On match: call `this.execute(event, editor)`.

### Critical registration finding: most of this dispatcher is Windows/Linux-only

The dispatcher's instance list is built lazily (offset ~533100–533640) as:

```
f2 = [new dX()]
isApple()   && f2.push(new eU(), new eZ())
isMac()     || f2.push(new dq(), new dz(), ... /* all 32 formatting/heading/list/alignment/color/date classes */)
isWindows() && f2.push(new e1(), new dV())
```

`isMac()`/`isWindows()`/`isApple()` are confirmed via a platform-helper module at offset ~258700–258996
(`Platform = {MAC:0, WINDOWS:1, LINUX:2, IOS:3, ANDROID:4}`). Because the middle line is
`isMac() || push(...)`, **that push only runs when `isMac()` is false** — i.e. on the shipped macOS
build, this entire `dj`-hierarchy dispatcher registers only `dX` (Tab), and (Apple-only) `eU`
(Control+L) and `eZ` (Control+O). **The 32 classes below that implement bold/italic/underline/
headings/lists/alignment/colors/blockquote/code/divider/date-time/etc. are never instantiated on
macOS at all.** They are the intended Windows/Linux keyboard-fallback layer. On the Mac build these
same actions are almost certainly wired through native Electron `Menu` accelerators instead, which
live in the main process and were out of scope for this renderer-only investigation (see "What
could not be decoded"). The table below documents what every class *says*, correctly labeling which
ones are actually live in the shipped Mac binary.

37 occurrences of `extends dj` were found and all 37 are characterized below (grep-verified: the
chain runs from `dq` to `f1`, ending where an unrelated `dateTimeManager` helper class begins).

### Complete binding table

"Cmd" below means "the base class's `cmd` requirement," which on the shipped Mac binary is only
ever actually reachable for the three rows marked **Apple-only/always-registered**; the rest are
listed as designed (Ctrl on Windows/Linux) since they are not registered on macOS.

| Class | Registration | Key(s) | Code(s) | Cmd/Ctrl | Shift | Alt | Action |
|---|---|---|---|---|---|---|---|
| `dX` | always | — | `Tab` | No (must be up) | any | any | `editor.handleTab(event)` → indent (no Shift) / outdent (Shift) via `handleIndentation` |
| `eU` | Apple-only | `l` | `KeyL` | No (Cmd must be up); requires physical **Ctrl** instead | No | No | macOS Control+L → `editor.centerCurrentSelection()` |
| `eZ` | Apple-only | `o` | `KeyO` | No (Cmd must be up); requires physical **Ctrl** instead | No | No | macOS Control+O → if a selection exists: `insertNewLine()` |
| `dq` | non-Mac only | `b` | `KeyB` | Yes | No | any | `toggleFormat('bold')` |
| `dz` | non-Mac only | `i` | `KeyI` | Yes | No | any | `toggleFormat('italic')` |
| `dB` | non-Mac only | `u` | `KeyU` | Yes | No | any | `toggleFormat('underline')` |
| `dG` | non-Mac only | `x` | `KeyX` | Yes | Yes | No | `toggleFormat('strikeThrough')` |
| `dH` | non-Mac only | — | `Digit1..6`, `Numpad1..6` | Yes | No | No | `editor.setHeading('H1'..'H6')` per digit |
| `dJ` | non-Mac only | — | `Digit7`, `Numpad7` | Yes | No | No | `toggleFormat('insertUnorderedList')` (bullet list) |
| `dK` | non-Mac only | — | `Digit8`, `Numpad8` | Yes | No | No | `toggleFormat('insertOrderedList')` (numbered list) |
| `dQ` | non-Mac only | — | `Digit9`, `Numpad9` | Yes | No | No | `toggleFormat('insertUnorderedCheckList')` (checklist) |
| `dU` | non-Mac only | — | `Digit9`, `Numpad9` | Yes | Yes | any | `editor.toggleUnorderedCheckList()` (direct call) |
| `dV` | Windows-only | — | `Digit9`, `Numpad9` | (dropped by Alt-override) | Yes | Yes | `editor.toggleUnorderedCheckList()` |
| `dY` | non-Mac only | `]`, `}`, `ї`, `ü` | `BracketRight` | Yes | No | No | `handleIndentation(false)` → indent |
| `dZ` | non-Mac only | `[`, `ğ`, `å` | `BracketLeft` | Yes | No | No | `handleIndentation(true)` → outdent |
| `e0` | non-Mac only | `z` | `KeyZ` | Yes | any | any | `UndoManager.handleUndoRedoEvent` → Shift ? redo() : undo() |
| `e1` | Windows-only | `y` | `KeyY` | Yes | any | any | `UndoManager.redo()` (Windows redo convention) |
| `e2` | non-Mac only | `l` | `KeyL` | Yes | Yes | No | `setTextAlignment('left')` |
| `e3` | non-Mac only | `e` | `KeyE` | Yes | Yes | any | `setTextAlignment('center')` |
| `e4` | non-Mac only | `r` | `KeyR` | Yes | Yes | any | `setTextAlignment('right')` |
| `e5` | non-Mac only | `j` | `KeyJ` | Yes | Yes | any | `setTextAlignment('full')` (justify) |
| `e6` | non-Mac only | `u` | `KeyU` | Yes | Yes | any | `toggleFormat('blockquote')` |
| `e7` | non-Mac only | `c` | `KeyC` | Yes | Yes | No | `toggleFormat('code')` (inline code) |
| `e8` | non-Mac only | `c` | `KeyC` | (dropped by Alt-override on Windows) | Yes | Yes | `toggleFormat('codeBlock')` |
| `e9` | non-Mac only | `h` | `KeyH` | Yes | Yes | any | `insertDivider()` (horizontal rule) |
| `eq` | non-Mac only | — | `Digit0..8`, `Numpad0..8` | (dropped by Alt-override) | No | Yes | gated by `textColorHighlightShortcutEnabled`; `toggleTextColor(color)`, 0=clear,1=red,2=orange,3=yellow,4=green,5=blue,6=pink,7=purple,8=gray |
| `ez` | non-Mac only | — | `Digit0..8`, `Numpad0..8` | (dropped by Alt-override) | Yes | Yes | same setting guard; `toggleHighlightColor(color)`, same map |
| `eB` | non-Mac only | `d` | `KeyD` | Yes | No | any | `dateTimeManager.insertDateTime()` |
| `eG` | non-Mac only | `d` | `KeyD` | Yes | Yes | No | `dateTimeManager.insertDate()` |
| `eJ` | non-Mac only | `d`, `Î` | `KeyD` | (dropped on Windows) | Yes | Yes | `dateTimeManager.insertTime()` |
| `eK` | non-Mac only | `;`, `:` | `Semicolon` | Yes | Yes | No | `toggleFormat('subscript')` |
| `eQ` | non-Mac only | `'`, `"` | `Quote` | Yes | Yes | No | `toggleFormat('superscript')` |
| `eV` | non-Mac only | `\` | `Backslash` | Yes | No | No | `toggleFormat('removeFormat')` (clear formatting) |
| `eX` | non-Mac only | `.` | `Period` | Yes | No | No | `restoreSelectionRange(); insertOrToggleCollapsibleSection()` |
| `eY` | non-Mac only | `ArrowUp`, `ArrowDown` | — | Yes | No | Yes | `d8.onKeyDown` → `moveListItemIfNeeded` — moves current list item up/down |
| `f0` | non-Mac only | `Enter` | — | Yes | any | No | if a table is selected: `tableManager.insertRows(!shiftKey)` — row below (Enter) / above (Shift+Enter) |
| `f1` | non-Mac only | `Enter` | — | Yes | any | Yes | if a table is selected: `tableManager.insertColumns(!shiftKey)` — column after (Alt+Enter) / before (Alt+Shift+Enter) |

Note the naming mismatch worth flagging explicitly: `dU` (Digit9, Shift, no required-Alt) and `dV`
(Windows-only registration, Digit9, Shift, Alt) both call the same `toggleUnorderedCheckList()`, and
are distinct from `dQ` (Digit9 alone, no Shift), which calls `toggleFormat('insertUnorderedCheckList')`.
This is the closest this file gets to the task's guessed "Cmd+Alt+9 / Cmd+Shift+9 / Cmd+Alt+Shift+9"
triad — but per the registration finding above, on the Mac build **only `dQ`'s registration line is
ever reached, and only via the non-Mac branch which doesn't run** — meaning list-toggle keyboard
shortcuts as literally coded here are Windows/Linux-only; the Mac checklist/bullet/number-list
shortcuts (if any) are not in this dispatcher.

### Unresolved

- `d8` (list-item mover backing `eY`) was only partially traced — `getNextListItem`/`moveListItem`/
  `moveListItemIfNeeded`/`onKeyDown` names and overall shape are certain, but `moveListItemIfNeeded`'s
  body wasn't fully unwound.
- The actual macOS Cmd-key bindings for bold/italic/underline/headings/lists/alignment/colors/quote/
  code/divider/date-time (i.e. what a Mac user actually presses) are **not in `renderer.js`'s `dj`
  hierarchy** per the registration finding above. They most likely live in Electron `Menu`/
  `accelerator` definitions in the main process, which was not covered by this investigation (see
  the top-level "What could not be decoded" section).

## 2. Markdown input-rule table and editor settings

Base class `class bU` (offset 387277 — no-op `match(){return false}` / empty `executeShortcut(){}`,
certain). The rule array `const cH=[...]` starts at offset 391876 and closes at ~402106. **Total: 9
rule instances**, confirmed two independent ways (`grep -c "new class extends bU"` inside the array
text, and depth-balanced comma-split parsing) — all 9 walked start to finish.

| # | Trigger | Guard conditions | Action | Certainty |
|---|---|---|---|---|
| 0 | typed `' '` | selection collapsed, `startOffset===3`; container passes a line-start check; **not** inside `LI`; **not** inside a heading; text before cursor trimmed `===` `'[]'` | `toggleFormat('insertUnorderedCheckList')` — unchecked checklist item | certain |
| 1 | typed `' '` | same guards, `startOffset===4`; text before cursor trimmed+lowercased `===` `'[x]'` | `toggleFormat('insertUnorderedCheckList')` then `toggleUnorderedCheckList()` — checked checklist item | certain |
| 2 | typed `' '` | `startOffset===2`; not in `LI`/heading; trimmed text before cursor is exactly `-`, `*`, or `+` | `toggleFormat('insertUnorderedList')` — bullet list | certain |
| 3 | typed `' '` | selection collapsed, text-node container, not in `LI`/heading; trimmed text before cursor matches `/^[0-9]+[*,.]{1}$/` and doesn't start with `0` | `toggleFormat('insertOrderedList')`; also sets `OL.start` to the typed number if ≠ 1 (e.g. `"5. "` starts the list at 5) — ordered list with custom start | certain |
| 4 | `inputTypes`: `insertText`, `insertCompositionText`, `insertParagraph` | selection collapsed, `startOffset<=3`; trimmed text of the preceding text node is exactly `"---"`, `"***"`, `"___"`, `"—-"`, or `"———"` | `insertDivider()` then removes the trigger text — horizontal rule | certain |
| 5 | typed `' '` | `startOffset===2`; line-start check; trimmed text before cursor `===` `>` | `toggleFormat('blockquote')` — blockquote | certain |
| 6 | typed `' '` | selection collapsed, `startOffset<=7`; line-start check; trimmed text before cursor is 1–6 repeated `#` characters | `setHeading('H'+count)` — H1 through H6 | certain |
| 7 | closing-delimiter char from the set `~ * _ \` ] ) ␛` scanning backward for a matching opener, OR whitespace/end-of-composition | backward scan validates the span (`shouldTriggerMarkdown`, special-cases exact code-fence text via a helper `cG`); skipped while `isComposing` | if the span is a code-fence pattern → `insertCode()` (code block); otherwise renders the captured markdown span (`**bold**`, `*italic*`/`_italic_`, `~strike~`, `` `code` ``) via a helper `bH(...)` and replaces the raw text with the formatted inline fragment | certain for the delimiter set and code-fence branch; **inferred** which exact delimiter maps to which inline style (that mapping lives inside `bH`, not traced) |
| 8 | whitespace-ish typed char, or `insertParagraph` | not already inside an `<A>` anchor; extracts the trailing "word" before the trigger; tests it as email / full URL / bare domain | wraps the match in a new `<a>`: `mailto:` for email, the URL itself, or `https://`+text for a bare domain; sets `title`, `spellcheck="false"` — auto-linking | certain for control flow; the three validator helpers' internal regexes weren't traced (inferred purpose from field names `isEmail`/`isURL`/`isURLWithoutProtocol`) |

### `autoFormatMarkdownEnabled` gating chain (all certain)

1. Editor default options (offset 524628) hard-code `shouldAutoFormatMarkdown: true` alongside
   `smartQuotes`, `smartDashes`, `smartArrows`, `shouldShowSlashMenu`.
2. A Vue computed ref (offset ~1066559/1119143) reads
   `settingsStore.editorSettings.autoFormatMarkdownEnabled` and feeds it into the editor's
   `options.shouldAutoFormatMarkdown` at construction time.
3. A `watch()` (offset 1117974) pushes any live change straight into the running editor instance's
   `options.shouldAutoFormatMarkdown` — no reload needed.
4. The actual short-circuit (offset 542956, inside the input handler):
   `this.options.shouldAutoFormatMarkdown && !this.isCodeEl() && this.runShortcuts(event, cH, editor)`
   — the entire 9-rule `cH` array is skipped whenever the setting is off, **and** whenever the
   cursor is inside a code element regardless of the setting.
5. `smartQuotes` / `smartDashes` / `smartArrows` are each gated by their *own* independent option
   flags in the same expression and lazily instantiate their own rule instances (`c7`/`cj`/`cq` for
   quotes, `bZ` for dashes, `c4`/`c1`/`c0`/`c2`/`c3` for arrows) — **independent of**
   `autoFormatMarkdownEnabled`; turning markdown auto-format off does not disable them.
6. The settings-UI row itself is at offset 1519733, label key `format_markdown_automatically_as_you_type`.

### Editor/note-related settings

The canonical settings-key map `jU` (offset 599624–603653, `{camelCaseKey: 'LOCALSTORAGE_CONSTANT'}`)
and the Pinia `settingsStore`'s state factory `v0()` were read to enumerate every editor/note-related
persisted setting:

| Setting key | Likely purpose |
|---|---|
| `autoFormatMarkdownEnabled` | master toggle for the `cH` table above |
| `slashMenuEnabled` | enables the `/`-triggered insert menu |
| `enableSpellCheck` | native spellcheck in the editor |
| `smartQuotes` | straight → curly quotes while typing |
| `smartDashes` | `--` → em dash |
| `smartArrows` | arrow-like sequences → Unicode arrows |
| `typeWriterEnabled` | "Typewriter mode" (keeps caret vertically centered) |
| `font` / `fontSize` | editor font family / size (default size 14) |
| `defaultImageSize` | default inserted-image size (default `"large"`) |
| `newNoteHeading` | default heading level auto-applied to a new note's title line (default `h2`) |
| `baseLineHeight` / `paragraphSpacing` | line-height / paragraph-spacing overrides |
| `lineWidthLevel` / `focusModeLineWidthLevel` | editor content max-width, normal vs. Focus Mode |
| `completedTodoStyle` | visual style for checked-off todos (default `"gray"`) |
| `moveCompletedTodoItemToBottom` | auto-moves checked todo items to bottom of list |
| `editProtectionEnabled` | "edit protection" guard (default off) |
| `codeWrap` | wraps long code-block lines instead of horizontal scroll (default on) |
| `defaultCodeLanguage` | default syntax-highlight language for new code blocks |
| `displayFileMode` | how attachments render inline (default `"preview"`) |
| `filePreviewHeight` | attachment preview height in px (default 400) |
| `hideTagsAutoComplete` | hides the `#tag` autocomplete popup |
| `previewAttachmentEnabled` | inline attachment preview vs. plain link (default on) |
| `isEditorRTL` | forces right-to-left editor direction |
| `editorBottomPadding` | extra scroll padding at the bottom (default 300px) |
| `focusModeOnNewNote` | auto-enters Focus Mode on new notes |
| `textColorHighlightShortcutEnabled` | gates keymap classes `eq`/`ez` above (default on) |
| `formatBarVisible` | shows/hides the floating format toolbar (key exists in `jU`; consuming code not located) |
| `extraWordsInDictionary` / `spellcheckLanguages` | custom dictionary additions / active spellcheck languages |
| `dateFormat` / `timeFormat` | date/time display format for note metadata |

Non-editor-surface settings also present but out of this task's scope: theme, sort order, security/
lock (`enableTouchID`, `lockWhenAppClosed`, `forceLock`, `autoLockDuration`), backup settings,
global-shortcut toggles, notes-list display options, and various Note-Info side-panel
collapse/expand flags.

### Unresolved

- Rule #7's exact delimiter→style mapping and whether `]`/`)` really drive `[text](url)` link
  syntax both live inside an untraced helper `bH(...)`.
- `formatBarVisible` is a real key in the settings map but its consuming code wasn't located.
- No un-decoded `ash(0x..)`/`aso(...)` calls were found anywhere in the `cH` array, `v0()`, or `jU`
  — decoding is complete and clean in all regions cited above.

## 3. Enter and Backspace handling

Three classes matter: the main editor class (`handleEnterInputEvent`, `handleBackspaceKeyDown`,
`handleTab`, `handleIndentation`, `getHeadingEl`, `removeHeading`, offsets ~538000–586000); a
`codeManager` with its own `handleEnterBeforeInputEvent`/`handleEnterInputEvent` (offsets
~440000–442200, confirmed via literal `"PRE"`/`HTMLPreElement`/`"CODE"` checks); and a
`blockquoteManager` with the same pair (offsets ~482400–483400, confirmed via literal
`"BLOCKQUOTE"` checks). A `tableManager` supplies `handleTabkeyDown` and (note the differently-cased
name) `handleBackSpaceKeyDown`.

### How Enter is handled

The `beforeinput` dispatcher (offset ~539400), while `_isEnterKeyPressed`, first calls both
sub-managers' `handleEnterBeforeInputEvent` to snapshot the pre-Enter `<pre>`/`<blockquote>`
ancestor (each manager's version is a few lines, fully read, certain), and records
`_beforeInputPreviousLi` when inside an `<li>`. Then, on the `input` event, `handleEnterInputEvent`
(main class, offset 548214) runs:

- **List item**: if the cursor lands in an `<li>` after the browser's native split, a helper (`Tc`,
  offset 321445) promotes a stray `<div>` Chromium sometimes creates instead of a sibling `<li>`
  into a real `<li>`; a checked/unchecked (`i3`) attribute is propagated to the correct sibling,
  defaulting the new item to unchecked.
- **Heading**: if the resulting block is a heading with non-empty text, it's left as a same-level
  heading (native behavior kept); if it's an **empty** heading, `removeHeading` (offset ~566950)
  converts it to a plain `<div>`, stripping descendant `class` attributes.
- **Blockquote** (`blockquoteManager.handleEnterInputEvent`, offset 482621): if the browser split the
  quote into two adjacent `<blockquote>` elements, they are merged back into **one** via `p8`
  (offset 319343) with an inserted `<br>` — the quote continues seamlessly. If the caret already
  landed outside any `<blockquote>` after Enter (native exit, typically after an empty trailing
  line), no interception happens and it stays a plain paragraph.
- **Code block** (`codeManager.handleEnterInputEvent`, offset 440389): if the browser split the
  `<pre>` into two, they are re-merged into **one** `<pre>` with a `<br>` marking the line — a code
  block can never be split into two by pressing Enter. If not split, only stray empty `<code>`
  remnants are cleaned up.
- **Table**: no dedicated "Enter inside a cell" branch exists. The only table-aware logic fires once
  the cursor has already moved **outside** the `<table>` (extracting a stray trailing node into its
  own paragraph after the table) — while still inside a cell, native contenteditable Enter behavior
  applies unmodified (**inferred** — typically a line break within the same cell, not a new row).
- **Empty list item**: no explicit JS branch was found that special-cases Enter on an empty `<li>`;
  this is believed to fall through to Chromium's native empty-`<li>` Enter behavior, but this could
  not be confirmed from the JS alone (flagged as unresolved below).
- **Plain paragraph**: no interception; native split applies.

### How Backspace is handled

`handleBackspaceKeyDown` (main class, offset 555231, fully read) runs, in order:

1. If a table cell **range** is selected, `tableManager.handleBackSpaceKeyDown()` handles it
   exclusively (clears selected cells' content; deletes the whole table if every cell was selected)
   and nothing else runs. For an ordinary blinking caret in a single cell (no range), this returns
   false and execution falls through with **no cell-specific branch** — native behavior applies
   (**inferred**: typically a no-op at a cell boundary).
2. If an image is selected, deletes it.
3. Otherwise, only for a **collapsed caret at the absolute start of a block**:
   - **List item** → `toggleFormat("outdent")` (≡ `handleIndentation(true)`) — unless the LI's own
     closest `<pre>` ancestor is inside it, in which case this branch doesn't fire.
   - **Blockquote** → if immediately preceded by another `<blockquote>` sibling, no interception
     (native merge keeps it inside the quote); otherwise `toggleFormat("blockquote")` strips quote
     formatting, converting to a plain paragraph.
   - **Code block (`<pre>`)** → `codeManager.removeCodeBlock` converts the whole block to a plain
     `<div>` using its text content (de-formats, doesn't delete).
   - **Collapsible section** (class `shine-collapsible-section`) → delegates to `gj.PH.handleBackspace`
     (body not read — unresolved).
   - **Heading** → converts to a plain paragraph via `toggleFormat("heading", '', {shouldToggleSameHeading:true})`,
     but **only if** the heading is the very first block in the document **and** the caret is at the
     absolute start of the whole editable area; otherwise native merge-with-previous-block runs
     unmodified (a `_beforeInputHeadingEl` clone is stashed beforehand for this case, but its
     downstream consumer wasn't found — unresolved).

### Enter key behavior by context

| Context | What happens |
|---|---|
| Empty list item | Not explicitly handled in JS found; presumed native Chromium behavior (unresolved) |
| Non-empty list item | Splits into a new `<li>`, with a fix-up for a Chromium quirk that sometimes emits a `<div>` instead |
| Heading | Non-empty result stays a heading; empty result converts to a plain paragraph |
| Blockquote | Split quotes are re-merged into one with an internal `<br>`; a native exit (already outside the quote) is left alone |
| Code block | Never splits into two blocks — always re-merged into one `<pre>` with an internal `<br>` |
| Table cell | No dedicated branch while inside a cell; native contenteditable behavior applies (inferred) |
| Plain paragraph | Native browser paragraph split, no interception |

### Backspace-at-start-of-block behavior

| Context | What happens |
|---|---|
| List item | Outdents one level (`toggleFormat("outdent")`), unless a `<pre>` is nested inside it |
| Blockquote | Strips quote formatting, unless preceded by another quote line (then native merge keeps it inside the quote) |
| Code block | Converts the whole block to a plain `<div>` (de-formats, not delete) |
| Table cell (bare caret, no range) | No cell-specific branch; native behavior applies (inferred) |
| Heading | Converts to a plain paragraph only if it's the first block *and* caret is at the document's absolute start; otherwise native merge |
| Collapsible section | Delegates to an untraced handler |
| Plain paragraph | Native character deletion / block merge |

### `handleIndentation`, `handleTab`/`handleTabkeyDown`, and `insertLineBreak`

- `handleIndentation(outdent: boolean)` (offset 550187, fully read): if the selection touches any
  `<li>`/`<ul>`/`<ol>`, outdent splits off the selected items and promotes them one nesting level up
  (or out of the list entirely at the top level); indent wraps the selected items into a new nested
  `<ul>`. **Outside of any list** (plain paragraph, heading, blockquote, code block), outdent deletes
  one preceding **U+2003 EM SPACE** character if present, and indent inserts one — i.e. **Tab-based
  indentation on non-list text inserts a literal em space, not a tab character or regular spaces.**
- `handleTab` (offset ~549935): if the cursor is in an `<li>`, always calls `handleIndentation`
  (table check short-circuited away); otherwise tries `tableManager.handleTabkeyDown`, falling back
  to `handleIndentation` if that returns false (not in a table).
- `tableManager.handleTabkeyDown` (offset 426257, fully read): classic spreadsheet Tab navigation —
  moves to the next cell (wrapping to the next row's first cell, **inserting a new row** if Tab is
  pressed in the table's last cell); Shift+Tab moves to the previous cell, wrapping to the previous
  row's last cell.
- `getNextListItem` (static, class `d8`, offset 442995, class fully read) — **correction to the
  original working assumption**: this is **not** used by Enter/Backspace list-split logic at all. It
  exclusively backs an Arrow-Up/Down "reorder list item" feature (`d8.onKeyDown` → `moveListItemIfNeeded`
  → `moveListItem`, wired to keymap class `eY` above), moving the current `<li>` above/below its
  neighbor including across nesting levels.
- `insertLineBreak` (offset 586071, fully read): inserts one `<br>` (two, if at the very end of the
  block's content — the classic "trailing `<br>` needs a sibling" HTML fix) inside whatever block
  currently holds the caret, uniformly across list items, headings, quotes, code, table cells, and
  plain paragraphs (only the code-block tail-detection differs slightly). No keymap class was found
  that calls it directly — presumably reachable via Shift+Enter through a code path outside the
  `dj`/`d9` hierarchy (unresolved).

### Unresolved

- Empty-list-item Enter behavior (no explicit branch found; presumed native).
- `_beforeInputHeadingEl`'s downstream consumer (captured on Backspace into a non-first heading, but
  never seen read again).
- `gj.PH.handleBackspace` (collapsible-section Backspace) — body not read.
- Identity of `gG` (used for `onKeyDown`/`handleBeforeInputEvent`/`handleAndroidBeforeInputEvent`/
  `handleEscape` in the main editor) — likely distinct from `d8` (no matching methods on `d8`), but
  its own class body wasn't located.
- `handleIndentation`'s nested-list unwrap/rewrap logic is intricate; only partially traced beyond
  the top-level behavior described above.
- The exact keybinding (if any, on the shipped Mac build) that triggers `insertLineBreak`.

## 4. Format bar / toolbar specification

Shortcut-symbol constants (offset ~931980, `{isMac:H2,isWin:H3}=iz`):
`H5` = `⌘` (Mac) / `Ctrl` (Win) — primary modifier; `H6` = `⌘` (Mac) / `''` (Win, dropped) —
secondary "also-Cmd" modifier; `H7` = `⌥` (Mac) / `Alt` (Win). Table below renders the Mac form.

The table itself is the `allFormats` getter of a Pinia store `editorFormatStore`
(`OG=defineStore("editorFormatStore",{getters:{allFormats(){...}}})`, array literal at offset
1,128,470–1,133,650). **34 entries total, walked to the closing `]`.** A `desktopFormats` getter
filters out `mobileOnly` rows and appends a synthetic `edit` row for the mobile-style edit button
(not part of the base table).

| id | shortcut (Mac) | eventType | activeKey | formatAction | formatValue | other |
|---|---|---|---|---|---|---|
| add | — | editorShowInsertMenu | — | — | — | the "+" button |
| slash | — | — | — | — | — | mobileOnly |
| heading | ⌘1,2,3,4,5,6 | editorSetHeading | heading | heading | H2 | opens native OS submenu (H1–H6) |
| bold | ⌘B | editorToggleFormat | bold | bold | — | |
| italic | ⌘I | editorToggleFormat | italic | italic | — | |
| underline | ⌘U | editorToggleFormat | underline | underline | — | |
| strike_through | ⌘⇧X | editorToggleFormat | strikeThrough | strikeThrough | — | |
| text_color | ⌘⌥1-8 | editorSetColor | isTextColor | textColor | — | |
| highlight | ⌘⌥⇧1-8 | editorSetColor | isHighlighted | highlight | — | |
| align_left | ⌘⇧L,E,R,J | editorSetTextAlignment | — | — | — | opens native submenu (left/center/right/justify) |
| image | — | — | — | — | — | mobileOnly |
| check_list | ⌘9 | editorToggleFormat | checkList | insertUnorderedCheckList | — | |
| bullet_list | ⌘7 | editorToggleFormat | unorderedList | insertUnorderedList | — | |
| number_list | ⌘8 | editorToggleFormat | orderedList | insertOrderedList | — | |
| undo | ⌘Z | editorUndo | — | — | — | |
| redo | ⌘⇧Z | editorRedo | — | — | — | |
| tag | — | — | — | — | — | mobileOnly |
| date | — | — | — | — | — | mobileOnly |
| collapsible | ⌘. | editorToggleFormat | collapsible | collapsible | — | |
| quote | ⌘⇧U | editorToggleFormat | blockquote | blockquote | — | |
| code | ⌘⇧C | editorToggleFormat | code | code | — | |
| code_block | \`\`\` | editorToggleFormat | codeBlock | codeBlock | — | |
| link | ⌘K | editorHandleLink | — | — | — | |
| divider | ⌘⇧H | editorInsertDivider | — | — | — | |
| note_link | — | — | — | — | — | mobileOnly |
| formula | ⌘⇧M | editorInsertFormula | — | — | — | |
| subscript | ⌘⇧; | editorToggleFormat | subscript | subscript | — | |
| superscript | ⌘⇧' | editorToggleFormat | superscript | superscript | — | |
| remove_format | ⌘\\ | editorToggleFormat | — | removeFormat | — | |
| indent | Tab | editorToggleFormat | indent | indent | — | |
| outdent | ⇧Tab | editorToggleFormat | outdent | outdent | — | |
| move_list_item_up | ⌘⌥↑ | editorMoveListItem | — | true | — | direction flag |
| move_list_item_down | ⌘⌥↓ | editorMoveListItem | — | false | — | direction flag |
| line_break | — | editorInsertLineBreak | — | false | — | mobileOnly |

(Note: this table's `heading`/`text_color`/`highlight`/list/alignment shortcuts describe the
toolbar's own click targets and displayed accelerator hints; they are a separate structure from the
`dj` keymap classes in §1, and — per §1's registration finding — are the likely place the real
Mac-native accelerators live, though this table itself doesn't wire the OS-level key listener.)

## 5. Slash-command menu and "+" menu

### Slash-command menu

`hz.refreshFormatsTemplates()` → `this.allFormatsTemplate` (offset ~510,600–517,800). **21
top-level entries**, several with `submenu` arrays (leaves shown nested below); `title` is the
i18n key passed to `f4['L'](...)`, also each leaf's `keywords` array is exactly what the typed text
after `/` is matched against (confirmed at the matcher, offset ~520,095: `flattenFormatsTemplate`
tests typed text against each item's `title` OR any of its `keywords`).

| title/key | action | keywords |
|---|---|---|
| heading | submenu H1–H6 → `setHeading('H#')` | — |
| format (parent) → bold / italic / underline / strikethrough / subscript / superscript | `toggleFormat(...)` per child | [bold] / [italic] / [underline] / [strikethrough] / [subscript] / [superscript] |
| text_color (parent) → red/orange/yellow/green/blue/pink/purple/gray/(none) | `setTextColor(color)` | [color, "textcolor"] |
| highlight (parent) → same 9 colors | `setHighlightColor(color)` | [color, "highlight"] |
| list (parent) → checklist / bullet_list / number_list / indent / outdent | `toggleFormat('insertUnorderedCheckList'/'insertUnorderedList'/'insertOrderedList'/'indent'/'outdent')` | [checklist,list] / [list,bullet] / [number,list] / [indent] / [outdent] |
| text_align (parent) → left/center/right/full | `setTextAlignment(x)` | [x, "align"] |
| table | submenu 2×2…10×10 (loop) | `insertTable(n,n)` | [table] per size |
| date | dynamic submenu via `dateTimeManager.getDatePopupItems()` | [date] |
| time | dynamic submenu via `dateTimeManager.getTimePopupItems()` | [time] |
| insert_divider | `insertDivider()` | [divider] |
| collapsible_section | `toggleFormat('collapsible')` | [collapsiblesection, section] |
| quote | `toggleFormat('blockquote')` | [block, quote] |
| code | `toggleFormat('code')` | [code] |
| code_block | `toggleFormat('codeBlock')` | [codeblock] |
| add_a_link | `insertCustomFormat('link')` | [link] |
| insert_image | `insertCustomFormat('image')` | [image] |
| insert_file | `insertCustomFormat('file')` | [file] |
| embed_video | `insertCustomFormat('embed')` | [video] |
| tex_formula | `insertCustomFormat('formula')` | [formula] |
| select_from_templates | `insertCustomFormat('template')` | [template] |
| remove_format | `toggleFormat('removeFormat')` | [removeformat] |

### "+" menu

**Distinct from the slash menu** — its own, smaller native **Electron `Menu.popup()`** template
(`label`/`accelerator`/`submenu` shape, not the Vue popup's `title`/`icon`/`keywords` shape), built
inline in the toolbar's click handler when `eventType==="editorShowInsertMenu"` (offset
1,136,288–1,137,750; triggered by toolbar row `id:"add"` above):

| label | accelerator | action |
|---|---|---|
| insert_image | ⌘⇧O | `editorSelectImage` |
| insert_file | ⌘O | `editorSelectFile` |
| insert_table (submenu 2×2…9×9, then "custom") | ⌘T | `editorInsertTable {rows,columns}`; "custom" opens a size-entry dialog |
| insert_date (submenu: datetime/date/time) | ⌘D / ⌘⇧D / ⌘⇧⌥D | `editorInsertDateTime` with `"datetime"`/`"date"`/`"time"` |
| embed_video | ⌘⇧Y | `editorShowEmbedModal` |
| tex_formula | ⌘⇧M | `editorInsertFormula` |

Evidence it's a separate structure, not a re-use of the slash menu: different table-size range
(2×2–9×9 + an explicit "custom" entry, vs. the slash menu's 2×2–10×10 with no custom entry); no
text-formatting items at all (consistent with "+" being insert-only); and it is structurally an
Electron `Menu` template rather than the Vue slash-popup shape.

### Unresolved (sections 4–5)

None in the ranges cited — every literal in the toolbar table, the slash-menu array, and the "+"
menu array decoded cleanly to a plain string; no residual undecoded calls were found there. The only
calls left un-inlined are legitimate runtime references, not string-array lookups: the i18n lookup
functions themselves (`m4(...)`/`f4['L'](...)`, key names given), an icon-asset lookup, the two
`dateTimeManager` dynamic-submenu builders (contents not statically knowable), and date-formatter
calls for the "+" menu's date submenu labels.

## 6. Search

### Note search: SQLite-backed storage, but JS-regex matching — not `LIKE`/FTS

Storage is SQLite (`preload.js`: `'upnote.sqlite3'`, `getSQLManager`, `setupMainSqliteDB`,
`node:sqlite`). But the actual text search is **hybrid**, and does not use SQL `LIKE`, `MATCH`, or
an FTS5 virtual table anywhere:

- `renderer.deob.js` (`agx`, offset ~1,575,798) sends unresolved note ids plus
  `{serializedRegexes: lj(regexArray), databaseLocation}` to `searchNotes` via
  `preload.js → ipcRenderer.invoke('SEND_MESSAGE_TO_SEARCH_NOTES_WORKER', ...)`.
- `main.js` routes that IPC channel to a real `node:worker_threads` `Worker` loaded from webpack
  chunk `154.js` (identified by decoding the chunk-id arithmetic in `main.js`; cross-checked against
  a second worker at chunk `673.js`, the file-change watcher).
- `154.js`'s `'SEARCH_NOTES'` handler was decoded far enough to recover the literal SQL:
  **`SELECT text FROM notes WHERE id = ? LIMIT 1;`** — a plain, parameterized, per-row fetch. It then
  rebuilds `new RegExp(source, flags)` for each serialized pattern and tests them in JavaScript
  against the fetched `text` column. `154.js` was grepped for `VIRTUAL`, `fts`, `MATCH`,
  `CREATE TABLE`, `CREATE INDEX` — zero hits; other decoded SQL fragments (`SELECT * FROM `,
  `ON CONFLICT(id) DO UPDATE SET `, `DELETE FROM `, transaction pragmas) point to a generic
  hand-rolled CRUD layer over tables `notes`, `noteLinks`, `notebookLinks`, `tagLinks`, `workspaces`
  — no FTS5 table exists.
- A renderer-side fast path (`agl`/`ah6`/`ah7`, offset ~1,574,000) matches already-loaded notes'
  **title** and a precomputed **`summary`** field synchronously in-memory, via the same kind of
  regex test (`l7`, offset 615363: `String.prototype.search` per regex, AND-combined via `Math.min`),
  cached by `{revision, index}`. Only notes not resolved this way (batches of 500) are sent to the
  `154.js` worker for a full-body match against the `text` column.

**Direct answers**: search matches the **`text`** column (a plaintext extraction), not `html` — the
`html` column exists in the same table/pool but the search query explicitly selects only `text`.
Default is **case-insensitive**; a `caseSensitive` option exists and is user-toggleable (mirrors the
in-note Find bar's "match case" toggle). Default is **not diacritic-sensitive** — "cafe" matches
"café" by default. This is implemented not via `.normalize()`/NFD or a bare regex `i` flag, but by a
character-class expansion: `fH()` (offset ~475,048) builds a map from diacritic classes (the
`'eèéẻẽẹêềếểễệëěēę'`-shaped string literals seen in the raw string pool are exactly this) to their
full sibling group, and `fK(term, {caseSensitive, locale})` (offset ~475,610) turns each input
character into a regex character class containing every case+diacritic variant (e.g. `e` →
`[eèéẻẽẹêềếểễệëěēęE...]`). This same `fK` builder is reused for both note search and the in-editor
Find (below), so folding behavior is consistent between the two features. A separate "escape
literally" mode falls back to plain `new RegExp(escaped, 'i')` (case-insensitive, not
diacritic-folding) when used.

### In-note find/highlight

`948.js` is a fork literally named **"advanced-markjs"** — mark.js's real `markRegExp(regexp, options)`
API, extended with a custom `acrossElements` option (`processMatchesAcross`) that lets one match span
multiple DOM elements (standard mark.js only matches within a single text node); it also
auto-appends the `g` flag and supports group-based highlighting via `separateGroups`/`hasIndices`.

`renderer.deob.js` class `Nq` (offset ~1,041,190) wraps it: `markAsync()` calls
`marker.markRegExp(regex, {exclude: ['.no-search-highlight, .no-search-highlight *'], ...})`;
`unmarkAsync()` calls `marker.unmark()`, with extra defensive code that temporarily swaps `<mark>`
nodes for `<span>` while unmarking a contentEditable root, to preserve editor selection/cursor state
across the DOM mutation. Two instances exist: one on `.search-result-list-view` (highlights matches
in the search-results list) and one on `.shine-editor` (offset ~1,061,222) — the real "Find in note"
feature.

Find-in-note's regex is built by `ail` (offset ~1,104,850) using the **same** `fK` diacritic-folding
builder as note search, compiled with the `g` flag, then passed to
`refreshMarkers(regex, {separateWordSearch:false, caseSensitive, acrossElements:true})` — so in-note
find is regex-based, diacritic-folded by default, and cross-element-aware, not a plain substring
scan. Matches are wrapped in native `<mark>` elements. Next/previous navigation (`aim`/`aio`, offset
~1,105,300) is store-driven, not native browser find: it re-queries all `<mark>` elements, computes
`(i±1) % count` with wraparound, moves an `.active-mark` class, and calls
`scrollIntoViewIfNeeded()`; the refresh callback also republishes `{activeMarkIndex, totalMarksCount}`
to the store (almost certainly what drives a "3 of 12"-style counter in the UI). A special case:
if the active match sits inside an internal `upnote://` link, pressing "next" jumps to the next
match instead of following the link.

## 7. Mobile/desktop conditionals

No `Capacitor`, `cordova`, `isMobile`, `isIOS`, `isAndroid`, or `navigator.platform`/`userAgent`
checks exist anywhere in `renderer.deob.js` (the sole `cordova` hit in the whole extraction is
inside `195.js`'s bundled Firebase SDK's generic environment detector — unrelated to UpNote).
Platform differences are instead expressed as:

1. **`mobileOnly` flags** on the shared toolbar/slash-menu table (§4): `slash`, `image`, `tag`,
   `date`, `note_link`, `line_break` are all `mobileOnly:true`. `desktopFormats()` filters these out
   and appends a desktop-only "edit" arrangement button.
2. **A runtime touch-capability flag**, `hasTouch = 'ontouchstart' in document.documentElement`
   (offset ~290,370), gating several concrete behaviors: table column-resize hit-area (8px vs. 10px
   on touch), a 400ms tap-vs-drag disambiguation for table cell drag-selection, an extra image
   zoom/view overlay button (shown only on touch; tapping an image with touch opens zoom instead of
   the desktop resize/option flow), a swapped click-listener (`clickDispatcher`) for popup/list
   components on touch, and checklist-state preservation firing on every input event on touch vs.
   only on Enter on desktop.
3. **Explicit Android/iOS-WebView code paths**, evidence the renderer bundle is literally shared
   with the mobile WebView app: a predicate `bJ['l7']()` gates Android-only `beforeinput` handling
   (`_androidSnapshot` capture, `handleAndroidBeforeInputEvent`, offset ~539,459); a function
   literally named `keepLiNodeForWKWebViewIfNeeded` (offsets 545,372 and 554,257) handles an
   iOS-WKWebView-specific quirk, called unconditionally alongside the Android branch in the same
   handler — confirming both platform-specific paths coexist in one shared bundle.
4. Most interactive elements (image resizer, drag handles, editor blocks) register both
   `touchstart` and `mousedown` on the same handler rather than branching — this is "support
   touchscreens on desktop too," not a platform gate, and is not counted as a conditional above.

### Unresolved (sections 6–7)

- No `CREATE TABLE notes (...)` DDL was found — only the `SELECT text FROM notes ...` query; column
  names beyond `text`/`html`/`title`/`summary` are inferred from other literals, not verified
  against a schema statement.
- `879.js`, `109.js`, `483.js` were not deobfuscated at all (only `154.js` was spot-decoded, since it
  is demonstrably the search worker); they may hold additional schema/column detail.
- The `154.js` worker's own regex-matcher helper (analogous to the renderer's `l7`) was not traced
  byte-for-byte to confirm it AND-combines multiple search terms identically — inferred from a
  shared `'search'` string literal in its pool, not from reading the function body.
- No mobile build artifact was available to independently confirm the "shared with mobile" claim in
  §7 beyond the runtime feature-detection/named-helper evidence inside this one desktop bundle.

## What could not be decoded

This consolidates every gap noted in the sections above, so it's clear what's a real limit of static
analysis versus what simply wasn't chased down:

**Biggest structural gap** — the shipped **macOS** binary does not run the `dj`-hierarchy keymap
dispatcher for any formatting command (bold, italic, underline, headings, lists, alignment, colors,
blockquote, code, divider, subscript/superscript, date/time) at all — that whole 32-class block is
gated behind `isMac() || push(...)`, which is false on Mac. Those commands' real Mac keyboard
shortcuts almost certainly live in Electron `Menu`/`accelerator` definitions in the main process
(`main.js`), which turned out to be obfuscated as well and was not deobfuscated beyond the few
indices needed for §6. **Fully reverse-engineering the Mac-native accelerator table would require
deobfuscating `main.js` the same way `renderer.js` was handled here** — not attempted in this pass.

**Not deobfuscated at all**: `879.js`, `109.js`, `483.js` (each has its own independent string-array
scheme; grepped in raw/encoded form for editor-setting names with no hits, but never decoded).
`673.js` was identified as the file-change-watcher worker chunk by chunk-id arithmetic but not
opened. `main.js` and `preload.js` are obfuscated (discovered mid-investigation, contrary to the
initial assumption that they were plain) — only specific indices were hand-decoded from them for
§6; no full-file pass was done.

**Partially traced / inferred rather than certain**:
- The `bH(...)` helper that renders input-rule #7's captured markdown span (§2) — which delimiter
  character maps to which inline style (bold/italic/strikethrough/code), and whether `]`/`)`
  actually participate in `[text](url)` link syntax.
- The three URL/email validator helpers behind auto-linking (input rule #8, §2) — control flow is
  certain, internal regex bodies are not.
- `d8`'s `moveListItemIfNeeded` body (§1, backing Arrow-Up/Down list reordering) — class shape and
  method names are certain, full body not unwound.
- `handleIndentation`'s nested-list unwrap/rewrap logic (§3) beyond the top-level indent/outdent
  behavior described.
- The `154.js` search-worker's regex-matching helper (§6) — inferred to AND-combine multiple terms
  like the renderer's `l7`, not independently verified by reading its body.

**Located but not read at all**:
- `gj.PH.handleBackspace` (collapsible-section Backspace handler, §3).
- The class behind `gG` (used for `onKeyDown`/`handleBeforeInputEvent`/`handleAndroidBeforeInputEvent`/
  `handleEscape` in the main editor, §3) — likely distinct from `d8`, identity unconfirmed.
- `_beforeInputHeadingEl`'s downstream consumer (§3) — captured on Backspace into a non-first
  heading, but no code was found reading it back.

**No explicit branch found (presumed native browser behavior, unconfirmed)**:
- Enter on an empty list item (§3).
- Enter or Backspace while the caret is inside a table cell with no range selected (§3) — the code
  only branches on table state once the cursor has moved *outside* the table, or when a multi-cell
  *range* is selected.
- The keybinding, if any, that triggers `insertLineBreak` on the Mac build (§3).

**No `CREATE TABLE` schema was recovered** for `notes` (§6) — only the `SELECT text FROM notes
WHERE id = ? LIMIT 1;` query literal; column names beyond `text`/`html`/`title`/`summary` are
inferred from other string-pool literals, not verified against a DDL statement.

**Confirmed clean**: the keymap registry (§1, 37/37 classes), the markdown input-rule array (§2,
9/9 rules), the toolbar table (§4, 34/34 entries), and the slash-menu/"+"-menu arrays (§5, all
entries) each decoded with **zero** residual `ash(0x..)`/`aso(...)`-style undecoded calls in their
respective regions — every gap in those sections is a "body not traced" gap, not a decoding failure.
