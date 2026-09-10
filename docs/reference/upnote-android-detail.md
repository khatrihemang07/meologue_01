# UpNote Android — Detailed Editor Behaviour

Device: `10BD8H0UM50004X`, 1080x2400px physical pixels, density 440. All coordinates below are raw
device pixels (as returned by `adb exec-out screencap`), captured on 2026-09-06. UpNote Android
build as installed at time of testing (version not confirmed — see "Could not determine" at the
end of this document).

Every note used for this investigation is prefixed `ZZTEST` and was authored by this session. No
pre-existing user note was opened, edited, or deleted.

Legend: **verified** = observed directly in a screenshot taken by this session. **inferred** =
reasoned from adjacent evidence but not directly screenshotted.

---

## 0. Toolbar structure — correction to the brief

**verified.** The editor's bottom toolbar is **one continuous horizontally-scrollable strip**, not
three discrete fixed "pages." Swiping reveals overlapping 7-icon windows; the underlying strip (in
left→right order, leftmost = default position when the editor opens on a body line) is:

```
+   /   ☑(checklist)   🖼(image)   H   ↶(undo)   ↷(redo)   A(text colour)   🖊(highlighter)
#(tag)   📅(date)   B   I   U   S(strike)   •(bullet list)   1.(numbered list)   ⇥(indent)
⇤(outdent)   ↵(soft line break)   ↑≡(move line up)   ↓≡(move line down)   ≡▾(align)
⇥▤(block indent / quote?)
```

That is 24 distinct tools, not 21. Consecutive "pages" from swiping overlap by exactly one icon
(redo ends page 1 and starts page 2; B ends page 2 and starts page 3; indent ends page 3 and starts
page 4). A blue **⌄ chevron** sits fixed at the far right of the toolbar row, outside the
scrollable strip, on every scroll position (see §8).

**verified — title-line divergence.** When the caret is in the **title** line, the toolbar's `H`
icon renders in the active/highlighted (blue) state, and the second-page icons (B/I/U/S/lists/etc.)
render in a dimmed/disabled visual style. The title is implemented as an always-active Heading
block — formatting marks are not offered on it. This was not called out in the desktop notes; worth
checking whether desktop also disables marks on the title.

Swipe command used throughout: `adb shell input swipe <x1> 1402 <x2> 1402 400` (drag content
left‑to‑right to reveal later icons on the right; right‑to‑left to go back toward `+`).

---

## 2. Selection-based formatting (verified)

Method: long-press a word (`adb shell input swipe X Y X Y 800`, i.e. hold in place ~0.8s) to select
it via Android's native word-selection, then drag/tap toolbar buttons.

- **Android's native selection context menu appears, and UpNote does NOT add anything to it.**
  Long-pressing "quick" in a test sentence produced the stock Android floating toolbar: `Cut |
  Copy | Select all | Ask Gemini | ⋮`. Opening the `⋮` overflow showed only OS-level entries:
  `Read aloud`, `Search`, `Search in Truecaller` (a 3rd-party app hooking the system selection
  action — not from UpNote). No Bold/Italic/formatting shortcuts, no UpNote branding, anywhere in
  this menu. This is a clean, notable divergence from apps (e.g. Google Docs, Notion mobile) that
  inject a custom formatting mini-toolbar into the selection UI — UpNote relies entirely on its own
  persistent bottom toolbar instead.
- **Applying a mark does NOT dismiss the selection.** Tapping Italic on the toolbar while "quick"
  was selected: the native selection handles and floating Cut/Copy menu disappeared (expected —
  any toolbar tap steals focus from the selection handles), but the **selection highlight itself
  stayed visible** on "quick", and the toolbar's `I` icon lit up active. Immediately tapping
  Underline, then (after scrolling) Strikethrough, then Text Color (orange) and Highlight (green)
  all applied to the *same* still-selected "quick" — five marks stacked on one selection without
  re-selecting between taps. Only tapping elsewhere in the document (or the system Back button)
  clears the selection. This means: on Android, the natural workflow is long-press once, then apply
  as many toolbar formats as you want in sequence.
- Android's Back button, pressed while a selection/menu is open, closes the keyboard entirely (not
  just the popup) and drops the selection — a bigger side effect than dismissing just the popup.

## 3. Undo / redo granularity (verified)

Testing performed by inserting a tag (`#zztesttag`), a trailing empty paragraph, and a Date-picker
insertion, then tapping the toolbar undo (page-1 icon, raw `755 1402`) repeatedly:

- **One undo = one discrete editor transaction, not one keystroke.** Undo #1 removed the entire
  inserted date string ("Sunday, September 6, 2026") in a single step. Undo #2 removed a trailing
  empty paragraph + its preceding newline together. Undo #3 removed the entire typed word
  "zztesttag" as one block, leaving just the `#`.
- Redo is exactly symmetric — tapping redo (raw `892 1402`) three times restored all three steps
  one at a time, byte-for-byte.
- Caveat: typed text in this session was injected via `adb shell input text "..."`, which commits
  to the IME as a single event rather than as individual keystrokes. It's likely a human typing on
  the real keyboard produces smaller (per-character or per-word) undo steps than what was observed
  here — this finding confirms undo is **transactional per input-commit**, but does not by itself
  establish the granularity of real keystroke-by-keystroke typing. Not independently verified.
- The **H1 heading + emptied-block** case from §1 is also relevant here: because the block-type
  reverted to a plain paragraph when the text was fully deleted (rather than undo being invoked),
  that specific transition was a *content edit* consequence, not an undo/redo behaviour.

## 4. Keyboard interaction (verified)

- **`KEYCODE_TAB` does not indent.** Sending it while the caret was inside a checklist item did
  **not** indent/nest the item. Instead it **blurred the text field and dismissed the software
  keyboard entirely** — Android treated Tab as a focus-navigation key with no other view to move
  to, so focus just left the editor. This is a clear, load-bearing divergence from desktop, where
  Tab indents a list item. On Android the only way to indent a list item is the toolbar's indent
  button (or, per the brief, the already-known indent button behavior) — there is no keyboard
  shortcut for it.
- **`KEYCODE_DEL` at the start of a checklist item unwraps it to a plain paragraph** — the checkbox
  is removed and the text becomes an ordinary line, cursor at start. This **matches** the desktop
  behaviour already documented in the brief ("unwrap to plain block") — no divergence found here.
- **Enter inside a checklist item** creates a new checklist item (with its own empty checkbox)
  below; pressing Enter again on an *empty* checklist item exits list mode entirely (reverts to a
  plain empty paragraph) — same two-Enter-exit convention as bullet/numbered lists on most editors,
  not verified against this project's desktop notes specifically.
- No hardware keyboard was available to test `?123` layout Tab key or physical Tab; only
  `adb shell input keyevent KEYCODE_TAB` was tried (see above) — this simulates whatever the OS
  does with a TAB key event, which may or may not equal a real Bluetooth keyboard's Tab in this
  app. **Not fully verified** — flagged in the "could not determine" list.

## 5. Checkbox / checklist interaction (verified)

- Tapping an empty checkbox fills it solid with a white checkmark; the item's text turns a dimmed
  gray. **There is no strikethrough** applied to completed items — dimming is the only visual
  change. (Compare to apps/desktop configs that strike through completed items — worth checking as
  a possible divergence.)
- **`moveCompletedTodoItemToBottom` appears to be OFF (or not applicable) on Android in this
  session.** With three items (`buy milk`, `Eggs`, `Bread`), checking the first two in order left
  them in their original top positions — they did not reorder to the bottom below the still-open
  `Bread` item. This was verified twice (once accidentally, once deliberately) with consistent
  results.
- Unchecking a completed item is symmetric — tapping again empties the box and restores full-
  brightness text, no reordering either way.

## 1. Toolbar buttons, page by page

### `+` button

**verified.** Tapping `+` (raw tap `68 1402`) opens a fixed, non-scrollable 5-item popup docked
just above the software keyboard:

```
▶  Embed Video
[] Scan Document
📎 Insert File
▦  Insert Table
📋 Paste from Markdown
```

This list did not scroll or change when swiped — it appears to always be exactly these 5 items,
i.e. `+` is a small "extras" menu, distinct from `/` (below). None of these were tapped through to
avoid touching the camera/scanner/file-picker system intents on a real device with real files.

### `/` button — full item list (verified)

Tapping `/` (raw tap `205 1402`) both **inserts a literal `/` character** into the text and opens a
categorized popup menu anchored under the caret. This is a real difference in mechanics from a
typical "slash command" (Notion-style): the `/` character is NOT auto-consumed when you pick an
item from a purely-formatting entry (see Heading finding below) — it can be left behind in the
text and must be deleted manually. The same `/`-menu can be triggered with the caret **in the
title line**, not just the body (verified accidentally, see §1a note below).

Full top-level list, in order (scrolling the popup down through it fully — 21 top-level rows, 15
of which are themselves submenus indicated by a `>` chevron):

```
H   Heading            >   (submenu: H1 H2 H3 H4 H5 … at least 5 levels, list continued past view)
B   Format              >   (submenu not explored in depth — presumably Bold/Italic/Underline/Strike)
A   Text Color          >
🖊  Highlight           >
:=  List                >
≡   Text Align          >
▦   Table               >
📅  Date                >
🕐  Time                >
—   Insert Divider          (no submenu — inserts directly)
>▤  Collapsible Section      (no submenu — inserts directly)
"   Quote                    (no submenu)
</> Code                     (inline code — no submenu)
</> Code Block                (no submenu)
🔗  Add a link                (no submenu)
🖼  Insert Image               (no submenu)
📎  Insert File                (no submenu)
▶  Embed Video                (no submenu)
f(x) TeX Formula               (no submenu)
📋  Select from Templates      (no submenu)
🅰̸  Remove formatting          (no submenu)
```

Note: `Insert Image`, `Insert File`, `Embed Video` appear in BOTH the `/` menu and the `+` menu —
they are not mutually exclusive lists. `Checklist` and `Tag` (the toolbar's `#` button) do **not**
appear anywhere in the `/` list — those two remain toolbar-only / input-rule-only entry points.

**verified — Heading submenu**: `H1, H2, H3, H4, H5` visible (list continues below the fold,
consistent with more levels such as H6, "Paragraph"/Normal — not confirmed).

**verified — a real behavioural quirk**: selecting `H1` from the Heading submenu enlarged the
current line (heading style applied) but left the literal `/` character in place, now rendered at
heading size. Backspacing to delete that leftover `/` deleted the *entire* line content and — because
the line was then fully empty — **the heading formatting did not persist**: typing fresh text into
the now-empty block produced normal paragraph text, not H1. i.e. an emptied heading block silently
reverts to a plain paragraph on Android. (Compare against desktop — not verified there in this
session.)

**verified — title accepts `/` too**: while investigating the above, backspacing at the very start
of a body paragraph merged it back into the title (same "unwrap on backspace-at-start-of-block"
behaviour noted for lists elsewhere), and typing `/` while the caret was in the merged title line
opened the identical `/` popup anchored to the title. So the title is not special-cased against
slash commands.

### Checklist button (toolbar page 1, 3rd icon)

**verified.** Tapping it (raw `343 1402`) converts the current empty line into a checklist item
(empty checkbox + text caret). The toolbar's checkbox icon shows an active/highlighted (blue
outline) state while the caret is inside a checklist item, matching the same "active tool
highlights" pattern seen for `H` on the title line.

### Text Color (`A`) and Highlighter (pen) buttons

**verified.** Both open an identical fixed 3×3 swatch grid: 8 preset hues (red, orange, yellow,
green, blue, pink, purple, gray — pastel versions for the highlighter) plus a 9th "remove /
none" swatch (circle with a diagonal slash). There is no custom-color / hex-input option and no
"+" for adding a swatch — 8 fixed colors is the entire palette for both tools. Tapping a swatch
applies immediately and closes the picker; the toolbar icon then shows an active/highlighted
outline. Confirmed by inspection after deselecting that both a text color (applied: orange) and a
highlight (applied: green) render correctly and simultaneously on the same run of text, layered
together with italic + underline + strikethrough from the same selection (see §2).

### Tag (`#`) button

**verified.** Tapping `#` inserts a literal `#` character and opens an autocomplete popup listing
the account's **existing tags** (i.e. it queries across all of the user's real notes, not just this
one) — omitted here for privacy since they are the user's real tag names. Typing after `#` filters
that list live and, once no existing tag matches, the popup switches to a single row: `+ Create
new tag "#<text>"`. Tapping it inserts the tag. Rendering: the finished tag (`#zztesttag` in
testing) renders as **plain inline text**, not as a colored pill/chip — no distinct visual
treatment beyond being literal `#`-prefixed text. (Whether desktop renders tags as chips is unknown
— worth checking as a possible divergence.)

### Date button (calendar icon)

**verified.** Tapping it opens a 6-row popup of format choices, all derived from the current
device date/time (no calendar-grid picker, no manual date entry):
```
Sunday, September 6, 2026 1:08 PM   (full date + time)
Sunday, September 6, 2026            (full date)
Sep 6, 2026 1:08 PM                  (abbreviated date + time)
Sep 6, 2026                          (abbreviated date)
9/6/26                               (numeric date)
1:08 PM                              (time only)
```
Selecting one inserts it as plain literal text at the caret (not a live/dynamic field — verified by
the fact it captured the exact minute of the tap, "1:08 PM", a snapshot, not a "Today" token).
`Time` from the `/` menu presumably offers the same list filtered to time formats (not separately
verified).

### Bullet list / Numbered list / Indent / Outdent buttons

**verified.** Typing `- ` (dash-space) auto-converts to a bullet list (already known input rule).
The toolbar's bullet-list icon lights up active while in a bullet item, matching the pattern for
every other block-type button. Numbered list works the same way via its own icon (not separately
exercised beyond confirming its presence). Indent/outdent are covered in depth in §9 (nesting).

### Soft line break, move-line-up/down, align, block-indent, quote (page 4 — inspected, not all
individually exercised)

**verified by inspection only** (screenshot, not tapped, to avoid destabilizing test content given
time constraints): the toolbar's final visible group is outdent, a return-arrow icon (soft line
break — already documented as inserting a same-item line break with no new bullet), move-line-up,
move-line-down, an align icon (`≡▾`), a block-indent/collapsible icon, and — right at the very end
of the scrollable strip, past what the brief described — a **Quote** icon, which duplicates the
`/` menu's "Quote" entry as a direct one-tap toolbar button. **Not independently verified by
tapping** — flagged below.

## 6. Search (verified)

Two distinct search surfaces exist, confirmed by directly exercising both:

**Global search** — bottom-bar magnifier icon (on the notes list, at the true bottom nav bar; raw
y ≈ 2280, not near the toolbar's y ≈ 1402 — the two are easy to confuse from a screenshot's visual
proportions). Opens a full-screen search field plus three collapsible sections: **Notes**,
**Templates**, **Trash** (each independently searched and counted, e.g. "Notes 1"). Typing a query:
- Is **case-insensitive** — query `zztest` matched the note titled `ZZTEST toolbar`, and the match
  was bold/blue-highlighted in the result list despite the case mismatch.
- Searches **both title and body** — the result list showed two lines for the one matching note:
  the title (`ZZTEST toolbar`) and a flattened content-preview snippet (`ZZTEST toolbar buy milk
  Eggs Bread The qui…`) with the match bolded in each.
- **Opening a result jumps into the note with every match highlighted in yellow inline**, in both
  the title and the body (confirmed: both `ZZTEST` in the title and `zztest` inside the `#zztesttag`
  tag were highlighted simultaneously after opening from search).

**In-note find** — reached via the editor's `···` overflow menu → **"Search this note"** (not the
magnifier from the list; there is no dedicated find icon inside the editor itself). Opens a find
bar with `<` `>` navigation chevrons, a text field, and a match counter in the header (`1/1` for a
single match). Also **case-insensitive** — searching `QUICK` matched and highlighted lowercase
"quick" in the body. Not established whether in-note find also covers the title (the test query
had no title overlap) — **not fully verified**.

## 7. Scrolling, autoscroll, and the keyboard

**Not verified / could not determine.** Time and turn budget did not allow a dedicated test of
whether the caret auto-scrolls above the keyboard when typing near the bottom of a long note, or
whether the toolbar stays pinned during a long scroll. Indirect observation throughout this session
is consistent with the toolbar always being docked immediately above the keyboard (it never moved
independently of the keyboard in any screenshot), but a targeted long-note/fast-typing test was not
run.

## 8. The `⌄` chevron

**verified.** The chevron at the far right of the toolbar (outside the scrollable icon strip, fixed
position, raw ≈ `996 1402`) simply **dismisses the software keyboard**, identical in effect to
pressing the system Back button once while text-editing with no popup open. It does **not** expand
to a fuller/secondary toolbar — confirmed by tapping it and observing the keyboard and toolbar
disappear together, leaving the note's footer ("Add to notebooks") in their place, with the note
still in "editing" state (title still selectable, no explicit "Done" needed).

## 9. Long lists and deep nesting (verified)

Built a bullet list and repeatedly tapped the toolbar indent button (page-3/4 icon) on a single
item:

| Depth | Glyph | Notes |
|---|---|---|
| 1 | `•` (filled circle) | default `- ` input-rule result |
| 2 | `◦` (hollow circle) | after 1 indent |
| 3 | `▪` (small filled square) | after 2 indents |
| 4 | `▪` (small filled square) | glyph unchanged from level 3 |
| 5 | `▪` (small filled square) | glyph unchanged; indentation continued to increase |
| 6 | `▪` (small filled square) | glyph unchanged; indentation still increasing — **no depth
cap observed** through 6 levels |

So the glyph cycle is only 3 deep (circle → hollow circle → square), then the square glyph repeats
for every further level, while the horizontal indent continues to grow with no visible ceiling
through level 6. Not tested beyond level 6.

**Outdent at level 1 (top of list) unwraps the item to a plain paragraph** — the bullet glyph is
removed entirely and the text becomes a normal line, left-aligned like the surrounding paragraphs.
This is the same "unwrap" behavior already confirmed for backspace-at-start-of-item (§4) and for
`/`-menu Heading selections on an emptied block (§1) — Android's editor consistently unwraps rather
than leaving an empty/broken block type.

## 10. Phone-specific surfaces

**verified — editor header `···` overflow menu**, full list, top to bottom:
```
Pin to top
Quick Access
Search this note      (→ in-note find, see §6)
――――――――――――――
Copy link to note
Version History
――――――――――――――
Export
――――――――――――――
Typography
Settings
――――――――――――――
Duplicate
Copy to Templates
Move to other space
――――――――――――――
Move to trash          (destructive, styled red)
```
Not opened further: Version History, Export, Typography, Settings, Move to other space (to avoid
unnecessary side effects on shared account state) — their sub-screens are **not verified**.

**Share icon** (header, next to `···`) — **not exercised**: tapping it would hand off to the
Android system share sheet (a cross-app OS feature, not UpNote-specific), and doing so risked
opening other installed apps unpredictably on a shared device; skipped deliberately.

**Swipe gesture on a notes-list row** — attempted once (a leftward drag across my own `ZZTEST`
row). It registered as a simple tap-to-open rather than revealing any swipe action (delete/pin/
archive buttons). This is **inconclusive, not a confirmed "no swipe actions exist"** — the gesture
parameters (distance/velocity) used via `adb shell input swipe` may not have crossed whatever
threshold the list uses to distinguish a swipe from a tap. **Not fully verified.**

**Haptics** — cannot be verified through screenshots/ADB; **not determined**.

## Environmental note: concurrent live sync

Partway through this session, notes appeared and mutated at the top of "All Notes" in real time
(e.g., a note cycling through titles like "a quote", "code here", "inlineword", "New Note",
"AXwordone wordtwo wordthreeY") without any action from this session. This is consistent with the
Mac-side agent (who owns the Mac GUI per this task's constraints) actively creating/editing test
notes concurrently, synced live to this Android device. These notes were **not created by this
session** and were never opened, edited, or deleted by it — logged here only so the sudden
title/timestamp churn visible in earlier screenshots is understood and not mistaken for an action
this session took.

## What could not be determined, and why

- **Real per-keystroke undo/redo granularity.** All typed text in this session went through
  `adb shell input text`, which commits as one IME event rather than individual keystrokes, so the
  observed "one undo = one whole word/phrase" result reflects the injection method as much as the
  app. A human typing on the real keyboard was not tested.
- **`KEYCODE_TAB` via a real hardware/Bluetooth keyboard.** Only the synthetic ADB keyevent was
  tried; it blurred the field and closed the keyboard rather than indenting — plausible but not
  guaranteed to match a real external keyboard's Tab handling in this app.
- **`moveCompletedTodoItemToBottom` as a named, toggleable setting.** Behaviorally it appears OFF
  (completed checklist items stayed in place), but the Settings menu itself was not opened to find
  a literal toggle by that name — not confirmed whether it exists as a user-facing setting on
  Android at all, or is simply hard-coded off.
- **Whether in-note find (§6) also searches the title**, since the test query had no title overlap.
- **Scrolling/autoscroll behavior** on a long note with the keyboard open (§7) — not exercised.
- **The editor header's Version History, Export, Typography, and Settings screens**, and **"Move
  to other space"** — opened only as menu labels, not drilled into.
- **The Android system share sheet** integration and its contents — not opened.
- **Swipe-to-delete/pin/archive gestures on notes-list rows** — one attempt registered as a tap;
  inconclusive on whether the gesture exists with different parameters.
- **Haptic feedback** — not observable via screenshots.
- **Exact UpNote Android version/build number** — not checked (would require the app's own
  About screen, not visited).
- **Whether tags render as chips/pills on desktop** (for comparison against Android's plain-text
  tag rendering found in §1) — this investigation only covered Android.


## Gap sweep — Enter/soft-break/indent/backspace and list metrics (2026-09-10)

**Different device from the rest of this document.** This sweep was run on `ZD222P9VZC`
(`motorola_edge_50_neo`), physical size **1200×2670px**, density **450** (`adb shell wm density`) —
not the `10BD8H0UM50004X` / 1080×2400 / density-440 device used for the sections above. Raw
coordinates quoted below are **not** comparable to raw coordinates quoted elsewhere in this
document; only the visual/behavioural findings are.

Work was done in a scratch notebook `meologue-probe`, in one note titled `ZZTEST-GapA-Enter`
(prefixed `ZZTEST` per this repo's convention for this investigation). **Cleanup**: the note was
moved to trash then permanently deleted from Trash; the notebook (and one duplicate
`meologue-probe` notebook + one accidental untitled note, both produced by this session's own
misfired taps — see method note below) were deleted via the sidebar's long-press → Delete Notebook.
Final sidebar state shows only the pre-existing `Memoir_1` notebook — cleanup succeeded. One
unrelated note titled "onetwo" appeared in Trash during this session and was **not** touched —
consistent with the "concurrent live sync" phenomenon already logged elsewhere in this document
(another session's test activity syncing to this device); it was left exactly as found.

**Method notes (read before the tables):**
- `adb shell input text "- "` **silently drops a trailing space** — the space must be sent as a
  separate `adb shell input keyevent 62` or the `- `/`1. `/`[] ` input rule never fires. This bit
  this session repeatedly; every table row below was re-verified after discovering it.
- No reliable synthetic Shift+Enter or Tab chord exists via `adb shell input`. Per the brief, the
  soft-line-break **toolbar button** was used as Android's Shift+Enter equivalent (§C) and no Tab
  claims are made (§D uses the toolbar indent button only, matching how a real user must operate
  on Android per the existing `KEYCODE_TAB` finding in §4 above).
- Ground truth throughout is **screenshot only**. An `Export → Export to Markdown` was attempted
  specifically to get literal-text ground truth for §C's plain-text soft-break case (to distinguish
  a `<br>` from a new block, the way the macOS notes distinguish them via the raw HTML), but the
  share sheet on this device offered no "save to local file" / Files-app target — only send-to-app
  targets (Gmail, Drive, Quick Share, etc.) that this session declined to use to avoid sending test
  content off-device. That one sub-finding is therefore marked **unverified** below, not asserted.
- The FAB (new-note button) and long-press context menus were intermittently unresponsive to a
  single `input tap`/`input swipe` — a real device-interaction quirk of this session, not a UpNote
  finding, logged here only so the raw coordinates in earlier screenshots aren't mistaken for a
  documented tap target.

### A. Enter on an EMPTY item, by list type

| List type | Before | Enter → After | Result | Status | Screenshot |
|---|---|---|---|---|---|
| Bullet, top-level | empty `•` item | bullet removed, empty plain paragraph | **List closes entirely** | verified | [before](screenshots/upnote-android/gapA-bullet-empty-before.png) / [after](screenshots/upnote-android/gapA-bullet-empty-after.png) |
| Numbered, top-level | empty `1.` item | number removed, empty plain paragraph | **List closes entirely** | verified | [before](screenshots/upnote-android/gapA-numbered-empty-before.png) / [after](screenshots/upnote-android/gapA-numbered-empty-after.png) |
| Checkbox, top-level | empty `☐` item | checkbox removed, empty plain paragraph | **List closes entirely** | verified | [before](screenshots/upnote-android/gapA-checkbox-empty-before.png) / [after](screenshots/upnote-android/gapA-checkbox-empty-after.png) |
| Bullet, **nested** (level 2) | empty `◦` item | **outdents one level** to a filled `•` at level 1 — stays in the list | **Outdents, does not close** | verified | [before](screenshots/upnote-android/gapA-nested-empty-before.png) / [after](screenshots/upnote-android/gapA-nested-empty-after.png) |

The nested-item row **matches** the macOS row already on file ("⏎ on an empty **nested** item
outdents **one level**; does not exit the list"). The three top-level rows have no macOS
counterpart in `upnote-editor-behaviour.md` to compare against — logged here as new information,
not a divergence claim.

### B. Enter mid-text / Enter on an item that has nested children

| Case | Before | After | Result | Status | Screenshot |
|---|---|---|---|---|---|
| Enter mid-text in a non-empty bullet item | `midtext` (cursor after "midt") | two sibling bullets: `midt` / `ext` | **Splits into new sibling item**, same as any block split | verified | [before](screenshots/upnote-android/gapB-midtext-before.png) / [after](screenshots/upnote-android/gapB-midtext-after.png) |
| Enter at end of a parent item that has a nested child below it | `Parent` (bullet) → nested `midt` (child) | new **empty level-1 item** inserted between `Parent` and `midt`; `midt` stays nested (now under the new empty item) | **Inserts sibling before the children**, does not merge into or split the child | verified | [before](screenshots/upnote-android/gapB-nested-parent-before.png) / [after](screenshots/upnote-android/gapB-nested-parent-after.png) |

Both rows match ordinary rich-text-editor expectations and are consistent with (not contradicted
by) the macOS "⏎ on a non-empty item → new sibling item" row. Neither scenario is spelled out
verbatim on the macOS side, so treat these as new confirmations, not corrections.

### C. Soft line break (toolbar button) — list item vs. plain text

| Context | Action | Result | Status | Screenshot |
|---|---|---|---|---|
| Inside a bullet item (`itemA`, cursor at end) | tap soft-break toolbar button, type `itemB` | `itemB` appears as a second line **inside the same `•` item**, indented to the text column, **no new bullet** | verified | [screenshot](screenshots/upnote-android/gapC-softbreak-listitem.png) |
| Plain paragraph (`plainA`, cursor at end) | tap soft-break toolbar button, type `plainB` | `plainB` appears as a visually separate line below `plainA` | **verified on screen; unverified whether it is a `<br>` or a new block** | [screenshot](screenshots/upnote-android/gapC-softbreak-plaintext.png) |

The list-item case is a clean, unambiguous confirmation of the existing Android toolbar finding
("the soft-break button starts a new line inside the same `<li>` with no bullet marker"). The
plain-text case is the one genuine gap in this sweep: per the macOS notes, UpNote's block
separator contributes **zero** vertical space, so a `<br>` and two sibling `<div>`s are visually
*identical* on screen — screenshots cannot tell them apart. The Export-to-Markdown attempt to get
literal text (see method notes above) hit a dead end on this device's share sheet. **Unverified —
flagged, not guessed.**

### D. Indent / outdent on the FIRST item of a list

| Action | Before | After | Result | Status | Screenshot |
|---|---|---|---|---|---|
| Tap indent with cursor in `One`, the first item of a 3-item bullet list (`One`, `Two`, `three`) | `One` at level 1 (filled `•`), siblings `Two`/`three` still level 1 | `One` nests to level 2 (hollow `◦`); `Two`/`three` unaffected | **Nests — does not refuse** | verified | [before](screenshots/upnote-android/gapD-first-item-before.png) / [after](screenshots/upnote-android/gapD-first-item-after-indent.png) |

This **matches macOS exactly**: "⇥ on the **first** item of a list | also nests, producing
`<ul><ul><li>…`". No divergence.

### E. Numbered-list nesting glyphs

| Level | Marker | Notes | Status | Screenshot |
|---|---|---|---|---|
| 1 | `1.` (Arabic numeral + period) | literal number, blue-tinted in this theme | verified | [screenshot](screenshots/upnote-android/gapE-numbered-level1.png) |
| 2 (indented once) | `◦` hollow circle | **not** `a.`/`i.` — reuses the bullet-list level-2 glyph | verified | [screenshot](screenshots/upnote-android/gapE-numbered-level2.png) |
| 3 (indented twice) | `▪` small filled square | reuses the bullet-list level-3 glyph | verified | [screenshot](screenshots/upnote-android/gapE-numbered-level3.png) |

**Noteworthy finding**: nesting a numbered list on Android does **not** produce a lettered/roman
sub-numbering scheme. Only the top level is a real number; every deeper level silently switches to
the exact same glyph cascade (`◦` then `▪`, repeating) documented for bullet lists in §9 above.
`upnote-editor-behaviour.md` does not document ordered-list nesting on macOS at all, so this is
logged as new information — **worth checking on desktop**, not asserted as a divergence.

### F. Backspace (`KEYCODE_DEL`) at the start of an item, by context

| Context | Before | After | Result | Status | Screenshot |
|---|---|---|---|---|---|
| Level-1 bullet item, non-empty (`bstest`) | cursor at start of text, bullet present | bullet removed, `bstest` becomes a plain paragraph | **Unwraps to plain block**, text preserved | verified | [before](screenshots/upnote-android/gapF-level1-before2.png) / [after](screenshots/upnote-android/gapF-level1-after.png) |
| Nested (level-2) bullet item, non-empty | cursor at start of text, hollow `◦` | item becomes level-1 filled `•`, text preserved | **Outdents one level** — does not unwrap on the first press | verified | [before](screenshots/upnote-android/gapF-nested-before.png) / [after](screenshots/upnote-android/gapF-nested-after.png) |
| Checkbox item, non-empty (`checkbstest`) | cursor at start of text, `☐` present | checkbox removed, becomes a plain paragraph | **Unwraps to plain block**, text preserved | verified | [before](screenshots/upnote-android/gapF-checkbox-before2.png) / [after](screenshots/upnote-android/gapF-checkbox-after.png) |
| Empty level-1 bullet item | empty `•`, cursor implicitly at start | bullet removed, becomes an **empty** plain paragraph — does **not** merge into the item above (`itemA` stays untouched, a blank line remains where the empty item was) | **Unwraps, no merge** | verified | [before](screenshots/upnote-android/gapF-empty-before-final.png) / [after](screenshots/upnote-android/gapF-empty-after.png) |

All four rows **match** the macOS table exactly: "⌫ at start of an item unwraps that item to a
plain block; does not merge into the item above" and "repeated ⌫ at start outdents one level per
press, nested → level 1 → plain block." No divergence found in this sweep for backspace.

### H. Rendering metrics

Device density: **450** (`adb shell wm density` → `Physical density: 450`), physical size
1200×2670px (`adb shell wm size`).

| Metric | Value | Method | Status |
|---|---|---|---|
| Bullet/numbered glyph cascade | Level 1 `•`/`1.` → level 2 `◦` → level 3 `▪` (repeats) | screenshot, §E above and §9 above | verified |
| Checked-item styling | Solid checkbox fill with white checkmark; item text dimmed to a lower-contrast gray; **no strikethrough** | screenshot, before/after tap | verified — [unchecked](screenshots/upnote-android/46-checkbox-unchecked.png) / [checked](screenshots/upnote-android/gapH-checked-styling.png) |
| Indent width per nesting level | Roughly **27–36dp** per level (measured by eye from screenshot pixel positions of the level-1/2/3 markers in §E, converted at this device's 450 density: 160/450 ≈ 0.356 dp/px) | screenshot pixel-reading, **not** a pixel-perfect tool measurement | **approximate — margin of error acknowledged, not a precise figure** |
| Block-to-block vertical gap vs. line height | Paragraph-to-paragraph gap (`plainA`→`plainB`) and soft-break line-to-line gap (`itemA`→`itemB`) measured visually indistinguishable in screenshots (~68–69px display-scale in both cases) | screenshot comparison only | **inferred, not confirmed** — consistent with the macOS finding that UpNote's block `<div>` has zero margin, but Android's underlying markup was not read (see §C's Export dead-end) |

### I. Where this sweep found Android and macOS to differ, and where it did not

**No new behavioural divergences from `upnote-editor-behaviour.md` were found in this sweep.**
Every Enter/indent/outdent/backspace case that has a macOS row on file **matched** it:
- Enter on empty nested item → outdents one level (match)
- Indent on the first item of a list → nests, doesn't refuse (match)
- Backspace at start of an item → unwraps to plain block, no merge upward (match)
- Repeated backspace outdents one level per press (match, confirmed across bullet nesting)
- Soft line break inside a list item → same `<li>`, no new bullet (match, re-confirmed)

The only items worth flagging are **new Android information with no macOS counterpart to compare
against** (not claimed divergences):
1. Enter on an **empty top-level** item (bullet, numbered, or checkbox) closes the list outright,
   reverting to a plain empty paragraph — `upnote-editor-behaviour.md`'s macOS table only documents
   this for a **nested** empty item (which outdents instead of closing). Whether macOS closes the
   list the same way on a top-level empty item is **unverified** — not tested there.
2. Numbered-list nesting reuses the **bullet** glyph cascade (`◦`, `▪`) at levels 2+ instead of a
   lettered/roman sub-scheme — macOS ordered-list nesting is not documented at all, so this cannot
   be compared. **Worth checking on desktop.**
3. Whether Android's soft-line-break inside a **plain paragraph** (not a list item) writes a `<br>`
   or a new sibling block is genuinely **unverified** — screenshots cannot distinguish the two given
   UpNote's zero-margin block model, and the Export flow had no local-save path on this device.

### What could not be determined, and why (this sweep)

- **§C plain-text soft-break, `<br>` vs. new block** — screen-only evidence is ambiguous by
  construction (see above); Export-to-Markdown was attempted and abandoned because the share sheet
  offered no local-file/Files-app target on this device, only send-to-app targets this session
  declined to use.
- **Precise indent-per-level in dp** — reported as an approximate range (27–36dp) read by eye from
  screenshot marker positions, not measured with pixel-level tooling. Treat as a rough estimate.
- **Whether a real hardware/Bluetooth keyboard's Shift+Enter or Tab produces different results** —
  out of scope per the brief; no such keyboard was attached this session.
- **Whether macOS's empty-top-level-item Enter behavior matches Android's "closes the list"
  finding** — not tested on macOS in this sweep; `upnote-editor-behaviour.md` only covers the
  nested-item case.

## Gap sweep #2 — selection, conversion, un-listing, multi-block (2026-09-10)

Same device as the previous "Gap sweep" section (`ZD222P9VZC`, motorola edge 50 neo, 1200×2670px,
density 450), different session. Work was done in a new scratch notebook `meologue-probe2`
(distinct from the earlier session's now-deleted `meologue-probe`), in a note titled `ZZTEST-Gap2`
and, for two sub-tests, two further notes `ZZTEST-Gap2K2` / `ZZTEST-Gap2K3` (prefixed `ZZTEST` per
convention). All coordinates below are raw device pixels; screenshots referenced are in
`screenshots/upnote-android/`, filenames prefixed `gap2-`.

**Method note — a persistent selection-handle bug in this session.** Long-pressing a word inside
the body reliably snapped the selection to the **title** line instead of the word under the
finger, on every note tested this session (reproduced on three separate notes). The workaround
used throughout: long-press anywhere in the body → tap **Select all** (selects title + full body)
→ drag the **start handle** down past the title to land just before the first body block. This
reliably produced a clean body-only selection and is *why* every screenshot below starts from a
"select all, trimmed" state rather than a direct word-drag. This is logged as a session/device
interaction quirk, not a documented UpNote behavior — not asserted as something a normal user would
hit.

### G. Multi-block selection → list

Built three blocks (`alpha` ⏎ `bravo` ⏎ `charlie`; auto-capitalized on commit to `Alpha`/`Bravo` —
consistent with the auto-capitalize-at-block-start finding already on file), selected all three,
then exercised the list toolbar buttons.

| Case | Result | Status | Screenshot |
|---|---|---|---|
| G1. Select 3 plain blocks, tap bullet-list | **Three separate bullets** (`• Alpha`, `• Bravo`, `• charlie`), not one bullet containing everything | verified | [before](screenshots/upnote-android/gap2-G-blocks-before.png) / [after](screenshots/upnote-android/gap2-G1-bullet-after.png) |
| G2. Same selection, checklist button | **Three separate checkboxes**, same pattern as bullet | verified | [after](screenshots/upnote-android/gap2-G2-checklist-multiblock.png) |
| G3. With the three bullet items still selected, tap bullet-list again (toggle off) | **Three plain blocks restored**, text unchanged, no merge | verified | [after](screenshots/upnote-android/gap2-G3-bullet-toggle-off.png) |
| G4. Select 3 bullet items, tap numbered-list | **Converts in place** — `1. Alpha`, `2. Bravo`, `3. charlie`; no nesting | verified | [after](screenshots/upnote-android/gap2-G4-bullet-to-numbered.png) |
| G5. Mixed selection (1 plain block `Alpha` + 2 bullet items `Bravo`/`charlie`), tap bullet-list | **Uniform conversion** — all three become bullets; the previously-plain block joins the list, the already-bulleted items are unaffected | verified | [after](screenshots/upnote-android/gap2-G5-mixed-to-bullet.png) |

### H. Round trip: plain → bullet → plain

| Case | Result | Status | Screenshot |
|---|---|---|---|
| H1. Plain block `roundtriptext` → bullet → plain | **Text survives unchanged** byte-for-byte through the round trip | verified | [before](screenshots/upnote-android/gap2-H1-plain-before.png) / [mid](screenshots/upnote-android/gap2-H1-bullet-mid.png) / [after](screenshots/upnote-android/gap2-H1-plain-after.png) |
| H2. Block with a **soft line break** (`softA` [soft-break] `softB`) → bullet → plain | **Structure does NOT survive.** Converting to bullet **splits** the block: `softA` becomes the bullet item, `softB` splits off as a separate plain block. Toggling the bullet back off leaves two permanent plain blocks (`softA`, `softB`) — the original single-block-with-soft-break structure is **not restored**. Text content is preserved (no data loss), only the block/soft-break structure is lost. | verified | [before](screenshots/upnote-android/gap2-H2-softbreak-before.png) / [bullet-mid, showing the split](screenshots/upnote-android/gap2-H2-softbreak-bullet-mid.png) / [after](screenshots/upnote-android/gap2-H2-softbreak-after.png) |
| H3. Block with **bold** text (`boldword`, fully bolded) → bullet → plain | **Text and bold formatting both survive unchanged** through the round trip | verified | [before](screenshots/upnote-android/gap2-H3-bold-before.png) / [after](screenshots/upnote-android/gap2-H3-bold-after.png) |

H2 is the standout finding of this group: a soft line break is **not** preserved by a list
conversion round trip — it is silently converted into a hard block boundary the first time the
containing block becomes a list item, and that boundary is permanent even after un-listing.

### I. Un-listing a NESTED list

Built a 3-level nested bullet list (`Lvl1` → indent → `Lvl2` → indent → `lvl3`), matching the
existing §9 glyph cascade (`•` → `◦` → `▪`).

**I1. Select all three levels, tap bullet-list off (toggle) repeatedly — does it flatten in one tap?**

**No — it does not flatten in one tap, and it does not monotonically lift one level per tap
either.** It took **5 taps**, alternating between two distinct behaviors depending on whether the
selection is *uniformly* listed or *mixed*:

| Tap | Selection state before tap | Result | Screenshot |
|---|---|---|---|
| 1 | All 3 uniformly bulleted (•/◦/▪) | **Outdents every item one level**: Lvl1 (was level 1) unwraps to plain; Lvl2 outdents to level 1 (•); lvl3 outdents to level 2 (◦) → now a **mixed** state | [tap1](screenshots/upnote-android/gap2-I1-toggle-off-tap1.png) |
| 2 | Mixed (plain + • + ◦) | Toggle button **re-bullets the whole selection instead of continuing to outdent**: all three become bulleted again (Lvl1/Lvl2 at level 1, lvl3 at level 2) — still mixed depths, but uniformly "in the list" | [tap2](screenshots/upnote-android/gap2-I1-toggle-off-tap2.png) |
| 3 | Uniformly bulleted (mixed depths) | Outdents every item one level again: Lvl1 & Lvl2 unwrap to plain, lvl3 outdents to level 1 (•) → mixed again | [tap3](screenshots/upnote-android/gap2-I1-toggle-off-tap3.png) |
| 4 | Mixed (plain + plain + •) | Re-bullets the whole selection: all three become level-1 bullets, now uniform | [tap4](screenshots/upnote-android/gap2-I1-toggle-off-tap4.png) |
| 5 | Uniformly bulleted, uniform depth (all level 1) | Outdents all three to plain — **fully flat** | [tap5](screenshots/upnote-android/gap2-I1-toggle-off-tap5.png) |

**Verified conclusion:** un-nesting a nested list via the toolbar toggle is not a simple "one tap
flattens" or "one level per tap" operation. The button's effect depends on whether the current
selection is uniformly listed: a **uniform** list selection outdents every item one level; a
**mixed** (partially-listed) selection re-lists everything instead of continuing to outdent. This
alternation repeats until the whole selection reaches level 1 and finally flattens.

**I2. Select only levels 2–3 (`Lvl2` + `lvl3`, not `Lvl1`), toggle bullet off — what happens to the untouched `Lvl1` parent?**

**The untouched parent also un-lists**, even though it was never part of the selection. Selecting
`Lvl2`+`lvl3` and toggling bullet off produced: `Lvl2` outdents to level-1 bullet, `lvl3` outdents
to level-2 bullet (the expected "outdent children" result) — **but `Lvl1`, not selected, lost its
bullet entirely and became a plain paragraph.** This is a genuinely surprising result: a list
item's bullet-ness on Android is not purely a per-item property independent of its (former)
children's state — un-nesting only the children collapsed the parent's list membership too.

Screenshot: [nested list built](screenshots/upnote-android/gap2-I2-nested-build.png) /
[after toggling off with only Lvl2+lvl3 selected](screenshots/upnote-android/gap2-I2-partial-toggle-off.png)
— verified.

**I3. Same for a checklist — do checked states survive?**

Built a checklist (`Chk1` checked ✓, `chk2` nested one level, `chk2` also checked ✓), selected
both, toggled the checklist button off:

- **`Chk1` (the parent) unwrapped completely to plain text — its checkmark is lost entirely** (no
  checkbox remains, plain unstyled text).
- **`chk2` (the child) outdented one level and remained a checklist item — and its checked state
  survived** (still shown checked, ✓, after the outdent).

Same parent-unwraps/child-outdents pattern as bullet-list I2, plus the added finding that a
**checked state survives only for an item that remains a checklist item** — it is unconditionally
lost for an item that unwraps to plain text (there is no "strikethrough" or other memory of the
check once the checkbox itself is gone).

Screenshot: [checklist built, nested + checked](screenshots/upnote-android/gap2-I3-checklist-nested.png)
/ [after toggle off](screenshots/upnote-android/gap2-I3-checklist-toggle-off.png) — verified.

### J. THE PRIORITY ROW — re-verified, numbered-list nesting glyphs

Built a numbered list slowly, one indent at a time, screenshotting after each level, on a clean
note with no other content in view:

| Level | Marker observed | Screenshot |
|---|---|---|
| 1 | `1.` (Arabic numeral) | [level 1](screenshots/upnote-android/gap2-J-numbered-level1.png) |
| 2 (indented once) | `◦` (hollow circle — the **bullet-list** level-2 glyph, not `a.` or `i.`) | [level 2](screenshots/upnote-android/gap2-J-numbered-level2.png) |
| 3 (indented twice) | `▪` (small filled square — the bullet-list level-3 glyph) | [level 3](screenshots/upnote-android/gap2-J-numbered-level3.png) |

**This confirms — does not contradict — this session's own earlier Android finding** (§E above,
from the 2026-09-10 gap sweep earlier in this document): Android numbered-list nesting switches to
the **bullet** glyph cascade at levels 2+; only the top level is a real number. Re-verified from
scratch, slowly, with a clean screenshot at each level — the earlier Android finding was correct
and is reproducible.

**On the reported contradiction with macOS:** the brief for this sweep states a "parallel macOS
pass reported `1.` at every level." This document (`upnote-editor-behaviour.md`) does not currently
contain a macOS ordered-list-nesting row to compare against — its Lists table only documents a
bullet glyph cascade, with no numbered-list nesting entry. This session has no macOS access and
cannot verify or resolve that side. What this sweep **can** state plainly: the Android glyph
cascade (`1.` → `◦` → `▪`) is real, reproducible, and was not a mistake in the earlier Android
write-up. If a macOS pass truly found `1.` persisting at every level, that is a genuine
cross-platform divergence worth recording once macOS is re-checked — it is not evidence that the
Android finding was wrong.

### K. Multi-block

**K1. Select two plain blocks (`blockA`, `blockB`), tap indent — do both indent?**

**No — and the result is a real defect, not merely "no-op."** Tapping indent on a selection
spanning two **plain** (non-list) blocks did not indent either block. Instead it **deleted the
text of the earlier block** (`blockA`), leaving an empty paragraph in its place; `blockB` was left
untouched, unindented, at the original left margin. Reproduced twice with identical results
(confirmed via undo restoring `blockA`, then repeating the exact same selection + indent tap with
freshly-verified toolbar-icon coordinates). **Verified, reproducible (2/2).**

Screenshot: [before](screenshots/upnote-android/gap2-K1-plainblocks-before.png) /
[after — blockA text gone](screenshots/upnote-android/gap2-K1-plainblocks-indent.png) /
[reproduced](screenshots/upnote-android/gap2-K1-plainblocks-indent-retry.png) /
[undo restores blockA, confirming it really was deleted](screenshots/upnote-android/gap2-K1-after-undo.png)

**K2. Paste multi-line text into an empty note — multiple blocks, or one block with line breaks?**

Copied three lines (`Chunk1`, `Chunk2`, `chunk3`) from a source note, pasted into an empty body
line of a different note (via the long-press context menu's **Paste**, not "Paste as plain text").

- **Result: multiple separate blocks**, not one block with line breaks. Confirmed structurally (not
  just visually) by placing the cursor at the start of the second pasted line and pressing
  Backspace once: the two lines **merged onto one line** (`Chunk1|Chunk2`) — the classic
  "backspace-at-start-of-block merges into the block above" behavior already documented for
  ordinary blocks, which only happens across a real block boundary, not within a single
  soft-broken block. **Verified.**
- **A secondary, unexplained anomaly**: only **two** of the three copied lines (`Chunk1`,
  `Chunk2`) appeared after paste — `chunk3` did not appear anywhere in the result, confirmed by
  probing the cursor position after paste (it sat immediately after `Chunk2`, not on a further
  empty third line). The selection that was copied did visibly include all three lines
  (screenshot-verified before the copy). Given repeated clipboard-interaction accidents earlier in
  this session (see method note above), this could be a stale-clipboard artifact rather than a
  genuine paste truncation — **marked unverified, flagged rather than asserted**, since the root
  cause could not be isolated within this session's time budget.

Screenshot: [paste result](screenshots/upnote-android/gap2-K2-paste-result-clean.png) /
[backspace-merge proof](screenshots/upnote-android/gap2-K2-blocktest.png)

**K3. Select two blocks, press Enter (keyevent 66) to replace the selection — what remains?**

**Unverified.** This session was unable to reliably produce a clean selection spanning exactly two
plain blocks on this note (see the "persistent selection-handle bug" method note above — long-press
repeatedly snapped to the title, and handle-drag attempts landed inconsistently between the two
target blocks despite multiple corrected-coordinate retries). One attempt produced a selection that
appeared, from the on-screen handles, to span from inside `blockX` to inside `blockY`; pressing
Enter in that state left **both `blockX` and `blockY` fully intact** and inserted a new empty block
between the title and `blockX` — which strongly suggests the actual selection at the moment Enter
was pressed was empty or mis-positioned, not a genuine two-block selection. **Not asserted as the
answer to K3** — flagged as unverified rather than guessed, per the brief's instruction.

Screenshot (for the record, not as a confirmed answer): [gap2-K3-enter-replace.png](screenshots/upnote-android/gap2-K3-enter-replace.png)

### Cleanup

Four notes were created for this sweep, all prefixed `ZZTEST` (`ZZTEST-Gap2`, `ZZTEST-Gap2K2`,
`ZZTEST-Gap2K3`, and one accidental empty duplicate title `zZZTEST-Gap2` produced by a mistap) —
all four were moved to Trash via long-press → **Move to trash**, one at a time, verified empty
afterward. The scratch notebook `meologue-probe2` (this session's own, confirmed empty of notes
first) was then deleted via the sidebar's long-press → **Delete Notebook**.

**Important, and logged rather than silently corrected:** the sidebar showed **two** notebooks
both named `meologue-probe2` throughout this session — this session's own (created fresh at the
start, ended up empty and was deleted) and a **second, pre-existing one** containing one note
titled `alphabet` (body `bravostar`), timestamped `8:23 am` — earlier than or concurrent with this
session's own notebook-creation time. That note's content (generic alphabetic filler words) matches
the "concurrent live sync" pattern already documented elsewhere in this file (another session's
test activity, likely the Mac-side agent, syncing to this device). **Neither that notebook nor its
note were created by this session, and neither was opened, edited, or deleted** — left exactly as
found, per the safety constraints for this sweep.

Final state: this session's own notebook and all four of its test notes are gone (notes in Trash,
notebook deleted); the pre-existing `Memoir_1` notebook and the other, not-mine `meologue-probe2`
notebook (with its one `alphabet` note) are untouched.
