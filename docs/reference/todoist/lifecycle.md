# Todoist task lifecycle — observed reference

Captured 2026-09-10 by driving the shipped web application, `app.todoist.com`, dark theme, Free
plan. This is the only part of the corpus that required **writing** to the account, so it was
confined to a single disposable task, `zzprobe-lifecycle`, created for the purpose and deleted
afterwards. A before/after canary over the Inbox confirmed no other task changed.

Every row is marked **Verified** (directly observed in DOM or a screenshot) or **Inferred/Gap**.
Screenshots in `lifecycle-shots/`, raw DOM in `lifecycle-dom/`.

**Three findings a replicator will otherwise get wrong:**

1. **Comments do not submit on Enter.** Enter *and* Shift+Enter both insert a newline; only
   Ctrl/Cmd+Enter or the "Comment" button posts. This is the **opposite** of the task composer,
   where Shift+Enter submits. Two editors, two rules — do not unify them.
2. **Editing is task-wide, not field-wide.** Clicking the description puts the *whole task* into
   edit mode: title and description become editors together, sharing one Cancel/Save pair. And
   clicking a generic part of that form focuses the **title**, so a select-all-and-delete there
   destroys the title rather than the description.
3. **A bare URL in a description is rewritten on save** — Todoist fetches the page and replaces the
   visible link text with its title. In a *comment* the URL keeps its text and gets an unfurl card
   instead.

## 1. Description

| Behaviour | Finding | Status |
|---|---|---|
| Placeholder (empty, at rest) | Idle row shows a small paragraph-lines icon + text **"Description"** (button, `aria-label="Description"`) | Verified |
| Placeholder inside editor | `<div contenteditable aria-label="Description">` with a ProseMirror empty-paragraph placeholder, literal text **"Description"** (`placeholder="Description"` attr) | Verified |
| Editor on focus | Clicking the description area (or the idle "Description" button) switches the **whole task** into edit mode: Task name AND Description both become `tiptap ProseMirror` editors simultaneously, sharing one **Cancel**/**Save** button pair below the description | Verified |
| Formatting toolbar | None. No toolbar element appears at rest, on focus, or while typing (checked DOM for `toolbar`/`bubble`/`format` classes — none found) | Verified |
| Markdown — bold `**x**` | Renders live as bold while typing (input-rule, not on save) | Verified |
| Markdown — bullet list `- x` | Renders live as a `<ul><li>` list while typing | Verified |
| Markdown — inline code `` `x` `` | Renders live as `<code>` span while typing | Verified |
| Markdown — bare URL | Auto-linked while typing; **on Save**, Todoist fetches the target page and **replaces the visible link text with the fetched page title** (e.g. `https://example.com` → link text becomes "Example Domain", href unchanged) | Verified |
| Markdown — italic, strikethrough, headings, numbered list, blockquote, fenced code block | Not tested | Gap |
| Updating a description | Click directly on the **rendered description text** (a `<p>`) to re-enter edit mode with focus placed inside the Description editor; type/edit; Save | Verified |
| ⚠️ Focus trap | Clicking a *generic* part of the combined edit block (not specifically a description paragraph) puts focus in the **Task name** field by default, not Description. Select-all+Backspace there deletes the **title**, not the description. Recovered via Cancel. | Verified (caution for replicator) |
| Deleting a description (emptying) | Select-all + Backspace inside the Description editor, then Save. **No confirmation required** — empty save is allowed silently, row reverts to the idle "Description" placeholder button | Verified |
| Cancel with unsaved changes | Clicking **Cancel** while the combined editor has unsaved edits shows a confirm dialog: title **"Discard unsaved changes?"**, body **"Your unsaved changes will be discarded."**, buttons **Cancel** / **Discard** | Verified |
| List-row preview | `div.task_description.task_description--first-line-description` in the row DOM contains the **full rendered HTML** of the description (not text-truncated in the DOM); CSS clamps it visually to one line with an ellipsis. Confirmed screenshot shows "**bold** and normal…" with bold preserved | Verified |

## 2. Comments

| Behaviour | Finding | Status |
|---|---|---|
| Affordance | Below "Add sub-task": a row with avatar + a control labelled **"Comment"** (`aria-label="Open comment editor"`) | Verified |
| Composer at rest (idle row) | Text **"Comment"** next to avatar, paperclip icon | Verified |
| Composer placeholder (focused, empty) | Verbatim placeholder text: **"Comment"** | Verified |
| Composer toolbar (focused) | Icons: attach file (`aria-label="Attach file"`), record audio (`aria-label="Record audio"`), insert emoji (`aria-label="Insert emoji"`), insert-from-integration (`aria-label="Insert from integration"`). Buttons: **Cancel**, and submit button literally labelled **"Comment"** (not "Post"/"Send") | Verified |
| Enter | Inserts a newline; does **not** submit | Verified |
| Shift+Enter | Inserts a newline; does **not** submit — **different from the task composer**, where Shift+Enter submits | Verified |
| Ctrl/Cmd+Enter | **Submits** the comment | Verified |
| Clicking "Comment" button | Also submits | Verified |
| Posted comment layout | Avatar (`img`), author `span.user_name` ("Hemang"), timestamp as a clickable anchor `href="#comment-<id>"` with text format **"Today 1:25 AM"** (day-word + 12h clock time; not tested how it reads after "Today" ages out) | Verified |
| Hover actions on a comment | Reveals "Add a reaction" (emoji-plus icon) and a "…" **"Comment options"** menu button | Verified |
| Markdown in a comment | bold / bullet list / inline code render identically to description. **Bare URL differs**: link text stays literal (e.g. `https://example.org`, underlined) — it is **not** replaced by the fetched title — but a separate **link-preview/unfurl card** is appended below the comment body showing the fetched title (e.g. "Example Domain") as a clickable card | Verified |
| "Comment options" menu items | Verbatim, in order: **Edit**, **Copy text**, **Copy link to comment**, **Delete** | Verified |
| Editing a comment | "Edit" swaps the rendered comment for the same tiptap editor, pre-filled with its content; buttons are **Cancel** and **Update** (not "Save") | Verified |
| "Edited" marker | None. Inspected the comment's outer HTML after an edit — no "edited"/"Edited" text or marker anywhere | Verified |
| Deleting a comment | "…" → Delete opens a confirm dialog, verbatim: title **"Delete comment?"**, body **"This comment will be permanently deleted."**, buttons **Cancel** / **Delete** | Verified |
| Ordering | **Oldest first** — new comments are appended at the bottom | Verified |
| Empty state | When the last comment is deleted, the **"Comments N" header disappears entirely** — no header, no empty-state message; only the composer box remains | Verified |
| Comments header | Collapsible: **"Comments N"** with a disclosure chevron (collapse/expand not exercised) | Verified (count/label) / Gap (toggle behaviour) |

## 3. Completion and Undo

| Behaviour | Finding | Status |
|---|---|---|
| Click checkbox to complete | Checkbox `aria-checked`/`aria-label` flips instantly (`Mark task as complete` → `Mark task as incomplete`); row gets class `task_list_item--completed` | Verified |
| Visual transition | With this view's "Display: 2" setting (completed tasks shown inline), the row is already relocated into the completed section, strikethrough + dimmed, by ~650ms after click. No distinct multi-stage animation observed at this polling granularity | Verified (coarse) |
| Undo affordance | A **toast**, not inline. Container: `div[data-testid="toasts-container"].global-toasts-provider-container`, inner element `role="alert" aria-live="polite"` | Verified |
| Toast wording (verbatim) | **"1 task completed"** with a separate **"Undo"** control, plus a small **"Close"** (×) icon button | Verified |
| Toast appearance timing | Not present at 150ms; present by 300ms after the click | Verified |
| Toast lifetime | Present continuously from ~300ms to 6000ms; gone by 8000ms on the next poll → **auto-dismisses somewhere between 6–8 seconds** | Verified (range, not exact) |
| Is "Undo" keyboard reachable | Yes — it is a real `<button type="button" tabIndex=0>` (not a plain span/div), inside the alert toast | Verified |
| Does Ctrl/Cmd+Z undo completion | **Yes** — pressing it immediately after completing reverted the task to incomplete (`aria-label` back to "Mark task as complete", `--completed` class removed) | Verified |
| Clicking the toast's "Undo" button directly | Not captured on its own — a follow-up script's round-trip latency exceeded the toast's ~6–8s lifetime so the toast was already gone by the time the click ran. Functionally equivalent behaviour was confirmed via Ctrl/Cmd+Z (same undo action) and the button's real/clickable DOM structure | Inferred (structurally verified, not captured live) |
| Toast on manual uncomplete | Manually clicking the checkbox again (not the Undo button) while the "1 task completed" toast is still showing does **not** spawn a second/different toast — the original one just runs out its own timer | Verified |
| Uncomplete → returns | Confirmed: after uncompleting, the row returns to the active (incomplete) section with an empty checkbox | Verified |

## 4. Activity Log

| Behaviour | Finding | Status |
|---|---|---|
| Entry point | Task's "…" **More actions** menu → **"View activity"**. That same menu also shows a header line "Added on {date} {time}" above the action list, and other items: Duplicate, Copy link to task (⇧⌘C), Add comments via email, View activity, Print, Delete (⌘⌫) | Verified |
| Dialog title | **"Task activity"** | Verified |
| Header inside dialog | **"Added on 10 Sep 1:15 AM"** (absolute creation timestamp), then a date-group header, e.g. **"10 Sep ‧ Today ‧ Thursday"** | Verified |
| Entry layout | avatar + actor ("You") + verb phrase + a live task-name "chip" (checkbox glyph + current title, clickable) + right-aligned relative timestamp | Verified |
| Timestamp format | Entries: relative, e.g. **"25 seconds ago"**, **"1 minute ago"**, **"2 minutes ago"**. Only the top "Added on" line is absolute ("10 Sep 1:15 AM"). Hover-for-absolute-tooltip not tested | Verified (relative) / Gap (hover tooltip) |
| Filter controls | **None.** Only a close ("Close modal") button exists in this dialog | Verified |
| Pagination / end of history | Infinite-scroll style list; reaching the top of the task's history shows literal text **"That's it. No more history to load."** | Verified |

### Exact activity-log wording templates (verbatim, `{task}` = task-name chip, `{content}` = plain-text rendering of the description/comment body)

| Event | Verbatim template |
|---|---|
| Task added | `You added {task}` |
| Description added (first time) | `You added a description {content} to {task}` |
| Description changed (already had one) | `You changed the description of {task} to {content}` |
| Description removed (emptied) | `You removed the description {content} from {task}` |
| Comment added | `You commented {content} on {task}` |
| Comment deleted | `You deleted a comment from {task}` (comment body is **not** shown) |
| Task completed | `You completed {task}` |
| Task uncompleted | `You uncompleted {task}` |
| Task renamed | `You changed the name of {task}` — **note:** the chip shows only the resulting **new** name; no "from X to Y" pair is rendered in the visible text, and no separate "old name" is displayed anywhere in this UI |

All of the above were directly triggered and captured from this probe task's own activity log (`lifecycle-dom/07-activity-log-full.html`, `08-activity-rename-full.html`).

## Not tested / explicit gaps

- Numbered lists, blockquotes, fenced code blocks, italics, strikethrough, headings in description/comment markdown.
- Collapsing/expanding the "Comments N" disclosure header.
- Emoji "Add a reaction" flow, file attachment flow, "Insert from integration" flow.
- Hovering a relative activity-log timestamp for an absolute tooltip.
- Activity-log entries for priority/date/label/project changes (out of the requested event set).
- Precise sub-second toast-lifetime boundary (measured as "disappears between 6s and 8s", not pinned closer).

## Canary

- `canary-start.json` / `canary-end.json`: 9 Inbox rows captured before and after (7 active tasks, 1 completed task "add split and splid both without fail EOD", 1 "+48 completed tasks" hint row).
- **Diff: clean.** The only task whose row text/state differs between start and end is `zzprobe-lifecycle` itself, and by design it ends identical to how it started (title `zzprobe-lifecycle`, no description, no comments, incomplete) — net-zero after the round-trip of edits. All six real user tasks and the one pre-existing completed task are byte-identical between the two captures.
