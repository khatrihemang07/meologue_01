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
