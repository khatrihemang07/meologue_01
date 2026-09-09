# Todoist scheduler, date rendering and priority — observed reference

Every row marked **VERIFIED** was produced by driving the shipped web application and reading back
ground truth, not by reasoning about it:

- **Todoist web**, `app.todoist.com`, dark theme, **Free plan**, captured 2026-09-10 with "today" =
  10 Sep 2026 (Thursday). Driven through ego-browser, with `getComputedStyle()` for every styling
  figure — never inferred from class names, which are content-hashed here.
- Every picker was opened from the **composer's unsaved draft**, never from a real task, and the
  draft was cancelled and discarded at the end. Nothing was submitted, completed, rescheduled or
  deleted; a before/after canary over the Inbox showed no change.
- Account at capture time: Inbox holding 6 active tasks and 1 completed, plus one "Getting Started"
  project of tutorial content carrying no dates and no priorities.

**INFERRED / GAP** marks anything not present in this account or not exercised. Those are stated
rather than filled in with something plausible — several date states simply do not exist in this
data, and two whole features are behind a paywall.

**Two limits worth knowing before reading:**

1. **Deadline and Duration are Pro-only.** On this Free account both open an upgrade paywall
   instead of a picker, so neither could be captured. meologue *has* a Deadline, so that surface
   has no reference to match against.
2. **P2 and P3 exist nowhere in this account's data**, so their row rendering is inferred from the
   picker's swatches rather than observed.

**Independently re-verified** after capture: the overdue colour `rgb(255,112,102)`, the upcoming
purple `rgb(169,112,255)`, and the completed-row muting to `rgb(204,204,204)`. The purple was
re-checked specifically to rule out its being a *recurrence* colour rather than an *upcoming* one —
two non-recurring tasks render it, so it tracks the date, not the repeat.

---

## 1. Scheduler popover — geometry

| Property | Value | Status |
|---|---|---|
| Container type | Anchored popover (positioned `absolute` under the "Date" button), **not** a centered dialog | VERIFIED |
| Positioning wrapper | `div.scheduler_popper.popper` — itself has no border/shadow/background, pure positioner | VERIFIED |
| Visual card | `div.scheduler[data-testid="scheduler-view"]` | VERIFIED |
| Width | `250px` | VERIFIED |
| Height | `525px` (calendar-only state; grows if content grows) | VERIFIED |
| Border radius | `10px` | VERIFIED |
| Box shadow | `rgba(0,0,0,.19) 0 10px 20px 0, rgba(0,0,0,.23) 0 6px 6px 0` | VERIFIED |
| Background | `rgb(38,38,38)` | VERIFIED |
| Border | `1px solid rgb(61,61,61)` | VERIFIED |
| z-index | `1000` | VERIFIED |

Full outerHTML saved at `scheduler-dom/scheduler-card.html`; screenshot at `scheduler-shots/scheduler-open.png`.

Light theme was not tested (this account renders dark) — **GAP**.

---

## 2. Quick options

Exact wording/order/icons, read from `scheduler-suggestions-item` buttons (`scheduler-dom/quick-options-ancestors.json`):

| Order | Label (exact) | `data-track` | Icon | Right-hand hint |
|---|---|---|---|---|
| 1 | Today | `scheduler\|date_shortcut_today` | calendar icon with the day number (10) rendered inside it | `Thu` |
| 2 | Tomorrow | `scheduler\|date_shortcut_tomorrow` | sun/sparkle icon | `Fri` |
| 3 | This weekend | `scheduler\|date_shortcut_thisweekend` | couch icon | `Sat` |
| 4 | Next week | `scheduler\|date_shortcut_nextweek` | calendar-with-arrow icon | `Mon 14 Sep` (full date, not just weekday) |
| 5 | No Date | `scheduler\|date_shortcut_nodate` | circle with diagonal slash | *(none)* |

All VERIFIED. "No Date" (capital D) **only appears once a date is already set** on the draft — confirmed by its absence before selecting a day and its appearance immediately after (screenshots `scheduler-open.png` vs `after-select-21.png`).

---

## 3. Type-to-schedule input

| Aspect | Value | Status |
|---|---|---|
| Placeholder / aria-label | `Type a date` | VERIFIED |
| `maxlength` | 150 | VERIFIED |
| Accepts | Natural language dates ("21 Sep") and recurrence phrases ("every monday") in the same box | VERIFIED |
| Resolved-date preview | A `button.scheduler-preview-content[data-testid="scheduler-date-preview"]` appears above the quick options once text resolves. For "every monday" it rendered: recurring icon + `Mon 14 Sep` + ` → Forever` + secondary line `No tasks` (task count on the resolved date) | VERIFIED |
| Clicking the preview | Commits the value and closes the scheduler | VERIFIED |
| Side effect | Selecting a date (via calendar click **or** the input) also inserts the matched phrase into the composer's title as a highlighted inline token: `<span data-testid="natural-language-match" data-match-id="21 Sep">21 Sep</span>` — i.e. the picker and Todoist's "type a date into the title" quick-add parser share the same highlighting mechanism | VERIFIED (unexpected but genuine finding) |
| Clear button | Once text is present, an `aria-label="Clear"` (X) button appears inside the input | VERIFIED |

---

## 4. Calendar grid

| Behaviour | Finding | Status |
|---|---|---|
| Week start | **Monday** (`M T W T F S S` header) | VERIFIED |
| Months per render | One month body per "Mon YYYY" heading; scrolling within the popover begins rendering the next month (`Oct`) — continuous/virtualized scroll, not a fixed 2-month block | VERIFIED |
| Day `aria-label` | ISO date, e.g. `2026-09-10` | VERIFIED |
| **Today marker** | **No `aria-current` and no ring/background of any kind.** Today's number (`10`) is marked *only* by `color: rgb(226,106,96)` + `font-weight: 700` vs default `rgb(255,255,255)` / `400`. Confirmed by reading `aria-current`/`aria-selected` on every day button in the visible grid — all `null` except the selected day's `aria-selected`. **This explicitly confirms prior work: there is no `aria-current`-style marker for today.** | VERIFIED |
| Selected-day marker | Class `calendar__day--selected`; the inner `.calendar__day__date` span gets a filled circular badge: `background: rgb(222,76,74)`, `border-radius: 12px`, `width: 24px`; number text `rgb(255,255,255)` / `font-weight: 700` | VERIFIED |
| Weekend dimming | Sat/Sun get class `calendar__day--greyed`, number color `rgb(204,204,204)` vs weekday `rgb(255,255,255)` — unrelated to "today" or "busy" | VERIFIED |
| Days with existing tasks ("busy") | Class `calendar__day--busy`. Rendered via a `::before` pseudo-element only (no extra DOM node): `content:""`, `3px × 3px`, `border-radius: 1.5px` (circular dot), `background: rgb(209,209,209)`, `position:absolute; bottom:2px`. Only Sep 12 (the day carrying 5 existing tasks) had this class in range | VERIFIED |
| Month navigation | `‹` / `›` arrows either side of the "Sep 2026" heading, plus a small circular "jump to today" icon between them | VERIFIED (present; click behaviour not exercised — **GAP**) |
| Range limit | Not probed (would require scrolling/navigating far past current data) | **GAP** |

Raw per-day JSON: `scheduler-dom/calendar-days.json`; pseudo-element probe: `scheduler-dom/` (see script output above, not separately filed — reproduce via `getComputedStyle(el, '::before')`).

---

## 5. Time

| Aspect | Value | Status |
|---|---|---|
| Entry point | "Time" button at the bottom of the scheduler card, **below** the calendar | VERIFIED |
| Picker shape | A second anchored popover/dialog, `role="dialog" aria-label="Select start and end time"`, `304–306px × 214–216px`, `border-radius:10px`, `box-shadow: 0 2px 8px rgba(0,0,0,.16)`, `background: rgb(40,40,40)` — stacks below/beside the scheduler card rather than replacing it | VERIFIED |
| Start time field | Free-text combobox, `aria-label="Start time"`, defaulted to the next quarter-hour (observed `12:45 AM`) | VERIFIED |
| Duration | Read-only field showing placeholder `No duration`, gated by an `aria-label="Upgrade"` icon (`data-icon-name="upgrade-icon"`, `fill:#FFBA0A`) — **Pro-only, not usable on this Free account** | VERIFIED |
| Time zone | Dropdown, default `Floating time` | VERIFIED |
| Footer | `Cancel` / `Save` buttons | VERIFIED |
| "No time" wording | Not directly observed as a row label (no task in this account carries a time) — inferred to be the simple absence of a time suffix after the date text, since Time is a wholly separate control from Date | **INFERRED / GAP** |

Screenshot: `scheduler-shots/time-picker.png`; DOM: `scheduler-dom/time-panel.json`.

---

## 6. Deadline

| Aspect | Value | Status |
|---|---|---|
| Location from composer | Not on the main toolbar — reached via composer's **"More actions"** menu → **Deadline** row (icon: gold sparkle, keyboard-shortcut hint `{`) | VERIFIED |
| Behaviour on this account | Clicking it opens a **full-page Pro-upgrade paywall modal** ("Try Pro for free…"), not a deadline date-picker. Deadline is entirely gated behind the paid plan; no deadline UI could be captured | VERIFIED |
| Existing-task detail view | Sidebar also shows a "Deadline" field/button, separate from "Date", carrying the same gold `upgrade-icon` — confirms it is a distinct field from Date, gated identically, everywhere it appears | VERIFIED |
| Deadline picker internals (calendar shape, wording, etc.) | Not observable on a Free account | **GAP** |

Screenshot: `scheduler-shots/deadline-picker.png`, `scheduler-shots/more-actions-menu.png`.

---

## 7. Recurrence

| Aspect | Value | Status |
|---|---|---|
| Entry via typing | Typing a recurrence phrase ("every monday") directly into the "Type a date" input is recognized live; the "Repeat" button disappears from the panel and is replaced by the resolved preview (icon + `Mon 14 Sep → Forever` + `No tasks`) | VERIFIED |
| Entry via dedicated button | A `Repeat` button sits at the bottom of the scheduler when no recurrence phrase is active. Its own dialog contents were **not opened/inspected** this run | **GAP** |
| Display once set (composer) | Date pill becomes the weekday/date text (e.g. `Monday`) plus a small circular-arrow (↻) icon appended, in the same purple family as the "next 7 days" date colour | VERIFIED |
| Display on existing rows | Task "hair wash" (real recurring task) shows `Saturday ↻` — weekday text followed by the same ↻ glyph, purple `rgb(169,112,255)` | VERIFIED |

---

## 8. Clearing a date

| Action | Wording | Status |
|---|---|---|
| From the scheduler | Quick option **"No Date"** (only shown once a date exists) | VERIFIED |
| From the composer pill directly | A small **"Remove date"** (×) button appended to the date pill once a date is set | VERIFIED |

---

## 9. Date rendering — existing rows (read-only, no clicks)

| State | Exact wording | Computed colour (rgb) | Icon | Notes |
|---|---|---|---|---|
| Overdue (active task) | `Yesterday` | `rgb(255,112,102)` | small filled-calendar icon, same colour | Row and task-detail page render identically (checked) |
| Overdue, but task is completed | `1 Sep` | `rgb(204,204,204)` (muted grey) | same calendar icon, muted | Completed state overrides the overdue-red with a neutral grey even though the `date_overdue` class is still applied |
| Within next 7 days (not today/tomorrow) | Weekday name only, e.g. `Saturday` | `rgb(169,112,255)` (purple) | calendar icon; a second ↻ icon is appended when the task recurs | 5 of 6 active Inbox tasks are in this state (all due "Saturday" = Sep 12) |
| "Today" nav item content | Only the overdue task appears (its own wording stays `Yesterday`) — **no task in this account is due exactly today**, so a fresh "Today" label could not be observed | — | — | **GAP** — stated, not invented |
| Tomorrow | Not present in this account | — | — | **GAP** |
| Further out / next year | Not present in this account (furthest visible due date is "Saturday", i.e. Sep 12) | — | — | **GAP** |
| With a time | No task in this account carries a time | — | — | **GAP** |
| With a deadline | Deadline is Pro-gated and unset on every task in this account | — | — | **GAP** |

Upcoming view's day-section headers (not per-row, but confirms the wording bank): `10 Sep ‧ Today ‧ Thursday`, `11 Sep ‧ Tomorrow ‧ Friday`, `12 Sep ‧ Saturday` — separator glyph is `‧` (U+2027 hyphenation point), and only Today/Tomorrow get a relative word; everything else is weekday-only, matching the row rendering. VERIFIED.

Raw data: `scheduler-dom/../inbox-dates.json` (relative path: `ev2/inbox-dates.json`).

---

## 10. Priority

### 10a. Picker (opened from composer → "Set priority")

`<li role="option" class="priority_picker_item">` × 4. Internal `data-value` is **inverted** from the displayed label:

| Displayed | Internal `data-value` | Icon colour (rgb) | Default? |
|---|---|---|---|
| Priority 1 | `4` | `rgb(209,69,59)` (red) | no |
| Priority 2 | `3` | `rgb(235,137,9)` (orange) | no |
| Priority 3 | `2` | `rgb(36,111,224)` (blue) | no |
| Priority 4 | `1` | `rgb(102,102,102)` (grey) | **yes** — `aria-selected="true" aria-checked="true"` pre-highlighted when nothing chosen |

All VERIFIED, all four confirmed genuinely distinct by reading `getComputedStyle` on all four `<li>` icons in one `page.evaluate()` call in the same picker instance (the earlier "four byte-identical captures" failure mode does **not** reproduce here — see raw values above, no two match). Full DOM: `scheduler-dom/priority-picker.json`.

### 10b. Display once chosen (composer)

Selecting "Priority 1" replaces the plain "Priority" button with a pill: a coloured flag icon (`rgb(209,69,59)`, matching the picker) + a neutral-grey text label `P1` (`rgb(204,204,204)` — the text itself is **not** coloured, only the flag icon is) + a "Remove priority" (×) button. VERIFIED (screenshot `composer-after-p1.png`).

### 10c. Display on existing rows

Read from the task checkbox (`.task_checkbox`), not the flag icon — rows use a filled-ring style rather than a flag:

| Row | Internal class | Displayed priority | Ring/fill colour | Checkmark colour |
|---|---|---|---|---|
| "hair wash" (real task, genuinely prioritized) | `priority_4` | **Priority 1** (per the inverted mapping above) | `rgb(255,112,102)` filled ring, 2px | `rgb(255,112,102)` |
| All other active Inbox tasks | `priority_1` | Priority 4 (default) | fully transparent ring/border | `rgb(169,169,169)` grey checkmark, invisible-ish |
| Completed task | `priority_1` | Priority 4 (default), but completed | `rgb(87,87,87)` grey fill | `rgb(38,38,38)` (same as page bg — checkmark not visually distinguishable once complete) |

VERIFIED for P1 and P4 (default) — both exist for real in this account (`hair wash` is genuinely P1). **P2 and P3 do not exist on any row in this account — their row-rendering colour is INFERRED only (not verified) from the picker's flag colours** (`rgb(235,137,9)` orange, `rgb(36,111,224)` blue) — stated as a gap.

### 10d. Is P4 the invisible default?

**Yes, confirmed.** An untouched composer shows a plain unlabeled "Priority" button (no pill, no colour) until something else is picked; the picker itself pre-checks "Priority 4"; and on real rows, "Priority 4" tasks render a fully transparent checkbox ring identical to "no priority set at all" — i.e. P4 is not merely low-visibility, it renders with **zero** colour, same as the checkbox's own neutral resting state. VERIFIED.

Note the checkbox-ring red (`rgb(255,112,102)`) and the picker/pill flag red (`rgb(209,69,59)`) are **not byte-identical** — same red family, two different exact values depending on which control renders it. Flagged explicitly so a replicator doesn't assume one colour token covers both surfaces.

---

## Files

- `scheduler-and-priority.md` (this file)
- `scheduler-dom/scheduler-card.html` — full scheduler popover outerHTML
- `scheduler-dom/full-snapshot.txt` — accessibility snapshot at open
- `scheduler-dom/quick-options.json`, `quick-options-ancestors.json` — quick-option rows
- `scheduler-dom/calendar-grid.json`, `calendar-days.json` — calendar cell data
- `scheduler-dom/selected-and-nodate.json` — selected-day styling + "No Date" option
- `scheduler-dom/time-panel.json` — Time/Duration/Timezone sub-dialog
- `scheduler-dom/priority-picker.json` — 4 priority options, colours, data-values
- `scheduler-shots/scheduler-open.png`, `after-select-21.png`, `type-every-monday.png`, `after-apply-recurrence.png`, `time-picker.png`, `priority-picker.png`, `composer-after-p1.png`, `more-actions-menu.png`, `deadline-picker.png`
- Canary: `../canary-before.json`, `../canary-after.json` (identical apart from two debug fields I stopped emitting; no task titles/ids/order/completion changed)
