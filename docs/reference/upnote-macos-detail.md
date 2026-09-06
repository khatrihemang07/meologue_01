# UpNote macOS — Editor Behaviour (Detail Reference)

Exhaustive, GUI-driven documentation of UpNote's editor beyond the basics already
established elsewhere (Enter/Shift+Enter, empty-line representation, `- `/`1. `/`[] `
input rules, Tab nesting, bullet/numbered/checklist toolbar conversion, glyph cascade).

Method: real UpNote.app driven via `cliclick` on macOS, ground truth read directly from
`upnote.sqlite3` (`notes.html`), screenshots taken when the DOM was ambiguous. Every
finding is marked **verified** (directly observed this session) or **inferred**
(reasoned from adjacent verified behaviour, not independently exercised).

Rig: window at 136,176 size 1126x613 pts, focus mode. Toolbar y=768pts. Test note used
throughout: a scratch note (originally `<ul><li>one</li><li>two</li></ul>`) reused and
reset between cases with Cmd+A, Delete x3, verified back to `<br>` before each case.

---

## 0. Toolbar coordinates (re-verified this session)

Confirmed against a fresh screenshot before use — matched the values supplied exactly:
`+` 168, H 209, B 251, I 293, U 336, S 377, text-colour 419, highlighter 462, align 503,
checklist 545, bullet 587, numbered 629, undo 671, redo 713, indent 756, quote 797,
inline-code 839, code-block 881, link 923, divider 965, f(x) 1007, more 1049 — all at
y=768.

---

## Environment hazard found this session (read before trusting any borderline result)

**verified** — `cliclick t:"…"` (the documented typing method) silently drops/garbles
characters under this machine's current load (multiple concurrent Claude Code sessions
running). Symptoms observed: `"line one"` → `lin`, `"abcdefghijklmnop"` → `abcg`,
`"hello world"` → `hl` or `ho wo`. It is NOT a fixed prefix-truncation — characters are
dropped irregularly throughout the string, and no error is reported. Retrying the same
`t:` call did not reliably fix it, and adding `-w` (inter-event delay) up to 150ms/char
did not fix it either.

Once, this also manifested as the **macOS system Character Viewer / Emoji picker**
(a floating search box with a dictation mic and category icons) popping up anchored to
the caret mid-type and swallowing the rest of the keystrokes — this is an OS-level
overlay, not part of UpNote, and its trigger could not be isolated (no fn-key or
Ctrl+Cmd+Space was issued by this session's own commands). Combined with one case where
a toolbar button visibly flashed "active" (Italic highlighted) but the very next DB read
and a fresh screenshot showed the mark had reverted to plain and the toolbar un-highlighted
with no corresponding action taken by this session — the evidence points at **another
process on this shared machine intermittently sending real keyboard input to the
frontmost app** during this session, despite this task's premise of exclusive GUI
ownership. This could not be confirmed (no other `cliclick` process was observed running
at the time of inspection) but the pattern is not explained by typing speed alone.

**Mitigation used for the rest of this document:** all text entry after this point uses
`osascript -e 'tell application "System Events" to keystroke "…"'` instead of
`cliclick t:`, which was 100% reliable in every trial run here (short and long strings,
repeated). Every finding below was additionally cross-checked with a second DB read
2-5s apart and/or a screenshot before being marked **verified**; a handful of first-pass
anomalies were caught this way and re-run cleanly. Single-key presses and chords via
`cliclick kp:` / `cliclick kd:…ku:…` were NOT observed to drop, only the multi-character
`t:` typing primitive — so those are used unchanged throughout.

---

## 1. Selection-based inline marks

| Case | Keys/clicks | Result HTML | Status |
|---|---|---|---|
| Select word "hello", Bold via **toolbar** | double-click word, click toolbar B (251,768) | `<b>hello</b> world` | verified |
| Re-click toolbar B on same (now fully-bold) selection | click toolbar B again | `hello world` (unbolded) | verified — toolbar click is a toggle |
| Bold via **chord** on unformatted selection | Cmd+B | `<b>hello</b> world` | verified — identical tag to toolbar |
| Cmd+B again on fully-bold selection | Cmd+B | unbolds | verified |
| Italic chord | Cmd+I | `<i>hello</i> world` | verified |
| Italic chord again (toggle off) | click toolbar I | plain | verified |
| Underline chord | Cmd+U | `<u>hello</u> world` | verified |
| Underline toggle off | click toolbar U | plain | verified |
| Strikethrough chord | Cmd+Shift+X | `<strike>hello</strike> world` | verified |
| Strikethrough toggle off | click toolbar S | plain | verified |
| **Partial-bold selection** — "hello" already `<b>`, select "hello wo" (spans into unformatted "world"), press Cmd+B | Home, Shift+Right×8, Cmd+B | `hello world` (ALL unbolded, including the previously-bold "hello") | verified |
| Same selection, Cmd+B again (now fully unformatted) | Cmd+B | `<b>hello wo</b>rld` (ALL bolded) | verified |

**Rule confirmed (ProseMirror-style `toggleMark`)**: the toggle looks at whether the mark
is active across the **entire** selection. If yes → remove from the whole selection. If
no (none, or only some of it) → apply to the whole selection. There is no "some are bold,
add to the rest" behaviour — a partially-bold selection is unbolded entirely on first
toggle, matching the same rule as "any active → remove-all" popular in ProseMirror/Tiptap.
The toolbar button's highlighted/active state follows the same "active across whole
selection" test (confirmed visually: with "hello" fully bold, selecting "hello wo" still
showed B highlighted, because divide — actually observed: the B icon highlighted for the
partial selection too, then toggling removed all — so the toolbar's "active" affordance
tracks "at least one char in selection has the mark", while clicking removes only when
**all** of it does; when it doesn't the click applies to all. Net effect is the single
toggle rule above.)

**Tags used** (verified, all via both toolbar click and Cmd-chord — identical output):
Bold → `<b>`, Italic → `<i>`, Underline → `<u>`, Strikethrough → `<strike>`. No `<strong>`/
`<em>`/inline `style=` were ever produced for these four marks.

**Cross-block selection**: selecting from inside one paragraph-div into the next and
applying Bold does **not** produce one mark spanning the block boundary — each block gets
its own independent `<b>…</b>` wrapping only the selected text within that block:
`line o<b>ne</b><div><b>line tw</b>o</div>` — verified.

**Whole-list selection**: selecting an entire 3-item bullet list (Cmd+A) and pressing
Cmd+B wraps each `<li>`'s full text in its own `<b>`:
`<ul><li><b>one</b></li><li><b>two</b></li><li><b>three</b></li></ul>` — verified. A
second Cmd+A + Cmd+B on the now-fully-bold list unbolds all three `<li>`s in one action —
verified (same whole-selection toggle rule as above, just spanning multiple list items).

**Nested marks**: selecting a word, applying Italic (Cmd+I → `<i>nested</i>`), then
re-selecting the same word and applying Bold (Cmd+B) produces **italic as the outer tag,
bold as the inner tag**: `<i><b>nested</b></i>` — verified (checked twice, 3s apart, for
consistency after the interference issue above).

**Mark "arming" on a collapsed caret** (no selection): typing `abc`, leaving the caret
collapsed at the end, pressing Cmd+B (no selection), then typing `def` produces
`abc<b>def</b>` — the mark is armed and applies going forward even with nothing selected.
Pressing Cmd+B again (still collapsed, at the end of the bold run) un-arms it; typing `ghi`
next produces `abc<b>def</b>ghi` (plain again). Both verified, checked twice.

---

## 2. Undo/redo granularity

**Redo shortcut is Cmd+Shift+Z. Cmd+Y does nothing** (verified — tried Cmd+Y twice after an
undo, no change; Cmd+Shift+Z then correctly redid both steps in sequence).

| Case | Steps | Result | Status |
|---|---|---|---|
| Type "hello" in one fast burst, Cmd+Z once | type→undo | `<br>` (whole word gone in one undo) | verified |
| Type "alpha", **2s pause**, type " beta", Cmd+Z once | | `alpha` (only " beta" removed) | verified |
| …Cmd+Z again | | `<br>` | verified |
| …Cmd+Shift+Z, Cmd+Shift+Z (redo x2) | | `alpha` then `alpha beta` | verified — redo is exactly symmetric |
| Type "ab", **1s pause**, type "cd", Cmd+Z once | | `ab` | verified |
| Type "ab", **0.3s pause**, type "cd", Cmd+Z once | | `ab` | verified |
| Type "ab" then "cd" with **no explicit pause** (back-to-back shell calls, only process-launch overhead between) | Cmd+Z once | `<br>` (both removed together) | verified |

**Grouping rule (verified)**: UpNote (ProseMirror-style) groups consecutive typing into
one undo step based on a **short time gap**, not character count or word boundaries — a
26-character string typed in a single instantaneous burst undoes completely in one Cmd+Z,
while inserting even a ~0.3s pause mid-stream splits it into two undo steps. The exact
threshold was not pinned to the millisecond, but it sits somewhere under ~300ms and above
whatever gap two back-to-back `osascript keystroke` shell invocations produce (roughly
tens of ms) — i.e., a fairly short/typical ProseMirror-history-style grouping window, not
a whole-sentence or whole-paragraph grouping.

**Undo of an input-rule conversion restores the literal typed text, not just the block
type.** Typing `- ` (which auto-converts the line to a bullet, producing
`<ul><li><br></li></ul>`) and then pressing Cmd+Z once produces `-&nbsp;` — i.e. it
reverts to the literal `"- "` paragraph text, undoing the *conversion* as its own step
rather than only removing the bullet wrapper and leaving an empty item. **Verified.**

**Undo of a toolbar/chord mark is its own step**, separate from the typing that preceded
it (even test with only a plain click in between, no typing pause needed since formatting
is applied as a discrete action): type "word", select all, click toolbar Bold →
`<b>word</b>`; Cmd+Z once → `word` (mark removed, text intact); Cmd+Z again → `<br>` (text
removed). **Verified**, two-step sequence confirmed independently.

**Undo of Tab-indent is its own step.** `<ul><li>item</li></ul>` → Tab →
`<ul><ul><li>item</li></ul></ul>` → Cmd+Z once → back to the flat
`<ul><li>item</li></ul>`. **Verified.**

**Undo does NOT cross a block boundary — Enter is always its own undo step.** Sequence:
type "first" → Enter → type "second" → `first<div>second</div>`. Then:
- Cmd+Z #1 → `first<div><br></div>` (only "second"'s typed text is removed; the second,
  now-empty, div block remains)
- Cmd+Z #2 → `first` (the Enter/block-split itself is undone, merging back to one block)
- Cmd+Z #3 → `<br>` (the word "first" is removed)

Three clean, independent, minimal steps — **verified**, and this is one of the more
consequential findings: block-splitting (Enter) is never silently absorbed into a
neighbouring text-edit undo step, no matter how fast the two actions happen in succession.

**Not determined**: exact behaviour of undo on Tab-indent that also crossed a re-nesting
of siblings, undo/redo of the glyph cascade (•→○→▪) specifically, and whether there is an
undo-history size cap — none were tested (out of scope for the time available; flagged in
the final summary).

---

## 3. Text colour and highlight

Clicking the toolbar **text-colour** button (419,768) opens a floating palette (anchored
above the toolbar, can render partially off the bottom of a short window — confirmed via
full-screen capture): **Red, Orange, Yellow, Green, Blue, Pink, Purple, Gray**, plus
**Remove Text Color**. Each row shows its own chord: **⌥⌘1..⌥⌘8** for the 8 colours,
**⌥⌘0** for Remove Text Color — verified these chords work directly without opening the
menu (Opt+Cmd+0 removed color that had been applied via the menu).

The **highlighter** button (462,768) opens the identically-shaped palette (same 8 colour
names/order) but with the **Shift** key added to every chord: **⌥⇧⌘1..⌥⇧⌘8**, and
**⌥⇧⌘0 = "No background"** (its remove-highlight item, labelled differently from text
colour's "Remove Text Color"). Verified the palette UI and shortcuts by screenshot; both
Opt+Cmd and Opt+Shift+Cmd chords were exercised.

**HTML emitted (verified)** — both features are **CSS classes on a `<span>`**, never
inline `style=` or hex values in the DOM:
- Text colour: `<span class="shine-text-red">colorword</span>` (class name is
  `shine-text-<colorname>`, lowercase, matching the menu label).
- Highlight: `<span class="shine-highlight-yellow">colorword</span>` (class name is
  `shine-highlight-<colorname>`).
- **Combined** (both applied to the same selection): they merge into **one span with two
  classes**, not nested spans: `<span class="shine-highlight-yellow shine-text-red">colorword</span>`.
- Switching directly from one colour to another **replaces** the class rather than
  stacking (Red → Blue via the menu produced `shine-text-blue` cleanly, no leftover
  `shine-text-red`) — verified.
- Removing one of the two (e.g. Opt+Shift+Cmd+0 while both a highlight and a text colour
  are active) removes only its own class, leaving the other intact:
  `<span class="shine-highlight-yellow shine-text-red">` → `<span class="shine-text-red">`
  after removing the highlight — verified.

**Not determined**: the actual hex/RGB values behind each named colour (would require
reading UpNote's shipped CSS/theme file, not exercised via the GUI this session — the
class names are stable identifiers regardless of theme, so this is a cosmetic gap only),
and whether text colour/highlight survive across light/dark theme switches.

---

## 4. Headings

Toolbar **H** button (209,768) opens a menu: **H1, H2, H3, H4, H5, H6, Normal** (no
shortcut hints shown in this menu, unlike the colour menus). Clicking H1 on a selected
paragraph produces `<h1>heading text</h1>` — verified.

**Cmd+1 through Cmd+6 = H1 through H6, verified directly** (no need to open the H menu):
Cmd+2 → `<h2>`, Cmd+6 → `<h6>`. **Cmd+0 does nothing** (tried after Cmd+6; block stayed
`<h6>` — not a "set to Normal" shortcut). **Cmd+7, in this build, is not "Normal"
either** — pressing it on an `<h6>` block wrapped the heading in a bullet list instead:
`<ul><li><h6>heading text</h6></li></ul>` (this is very likely just the bulleted-list
toggle shortcut, unrelated to headings, firing because Cmd+7 is bound to it independent of
current block type — see the keyboard-chords section). **The "Normal" menu item's
shortcut, if any, was not found** — flagged as not-determined below.

**Heading ⇄ list composition (verified both directions)** — headings and list-item-ness
are orthogonal and combine by nesting the `<hN>` inside the `<li>`, never one replacing
the other:
- Heading first, then list-ify: `<h6>heading text</h6>` + bullet-list chord →
  `<ul><li><h6>heading text</h6></li></ul>`.
- List first, then heading: `<ul><li>listitem</li></ul>` + Cmd+1 →
  `<ul><li><h1>listitem</h1></li></ul>`.

**Enter at the END of a heading does NOT continue the heading** — it starts a plain
paragraph: `<h2>My Heading</h2>` + End + Enter + "next line" →
`<h2>My Heading</h2><div>next line</div>` — verified.

**Enter in the MIDDLE of a heading's text SPLITS it into two headings of the same
level** (this differs from the end-of-heading case above): `<h3>HeadSplit</h3>`, caret
placed between "Head" and "Split", Enter → `<h3>Head</h3><h3>Split</h3>` — verified. So
the rule is: splitting a heading's own text preserves the heading level on both halves,
but pressing Enter on the trailing empty position (end-of-block) demotes to a normal
paragraph for the new block.

**Not determined**: the "Normal" heading-menu item's keyboard shortcut (if any) — not
isolated in the time available; what Cmd+7/Cmd+8/Cmd+9 do outside of a heading context
(only tested Cmd+7 immediately after Cmd+6 on a heading); whether headings can be
nested inside a checklist item or blockquote the same way they nest inside `<li>`.

---

## 5. Quote, code block, inline code, divider, link

All via toolbar buttons on a selected line of text unless noted.

| Block | Button | HTML produced | Status |
|---|---|---|---|
| Quote | 797 | `<blockquote>a quote line</blockquote><br>` (an empty trailing paragraph is auto-appended after the quote) | verified |
| Code block | 881 | `<pre spellcheck="false">code here</pre><br>` (same auto-appended trailing empty paragraph) | verified |
| Inline code (on a selection, not a whole line) | 839 | `<code spellcheck="false">inlineword</code>` | verified |
| Divider | 965 | `<hr>` — clicking it on an empty note produced `<hr><br><br>` (two empty paragraphs after) | verified |
| Link (on a selection) | 923 | opens a "Please enter a link" popup anchored under the selection; typing a URL + Enter produces `<a href="https://example.com">linktext</a>` | verified |

**Quote internal structure**: each line inside a blockquote is its own `<div>` child —
**Enter inside a quote (even at the end) adds another `<div><br></div>` sibling and does
NOT exit the quote**, no matter how many times you press it (tested up to 4 consecutive
Enters, still inside `<blockquote>`) — verified.

**Code block internal structure is different: lines are joined by `<br>`, not `<div>`.**
Enter inside a `<pre>` inserts a literal `<br>` within the same `<pre>` element:
`<pre spellcheck="false">code here<br>line2</pre>` — verified. Also does not auto-exit on
repeated Enters (tested 4x, still inside `<pre>`).

**Escaping both quote and code block: Backspace at the very start of the block's first
line unwraps it back to a plain `<div>` paragraph** (same generic "Backspace-at-start
unwraps" rule already established for lists, applied here too) — verified for both:
- Quote: `<blockquote>a quote line</blockquote>` → caret Home, Backspace →
  `<div>a quote line</div>`.
- Code: `<pre>codeline</pre>` → caret Home, Backspace → `<div>codeline</div>`.

**Escaping via arrow key, not Backspace**: pressing Down-arrow while the caret is on the
last line inside a `<pre>` moves the caret out into the trailing empty paragraph after
the code block (into the auto-appended empty block that toolbar-conversion left behind) —
confirmed the caret lands outside the `<pre>` and subsequent typing is plain text, not
code. **Verified** the caret exits this way; the exact serialization of that trailing
paragraph once text is typed into it looked unusual (text appeared to sit directly after
`</pre>` with no visible wrapping `<div>` in one capture:
`<pre spellcheck="false">code here<br>line2<br><br><br><br></pre>outside` — flagged as
**inferred/unconfirmed** whether that's a real editor quirk or a serialization artifact of
this particular sequence; not independently re-verified from a clean state).

**Not determined**: exact popup/flow for editing or removing an existing link (only
creation was tested), whether the divider is a void self-closing block that can't contain
a caret at all (behavior when arrowing onto it wasn't separately isolated from the
auto-inserted trailing blank lines), and Enter/Backspace behavior specifically at a
divider.

---

## Mid-session correction: the in-page keymap is dead on macOS — the Electron menu bar is authoritative

A parallel static-analysis pass on UpNote's bundle found that **32 of 37 in-page
(ProseMirror) keymap bindings are gated behind an `isMac()` check that excludes macOS** —
only Tab, Control+L and Control+O register from the editor's own keymap on this platform.
The real Mac chords come from **Electron `Menu` accelerators**, which live in the app's
native menu bar and are opaque to static analysis of the renderer bundle. This session
enumerated them directly with the macOS Accessibility API (no typing involved — this
reads the menu structure only) and then **verified each candidate chord by actually
pressing it in the editor and reading `notes.html` back**, per the instruction that the
menu table is a hypothesis and the live chord sweep is the arbiter.

### Full Mac menu-bar accelerator table (verified via Accessibility API read, not inferred)

Read with (per menu):
```
osascript -e 'tell application "System Events" to tell process "UpNote" to tell menu bar 1 to tell menu bar item "Format" to tell menu 1 to get {name of every menu item, ...}'
```
(done per-item in a loop to keep name/char/modifier correlated — the flattened
multi-list form misaligns on separators). Modifier code 0 decoded as Cmd, 1 as Cmd+Shift,
2 as Cmd+Option, 3 as Cmd+Option+Shift (decoding cross-checked against chords already
confirmed working by direct GUI testing — e.g. Bold=mods 0=Cmd+B, Strikethrough=mods
1=Cmd+Shift+X, Redo=mods 1=Cmd+Shift+Z, all matched independently-observed behaviour).

**Format menu:**

| Item | Accelerator (decoded) |
|---|---|
| Bold | Cmd+B |
| Italic | Cmd+I |
| Underline | Cmd+U |
| Strikethrough | Cmd+Shift+X |
| Subscript | Cmd+Shift+; |
| Superscript | Cmd+" (i.e. Cmd+Shift+') |
| Bullet List | Cmd+7 |
| Number List | Cmd+8 |
| Quote | Cmd+Shift+U |
| Code (inline) | Cmd+Shift+C |
| Code Block | Cmd+Option+Shift+C |
| Insert Divider | Cmd+Shift+H |
| Add a link | Cmd+K |
| Embed Video | Cmd+Shift+Y |
| TeX Formula | Cmd+Shift+M |
| Remove formatting | Cmd+\ |
| Heading, Text Color, Highlight, Text Align, Checklist, More, Table, Collapsible Section, Date/Time, Remove all links | no top-level accelerator reported (Heading's H1-H6 and Text Color/Highlight's 8 colours are submenu items with their own accelerators — already documented above via GUI: Cmd+1..6 for headings, ⌥⌘1..8 / ⌥⇧⌘1..8 for colour/highlight) |

**Edit menu:** Cut=Cmd+X, Copy=Cmd+C, Paste=Cmd+V, Paste and match style=Cmd+Shift+V,
Select All=Cmd+A, Undo=Cmd+Z, Redo=Cmd+Shift+Z, Insert Image=Cmd+Shift+O, Insert
File=Cmd+O. Start Dictation and Emoji & Symbols are bound to the physical **Globe/fn
key** (shown as 🎤/🌐 glyphs, not a Cmd chord) — **this is almost certainly the source of
the stray system Character-Viewer popup noted in the environment-hazard section above**:
something on this shared machine is issuing a real fn-key press independent of this
session's own `cliclick`/`osascript` commands (neither tool asserts the fn/Globe key).

**View menu:** Sidebar=Cmd+Shift+\, Info=Cmd+Shift+I, Switch Space=Cmd+J, Switch
View=Cmd+Option+J, Format panel=Cmd+Shift+A, Focus Mode=Cmd+Shift+F, Back=Cmd+Shift+[,
Forward=Cmd+Shift+], Lock=Cmd+L, Toggle Full Screen=Control+Cmd+F (standard macOS
convention; the raw modifier code for this one didn't decode cleanly against the
0/1/2/3 scheme above, so the chord itself is inferred from convention, not re-verified by
keypress).

**Note menu:** Pin to top=Cmd+Shift+P, Quick Access=Cmd+Shift+S, Search this
note=Cmd+F, Replace=Cmd+R, Copy link to note=Cmd+Option+Shift+L, Add to
notebooks=Cmd+Shift+B, Export=Cmd+E, rename/Edit=Cmd+Shift+W, Print=Cmd+P, Move to
trash=Cmd+Delete (Backspace).

### Live chord verification (actually pressed, `notes.html` read back) — this is what to trust

| Chord | Menu says | Actually does | Status |
|---|---|---|---|
| Cmd+B / Cmd+I / Cmd+U | Bold/Italic/Underline | works exactly as menu states | **verified alive** |
| Cmd+Shift+X | Strikethrough | works | **verified alive** |
| Cmd+1..Cmd+6 | (submenu, not in top-level table) | H1..H6 | **verified alive** |
| Cmd+7 | Bullet List | converts to `<ul>` | **verified alive** |
| Cmd+8 | Number List | converts to `<ol>` | **verified alive** |
| Cmd+K | Add a link | opens "Please enter a link" popup; Escape cancels cleanly | **verified alive** |
| Cmd+Shift+U | Quote | **with an actual selection**: converts the line to `<blockquote>` | **verified alive, but selection-sensitive** — with only a collapsed caret (no selection), the same chord instead **inserted a brand-new empty blockquote after the current line** rather than converting it (`quotechord<blockquote><br></blockquote>`). Toolbar-button clicks did not show this split behaviour in the earlier tests (those always had a selection). |
| Cmd+Option+Shift+C | Code Block | with a real selection (confirmed via visible highlight): converts to `<pre>` | **verified alive** (an earlier attempt with a failed/absent selection wrongly looked dead — see note below) |
| Cmd+Shift+H | Insert Divider | with a real selection: replaces selected text with `<hr>` | **verified alive** (same false-negative trap as above) |
| **Cmd+Shift+C** | Code (inline) | **nothing happens** — tried twice, once with a visibly-highlighted full-line selection (screenshot-confirmed) and once via Cmd+A; text stayed plain both times, UpNote remained frontmost (no stolen focus) | **verified dead** — this is a genuine "menu accelerator exists but does not fire" case, exactly the kind of gap this investigation was asked to catch |
| Cmd+Shift+7 | (not in Format's top-level table) | nothing | **verified dead** |
| Cmd+Shift+8 | (not in Format's top-level table) | nothing | **verified dead** |
| Cmd+Shift+9 | (not in Format's top-level table at all — Checklist's own menu row reported no accelerator) | converts to a checklist: `<ul><li data-checked="false">…</li></ul>` | **verified alive** — works despite having no discoverable menu accelerator string, so it's likely bound some other way (a second, redundant Electron accelerator, or an in-page binding that isn't gated by `isMac()`) |
| Cmd+] / Cmd+[ (no Shift) | not listed (View's Back/Forward use Cmd**+Shift**+[ / ]) | **indent / outdent** a list item, identical to Tab/Shift+Tab | **verified alive** — a completely different pair of chords from the menu's Back/Forward, which use Shift |
| Cmd+0 | not listed | nothing (tried right after Cmd+6, block stayed `<h6>`) | **verified dead / no binding found** |
| Home / End | n/a (OS-level text editing) | move caret to start/end of the current line/block | **verified** |
| Cmd+Left / Cmd+Right | n/a | identical to Home/End — start/end of line | **verified** |
| Option+Left / Option+Right | n/a | move caret one word back/forward | **verified** |
| Shift+Option+Right | n/a | extends selection one word forward (confirmed by then bolding the selection) | **verified** |
| Option+Backspace | n/a | deletes the previous word | **verified** |
| Cmd+Backspace | n/a | deletes from caret back to the start of the line | **verified** |

**Important caveat discovered mid-sweep**: a naive first pass marked Cmd+Shift+C,
Cmd+Option+Shift+C, and Cmd+Shift+H as "dead" — but that pass used `dc:` (double-click)
to select a word, and on at least one occasion **the double-click silently failed to
select anything** (confirmed by a follow-up screenshot showing a bare caret, no
highlight) while looking successful in the terminal. Re-running those three chords with a
guaranteed selection (Cmd+A, visually confirmed by screenshot) flipped two of the three
verdicts to "alive." **Only re-test with a screenshot-confirmed selection should be
trusted** — this is now the standard this document holds itself to for every "dead chord"
claim above test, and it's a specific trap worth calling out for anyone continuing this
work: a `cliclick dc:` double-click can silently no-op if the coordinate is even slightly
off, with no error and no different exit code.

**A second, separate GUI confound was hit here too**: mid-sweep, one attempt (Option+
Shift+Cmd+C or a neighbour) caused a totally unrelated **system-wide clipboard-history
popup** (visually similar to the Maccy app — a list of recent clipboard entries with
Cmd+1..Cmd+9 shortcuts shown) to appear over the whole screen, stealing focus from
UpNote entirely for one step. This is further evidence (beyond the emoji-picker incident)
that **something else on this shared machine has global hotkeys active** and can
intercept a chord before UpNote's own menu ever sees it — Escape dismissed it and UpNote
regained focus cleanly with the note content unaffected, but any single "dead chord"
result on this machine should be treated with suspicion unless independently reproduced,
which is why the table above only marks a chord dead after a clean, selection-confirmed,
UpNote-stayed-frontmost re-run.

### Tab on plain (non-list) text inserts a literal U+2003 EM SPACE — confirmed at the byte level

Typing `ab`, pressing Tab, typing `cd` and reading the raw bytes of `notes.html`
(`sqlite3 ... "select hex(html) from notes ..."`) gave:
```
6162 E28083 6364   →   "ab" + U+2003 (EM SPACE, UTF-8 E2 80 83) + "cd"
```
i.e. **Tab on ordinary text is not a real tab character, does not move focus, and is not
input-rule-eaten — it inserts one em-space glyph** and the caret continues in the same
paragraph (`ab cd` on screen, visibly wider gap than a normal space). **Verified at both
the rendered-screenshot and raw-byte level.** This only applies outside of the
list/checklist Tab-to-indent context documented elsewhere (already established:
Tab at the start of a list item indents instead).

---

---

## 6. Search (completed in the main session after the Sonnet agent hit its quota)

**In-note find — `Cmd+F`.** Opens a find bar pinned above the editor: magnifier + options
chevron, query field, `n/total` match counter, prev/next chevrons, close X.

| Property | Finding | Status |
|---|---|---|
| Case sensitivity | **Case-insensitive by default.** Query `apple` against `Apple apple APPLE banana` reports `1/3` | verified |
| Highlighting | **All** matches highlighted simultaneously in yellow, not only the current one | verified |
| Options menu | `✓ Ignore Case` (user-toggleable), and a mode switch `✓ Search` / `Replace` | verified |
| Find **and replace** | Present, via the same options menu | verified (menu item seen; replace not exercised) |

This corroborates the Android agent's independent finding (case-insensitive, yellow
highlight) and the static agent's (JS-regex matching, case-insensitive + diacritic-folding
by default). Three independent methods agree.

## 7. Slash menu (macOS)

Typing `/` opens a **categorised, nested** menu — NOT a flat list:

`Heading ▸`, `Format ▸`, `Text Color ▸`, `Highlight ▸`, `List ▸`, `Text Align ▸`,
`Table ▸`, `Date ▸`, `Time ▸`, `Insert Divider`, … (list continues below the fold)

The `/` character **remains in the document** as literal text while the menu is open —
identical to the Android behaviour. **verified**

## 9. Selection-spanning destructive operations

| Case | Keys | Result HTML | Status |
|---|---|---|---|
| Two blocks `one`/`two`, select all, Enter | Cmd+A, ⏎ | `<div><br></div><div><br></div>` — selection deleted, **two** empty blocks left, not one | verified |
| 2-item bullet list, select all, Tab | Cmd+A, ⇥ | `<ul><ul><li>one</li><li>two</li></ul></ul>` — both items indent together, again as an orphan nested `<ul>` with no parent `<li>` | verified |

## 10. Paste behaviour

| Clipboard content | Result HTML | Status |
|---|---|---|
| Plain text `line one\n\nline two` | `line one<br><br>line two` | verified |
| GFM `- alpha\n- bravo\n` | `- alpha<br>- bravo<br><br>` | verified |

**Two consequential rules.** (1) Newlines in pasted plain text become **`<br>` soft breaks
inside one block** — paste never creates block splits. (2) **UpNote does not convert pasted
Markdown into structure**: the `- ` markers survive as literal text. Its input rules fire on
typing only, never on paste.

This is a point where copying UpNote exactly would be a *regression* for this repo. An Entry's
body IS Markdown, so pasted GFM is parsed into a list on the way in — and ADR 0045 argued
that deliberately, on the grounds that a person pasting ordinary GFM should not watch their
list flatten into a paragraph with no error and no explanation.
