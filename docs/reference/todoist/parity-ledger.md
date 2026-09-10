# Todoist parity ledger

One row per nuance. This file is the checklist the Todo rebuild is measured against, and it is the
definition of done — a ticket lands when every row it owns reads `matched` or `divergent`.

Rows are generated from the reference docs in this directory as those are written, never recalled
from memory afterwards. If a behaviour has no row here, it was never established, and code that
claims to replicate it is claiming something nobody checked.

## Status vocabulary

| Status | Meaning |
|---|---|
| `todoist-captured` | We know what Todoist does. Nothing has been built. |
| `built` | meologue implements it. **Not a terminal state** — nobody has compared them. |
| `matched` | Driven in both apps side by side and compared on all three axes below. |
| `divergent` | Deliberately different. The Note column says why, and whose decision it was. |
| `blocked` | Cannot be established. The Note says what stopped it. |

`built` is called out because conflating it with `matched` is precisely how the implementation this
rebuild replaces came to diverge so widely while looking finished.

## What `matched` requires

Pixel-diffing two different applications cannot work — different content, different account,
different strings. So a row is `matched` only when all three agree:

1. **Behavioural** — same input, same state transition. The axis that decides correctness.
2. **Structural** — the DOM contract: same elements, attributes, ARIA roles and labels.
3. **Dimensional** — measured `getComputedStyle` values with both apps showing deliberately
   identical content: row height, font family/size/weight/line-height, colour as rendered `rgb`,
   padding, border-radius, checkbox diameter, indent step.

Screenshots are captured for human review and live in `pairs/`, named `<ID>-todoist.png` and
`<ID>-meologue.png`. They are evidence for a reader, not the pass criterion — two screenshots can
look alike while the behaviour differs.

## ID scheme

| Prefix | Area |
|---|---|
| `QA-` | Quick add: recognition, withdrawal, the token vocabulary, composer chrome |
| `ROW-` | Task row: anatomy, checkbox, hover, metadata line, long titles |
| `DATE-` | Date wording, tone and colour, wherever a Date renders |
| `SCHED-` | The scheduler: quick options, calendar, time, deadline, recurrence |
| `PRI-` | Priority: pickers, display, ordering |
| `DET-` | Task detail view: layout, title editing, description, sub-tasks |
| `CMT-` | Comments and the activity log |
| `KBD-` | Keyboard shortcuts, focus movement, focus appearance |
| `NAV-` | Sidebar, destinations, counts |
| `STR-` | Projects, Sections, Labels, Filters |
| `THEME-` | The design-token scope itself: palette, type, density, radii |

## Ledger

_Rows are appended as each reference doc in this directory is written._

| ID | Nuance | Todoist evidence | meologue evidence | Status | Note |
|---|---|---|---|---|---|
| QA-01 | A recognised match is an `inline-block` span with 4px horizontal padding — it occupies width, so following glyphs shift | quick-add.md § the one fact | — | `todoist-captured` | Decides #225's architecture: needs contenteditable |
| QA-02 | The recognised span carries `data-testid="natural-language-match"` and `data-match-id` holding the **resolved** value | quick-add.md § the span | — | `todoist-captured` | |
| QA-03 | Recognised state is marked by `data-highlighted-match="true"` | quick-add.md § the span | — | `todoist-captured` | |
| QA-04 | First Backspace after a match withdraws recognition and **deletes no character** | quick-add.md § recognition and withdrawal | — | `todoist-captured` | The user's opening complaint |
| QA-05 | Second Backspace deletes a character and removes the span | quick-add.md § recognition and withdrawal | — | `todoist-captured` | |
| QA-06 | Withdrawn span persists as the **same element**, restyled to `inline` with no padding | quick-add.md § the span | — | `todoist-captured` | One span, two states, delete on edit |
| QA-07 | Withdrawal is per-occurrence and one edit deep — editing back to the same text re-recognises | quick-add.md § withdrawal is not sticky | — | `todoist-captured` | Opposite of our signature model |
| QA-08 | Moving the caret into a recognised span does not withdraw it | quick-add.md § other ways to reject | — | `todoist-captured` | |
| QA-09 | Date vocabulary: today/tod/tomorrow/tmr/weekday/next week/in N days/25 dec/12/25 | quick-add.md § vocabulary | — | `todoist-captured` | |
| QA-10 | Time vocabulary: `at 5pm`, `5pm`, `17:00` | quick-add.md § vocabulary | — | `todoist-captured` | |
| QA-11 | Recurrence vocabulary, with `daily` normalised to "every day" | quick-add.md § vocabulary | — | `todoist-captured` | |
| QA-12 | `p1`–`p4` recognised as priority, showing no date control | quick-add.md § vocabulary | — | `todoist-captured` | |
| QA-13 | `#` project popup, filtering, with "Project not found. Create X" fallback | quick-add.md § autocomplete | — | `todoist-captured` | |
| QA-14 | `@` label popup with "Label not found. Create X" fallback | quick-add.md § autocomplete | — | `todoist-captured` | Our build uses `%`; #226 reverses that |
| QA-15 | Footer controls mirror the parse and gain Remove buttons once set | quick-add.md § composer chrome | — | `todoist-captured` | |
| QA-16 | Composer is 580×97px at rest, radius 12px, padding 16px | quick-add.md § composer chrome | — | `todoist-captured` | Dark theme values |
| QA-17 | The title field is the only contenteditable — no description input by default | quick-add.md § composer chrome | — | `todoist-captured` | |
| QA-18 | `Tab` from the title moves to More actions | quick-add.md § composer chrome | — | `todoist-captured` | |
| QA-19 | `Shift+Enter` **submits** rather than inserting a newline | quick-add.md § Shift+Enter | — | `todoist-captured` | User had independently flagged this |
| QA-20 | Composer title renders at 16px/23px against 13px chrome | quick-add.md § fonts | — | `todoist-captured` | |
| QA-21 | Arrow-key navigation inside autocomplete popups | quick-add.md § autocomplete | — | `blocked` | Capture inconclusive; not evidence of absence |
| QA-22 | Deadline syntax in the composer | — | — | `blocked` | Never reached |
| QA-23 | Plain `Enter` isolated from `Shift+Enter` | — | — | `blocked` | Stopped after the account mutation |
| QA-24 | Growth behaviour with a 300+ character title | — | — | `blocked` | Never reached |
| DATE-01 | Overdue renders a relative word ("Yesterday") in `rgb(255,112,102)` with a calendar icon | scheduler-and-priority.md §9 | — | `todoist-captured` | Re-verified independently |
| DATE-02 | Completion **overrides** the date tone — a completed overdue row mutes to `rgb(204,204,204)` | scheduler-and-priority.md §9 | — | `todoist-captured` | Re-verified |
| DATE-03 | Within the next 7 days renders the **weekday name only**, in `rgb(169,112,255)` | scheduler-and-priority.md §9 | — | `todoist-captured` | Re-verified; tracks the date, not recurrence |
| DATE-04 | A recurring task appends ↻ after the date, same colour | scheduler-and-priority.md §7 | — | `todoist-captured` | |
| DATE-05 | Upcoming day headings read `10 Sep ‧ Today ‧ Thursday`, separator U+2027; only today/tomorrow get a relative word | scheduler-and-priority.md §9 | — | `todoist-captured` | |
| DATE-06 | Row wording for a task due exactly today / tomorrow | — | — | `blocked` | No such task exists in the account |
| DATE-07 | Row rendering of a date carrying a time | — | — | `blocked` | No such task exists |
| DATE-08 | Row rendering of a Deadline | — | — | `blocked` | **Deadline is Pro-only**; account is Free |
| SCHED-01 | Anchored popover, 250×525px, radius 10px, background `rgb(38,38,38)`, border `1px solid rgb(61,61,61)` | scheduler-and-priority.md §1 | — | `todoist-captured` | Dark theme; light untested |
| SCHED-02 | Quick options in order: Today `Thu` · Tomorrow `Fri` · This weekend `Sat` · Next week `Mon 14 Sep` | scheduler-and-priority.md §2 | — | `todoist-captured` | Next week shows a full date, others a weekday |
| SCHED-03 | "No Date" appears **only once a date is already set** | scheduler-and-priority.md §2 | — | `todoist-captured` | |
| SCHED-04 | A "Type a date" input accepts dates and recurrence phrases and previews the resolution above the quick options | scheduler-and-priority.md §3 | — | `todoist-captured` | Preview shows the resolved date and task count |
| SCHED-05 | Picking a date **writes the phrase back into the title** as a highlighted recognition token | scheduler-and-priority.md §3 | — | `todoist-captured` | Picker and typed parsing share one mechanism |
| SCHED-06 | Calendar week starts **Monday** | scheduler-and-priority.md §4 | — | `todoist-captured` | |
| SCHED-07 | Today carries **no `aria-current`** and no ring — only bold and `rgb(226,106,96)` | scheduler-and-priority.md §4 | — | `todoist-captured` | Deliberate; do not "fix" |
| SCHED-08 | Selected day is a filled circle, `rgb(222,76,74)`, 24px, radius 12px | scheduler-and-priority.md §4 | — | `todoist-captured` | |
| SCHED-09 | Days carrying tasks get a 3×3px dot via `::before`, no extra DOM node | scheduler-and-priority.md §4 | — | `todoist-captured` | |
| SCHED-10 | Weekends dim to `rgb(204,204,204)`, independent of today/busy | scheduler-and-priority.md §4 | — | `todoist-captured` | |
| SCHED-11 | Time opens a second dialog with start time, duration and timezone, defaulting to "Floating time" | scheduler-and-priority.md §5 | — | `todoist-captured` | Matches our floating-time glossary rule |
| SCHED-12 | Duration is Pro-gated | scheduler-and-priority.md §5 | — | `divergent` | We removed Duration deliberately (issue #179) |
| SCHED-13 | The Deadline picker's own UI | — | — | `blocked` | **Pro-only paywall** |
| SCHED-14 | The dedicated Repeat dialog's contents | — | — | `blocked` | Not opened this run |
| PRI-01 | Picker swatches: P1 `rgb(209,69,59)`, P2 `rgb(235,137,9)`, P3 `rgb(36,111,224)`, P4 `rgb(102,102,102)` | scheduler-and-priority.md §10a | — | `todoist-captured` | Four confirmed genuinely distinct |
| PRI-02 | Internal `data-value` is **inverted** from the label — P1 is 4 | scheduler-and-priority.md §10a | — | `todoist-captured` | Our store already inverts identically |
| PRI-03 | P4 is pre-selected and is the invisible default — a transparent ring, not a grey one | scheduler-and-priority.md §10d | — | `todoist-captured` | |
| PRI-04 | The composer pill colours only the **flag icon**; its `P1` text stays neutral grey | scheduler-and-priority.md §10b | — | `todoist-captured` | |
| PRI-05 | The row checkbox ring red `rgb(255,112,102)` is **not** the picker red `rgb(209,69,59)` | scheduler-and-priority.md §10c | — | `todoist-captured` | Two surfaces, two values — don't unify into one token |
| PRI-06 | Row rendering for P2 and P3 | scheduler-and-priority.md §10c | — | `blocked` | No P2/P3 task exists in the account |
| ROW-01 | Row height 59px, zero padding on the row itself | row-and-detail.md §1 | — | `todoist-captured` | |
| ROW-02 | Divider is `border-bottom: 1px solid rgb(61,61,61)` with **0px left inset** — full list width | row-and-detail.md §1 | — | `todoist-captured` | |
| ROW-03 | Checkbox: 24×24 hit box around an 18×18 visible ring, `1px solid rgb(169,169,169)`, tinted by priority | row-and-detail.md §1 | — | `todoist-captured` | |
| ROW-04 | Hover reveals drag handle, then Edit · Date · Comment · More, each `opacity` 0→1; the row background does **not** change | row-and-detail.md §1 | — | `todoist-captured` | Our build changes background and hides these on coarse pointers |
| ROW-05 | Long titles **wrap** to 4 lines via `-webkit-line-clamp: 4`, they do not truncate to one | row-and-detail.md §1 | — | `todoist-captured` | The user complained specifically about long titles |
| ROW-06 | Markdown in a **title** stays literal | row-and-detail.md §1 | — | `todoist-captured` | |
| ROW-07 | A Description renders as **real HTML from markdown**, previewed as a first line beneath the title | row-and-detail.md §1 | — | `todoist-captured` | Our row shows no description indicator at all |
| ROW-08 | Comment count is an icon plus number, linking to `?intent=reply` | row-and-detail.md §1 | — | `todoist-captured` | |
| ROW-09 | Metadata blocks are adjacent flex children with a gap — no separator glyph between date and comments | row-and-detail.md §1 | — | `todoist-captured` | |
| DET-01 | Opening a task changes the URL to `/app/task/{slug}-{id}`; Escape returns | row-and-detail.md §2 | — | `todoist-captured` | Our detail is already a route |
| DET-02 | The detail title at rest is a **non-editable `div.task_content`** — the same display component the row uses, not the composer's editor | row-and-detail.md §2 | — | `todoist-captured` | Display and edit are split |
| DET-03 | The title carries the hint "Activate to edit the task name" | row-and-detail.md §2 | — | `todoist-captured` | |
| DET-04 | What the title becomes **once activated** for editing | — | — | `blocked` | Would have meant typing into a real task; the open question for #225 |
| DET-05 | The detail dialog is `data-testid="task-details-modal"` | keyboard.md §1 | — | `todoist-captured` | |
| KBD-01 | The overlay lists **80 shortcuts across 8 sections**: General 13, Quick Add 11, Navigate 15, Edit task 17, Add task 5, Sub-task 3, Projects 11, Calendar/Upcoming 5 | keyboard.md §1 | — | `todoist-captured` | Transcribed, not driven |
| KBD-02 | `?` opens the shortcuts overlay | keyboard.md §1 | — | `todoist-captured` | Verified by driving |
| KBD-03 | **Both** arrow keys and `j`/`k` move focus between rows | keyboard.md §2 | — | `todoist-captured` | Verified via `document.activeElement` |
| KBD-04 | Focus **wraps** at both ends, and the cycle includes the "Add task" button and completed rows | keyboard.md §2 | — | `todoist-captured` | Verified |
| KBD-05 | The focus ring is an **inset box-shadow** `rgb(23,91,194) 0 0 0 1px` plus a `rgba(255,255,255,0.14)` background tint — the CSS `outline` property is unset | keyboard.md §2 | — | `todoist-captured` | Verified |
| KBD-06 | The full 80-key map, key by key | keyboard.md §1 | — | `todoist-captured` | **Transcribed from the overlay; each key still needs driving before it can read `matched`** |
| DET-06 | Activating the title swaps in `tiptap ProseMirror` editors labelled "Task name" and "Description" — **the same component as the composer** | lifecycle.md, quick-add.md | — | `todoist-captured` | Resolves DET-04; the user's central claim, confirmed |
| DET-07 | Recognition fires in the **detail** title exactly as in the composer — same span, padding and match id | lifecycle.md | — | `todoist-captured` | Our detail title does no parsing at all |
| DET-08 | While editing, the properties panel's Date control does **not** reflect an in-title recognition until save — unlike the composer's footer, which fills live | lifecycle.md | — | `todoist-captured` | Two surfaces, two behaviours |
| DET-09 | Editing is **task-wide**: clicking the description puts title and description into edit together, sharing one Cancel/Save | lifecycle.md §1 | — | `todoist-captured` | |
| DET-10 | Clicking a generic part of the edit form focuses the **title**, not the description | lifecycle.md §1 | — | `todoist-captured` | A destructive trap worth reproducing carefully |
| DET-11 | The Description placeholder reads exactly "Description"; there is **no formatting toolbar** anywhere | lifecycle.md §1 | — | `todoist-captured` | |
| DET-12 | Description markdown renders **live as input rules** — bold, bullet list, inline code | lifecycle.md §1 | — | `todoist-captured` | |
| DET-13 | A bare URL in a description is **rewritten on save** to the fetched page title | lifecycle.md §1 | — | `todoist-captured` | Network-dependent; likely a deliberate divergence for us |
| CMT-01 | Comments submit on **Ctrl/Cmd+Enter or the "Comment" button** — Enter and Shift+Enter both insert a newline | lifecycle.md §2 | — | `todoist-captured` | Opposite of the task composer |
| CMT-02 | Comment markdown renders like the description's, but a bare URL keeps its text and gains an unfurl card | lifecycle.md §2 | — | `todoist-captured` | |
| CMT-03 | Comment edit, delete and their confirmation wording | lifecycle.md §2 | — | `todoist-captured` | |
| CMT-04 | Undo toast reads exactly **"1 task completed"** with an "Undo" button and a Close, in `role="alert" aria-live="polite"` | lifecycle.md §3 | — | `todoist-captured` | Appears ~150–300ms after completion |
| CMT-05 | The toast auto-dismisses after **6–8 seconds**, and Ctrl/Cmd+Z also undoes a completion | lifecycle.md §3 | — | `todoist-captured` | Measured |
| CMT-06 | Activity wording: `You added {task}`, `You completed {task}`, `You uncompleted {task}`, `You commented {content} on {task}`, `You added a description {content} to {task}`, `You changed the description of {task} to {content}`, `You removed the description {content} from {task}`, `You deleted a comment from {task}`, `You changed the name of {task}` | lifecycle.md §4 | — | `todoist-captured` | A rename shows only the new name, never old→new |
| CMT-07 | The activity list has **no filters** and ends with "That's it. No more history to load." | lifecycle.md §4 | — | `todoist-captured` | |
| CMT-08 | Italics, strikethrough, headings, numbered lists, blockquotes, fenced code blocks | — | — | `blocked` | Not exercised in the write session |
| THEME-01 | Todoist's light-theme palette, type and density | — | — | `blocked` | Todoist was only ever observed in dark theme (README's own "How it was captured"); `index.css`'s `[data-surface="todo"]` base block (issue #223) derives a legible light approximation, not a match — no light-mode row here can read `matched` until Todoist's own light theme is captured |
| THEME-02 | Dark palette: content pane `rgb(31,31,31)`, sidebar/body ground `rgb(38,38,38)` — the secondary surface reads **lighter** than the page | scheduler-and-priority.md, measured directly | measured in-app: sidebar `rgb(38,38,38)`, content `rgb(31,31,31)` | `matched` | Dark only. Initially failed: the sidebar painted nothing and inherited the content colour — caught by looking at a screenshot, not by any test |
| THEME-03 | Borders `rgb(61,61,61)`, muted text `rgb(204,204,204)`, focus ring `rgb(23,91,194)` | corpus | `index.css` | `built` | |
| THEME-04 | Type scale: row 14px/21px, chrome 13px, composer title 16px/23px | row-and-detail.md, quick-add.md | `index.css` `--td-*-font-size` | `built` | Three sizes this app never had to distinguish |
| THEME-05 | The system font stack, not Geist, inside Todo | quick-add.md § fonts | measured in-app: resolves to `-apple-system, "system-ui", …` | `matched` | Initially failed silently — `@theme inline` bakes `--font-sans`'s literal into the `font-sans` utility, so re-pointing the token was inert while every test stayed green. Fixed with a direct `font-family` on the scope |
| NAV-08 | The chrome/sidebar renders at 13px, smaller than the row text | row-and-detail.md, quick-add.md § fonts | measured in-app: 13px | `matched` | |
| NAV-09 | Content column: Todoist left-aligns a ~750px column beside the sidebar and puts the view name in it as a large heading; ours centres a narrower column under a separate "Todo" app bar | live app | screenshot `pairs/NAV-01-meologue.png` | `todoist-captured` | Visible gap, owned by the row/detail tickets rather than #223 |
| NAV-10 | Todoist's add-task affordance is a subtle "+ Add task" row at the **end of the list**, with the composer as an overlay; ours is a bordered input with an "Add" button at the **top** | quick-add.md § composer chrome | screenshot | `todoist-captured` | #226 owns it |
| NAV-01 | Sidebar order: Add task · Search · Inbox / Today / Upcoming / Filters & Labels with counts · Favourites · Projects tree | row-and-detail.md, live sidebar | `todo-sidebar.tsx` | `built` | |
| NAV-02 | The sidebar renders only inside `/todo/*`, at ≥900px, in the pane the shell already has | ADR 0070 | `chat-shell-layout.tsx` | `built` | No second pane, divider or width mechanism |
| NAV-03 | Below 900px there is no sidebar and the bottom bar remains | ADR 0070 | `chat-shell-layout.test.tsx` | `built` | Held by a test, not an assertion — this is what keeps Android intact |
| NAV-04 | Scoped `<nav aria-label="Todo">` with real hrefs and `aria-current` | `chat-list.tsx` precedent | `todo-sidebar.tsx` | `built` | |
| NAV-05 | Upcoming day headings read `10 Sep ‧ Today ‧ Thursday`; only today and tomorrow get a relative word | scheduler-and-priority.md §9 | `task-views.ts` `upcomingDayHeading()` | `built` | |
| NAV-06 | "Filters & Labels" is one destination covering both, with a combined count | live sidebar | `todo-sidebar.tsx` links to `/todo/filters` only | `divergent` | No Labels destination exists yet; #229 owns it. Count is Filters only |
| NAV-07 | "Add task" in the sidebar opens the composer from anywhere | live sidebar | links to `/todo/inbox` | `divergent` | No global composer exists yet; #226 owns it |
