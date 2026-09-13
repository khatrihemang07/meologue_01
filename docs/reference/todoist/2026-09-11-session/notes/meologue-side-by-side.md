# meologue vs Todoist — Todo UI side-by-side

Measured live in a real browser (ego-browser, Chromium) against meologue's dev
build at `http://127.0.0.1:5188/todo/*`, viewport 1470x836, dark theme
(`html.dark`, confirmed active). Data: three tasks created via quick-add
(`Room clean tod`, `hair wash tmr p1`, `naukri photo update tmr`), one
completed, a description added to `hair wash`, and two extra tasks with
long titles created solely to force title wrap. Todoist values are the ones
already recorded in the parity ledger (measured 2026-09-11, dark).

Screenshots: `meologue-inbox.png`, `meologue-inbox-wrapped.png`,
`meologue-today.png`, `meologue-task-detail-final2.png` (all in this
scratchpad directory).

| Field | Todoist | meologue | Verdict |
|---|---|---|---|
| body / sidebar background | `rgb(38,38,38)` | `rgb(38,38,38)` (the `<nav>` holding Inbox/Today/Upcoming) | **match** |
| content pane background | `rgb(31,31,31)` | `rgb(31,31,31)` (the `bg-background` pane right of the sidebar) | **match** |
| row height — plain | 59px | 59px (`[data-task-row-box]`, `min-height:59px`) | **match** |
| row height — with description | 79px | 59px — a one-line description doesn't grow the row; title(21px)+meta(≈16px)+description(≈16px)=53px still fits under the 59px floor because the row centers its content instead of adding a dedicated description line | **diverges** |
| row height — wrapped title | 100px | 66px for a 3-line wrapped title (line-clamp-4 lets it grow past the 59px floor, confirmed by screenshot showing genuine 3-line wrap) — mechanism exists but the resulting height is smaller | **diverges** |
| row title font-size / line-height | 14px / 21px | 14px / 21px | **match** |
| row title colour | `rgb(255,255,255)` | `rgb(255,255,255)` | **match** |
| row divider | `1px solid rgb(61,61,61)`, full-width, 0 left inset | `1px solid rgb(61,61,61)` on `[data-task-row-box]` (not the `<li>`, which has 0px — the wrapper trap), same x as the `<li>`, full row width, 0 left inset | **match** |
| date control font-size | 12px | 12px | **match** |
| date **Today** | `rgb(37,184,76)` green | `rgb(169,112,255)` purple | **diverges — confirmed prediction** |
| date **Tomorrow** | `rgb(255,154,20)` orange | `rgb(169,112,255)` purple (identical to Today's value) | **diverges — confirmed prediction** |
| date **completed row** | `rgb(204,204,204)` | absent — the collapsed Completed disclosure renders no date element at all for its rows | **gap** |
| completed title | `rgb(128,128,128)` + `line-through` | `rgb(204,204,204)`, `text-decoration: none` | **diverges** |
| checkbox ring **P1** | 18×18, 2px, `rgb(255,112,102)` | 18×18, **1px**, `rgb(255,112,102)` — size and colour match, width does not | **diverges — confirmed prediction (colour matched, width did not)** |
| checkbox ring **P4** | 18×18, 1px, `rgb(169,169,169)` | 18×18, 1px, `rgb(169,169,169)` | **match** |
| content column width / sidebar width | 800px / 280px | content column: `w-[97%] md:w-[85%]` of the content pane (measured 971px of a 1142px pane at this viewport); sidebar: not fixed — it's the resizable "conversation list" column (`clamp(260px,var(--list-w),…)`), measured 306px by default | **diverges — confirmed prediction (content column is percentage-based)**; sidebar also diverges (resizable panel reused from a chat/journal layout, not a fixed 280px rail) |
| view heading | `<h1>` 26px / weight 700 / 35px line-height, left-aligned in the column | no `<h1>` anywhere in the DOM (`document.querySelectorAll('h1').length === 0`). The app-bar shows a `<span>` "Todo" at 16px/500/24px line-height; per-view context comes only from sidebar active-state and, on Today, a small `<h2>` "Due today (N)" group label at 14px/500/20px line-height | **diverges — confirmed prediction (separate app bar, not an in-column h1)** |
| add-task affordance position | below the last row | **above** the list, directly under the app bar | **diverges — confirmed prediction** |
| completed tasks | interleaved inline in the main list | segregated into a collapsed `<details>` "Completed (N)" disclosure below the active rows; completing a task visibly removes it from the live list and files it there | **diverges — confirmed prediction** |
| Today view: date control for due-today rows | absent from the DOM | present — the "Today" badge (`rgb(169,112,255)`) still renders on each row inside the Today view itself, redundant with the view's own "Due today (1)" heading | **diverges — confirmed prediction (redundant "Today" badge)** |

## Predicted divergences: confirmed / refuted

All six were **confirmed**, one with a nuance:

1. Today/Tomorrow render as one purple `rgb(169,112,255)` "upcoming" tone — **confirmed**, exact match to the predicted value, for both dates.
2. Checkbox ring is 1px for every priority — **confirmed**, but only for the width. The colour is NOT flattened: P1 still renders its own red (`rgb(255,112,102)`) and P4 its own grey (`rgb(169,169,169)`) — matching `task-priority-colors.ts`'s two-function design (only the box-shadow width in `task-row-content.tsx` line 348 is the hardcoded `1px`, the colour argument is still per-priority).
3. Today's view shows a redundant "Today" badge — **confirmed**, visually and in the DOM (screenshot `meologue-today.png`).
4. Completed tasks are segregated into a collapsed "Completed" disclosure — **confirmed**, a `<details>` element, collapsed by default, appearing only after the first completion.
5. The add-task field renders above the list — **confirmed** (screenshot `meologue-inbox.png`).
6. The content column is a percentage of the pane (97%/85%), not fixed 800px, and the view name lives in a separate app bar rather than an in-column `<h1>` — **confirmed**, both halves: `w-[97%] md:w-[85%]` measured directly in `task-row-content.tsx`'s sibling layout, and zero `<h1>` elements exist anywhere in the Todo UI's DOM.

## Additional findings not predicted

- The sidebar itself is not a fixed 280px rail as in Todoist — it's the app's resizable "conversation list" pane (`w-[clamp(260px,var(--list-w),…)]`, default measured 306px), repurposed from a chat/journal layout. This is a structural divergence beyond what was asked to confirm.
- Completed rows drop the date entirely (gap, not just a colour mismatch) and use `rgb(204,204,204)` with no `line-through` for the title, rather than Todoist's dimmer `rgb(128,128,128)` + strikethrough.
- A row with a one-line description does not grow past the 59px floor in meologue because content is vertically centered rather than Todoist's fixed extra line; only a genuinely wrapping title (3+ lines) pushes the row taller, and even then the resulting height (66px for 3 lines) undershoots Todoist's 100px.

## What could not be measured

- P2/P3 checkbox-ring colours were not exercised (no P2/P3 task was created — out of scope for this pass, and the source comment for `task-priority-colors.ts` notes Todoist's own P2/P3 row colours were never captured either, so there is nothing to compare against).
- Nothing else was blocked. The single-window lock trap did trigger once, transiently, right after a full-page `goto()` to `/todo/today` (probably a race in reclaiming the OPFS lock across the reload); a second reload cleared it immediately and no data was lost. Confirmed via `document.body.innerText` checks before treating any subsequent snapshot as trustworthy, per the mission's trap #1.

## Housekeeping

- Dev server (`pnpm dev --host 127.0.0.1 --port 5188 --strictPort`) was killed; port 5188 confirmed free.
- ego-browser task space (id 32) was finished with `keep: []`; no Pages retained.
