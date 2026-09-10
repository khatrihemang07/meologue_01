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

---

## Gap sweep — Enter/Shift-Enter/Tab/Backspace and list metrics (2026-09-10)

Method: same rig as above (UpNote 9.22.2, macOS, `osascript ... keystroke` for text,
`osascript ... key code 36`/`48`/`51` for Enter/Tab/Backspace — these proved more reliable
this session than `cliclick kp:return`/`kp:tab`/`kp:delete`, which intermittently no-op'd
with no error; see new environment note below), ground truth read from a WAL-inclusive copy
of `upnote.sqlite3`. Every finding below was cross-checked with at least two DB reads several
seconds apart (this session found the on-disk save can lag the visible editor state by
5-10s, longer than the 1-2s assumed earlier in this document — see note below) plus a
screenshot. All work happened in a single scratch note inside a notebook named
`meologue-probe`, reset with Cmd+A + repeated Backspace between cases (or a fresh File ▸
New Note when reset left stray content — both are noted inline where used). Screenshots are
in `screenshots/upnote-macos/gap-*.png`.

### New environment/method notes this session

- **Save latency is longer than assumed**: the earlier "cross-check 2-5s apart" guidance in
  this document undersells it. This session repeatedly saw the on-disk `html` column lag the
  true editor state by 5-10s (once observed effectively lost after 20s+ when the note was
  navigated away from before the debounced save fired — see "Not determined" below). Every
  reading in the tables below used a ≥3.5s wait, usually two waits with a re-read.
- **`cliclick kp:return` / `kp:tab` / `kp:delete` are not reliable on this machine this
  session** — they silently no-op on an unpredictable fraction of presses (no error, no
  stolen focus, just nothing happens). Switching to `osascript ... key code 36` (Return),
  `key code 48` (Tab), `key code 51` (Backspace) was 100% reliable in every retry this
  session. `cliclick kp:arrow-*` and `cliclick c:x,y` (click) were fine throughout.
  Single-key `cliclick kp:` primitives besides return/tab/delete were not re-tested for this
  same flakiness; treat any silently-no-op result on this machine with suspicion and retry
  via `key code` before concluding a chord is dead.
- **This machine had a live concurrent human user and a second Claude Code session during
  this sweep** (confirmed via screenshots showing live Brave/VS Code activity unrelated to
  this task, and stray contamination — a stray word appeared in the probe note once, and
  once ~26 minutes of typed content reverted to an earlier state after navigating to a
  different note before its save had landed). Every reading in the tables below was the
  *second* independent read (or later), and any run that looked contaminated was discarded
  and redone from a fresh `File ▸ New Note` rather than trusted.
- Window/toolbar coordinates from this document's rig section were **not** reusable
  unmodified this session — the UpNote window had moved to a second, higher-resolution
  display with a different on-screen position (though the same 1126×613pt size). All clicks
  this session first re-read the window's live position via System Events, then applied the
  same point-space deltas documented in the rig section.

### Group A — Enter / Shift+Enter on lists

| Case | Setup HTML | Action | Result HTML | Status |
|---|---|---|---|---|
| A1 — empty top-level **bullet** | `<ul><li><br></li></ul>` | ⏎ | `<br>` — list exits entirely, no leftover `<li>` | verified (2 reads, ~9s apart) |
| A1 — empty top-level **numbered** | `<ol><li><br></li></ol>` | ⏎ | `<br>` — same | verified |
| A1 — empty top-level **checkbox** | `<ul><li data-checked="false"><br></li></ul>` | ⏎ | `<br>` — same | verified |
| A1 — empty top-level **checked** checkbox (= A8) | `<ul><li data-checked="true"><br></li></ul>` | ⏎ | `<br>` — same; checked-ness has no effect on this rule | verified |
| A2 — empty **level-3** nested bullet | `<ul><li>one</li><ul><li>two</li><ul><li><br></li></ul></ul></ul>` | ⏎ | outdents **one level**: `<ul><li>one</li><ul><li>two</li><li><br></li></ul></ul>` | verified |
| A2 — (continuing) empty **level-2** | (above result) | ⏎ | outdents to level-1: `<ul><li>one</li><ul><li>two</li></ul><li><br></li></ul>` | verified |
| A2 — (continuing) empty **level-1** | (above result) | ⏎ | **exits the list entirely**, new plain sibling block: `<ul><li>one</li><ul><li>two</li></ul></ul><div><br></div>` | verified — one level outdented per press, all the way out, matches A1 |
| A3 — mid-text | `<ul><li>alphabravo</li></ul>`, caret between "alpha"/"bravo" | ⏎ | tail moves to a new sibling item: `<ul><li>alpha</li><li>bravo</li></ul>` | verified |
| A4 — start of non-empty item | `<ul><li>hello</li></ul>`, caret before "h" | ⏎ | blank item inserted **above**, original text unaffected below it: `<ul><li><br></li><li>hello</li></ul>` | verified — Home key did NOT reliably move caret to start on this build; `arrow-left` × (length) did |
| A5 — item with nested children | `<ul><li>one</li><ul><li>child</li></ul></ul>`, caret at end of "one" | ⏎ | new **empty sibling item inserted between** the parent and its children (children do **not** move into the new item, they stay right after it): `<ul><li>one</li><li><br></li><ul><li>child</li></ul></ul>` | verified |
| A6 — Shift+Enter inside a bullet item | `<ul><li>alpha</li></ul>` | ⇧⏎ then type "bravo" | `<br>` inside the **same** `<li>`: `<ul><li>alpha<br>bravo</li></ul>` | verified **at the raw byte (hex) level**: `...616c7068613c62723e627261766f...` = "alpha" + `<br>` + "bravo" |
| A7 — Shift+Enter inside a checkbox item | `<ul><li data-checked="false">alpha</li></ul>` | ⇧⏎ then type "bravo" | `<br>` inside the same `<li>`, `data-checked` untouched: `<ul><li data-checked="false">alpha<br>bravo</li></ul>` | verified |

Screenshots: `gap-a1-empty-item-enter-exits-list.png`, `gap-a2-level3-nested-empty-item.png`
(glyph `▪` confirms level 3 before the outdent sequence), `gap-a4-enter-at-start-blank-above.png`,
`gap-a5-enter-on-item-with-children.png`.

### Group B — Tab / Shift+Tab

| Case | Setup | Action | Result | Status |
|---|---|---|---|---|
| B1 — Tab in the **middle** of an item's text | `<ul><li>alphabravo</li></ul>`, caret between "alpha"/"bravo" | ⇥ | **indents the whole item** (does not split, does not insert em-space): `<ul><ul><li>alphabravo</li></ul></ul>` | verified — caret position within the item's text does not matter for Tab, only that the caret is inside a list item at all |
| B2 — Shift+Tab on a **level-1** item | `<ul><li>alpha</li></ul>` | ⇧⇥ | **exits the list entirely**, bare text at root: `alpha` (confirmed at hex level, no wrapping tag) | verified |
| B3 — Shift+Tab on plain prose (no em-space) | `plain text here` (bare, not a list) | ⇧⇥ | **no-op**, byte-for-byte unchanged | verified |
| B4 — Tab on a 3-item multi-line selection | `<ul><li>one</li><li>two</li><li>three</li></ul>`, Cmd+A | ⇥ | **all three indent together** into one orphan nested `<ul>`: `<ul><ul><li>one</li><li>two</li><li>three</li></ul></ul>` | verified — extends the 2-item finding already in §9 above to 3 items, same rule |
| B5 — numbered item nested under a bullet parent | `<ul><li>one</li></ul>`, Enter, Tab (empty level-2 item), then Cmd+8 to convert that item to numbered | — | `<ul><li>one</li><ol><li><br></li></ol></ul>` — the `<ol>` is a **sibling of the bullet's `<li>`**, same orphan-list pattern as bullet/bullet nesting. Rendered marker: `1.` at the level-2 indent | verified |
| B6 — Tab at the very end of an empty note | `<br>` (empty note) | ⇥ | Focus **stays in UpNote** (confirmed via `System Events` frontmost-process check immediately after the keypress) and inserts a **U+2003 em-space**, exactly the already-documented plain-text Tab rule — Tab never does OS/browser-style focus traversal in this editor | verified |

Screenshot: `gap-b2-shifttab-level1-exits-list.png`, `gap-b5-numbered-nested-under-bullet.png`.

**Correction/clarification to the existing "Tab / Shift+Tab" table** in this document
(§"Tab on plain (non-list) text inserts a literal U+2003 EM SPACE"): that finding is
correct and B6 above reproduces it exactly for the empty-note case, so no contradiction —
just confirming it also holds with nothing before or after the caret.

### Group C — Numbered lists

| Case | Finding | Status |
|---|---|---|
| C1 — marker glyph at levels 1/2/3 | **`1.` at every level** — numbers do **not** cascade to `a.`/`i.` the way bullets cascade `•`/`○`/`▪`. Only the indent changes; the glyph stays a plain arabic numeral + period at all three levels tested | verified, screenshot `gap-c1-numbered-marker-all-levels.png` |
| C2 — numbering continuation across an indent/outdent | Built `1. item1`, `2. item2`, indented a 3rd item (auto-converts to a **bullet**, not a numbered sub-item, matching the general "Tab always produces `<ul>` unless explicitly re-converted" rule from B5), then outdented a 4th item back to level 1 | The 4th item, back at level 1, renders **`3.`** — the top-level sequence counts only its own level's items and **skips over** the nested bullet, i.e. 1, 2, [bullet, uncounted], 3 | verified, screenshot `gap-c2-numbering-continuation.png` |
| C3 — plain block interleaved between two numbered lists | `<ol>` (1,2) → exit list → plain paragraph → new `1. charlie` | Second `<ol>` **restarts at `1.`** — no shared counter across the two separate `<ol>` elements | verified, screenshot `gap-c3-numbering-restarts-after-plain-block.png` |

Also newly observed and worth recording: once a numbered list reaches **10 or more items**,
UpNote stamps the `<ol>` itself with `data-upnote-marker-digit-count="2"` (verified in the
stored HTML for an 11-item list). This is the mechanism behind the marker alignment in E4
below — UpNote tracks how many digits the widest marker in the list needs and uses that to
lay the list out, rather than leaving it to native browser/CSS list-marker layout.

### Group D — Backspace

| Case | Setup | Action | Result | Status |
|---|---|---|---|---|
| D1 — start of **empty** level-1 item | `<ul><li><br></li></ul>` | ⌫ | `<br>` — exits list, same as Enter (A1) | verified |
| D1 — start of **non-empty** level-1 item | `<ul><li>hello</li></ul>`, caret before "h" | ⌫ | `hello` (bare) — **same unwrap-to-plain-block rule**, the only difference is whether the surviving content is empty or not | verified — confirms the existing doc's "does not merge into the item above" rule holds identically for empty and non-empty items |
| D2 — start of an item that **has nested children** | `<ul><li>one</li><ul><li>child</li></ul></ul>`, caret before "one" | ⌫ | `one` unwraps to a plain `<div>`, and the children are **orphaned in place at their original depth** (not promoted to level 1): `<div>one</div><ul><ul><li>child</li></ul></ul>` | verified |
| D3 — start of a **checked** checkbox item | `<ul><li data-checked="true">task</li></ul>`, caret before "t" | ⌫ | `task` (bare text) — **`data-checked` is dropped entirely**, no trace of the checked state survives on the resulting plain block | verified, screenshot `gap-d3-checkbox-backspace-drops-checked.png` |
| D4 — joining two plain `<div>` blocks | `<div>alpha</div><div>bravo</div>`, caret before "bravo" | ⌫ | `alphabravo` — direct concatenation, no space/`<br>`/wrapper inserted, single bare root block (only block left) | verified |
| D5 — Backspace **immediately** after the `- ` input rule fires | type `- ` (fires the rule → `<ul><li><br></li></ul>`), then Backspace with **no settling delay** | ⌫ | `<br>` — **does not** restore the literal `- ` text. This is the ordinary "empty-item Backspace" unwrap (same as D1-empty), a genuinely different code path from Cmd+Z, which — per the Undo section above — **does** restore the literal `-&nbsp;` | verified at hex level (`3c62723e` = exactly `<br>`, nothing else) |

### Group E — Rendering measurements

Measured by taking a full-resolution screenshot (`screencapture -x -D2`, native pixels — this
session's display was 2560×1664 physical px at a 2:1 Retina scale, i.e. 1280×832 pt logical
— UpNote's own window/zoom was the default, untouched 100%) and locating glyph bounding boxes
with Pillow (`PIL`) rather than eyeballing. All px figures below are **device pixels**; the pt
figure divides by the 2× Retina scale factor confirmed for this display.

| Measurement | Finding | Status |
|---|---|---|
| E1 — line-height / inter-block gap | Two consecutive plain one-line blocks: text-top-to-text-top pitch = **60px = 30pt**. Per the existing "zero margin" finding, this single 30pt figure **is** both the line-height and the full inter-block gap — there is no additional block margin on top of it | verified, screenshot `gap-e1-line-height-measurement.png` |
| E2 — list left indent per level, and glyph-to-text gap | Bullet glyph left edge moved right by **~54-56px (~27-28pt) per nesting level** (level1→2 and level2→3 increments were consistent within a few px). The gap between a glyph's right edge and its item's text start was **~20-21px (~10-10.5pt), consistent across bullet levels 1-3** (level-2's hollow `○` needed a lower brightness threshold to detect — its outline anti-aliases much fainter than the solid level-1 `•` and level-3 `▪`, which is itself worth knowing for anyone re-measuring this) | verified, screenshot `gap-e2-list-indent-levels.png` |
| E3 — checkbox glyph size, offset, checked rendering | Checkbox glyph bounding box: **31×30px (~15.5×15pt) square**. Glyph-to-text gap: **20px (~10pt)** — matches the bullet gap in E2. Checked state: box fills solid with a checkmark, and **the item's text dims from peak brightness 224/255 to 144/255 (≈36% dimmer)** — confirmed **no strikethrough** (no horizontal bright line was found bisecting the checked text's glyph height) | verified, screenshot `gap-e3-checkbox-checked-rendering.png` |
| E4 — numbered marker alignment at 10+ items | **Right-aligned.** In an 11-item list, every item's text ("item") starts at the identical left x-coordinate regardless of whether its marker is `1.`-`9.` (1 digit) or `10.`/`11.` (2 digits) — the single-digit markers sit indented one digit-width to the right of the double-digit ones. Confirmed both visually and by the `data-upnote-marker-digit-count="2"` attribute UpNote stamps onto the `<ol>` once a 2-digit marker appears (see Group C) | verified, screenshot `gap-e4-numbered-marker-alignment.png` |

### Not determined this session

- Whether the on-disk save ever has a hard flush trigger (note switch, app blur, explicit
  Save menu item) — this session observed **File ▸ Save**, navigating to a different note,
  and returning all fail to guarantee a flush of a very recent edit; one ~26-minute-old
  two-line edit was lost this way (reverted to its previous saved state) after navigating
  away before waiting long enough. The exact debounce/flush trigger was not isolated — budget
  every future scripted session generous (10s+) settle time before trusting a "final" read,
  and avoid navigating away from a note immediately after editing it.
- Numbered-list nesting was only exercised via Tab (which defaults to `<ul>` at the next
  level) plus an explicit Cmd+8 re-conversion per level (per B5/C1). Whether there is a
  *direct* keyboard path to a numbered child (e.g. typing `1. ` inside an already-list
  context) was tried and found **not** to fire the input rule (stays literal text) — this is
  itself a finding but the underlying reason (input rules disabled inside any list vs.
  disabled only for `<ol>`-inside-`<ul>`) was not isolated further.
- E1-E4 measurements were taken at this session's ambient window size/zoom (default 100%,
  1126×613pt window) on one specific display; a different zoom level or display would shift
  the absolute px/pt figures proportionally, though the *ratios* (e.g. indent-per-level ≈
  bullet-glyph-width, checkbox gap ≈ bullet gap) should hold.

---

## Gap sweep #2 — selection, conversion, un-listing, multi-block (2026-09-10)

Method: UpNote 9.22.2 on macOS, driven from a scratch notebook named `meologue-probe2`
(created fresh this session via File ▸ New Notebook…, since the prior session's
`meologue-probe` notebook no longer exists — it was never a persisted `notebooks` row when
checked at the start of this session). One scratch note, id `01a08921-a86c-7362-8b03-3c6a33cc1984`,
reused and reset with Cmd+A + repeated `key code 51` (Backspace) between cases. Text entry via
`osascript ... keystroke`; Enter/Tab/Backspace/arrows via `osascript ... key code` (36/48/51/
123-126) — both were reliable this session. Mouse clicks via `cliclick c:`/`dc:`/`kd:shift
c: ku:shift`, with click coordinates derived from the live window position+size (read fresh via
System Events each time the window moved) rather than fixed pixel constants, because the window
was relocated/resized by outside interference partway through the session (see below). Ground
truth read from a WAL-inclusive copy of `upnote.sqlite3`, every finding cross-checked with two
reads ≥4s apart via a `settle_read` helper; hex (`select hex(html)`) pulled wherever byte-exact
confirmation mattered. Screenshots are in `screenshots/upnote-macos/gap2-*.png`.

**Environment interference recurred this session, consistent with the hazard already
documented above.** Twice, an action landed on the wrong target: (1) a click on the sidebar
"+" next to Notebooks was followed, one screenshot later, by the window having relocated to a
different position/size and frontmost app having changed to `Code` — something else took focus
immediately after the click landed (the click itself worked; a follow-on interference event
moved focus away before the next command). (2) On two separate occasions a `Tab` keypress
landed while a stale `select_all` selection was still active instead of the single collapsed
caret a preceding click was meant to leave, producing a multi-item-indent result instead of the
single-item indent intended (visible in the resulting HTML as an implausible jump — e.g. the
wrong item nesting). Both were caught immediately by reading the HTML/screenshot straight after
and were corrected with Cmd+Z before the real test was re-run with a verified (screenshotted)
selection state. No finding below was accepted without a screenshot or hex confirmation of the
actual selection/state immediately beforehand.

### Group G — Multi-block selection → list conversion

All conversions below used the **Cmd accelerator** (Cmd+7 bullet, Cmd+8 numbered, Cmd+Shift+9
checklist) — the same chords already verified alive earlier in this document — rather than the
toolbar or Format menu, for consistency and reliability.

| Case | Setup | Action | Result HTML | Status |
|---|---|---|---|---|
| G1 — three blocks → bullet | `alpha` ⏎ `bravo` ⏎ `charlie` (3 blocks), Cmd+A | Cmd+7 | `<ul><li>alpha</li><li>bravo</li><li>charlie</li></ul>` — **three separate `<li>`s**, not one `<li>` with all the text | verified |
| G2 — same, numbered | rebuild 3 blocks, Cmd+A | Cmd+8 | `<ol><li>alpha</li><li>bravo</li><li>charlie</li></ol>` — three separate `<li>`s | verified |
| G2 — same, checklist | rebuild 3 blocks, Cmd+A | Cmd+Shift+9 | `<ul><li data-checked="false">alpha</li><li data-checked="false">bravo</li><li data-checked="false">charlie</li></ul>` — three separate `<li>`s | verified |
| G3 — toggle bullet off | (G1 result), Cmd+A | Cmd+7 again | `alpha<br>bravo<br>charlie` — **one single block, joined by `<br>`, NOT three separate `<div>`s.** Confirmed at hex level: `616C7068613C62723E627261766F3C62723E636861726C6965` | verified — **the flatten-to-plain step re-merges into one block, unlike Enter on a selection (§9) which leaves N empty divs** |
| G3 — toggle numbered off | (G2 bullet result), Cmd+A | Cmd+8 again | `alpha<br>bravo<br>charlie` — same one-block-with-`<br>` collapse | verified |
| G3 — checklist "toggle off" | (G2 checklist result, all `data-checked="false"`), Cmd+A | Cmd+Shift+9 again | `<ul><li data-checked="true">alpha</li><li data-checked="true">bravo</li><li data-checked="true">charlie</li></ul>` — **does NOT un-list.** It flips `data-checked` false→true on all items instead | verified — **checklist fundamentally does not use this chord to exit the list; a third press flips true→false again (see i3-checklist-toggle screenshots), cycling forever** |
| G4 — bullet → numbered (different type) | 3-item bullet list, Cmd+A | Cmd+8 | `<ol><li>alpha</li><li>bravo</li><li>charlie</li></ol>` | verified — **converts cleanly in place, no nesting introduced** |
| G5 — mixed selection (1 plain + 2 list items), precise mouse selection | `plain` (plain block) + `<ul><li>item1</li><li>item2</li></ul>`, select all 3 via click+shift-click (verified by screenshot: all 3 highlighted) | Cmd+7 | `<ul><li>plain</li><li>item1</li><li>item2</li></ul>` — **"plain" becomes a list item too; all three end up bulleted** (same "any inactive → activate all" rule already established for inline marks in §1, now confirmed at block-list granularity) | verified |

**Selection-boundary gotcha found while setting up G5** (not part of the G5 answer itself, but
a real, reproduced trap): building the "2 items only" selection with `Shift+Up ×2` from the end
of `item2` — where `plain`, `item1`, `item2` all happened to be exactly 5 characters — put the
selection anchor exactly at the END of the `plain` block (same column, one line up). The
highlight rendered as covering only `item1`+`item2` (visually correct), but applying Cmd+7 to
that selection **also converted `plain`** into a list item, even though zero characters of it
were visibly selected. Re-doing the identical 2-item selection via mouse click+shift-click (not
touching `plain`'s line at all) gave the expected `plain<ul><li>item1</li><li>item2</li></ul>`
with `plain` untouched. **Conclusion: a keyboard selection whose anchor lands exactly on a
block boundary can pull the adjacent block into a block-level command even when nothing in it
is visibly highlighted — a mouse-verified selection is the only trustworthy one for this class
of test.** Screenshots: `gap2-g1-three-blocks-to-bullet.png`, `gap2-g3-bullet-toggle-off-
collapses-to-one-block.png`, `gap2-g3-checklist-second-press-toggles-checked.png`, `gap2-g3-
checklist-third-press-unchecked.png`, `gap2-g4-bullet-to-numbered-inplace.png`, `gap2-g5-mixed-
selection-after-bullet.png`.

### Group H — Single block ↔ list round trip

| Case | Before | After bullet | After toggle back | Byte-identical to original? | Status |
|---|---|---|---|---|---|
| H1 — plain text | `hello world` (hex `68656C6C6F20776F726C64`) | `<ul><li>hello world</li></ul>` | `hello world` | **Yes** — hex matches exactly | verified |
| H2 — block with a `<br>` soft break | `line one<br>line two` (hex `6C696E65206F6E653C62723E6C696E652074776F`) | `<ul><li>line one</li><li>line two</li></ul>` — **the `<br>` does NOT survive as a soft break inside one `<li>`; it gets promoted to a real list-item boundary (2 items), not `<li>line one<br>line two</li>`** | `line one<br>line two` — merged back into one block with `<br>` | **Yes**, end-to-end — but the intermediate representation is not what most people would guess | verified |
| H3 — inline marks (bold, italic) | `<b>bold</b> <i>italic</i> plain` (hex `3C623E626F6C643C2F623E203C693E6974616C69633C2F693E20706C61696E`) | `<ul><li><b>bold</b> <i>italic</i> plain</li></ul>` | `<b>bold</b> <i>italic</i> plain` | **Yes** — hex matches exactly | verified |

### Group I — Un-listing a NESTED list (the key case)

I1 — 3-level bullet list `<ul><li>one</li><ul><li>two</li><ul><li>three</li></ul></ul></ul>`
(glyphs `•`/`○`/`▪`, screenshot `gap2-i1-3level-bullet-built.png`), Cmd+A + Cmd+7 pressed
**repeatedly**, exact HTML after each press:

| Press | Result HTML | What happened |
|---|---|---|
| 1 | `one<br><ul><li>two</li><ul><li>three</li></ul></ul>` | Selection was **fully list-active** → toggle-off fires. Only the outermost `<li>` ("one") unwraps to plain text; the nested sub-list (two/three) is **not flattened**, just shifts up one level as a whole (loses its outer wrapper) |
| 2 | `<ul><li>one</li><li>two</li><ul><li>three</li></ul></ul>` | Selection was now **mixed** (one=plain, two/three=list) → the "any inactive → activate all" rule fires instead of continuing to strip: "one" gets **re-listified**, flattened to the same level as "two" |
| 3 | `one<br>two<br><ul><li>three</li></ul>` | Selection fully list-active again → toggle-off strips one more level: "one" and "two" unwrap to plain (joined by `<br>`), "three" survives alone as its own single-item list |
| 4 | `<ul><li>one</li><li>two</li><li>three</li></ul>` | Mixed again → activate-all re-listifies everything **flat** (relative nesting is not restored) |
| 5 | `one<br>two<br>three` | Fully active → toggle-off flattens completely to one plain block, `<br>`-joined |

**Answer: neither "flatten all at once" nor a clean "one level lifts per press" — it alternates
between stripping one level (when the selection is uniformly list-active) and re-normalizing to
flat (when the previous strip left a mixed selection), converging to fully-flat plain text after
5 presses for a 3-level list.** This is the same "any inactive → activate all, else remove all"
rule already documented for inline marks in §1, now shown to govern list-unwrapping too, and it
means **naive repeated Cmd+7 does not monotonically de-nest** — it can re-nest on alternating
presses. Screenshots: `gap2-i1-press1.png` … `gap2-i1-press5-final-flat.png`.

I2 — same 3-level list rebuilt; this time selecting **only the level-2 and level-3 items**
(`two`+`three`, confirmed by screenshot — `one` NOT highlighted) and pressing Cmd+7 once:

`<ul><li>one</li><li>two</li><ul><li>three</li></ul></ul>` — **the level-1 parent ("one") is
completely unaffected** (still a normal `<li>`, same position); only the selected sub-range has
one level stripped (two moves from level-2 to level-1 of what remains, three stays nested one
level under it). **verified**, screenshot `gap2-i2-scoped-toggle-parent-untouched.png`.

I3 — numbered: rebuilding the same 3-level structure via Tab always produces `<ul>` at each
nested level regardless of the root being `<ol>` (matches the already-documented "Tab always
nests as `<ul>`" rule) — so the first Cmd+8 on a select-all of a `<ol>`/`<ul>`/`<ul>` mix is a
**mixed selection** and activates all to `<ol>` first (`<ol><li>one</li><ol><li>two</li><ol>
<li>three</li></ol></ol></ol>`), and only the *second* press begins the same strip/re-normalize
alternation seen in I1 (`one<br><ol><li>two</li><ol><li>three</li></ol></ol>`). **Same
underlying rule as bullet, just requires one extra "normalize the mixed ol/ul" press first when
the nesting was built via Tab.** verified.

I3 — checklist: built a 3-level nested checklist (`<ul><li data-checked="false">one</li><ul>
<li data-checked="false">two</li><ul><li data-checked="false">three</li></ul></ul></ul>`,
screenshot `gap2-i3-checklist-3level-built.png`), checked "two" via a verified checkbox click
(`data-checked="true"`), then Cmd+A + Cmd+Shift+9 **repeatedly**:

| Press | Result | 
|---|---|
| 1 | `<ul><li data-checked="true">one</li><ul><li data-checked="true">two</li><ul><li data-checked="true">three</li></ul></ul></ul>` — mixed checked-state → **activates all to checked=true**. Nesting **completely unchanged** |
| 2 | `<ul><li data-checked="false">one</li><ul><li data-checked="false">two</li><ul><li data-checked="false">three</li></ul></ul></ul>` — uniform → flips to false. Nesting **still completely unchanged** |

**Answer: for checklist, Cmd+Shift+9 on a nested selection NEVER un-lists, at any press —
it only ever toggles `data-checked` uniformly (mixed→true, then true↔false thereafter). The
`data-checked` attribute and the full nesting structure both survive indefinitely; there is no
"peel a level" behavior for checklists via this chord at all**, in sharp contrast to bullet and
numbered lists. verified, screenshots `gap2-i3-checklist-toggle-activates-all-checked.png`,
`gap2-i3-checklist-toggle-back-unchecked.png`.

### Group J — Nested-list conversion

J1 — flat 3-item bullet list, indented item 2 and item 3 to level 2 only (`<ul><li>one</li>
<ul><li>two</li><li>three</li></ul></ul>`), select all, Cmd+8:

`<ol><li>one</li><ol><li>two</li><li>three</li></ol></ol>` — converts cleanly in place at both
levels (`<ul>`→`<ol>`), no extra nesting. Rendered markers: level 1 = `1.`, level 2's own
counter restarts independently at `1.`/`2.` (matches the already-documented "each separate
`<ol>` restarts at 1" rule, here applied to a nested-but-sibling `<ol>`). **verified**,
screenshot `gap2-j1-2level-numbered.png`.

### J2 — the marker-glyph question, settled

Built a genuine 3-level **numbered** list — level 1 `one`, level 2 `two`, level 3 `three`, each
level explicitly converted to `<ol>` (not left as the `<ul>` that Tab produces by default) —
and read both the DOM and a full-resolution screenshot:

**DOM (verified via hex-checked `select html`):**
```html
<ol><li>one</li><ol><li>two</li><ol><li>three</li></ol></ol></ol>
```
Three independently-nested `<ol>` elements, each restarting its own counter at 1.

**Screenshot** (`gap2-j2-3level-numbered-all-markers-are-1.png`) shows, unambiguously:
```
1. one
   1. two
      1. three
```

**Answer: on macOS, the marker is a plain arabic numeral + period — "1." — at every nesting
level, level 1 through level 3. There is no cascade to `a.`/`i.` and no substitution to bullet
glyphs (`◦`/`▪`) at levels 2-3.** This **reconfirms** (does not contradict) the existing
"Group C1" finding earlier in this document ("`1.` at every level... only the indent changes").
It directly **contradicts the parallel Android-pass report** of bullet glyphs appearing at
levels 2-3 of a numbered list — that is a genuine **macOS ≠ Android platform difference**, not
a mistake in either report: this session verified the macOS side at both the DOM level and the
pixel level, from a freshly-built, explicitly-all-`<ol>` 3-level list, with no ambiguity.

### Group K — Multi-paragraph behaviour

| Case | Setup | Action | Result HTML | Status |
|---|---|---|---|---|
| K1 — Tab on two selected **plain** blocks | `alpha` ⏎ `bravo` (2 plain blocks), Cmd+A (verified selected via screenshot) | Tab | `<space>` — hex `E28083` = **a single U+2003 EM SPACE**. **Both blocks' text is destroyed**; the selection is deleted and replaced by one em-space in one remaining block, exactly like the already-documented "Tab on plain text inserts an em-space" rule, but here it nukes a whole multi-block selection first | verified — **reproduced twice from a fresh rebuild, confirmed by screenshot (both words visibly gone) and by hex both times. This is destructive and easy to trigger by accident (e.g. muscle-memory Tab while intending to indent) — worth flagging prominently for anyone building similar behavior** |
| K2 — cross-block-boundary **partial** selection (`alpha`**bet**‖**bravo**star, only "bet"+"bravo" actually selected across the boundary, confirmed by screenshot) + bullet | `alphabet` ⏎ `bravostar`, partial mouse selection spanning the boundary | Cmd+7 | `<ul><li>alphabet</li><li>bravostar</li></ul>` — **both blocks convert in full**, even though only part of each was selected | verified — list conversion operates at block granularity; partial in-block selection is enough to pull the whole block in |
| K3 — paste multi-line plain text | — | — | Already answered by the existing "Paste behaviour" section above (§10): newlines become `<br>` inside **one** block, never a block split | **already verified — not re-tested** |
| K4 — select two blocks, press Enter | — | — | Already answered by the existing §9 "Selection-spanning destructive operations": `<div><br></div><div><br></div>` — **two** empty blocks remain, not one (note the contrast with K1: Enter's selection-delete leaves N empty divs, but Tab's selection-delete-then-em-space leaves exactly ONE block — different destructive paths, different residue) | **already verified — not re-tested** |

Screenshots: `gap2-k1-before-tab-two-blocks-selected.png`, `gap2-k1-after-tab-destroyed-to-
emspace.png`, `gap2-k2-cross-boundary-partial-selection.png`, `gap2-k2-after-bullet-both-full-
blocks.png`.

### Safety diff (required by task rules)

Pre-session snapshot: 373 notes (WAL-inclusive copy of `upnote.sqlite3`, taken before any GUI
action this session). Post-session snapshot: 374 notes, taken after a ≥5s settle at the end of
the sweep. Diffing `id|title|trashed|deleted` for every note between the two snapshots: **the
only difference is the addition of exactly one new row** — `01a08921-a86c-7362-8b03-
3c6a33cc1984` (`alphabet`, trashed=0, deleted=0), the scratch note created and reused
throughout this session via File ▸ New Note. **Every one of the 373 pre-existing notes has an
identical `trashed`/`deleted` value before and after — none were touched, trashed, or
deleted.** No multi-select or batch action was used at any point; no note besides the one
scratch note above was created, and no note was deleted.
