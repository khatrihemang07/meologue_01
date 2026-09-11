# Todoist quick add — observed reference

Every row marked **verified** was produced by driving the shipped web application and reading back
ground truth, not by reasoning about it:

- **Todoist web**, `app.todoist.com`, dark theme, driven through ego-browser with `page.evaluate()`
  for both interaction and measurement. Captured 2026-09-10, with "today" = 10 Sep 2026 (Thursday).
- Styling figures are **computed** values read with `getComputedStyle()`, never inferred from class
  names — Todoist's classes are content-hashed and carry no meaning.
- Measurements marked **verified twice** were taken by one agent and then re-measured independently
  before being written down.

Anything not verified is labelled as such. Where a question could not be reached, that is stated
rather than filled in with something plausible.

## The one fact that decides the implementation

**A recognised match is a real inline-block box that occupies width.** It is not a colour painted
behind the text. When recognition fires, the glyphs after the match physically shift.

Verified twice, driving `tod` in Quick Add:

| State | Editor text | Span | `display` | padding L/R | Rendered width |
|---|---|---|---|---|---|
| `tod` recognised | `tod` | `data-highlighted-match="true"` | `inline-block` | 4px / 4px | **32.31px** |
| after Backspace ×1 | `tod` — **unchanged** | span present, attribute **removed** | `inline` | 0 / 0 | **24.31px** |
| after Backspace ×2 | `to` | span **gone** | — | — | — |

The 8px difference is exactly the horizontal padding appearing and disappearing.

**Consequence for any replica:** a transparent-text `<input>` with a highlight layer painted behind
it cannot reproduce this. A layer behind text can recolour it; it cannot move it. Faithful
replication requires a real contenteditable with inline-block spans.

~~**And a simplification that goes the other way:** the span is *not* created and destroyed around
recognition. It is **one element in two visual states**, removed only when the underlying text
changes.~~ So the model is one span per match, a two-state style, and a delete-on-edit rule — not
three separate representations.

> **Corrected 2026-09-11 (`live-audit-2026-09-11.md`, ledger QA-06).** The struck claim is **false
> for Todoist's DOM**, though it was marked verified. A `MutationObserver` watching the editor
> through one Backspace, with a unique token set on the recognised span, showed in 3 of 3 runs that
> **Todoist removes the recognised span and inserts a new one** (plus a text node): the held node
> ends detached and the span now in the editor lacks the token. It *looks* like one element in two
> states because the replacement carries the same text and `data-match-id`, which is almost
> certainly how the original capture read it.
>
> What survives is the **model**, not the DOM claim: one match, two visual states, removed when the
> text changes is still a sound way to *implement* this, and it is what meologue does — its span
> keeps its identity through withdrawal. That is a structural divergence with no user-visible
> effect (QA-06, `divergent`). **On 2026-09-12 the user chose to match Todoist**, so meologue's
> withdrawal is to be changed to replace the span node rather than restyle it.

## The recognised-match span

```
<span data-testid="natural-language-match" data-match-id="10 Sep" data-highlighted-match="true">tod</span>
```

| Property | Recognised | Withdrawn |
|---|---|---|
| `data-highlighted-match` | `"true"` | absent |
| `display` | `inline-block` | `inline` |
| `padding-left` / `padding-right` | 4px / 4px | 0 / 0 |
| `background-color` | `rgb(111, 38, 37)` | transparent |
| `color` | `rgb(255, 255, 255)` | inherited |
| `border-radius` | 3px | 0 |
| `font-size` / `line-height` | 16px / 23px | 16px / 23px |

`data-match-id` carries the **resolved** value (`"10 Sep"`), not the typed text — so the element
knows what it parsed to, and the footer control mirrors it.

## Recognition and withdrawal (verified)

| Keystroke | Field text | Span state |
|---|---|---|
| — | `""` | none |
| `t` | `"t"` | none |
| `to` | `"to"` | none |
| `tod` | `"tod"` | present, highlighted, `data-match-id="10 Sep"` |
| Backspace ① | `"tod"` — unchanged | present, **highlight stripped** |
| Backspace ② | `"to"` | removed |
| Backspace ③ | `"t"` | plain text |

**The first Backspace after a recognised match consumes the keystroke to withdraw recognition and
deletes no character.** Only the second deletes.

### Withdrawal is not sticky (verified)

From a withdrawn `tod`: type `x` → `todx`, span disappears (not a recognisable phrase). Backspace
the `x` → back to `tod` → **recognition returns**, same `data-match-id`. Clearing the field and
retyping `tod` also re-recognises.

So withdrawal is per-occurrence and one edit deep. It is not remembered against the word.

### Other ways to reject a recognition

- Backspace once — **verified**.
- A **"Remove date"** footer button appears once a date is recognised — **observed in the DOM,
  never clicked** (clicking it would have mutated a real account). Its effect is inferred.
- No dismiss affordance on the span itself, and no dedicated shortcut, was found in the DOM.

**Moving the caret into a recognised span does not withdraw it** — verified with `Home` then
`ArrowRight`.

## Recognised vocabulary (verified)

Each term typed alone into a freshly opened Quick Add. "Recognised" = the span is present and
highlighted; the value is its `data-match-id`. Today = 10 Sep 2026.

| Term | Parsed as | | Term | Parsed as |
|---|---|---|---|---|
| `today` | 10 Sep | | `25 dec` | 25 Dec |
| `tod` | 10 Sep | | `12/25` | 25 Dec |
| `tomorrow` | 11 Sep | | `at 5pm` | 10 Sep 5:00 PM |
| `tmr` | 11 Sep | | `5pm` | 10 Sep 5:00 PM |
| `monday` | 14 Sep (next Monday) | | `17:00` | 10 Sep 5:00 PM |
| `friday` | 11 Sep (this Friday) | | `every day` | recurrence, every day |
| `next week` | 14 Sep | | `every monday` | recurrence, every monday |
| `in 3 days` | 13 Sep | | `daily` | recurrence, **normalised** to every day |

`p1`–`p4` are recognised as priorities and show no date control. A recurring term still carries a
start date.

**Deadline syntax — not tested.** The session stopped before reaching it.

## Autocomplete popups (verified)

`data-testid="content-editor-suggestions-dropdown"`, `role="listbox"` with `role="option"` rows.

| Sigil | Behaviour | No match |
|---|---|---|
| `#` project | lists real projects, Inbox first, then a "My Projects" group heading; typing filters | *"Project not found. Create &lt;text&gt;"* |
| `@` label | lists real labels | *"Label not found. Create &lt;text&gt;"* |
| `+` assignee | listbox opens but is **empty** — no options, no message | — (personal account, no collaborators) |

- **Arrow-key navigation — inconclusive.** `ArrowDown` was sent with the `#` popup open and the
  captured DOM did not change; no `aria-selected` is used. This is a capture limitation, **not**
  evidence that arrow navigation is absent. Marked inferred.
- **Escape — partially verified.** One `Escape` did not visibly close the popup in our capture; a
  second closed the popup *and* raised the "Discard unsaved changes?" confirmation, since the title
  still held text. Whether that is genuinely two presses or one under-captured press is **not
  certain**.

## Quick Add chrome (verified)

- Opened by the sidebar's global **Add task** button, giving `role="dialog"`,
  `aria-label="Quick Add"`, `data-testid="quick-add"`.
  > **Corrected 2026-09-11 (`live-audit-2026-09-11.md`).** This line used to name that button
  > `button.plus_add_button`. On the captured account that selector is the **in-list inline**
  > add-task trigger (a single instance inside `ul.items`), which opens an inline composer row, not
  > this dialog. The global opener is the sidebar's "Add task" button, which carries **no
  > aria-label** — find it by its text, excluding `.plus_add_button`, with the sidebar expanded.
  > A driver that followed the old selector measured the inline row and reported it as Quick Add.
  > Always assert `[role="dialog"][aria-label="Quick Add"]` before measuring.
- The title field is the **only** `[contenteditable="true"]` in the dialog at rest, `aria-label="Task
  name"`. **There is no separate description input by default.**
- Footer row: More actions · Select project (shows current, e.g. "Inbox") · Set date (shows "Date"
  when unset, the parsed value once recognised, with a "Remove date" button appearing alongside) ·
  Set priority (shows "Priority", then "P1" once recognised, with "Remove priority" alongside) · Add
  labels · then Cancel and Add task.
- Below the footer: "Attach to task" and "Scan for tasks", each with a helper caption.
- **Corrected 2026-09-11:** re-measured on the asserted dialog, it is **580 × 66px with an empty
  draft** and **580 × 97px once a date is recognised** (the footer grows). The "at rest" figure
  below was a recognised-state reading, as `pass2-2026-09-11.md` §4 had already found. Every other
  value below re-measured identically. Artifact: `live-audit-dom/quickadd-dialog-todoist.json`.
- Geometry ~~at rest~~ with a date recognised: **580 × 97px**, padding 16px, border `1px solid rgb(61,61,61)`, radius **12px**,
  shadow `rgba(0,0,0,0.2) 0 4px 8px`, background `rgb(40,40,40)` (dark theme). An earlier read of the
  same selector returned 348 × 39.6px; that was a pre-layout read and is superseded — **flagged, not
  fully resolved**.
- `Tab` from the title field moves focus to **More actions**, not to a description field.

## Fonts (verified)

One stack throughout — Todoist does not swap fonts between chrome and Quick Add:

```
-apple-system, "system-ui", "Segoe UI", "Noto Sans", system-ui, sans-serif,
"Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"
```

| Element | size | weight | line-height |
|---|---|---|---|
| `body` | 13px | 400 | normal |
| Quick Add title input | **16px** | 400 | **23px** |
| task-list row title | 13px | 400 | normal |

The recognised span matches the Quick Add input exactly (16px / 23px), confirming it lives inside the
title editor rather than in a separate overlay.

## `Shift+Enter` submits Quick Add

**Verified, accidentally.** Typing a title, pressing `Shift+Enter`, then typing again closed the
dialog and **created the task**. Shift+Enter does not insert a newline in the title field.

This corroborates a complaint the user had already written down independently, in their own Todoist
task: *"Shift enter is also counting just like enter. Wrong."*

Plain `Enter` versus `Shift+Enter` was **not** isolated further — testing stopped at that point
because the account had been mutated. The created task was afterwards deleted and the Inbox verified
back to its prior contents.

## Destructive confirmation wording (verified)

Captured while cleaning up test residue, and worth matching exactly:

| Act | Dialog text |
|---|---|
| Delete a task | *"Delete task? The &lt;name&gt; task will be permanently deleted."* |
| Delete a project | *"Delete project? The &lt;name&gt; project and all its tasks will be permanently deleted. This action cannot be undone."* |
| Delete a label | *"Delete label? The &lt;name&gt; label will be permanently deleted."* |

Buttons read **Cancel** and **Delete**.

## Menus seen in passing (verified)

- Task **More actions**: Duplicate · Copy link to task `⇧⌘C` · Add comments via email · View
  activity · Print · Add extension… · Delete `⌘⌫`
- **Label options menu**: Edit · Add to favorites · Move to shared labels · Copy link to label ·
  Delete
- The task detail view is a **route**, not only an overlay — opening one changes the URL to
  `/app/task/<slug>-<id>`.

## Not established

- Deadline syntax in Quick Add.
- Plain `Enter` behaviour in the title, isolated from `Shift+Enter`.
- How title and description separate once multi-line content exists.
- Growth behaviour with a 300+ character title.
- Arrow-key navigation within the autocomplete popups.
