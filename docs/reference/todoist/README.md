# Todoist — observed reference

What Todoist's web app actually does, established by driving it rather than by reasoning about it.
`CONTEXT.md` already commits this repo to Todoist parity ("every design question meologue answers
gets checked against Todoist's own help center and developer docs"), and this directory is what that
checking reads from.

## A word this directory reserves

In this directory, **"Quick Add"** means Todoist's own task-creation dialog (`role="dialog"
aria-label="Quick Add"`, opened by its global "Add task" affordance). **"Composer"** is reserved
for meologue's own Entry-writing Destination as defined in `CONTEXT.md`, and is never used here for
Todoist's dialog — the two got confused with each other once already.

## How it was captured

- **Todoist web**, `app.todoist.com`, **dark theme**, **Free plan**, captured 2026-09-10 with
  "today" = 10 Sep 2026 (Thursday). Light theme was never observed — treat every colour here as a
  dark-theme value.
- Driven through **ego-browser**. Interaction and measurement both go through `page.evaluate()`:
  elements are found and clicked by asserted identity, never by coordinates.
- **Every styling figure is a computed value** read with `getComputedStyle()`. Todoist's class names
  are content-hashed and carry no meaning, so nothing here is inferred from a class.

## The marking convention, and why it is strict

Every row in every document is marked **verified** (driven and read back), **inferred** (reasoned
from what was seen), or **blocked / gap** (could not be established). These are never blurred.

A false negative is the most expensive thing this corpus could contain — "this key does nothing",
"this state has no colour" — because it silently licenses a wrong implementation. So `keyboard.md`'s
whole keymap is marked *transcribed from Todoist's own overlay, not verified by driving*, and only
individually-driven rows are promoted.

## Working against a real account

This was captured against the author's own live Todoist, which constrains the method:

- **The account is Free, capped at 5 projects.** Exceeding the cap does not refuse the new project —
  Todoist accepts it and makes *some* project view-only, and once picked **the user's own** rather
  than the scratch one. Never provision a project per agent.
- **Run one browser agent at a time.** Parallel agents, even strictly read-only ones, mis-click:
  Todoist's live sync re-renders the list under a click and it lands somewhere else. This is how a
  real task got completed during capture.
- **Read-only wherever possible.** Almost everything here was observed without writing: recognition
  states, pickers and the shortcut overlay are all visible in an unsaved Quick Add draft, discarded
  afterwards.
- **`lifecycle.md` is the exception** — completion, comments, descriptions and activity wording
  cannot be seen without mutating. That was confined to one disposable task, deleted afterwards,
  with a before/after canary over the Inbox.

## The documents

| File | Covers |
|---|---|
| `quick-add.md` | Recognition and withdrawal, the token vocabulary, autocomplete popups, Quick Add chrome, fonts |
| `scheduler-and-priority.md` | The scheduler popover, quick options, calendar, time, recurrence, date rendering, priority |
| `row-and-detail.md` | Task row anatomy, hover, metadata, the detail view's structure |
| `keyboard.md` | The 80-shortcut map, focus movement, focus appearance, accessibility semantics |
| `lifecycle.md` | Description and comment CRUD, completion and undo, activity-log wording |
| `parity-ledger.md` | **The checklist.** One row per nuance; a ticket lands when its rows read `matched` |

Raw evidence sits beside each document in `*-dom/` and `*-shots/`.

## What could not be established

Stated here so their absence reads as a limit, not an oversight:

- **Deadline and Duration are Pro-only.** Both open an upgrade paywall on a Free account. meologue
  *has* a Deadline, so that surface has no reference to match against.
- **Several date states do not exist in this account's data** — nothing due exactly today or
  tomorrow, nothing further out, nothing carrying a time. Their row rendering is unobserved.
- **No task carries P2 or P3**, so those row colours are inferred from the picker's swatches.
- **The keymap is transcribed, not driven.** Exercising it would have mutated real data.
- Light theme, arrow-key navigation inside the autocomplete popups, and a handful of markdown forms.

## The one fact that shapes the rebuild

A recognised natural-language match is an **`inline-block` span carrying 4px of horizontal padding**
— 32.31px wide recognised against 24.31px withdrawn. It occupies width, so text after it physically
shifts when recognition fires. A highlight painted *behind* a plain input cannot reproduce that.

And the editor it lives in is **ProseMirror (Tiptap)**, `aria-label="Task name"` — the *same
component* in the Quick Add dialog and in the detail view's edit mode, with recognition firing
identically in both. Creating a task and renaming one really are the same input.
