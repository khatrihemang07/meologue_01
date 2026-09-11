# Todoist task row and detail view — observed reference

Captured 2026-09-10 by driving the shipped web application, `app.todoist.com`, dark theme, Free
plan, against the user's own Inbox.

**The single most consequential finding is in §2:** the detail view's title is a plain,
non-editable `div.task_content` — the *same display component the list row uses*, not Quick
Add's `contenteditable`. It carries the hint "Activate to edit the task name". So Todoist
splits display from editing, and what is shared with creating a task is the **editor**, not the
element sitting there at rest. **What the activated editor becomes was not verified** — that would
have meant typing into a real task — and it is the open question for the ticket that unifies the
three title surfaces.


Observer only: rows were hovered/read via `page.evaluate()` and
`page.mouse.move()`; the task detail view was opened via the documented
`Enter` shortcut (never by clicking inside the row) and closed via `Escape`;
nothing inside the detail view was typed into or clicked. Canary confirmed
unchanged — see `keyboard.md`.

All measurements below are **verified** (read via `getBoundingClientRect()` /
`getComputedStyle()` in `page.evaluate()`), not eyeballed from screenshots,
unless marked "inferred."

## 1. The task row

Reference task for rest/hover comparisons: "naukri photo update" (plain
task, no comments, no description). `outerHTML` at rest is in
`row-dom/row_rest.json` (captured on the "hair wash" task, structurally
identical); hovered `outerHTML` is in `row-dom/row_hover.html`.

### Row box

- Computed height: **59px** (measured on `<li data-item-id>`, no visible
  content wrapping to a 2nd line).
- Padding: **0px on all sides** (top/bottom/left/right all `0px`) on the
  `<li>` itself — internal spacing comes from the children's own padding,
  not the row.
- Row background: `rgb(31, 31, 31)` at rest.
- **Divider**: implemented as `border-bottom: 1px solid rgb(61, 61, 61)` on
  the `<li>` itself (not a separate `<hr>`).
  - **Left inset: 0px.** The `<li>`'s `left` edge (470px in the captured
    viewport) is identical to its parent `<ul>`'s `left` edge (470px) — the
    divider runs the full width of the list, edge-to-edge, and is **not**
    indented to align with the checkbox or the title text (title/content
    itself starts ~27px further right, at 497px, because of the checkbox
    column).

### Checkbox

- Outer hit target (`<button class="task_checkbox" role="checkbox"
  aria-label="Mark task as complete">`): **24×24px**, `border: 0`,
  transparent background — this is just the clickable button box, not the
  visible ring.
- The **visible ring** is a nested `<span>` (class `nFjnBtO`): **18×18px**,
  `border: 1px solid rgb(169, 169, 169)`, `border-radius: 50%` (a true
  circle), transparent fill.
- A sibling `<span class="UgB8lOl">` (also 18×18px, `border-radius: 50%`)
  sits behind it with a fully transparent border/background at rest — likely
  a hover/press fill layer, but it stayed transparent under a real
  `page.mouse.move()` hover in this capture, so its hover-fill behavior is
  a **gap**.
- Ring color is **priority-dependent**, not fixed: on the P4 (no-priority)
  "naukri" task the checkbox class includes `priority_4` and renders the
  gray ring above; on the P1 task ("hair wash", confirmed P1 in its detail
  view) the same structure renders with a **red** ring instead (visible in
  `row-shots/naukri_rest.png` vs. the red circle in the Inbox screenshots).
- **On hover** (never clicked): the checkmark `<svg>` inside the button,
  which sits at `opacity: 0` at rest, transitions to `opacity: 1` — i.e.
  hovering previews the checkmark glyph in the same gray as the ring
  (`rgb(169, 169, 169)`); the ring itself does not change size, border
  width, or color on hover in this capture.

### What hover reveals

Comparing computed styles at rest vs. under a real `page.mouse.move()` onto
the row (script `19_hover_mechanism.mjs`; visual confirmation in
`row-shots/naukri_rest.png` vs. `row-shots/naukri_hover.png`):

- **Row background does not change on hover** — `rgb(31, 31, 31)` before and
  after, confirmed both by computed style and by pixel-comparing the two
  screenshots. (This differs from the *focused* state, which does tint the
  background — see `keyboard.md` §2.)
- **Drag handle** (`span.task_list_item__drag_handle`, a 6-dot grip icon,
  24×24px, sits left of the checkbox): `opacity: 0` at rest → `opacity: 1`
  on hover. Its wrapping container (`.task_list_item__drag_container`) is
  always present in the DOM and always `opacity: 1`; only the icon span
  itself is hidden/revealed.
- **Right-hand action icons, in DOM/visual order, each individually
  `opacity: 0` at rest → `opacity: 1` on hover** (the wrapping bar
  `.task_list_item__actions` is itself always `opacity: 1`; hiding happens
  per-button):
  1. `button[aria-label="Edit"]` — pencil icon.
  2. `button[aria-label="Date"]` (`due_date_controls`, no visible text on
     this instance) — calendar icon; opens the date/scheduler picker.
  3. `button[aria-label="Comment"]` (`task_list_item__comments_link`) —
     speech-bubble icon.
  4. `button[aria-label="More actions"]` (`data-testid="more_menu"`,
     `aria-haspopup="menu"`) — three-dot overflow icon.
- None of these were clicked; accessible names and order were read from the
  DOM, and their reveal was confirmed by computed `opacity` plus the
  before/after screenshots.

### Metadata line

Order, confirmed on a task with both a date and a comment count
("Buy mobile holder and get the bike fixed", see
`row-dom/metadata_line_with_comment.html`):

1. **Date**: `<button data-testid="due-date-control" class="due_date_controls">`
   containing a small calendar **icon** (12×12 `<svg>`) immediately followed
   by **text** (e.g. "Saturday"). A screen-reader-only `<div>` with text
   "Date:&nbsp;" precedes it (visually hidden, class shared with the
   equally-hidden "Task:&nbsp;" label before the title).
2. **Comment count**: `<a aria-label="1 comment" href="/app/task/{slug}-{id}?intent=reply">`
   containing a comment-bubble **icon** (12×12 `<svg>`) immediately followed
   by the **count** as text (`<span aria-hidden="true">1</span>`).

No visible separator character (comma, pipe, dot) sits between the date
block and the comment block — they are simply adjacent flex children with a
gap. Only two metadata kinds were observed in this Inbox (date, comment
count); labels, assignee, or sub-task counters were not present on any of
the 7 tasks, so their position in the order is a **gap**.

### Long title wrap/truncate and markdown-in-title

Verified on the existing long task "Need to improve reflect and todo
completely…":

- The title node (`div.task_content`) computes `white-space: normal` and
  `-webkit-line-clamp: 4` with `overflow: hidden` — **long titles wrap**
  across multiple lines, then are **clamped after 4 lines** (not a
  single-line ellipsis).
- **Markdown in the title stays literal.** No task in this Inbox has
  markdown syntax in its title, but the title element itself
  (`div.task_content`) is structurally proven to be a plain text container:
  compare it to the **description** field on "Buy bluetooth for vishal",
  which contains a markdown link (`[Amazon.in](https://amazon.in/...)`) —
  there, the *description* renders as `<div class="task_description
  task_description--first-line-description"><p><a href="...">Amazon.in</a></p></div>`,
  i.e. real HTML produced from markdown. The *title*, by contrast, is
  always `<div class="task_content">{plain text}</div>` with no nested
  markup for any of the 7 tasks observed, including ones with special
  characters. So: **description markdown renders; title markdown would stay
  literal** (inferred from the title component's plain-div structure, since
  no task in this Inbox actually has markdown syntax typed into its title —
  stated as a gap for the literal claim, though the structural evidence is
  strong).

## 2. The task detail view

Opened via keyboard only: focus a row (`ArrowDown`), then `Enter`
("Open task view" per the shortcuts overlay). Screenshots:
`row-shots/detail_view_01.png` (task with description),
`row-shots/detail_no_description.png` (task with no description).
Full dialog `outerHTML`: `row-dom/detail_dialog_full.html`.

### URL

**Yes, the URL changes.** Shape:
`https://app.todoist.com/app/task/{slugified-title}-{taskId}`, e.g.:

- `.../app/task/need-to-improve-reflect-and-todo-completely-they-are-crap-right-now-specially-wh-6hRwF8R8HMPhmqjG`
- `.../app/task/hair-wash-6h666qC9ghpFvf8p`

The slug is the title lowercased/hyphenated and truncated to a bounded
length; the task ID is always appended as the final path segment, and is
authoritative (the slug portion is decorative). Closing with `Escape`
returns the URL to `.../app/inbox`.

### Geometry and structure

- Dialog (`role="dialog"`, `data-testid="task-details-modal"`,
  `aria-label` = full task title, `aria-modal` **not set**): **864×698px**
  in this viewport, positioned as an overlay (not full-page), top-left at
  (298, 64).
- Three stacked children: a **48px-tall `<header>`**, a 1px `<hr>`, and a
  **649px-tall content region** spanning the full dialog width.
- The content region splits into two columns:
  - **Right column (properties panel)**: fixed **260px** wide.
  - **Left column (title/description/sub-task/comments)**: the remainder,
    ~604px wide.
- **Header** contents (left to right): a small project-icon + "Inbox"
  breadcrumb/link, then on the right: up-arrow and down-arrow buttons
  (navigate to prev/next task), a "…" more-actions button, and a close
  ("×") button.
- **Footer**: there is no distinct footer chrome; the bottom of the left
  column holds a persistent comment-entry affordance (see below), which
  functions as the closest thing to a footer.

### Title element — answers the sibling-ticket question

**The detail-view title, at rest, is a plain non-editable `<div>`, the same
`task_content` component class used in the list row — not Quick Add's
contenteditable, and not a `<textarea>`.**

Verified directly:
```
<div class="task_content task-overview-content-large">{title text}</div>
```
`contentEditable` attribute: absent. `isContentEditable`: `false`.
`tabIndex`: `-1`. It sits next to a visually-hidden `id="a11y_task_name"`
label whose text reads **"Activate to edit the task name"** — implying the
title becomes editable only after an explicit activation step (a click or
Enter-to-edit), which was **not performed** (per the "never type into it"
rule), so what it turns into on activation is a **gap**.

For contrast, Quick Add's title field (opened separately,
never typed into, then closed with Escape) is a different component
entirely: `<div role="textbox" contenteditable="true" aria-label="Task
name">` — always-editable, `role="textbox"`. So: **the detail-view title at
rest is the row's display component, not Quick Add's input component.**
Whether they converge into the same editable widget once the detail title
is activated is unverified (gap).

### Properties panel — full control inventory

All are `<button>` elements inside the 260px right column
(`row-dom/properties_panel.html`):

| Label | Accessible name / content | Notes |
|---|---|---|
| Project | `aria-label="Select a project"`, shows "Inbox" | |
| Date | (no `aria-label`; text shows e.g. "Yesterday"/"Saturday") | recurring tasks show an extra repeat icon |
| — | `aria-label="No Date"` | a small "clear date" (X) button next to the Date control |
| Deadline | (no `aria-label`; text "Deadline") | rendered with a lock/upgrade icon in this account — likely a paid-plan-gated feature |
| Priority | (no `aria-label`; shows "P4" or "P1" etc.) | flag icon colored by priority |
| Labels | (no `aria-label`; text "Labels") | plus-icon, empty state |
| Reminders | (no `aria-label`; text "Reminders") | plus-icon, empty state |
| Location | (no `aria-label`; text "Location") | also shown with a lock/upgrade icon |

Section order top-to-bottom: Project, Date, Deadline, Priority, Labels,
Reminders, Location.

### Description placeholder

**Exact wording: "Description"** (with a small paragraph-lines icon to its
left), in a dedicated element `<div class="task-overview-description-placeholder">`.
Confirmed on "hair wash," which has no description. When a task does have a
description (e.g. the long "Need to improve reflect…" task), the same slot
instead renders the description's markdown content as-is (verified in
`detail_view_01.png` showing two description paragraphs) — never both.

### Comments area empty state

**Exact wording: "Comment"** — a single collapsed
`<button data-testid="open-comment-editor-button" aria-label="Open comment
editor">` showing the text "Comment" next to the current user's avatar and a
paperclip (attachment) icon. There is no separate "No comments yet" heading
above it in this state; the collapsed comment button *is* the empty state.
Not clicked (would open a live comment editor).

## Files

- `row-dom/row_rest.json` — row `outerHTML` + computed styles at rest
  (checkbox, row box).
- `row-dom/row_hover.html` — row `outerHTML` while hovered.
- `row-dom/metadata_line_with_comment.html` — metadata line markup
  (date + comment count).
- `row-dom/detail_dialog_full.html` — full task-detail dialog `outerHTML`.
- `row-dom/properties_panel.html` — properties-panel-only `outerHTML`.
- `row-shots/row_rest.png`, `row_hover.png` — first-row-focused context
  shots.
- `row-shots/naukri_rest.png`, `naukri_hover.png` — clean rest/hover pair on
  an unfocused row.
- `row-shots/checkbox_hover.png` — checkbox hover state.
- `row-shots/focused_row.png` — keyboard-focused row appearance.
- `row-shots/detail_view_01.png` — detail view, task with description.
- `row-shots/detail_no_description.png` — detail view, task with no
  description (shows the "Description" placeholder).
- `row-shots/composer_open.png` — Quick Add, opened for inspection
  only, closed without typing.
