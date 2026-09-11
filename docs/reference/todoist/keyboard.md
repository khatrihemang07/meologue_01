# Todoist keyboard map, focus behaviour and accessibility — observed reference

Captured 2026-09-10 by driving the shipped web application, `app.todoist.com`, dark theme, Free
plan. Observer only — nothing was created, completed, deleted, rescheduled or edited, and a
before/after canary over the Inbox confirms it.

**The keymap table is transcribed from Todoist's own shortcuts overlay and is NOT verified by
driving.** That distinction is load-bearing: a key the overlay lists may behave differently, and a
false "this does nothing" is the most expensive error this document could contain. Rows individually
marked **verified** were actually driven — and only non-mutating keys were, since exercising the
rest would have changed the user's data.

Focus and styling figures are computed values read with `getComputedStyle()`, never inferred from
class names, which are content-hashed here.

## Canary

- Start: `canary_start.json` — 7 Inbox items (6 open, 1 completed:
  "add split and splid both without fail EOD").
- End: `canary_end.json` — same 7 items, same titles, same `ariaChecked`
  flags, same `data-item-id`s, same order.
- **Diff: none.** The only textual difference between the two JSON files is
  an extra `bodyTextSample` debug field present in the start capture and
  omitted from the end capture; the `items` array (titles + completed flags)
  is byte-identical between the two captures.

## 1. Keyboard shortcuts overlay

Opened with `?` (General → "Show keyboard shortcuts"). It is a `role="dialog"`
panel (`data-testid` not set on this one; the task-detail dialog uses
`data-testid="task-details-modal"`), title "Keyboard Shortcuts", with an
internal scrolling content div (`scrollHeight` 3256px vs `clientHeight`
713px — i.e. the panel is ~4.5 screens tall). **All 8 section headings and
all 80 shortcut rows are present in the DOM at once — the overlay is not
virtualized** — so the full content was extracted directly via
`page.evaluate()` in addition to being screenshotted in 6 scroll positions
(0, 700, 1400, 2100, 2800, and max-scroll) to visually confirm nothing is
clipped.

Full raw `outerHTML` of the dialog: `keyboard-dom/shortcuts_dialog_full.html`
(52,257 characters). Screenshots: `keyboard-shots/overlay_01.png`,
`overlay_scroll_0.png`, `overlay_scroll_700.png`, `overlay_scroll_1400.png`,
`overlay_scroll_2100.png`, `overlay_scroll_2800.png`,
`overlay_scroll_bottom.png`.

**Overlay lists 80 shortcuts across 8 sections:** General (13), Quick Add
(11), Navigate (15), Edit task (17), Add task (5), Sub-task (3), Projects
(11), Calendar and Upcoming views (5).

### Keymap table — TRANSCRIBED FROM THE OVERLAY, NOT VERIFIED BY DRIVING

Key column reproduces exactly what the overlay renders (its own separator
words "or"/"then" and comma groupings), reconstructed token-by-token from the
DOM (`<kbd>` = key, plain `<div>` = literal separator text) so spacing
matches what a user sees on screen. Section headings and label wording are
copied verbatim; nothing summarized, normalized, or reordered.

One shortcut is verified below in the Navigation section (marked ✅); every
other row in this table is transcription-only (unverified by driving) unless
separately marked.

#### General

| Key(s) | Action (overlay's wording) |
|---|---|
| Enter | Open task view |
| X | Select task |
| ⌘A | Select all tasks |
| ↑ or K | Move focus up |
| ↓ or J | Move focus down |
| ← | Move focus to the left |
| → | Move focus to the right |
| Esc | Dismiss/cancel |
| Z or ⌘Z | Undo |
| ⌘K | Open Quick Find |
| ? | Show keyboard shortcuts |
| M | Open/close sidebar |
| ⌘⌥0 | Collapse/expand view |

#### Quick Add

| Key(s) | Action (overlay's wording) |
|---|---|
| Q | Add task |
| ⇧Q | Dictate tasks with Ramble |
| # | Pick project |
| / | Pick section |
| + | Add assignee |
| @ | Add label |
| P1, P2, P3, P4 | Set priority |
| ! | Add reminder |
| { | Set deadline |
| ↓ | Add description |
| ⇧↓ | Open more actions |

#### Navigate

| Key(s) | Action (overlay's wording) |
|---|---|
| G then H or H | Go to home |
| G then i | Go to Inbox |
| G then T | Go to Today |
| G then U | Go to Upcoming |
| G then V | Go to Filters & Labels |
| G then A | Go to reporting |
| G then P | Open project… |
| G then / | Open section… |
| G then L | Open label… |
| ⇧G | Open task in its project |
| O then P | Open Productivity |
| O then N | Open notifications |
| O then U | Open user menu |
| O then S | Open settings |
| O then T | Open themes |

#### Edit task

| Key(s) | Action (overlay's wording) |
|---|---|
| ⌘E | Edit task |
| E | Complete focused task |
| C | Comment on task |
| T | Set date… |
| ⇧T | Remove date |
| D | Set deadline… |
| ⇧D | Remove deadline |
| Y | Set priority… |
| ⇧R | Assign to… |
| L | Change labels |
| V | Move to… |
| ⌘⌫ or ⇧Delete | Delete task permanently… |
| ⇧⌘C | Copy link to task |
| . or ⇧. | More actions |
| ⌘↓ | Move to and edit the task below |
| ⌘↑ | Move to and edit the task above |
| , | Move focus to multi-select toolbar |

#### Add task

| Key(s) | Action (overlay's wording) |
|---|---|
| A | Add new task to the bottom of the list |
| ⇧A | Add new task to the top of the list |
| Enter | Save new task and create another one below |
| ⇧Enter | Save task and create another one below |
| ⌃Enter | Save task and create another one above |

Note: this section documents the Quick Add composer's own Enter/⇧Enter/⌃Enter
behavior — none of these were pressed during this capture (per the
Shift+Enter-submits trap), so they are transcription-only.

#### Sub-task

| Key(s) | Action (overlay's wording) |
|---|---|
| ⇧E | Expand/collapse task |
| ⌃] | Increase indent of selected task |
| ⌃[ | Decrease indent of selected task |

#### Projects

| Key(s) | Action (overlay's wording) |
|---|---|
| ⌥P | Add project |
| S or Ы | Add section |
| ⇧S | Share project |
| ⇧V | Change layout & view |
| D | Sort by date |
| P | Sort by priority |
| N | Sort alphabetically |
| R | Sort by assignee |
| W | More actions |
| C | Comments |
| i | Insights |

Note on "S or Ы": this is exactly what the overlay's DOM renders — two
`<kbd>` elements, "S" and "Ы" (Cyrillic Ye). It is reproduced verbatim rather
than corrected, but it is very likely a Todoist keyboard-layout-detection
artifact (mapping the physical key next to S on some layout) rather than an
intentional second shortcut; flagged as a gap/oddity, not resolved.

#### Calendar and Upcoming views

| Key(s) | Action (overlay's wording) |
|---|---|
| T or ⌥⇧Y | Go back to today |
| ⇧→ | Go to next week/month |
| ⇧← | Go to previous week/month |
| ↑ | Scroll up in week view |
| ↓ | Scroll down in week view |

## 2. Focus and navigation (non-mutating only) — VERIFIED

All claims below were verified by reading `document.activeElement` before
and after each key press (script outputs preserved in
`/private/tmp/.../scratchpad/scripts/11_focus_nav.mjs`,
`12_focus_wrap.mjs`, `13_focus_wrap2.mjs`, `26_tab_order.mjs`,
`27_tab_order_fresh.mjs`), not inferred from appearance.

- **Arrow keys and j/k both move focus, verified.** With focus on task row 1
  (`div.task_list_item__body`, text "Need to improve reflect…"):
  - `ArrowDown` → row 2 ("hair wash")
  - `ArrowDown` → row 3 ("naukri photo update")
  - `j` → row 4 ("naukri photo update" → next, "Buy mobile holder…") — i.e.
    `j` behaves identically to `ArrowDown`
  - `k` → moved back up one row — i.e. `k` behaves identically to `ArrowUp`
  - `ArrowUp` → moved back up one row again
  - Confirms the overlay's claim: "Move focus up: ↑ or K" / "Move focus
    down: ↓ or J".
- **Focus wraps at both ends, verified.** From row 1, `ArrowUp` moved focus
  to the *last* item in the Inbox list — the completed task "add split and
  splid both without fail EOD" (not row 1 again, and not staying put).
  Walking `ArrowDown` from row 1 through all 6 open tasks lands on the
  **"Add task" button** (`<button>`, text "Add task") as the 7th stop, then
  one more `ArrowDown` lands on the completed task row, and one more
  `ArrowDown` after that wraps back to row 1. So the traversal order is:
  6 open tasks → "Add task" affordance → 1 completed task → wraps to
  start. Focus does **not** skip the "Add task" button; it is part of the
  cycle. (No section headings exist in this Inbox view to test skipping.)
- **Focused row appearance, verified via computed style** (on
  `div.task_list_item__body`, the element that actually receives focus —
  not the parent `<li>`):
  - `box-shadow: rgb(23, 91, 194) 0px 0px 0px 1px inset` — a 1px **inset**
    ring, blue (`rgb(23,91,194)`), 0 blur, 0 spread offset beyond the 1px
    width. This is the focus ring; `outline` itself is unset
    (`0px none`) — Todoist implements the ring via inset box-shadow, not
    the CSS `outline` property.
  - `background-color: rgba(255, 255, 255, 0.14)` — a translucent white
    tint over the row's normal `rgb(31, 31, 31)` background.
  - The parent `<li>` itself is unaffected (`outline: none`,
    `box-shadow: none`, background stays `rgb(31, 31, 31)`).
  - Screenshot: `row-shots/focused_row.png`.
- **Tab order from page load, verified** (fresh `page.reload()`, then 15
  `Tab` presses, reading `document.activeElement` each time — see
  `27_tab_order_fresh.mjs`):
  1. Immediately after load, before any Tab, focus already sits on
     `<main aria-label="Main Content">` (an apparent skip-to-content
     landing point) — the sidebar (logo, Add task, Search, Inbox, etc.) is
     **not** reached by these 15 Tab presses.
  2. `button[aria-label="View Options Menu"]` ("Display: 2")
  3. `a[aria-label="Comments"]`
  4. `button[aria-label="Project options menu"]`
  5. `div.task_list_item__body` (row 1, focusable row body)
  6. `button.task_checkbox[aria-label="Mark task as complete"]` (row 1)
  7. `button.due_date_controls` (row 1, sr-only text "Date: Yesterday")
  8. `button[aria-label="Edit"]` (row 1)
  9. `button.due_date_controls[aria-label="Date"]` (row 1)
  10. `button[aria-label="Comment"]` (row 1)
  11. `button[aria-label="More actions"]` (row 1)
  12. `div.task_list_item__body` (row 2, "hair wash")
  13. `button.task_checkbox` (row 2)
  14. `button.due_date_controls` (row 2)
  15. `button[aria-label="Edit"]` (row 2)

  Pattern: each task row is one Tab stop for the row body, then one stop
  per action control inside it (checkbox → inline due-date button →
  Edit → Date → Comment → More actions), i.e. **6 tab stops per row**,
  before advancing to the next row.
- Gap: whether Left/Right arrow ("Move focus to the left/right" per the
  overlay) do anything in this single-column list view was not tested —
  Inbox is a plain list with no adjacent column, so there was nothing safe
  to verify against; likely applies to board/grid views only.

## 3. Accessibility semantics — VERIFIED (structure), overlay text is as documented above

- **List**: `<ul class="items">` — no explicit `role` or `aria-label`
  (relies on the implicit HTML `list` role). A different, unrelated `<ul>`
  in the sidebar carries `aria-label="Main filters"`; the task list itself
  has no explicit ARIA label.
- **Row**: `<li data-testid="task-list-item" data-item-id="…" aria-selected="false">`
  — implicit `listitem` role, explicit `aria-selected` (true/false) kept in
  sync with row selection state. The interactive part of the row is a
  **nested** `<div role="button" tabindex="0" class="task_list_item__body"
  aria-labelledby="task-{id}-content" aria-describedby="task-{id}-info-tags">`
  — this div, not the `<li>`, is what actually receives focus (confirmed in
  section 2).
- **Checkbox**: `<button role="checkbox" aria-checked="false"
  aria-label="Mark task as complete" aria-describedby="task-{id}-content">`.
  In the task-detail view the same control's label becomes
  `"Checkbox for {task title}"` instead of the generic row label.
- **Composer** (Quick Add, opened with `Q` for inspection only, then closed
  with `Escape` — no text typed, canary confirmed unaffected): the dialog is
  `role="dialog"`, `data-testid="quick-add"`, `aria-modal` **not set**
  (absent, not `"false"`). Its title field is a
  `<div role="textbox" contenteditable="true" aria-label="Task name">` —
  i.e. a rich-text **contenteditable div**, not a `<textarea>`.
- **Task detail dialog**: `role="dialog"`, `data-testid="task-details-modal"`,
  `aria-label` = the task's full title, `aria-modal` **not set** here either
  (both dialogs observed in this session — the shortcuts overlay and the
  task detail — omit `aria-modal` entirely rather than setting it to
  `"true"`).
- **Live region**: exactly one `[aria-live="assertive"]` element exists on
  the page, with `role="status"` and `aria-atomic="true"`. At the time of
  inspection its text content was empty — it presumably populates
  transiently after state-changing actions (e.g. "Task completed"), but no
  such action was performed in this session, so its populated content is a
  **gap**, not verified.

## Files

- `keyboard-dom/shortcuts_dialog_full.html` — full overlay `outerHTML`.
- `keyboard-shots/overlay_01.png`, `overlay_scroll_0.png`,
  `overlay_scroll_700.png`, `overlay_scroll_1400.png`,
  `overlay_scroll_2100.png`, `overlay_scroll_2800.png`,
  `overlay_scroll_bottom.png` — full-overlay screenshots covering top to
  bottom.
- `canary_start.json`, `canary_end.json` — Inbox canary before/after.
