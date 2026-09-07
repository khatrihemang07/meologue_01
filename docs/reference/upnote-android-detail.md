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

