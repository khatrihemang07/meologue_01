# Todoist evidence capture — pass 2 findings

Captured against the real Todoist account (app.todoist.com), task space 30,
page `p1`. All Quick Add work happened in an unsaved draft, discarded with
Escape; no task was ever submitted (confirmed by list diff before/after).
No project was created. Theme was the only setting changed, and it is
restored to Dark and verified at the end of this document.

Legend: **verified** = measured directly with `getComputedStyle()` on the
leaf node that actually paints the colour. **gap** = not reachable / not
captured, with the reason stated.

---

## Task A — Quick Add + Scheduler, DARK theme

### 1. Quick Add dialog

| Field | Value | Status |
|---|---|---|
| Size (empty draft) | 580×66 | verified |
| Size (with toolbar, date recognized) | 580×97 | verified |
| Border radius | 12px | verified |
| Padding | 16px | verified |
| Background | `rgb(40, 40, 40)` | verified |
| Border | `1px solid rgb(61, 61, 61)` | verified |
| Box-shadow | `rgba(0, 0, 0, 0.2) 0px 4px 8px 0px` | verified |
| Footer buttons, empty draft (in order) | More actions, Select project ("Inbox"), Set date, Remove date, Set priority, Add labels, Cancel, Add task | verified |
| Footer buttons, after date recognized (in order) | More actions, Remove date, Cancel, Add task | verified |

Note: the empty-draft dialog also shows two dropzone affordances ("Attach to
task", "Scan for tasks") below the input — these are always present, not
Quick-Add-toolbar items.

### 2. Recognition span (typed "tod")

| Field | Value | Status |
|---|---|---|
| `data-testid` | `natural-language-match` | verified |
| Text | `tod` | verified |
| `data-match-id` | `11 Sep` (i.e. resolves to "Today", 11 Sep 2026) | verified |
| `data-highlighted-match` | `true` | verified |
| display | `inline-block` | verified |
| padding-left / right | `4px` / `4px` | verified |
| background | `rgb(111, 38, 37)` | verified |
| color | `rgb(255, 255, 255)` | verified |
| border-radius | `3px` | verified |
| font-size | `16px` | verified |
| line-height | `23px` | verified |
| rendered width | `32.31px` | verified |

**Backspace behaviour** (ledger claim: first Backspace withdraws recognition
and deletes no character):

| Step | Text | Match present | Highlight | Status |
|---|---|---|---|---|
| Before backspace | `tod` | yes | `true` | verified |
| After 1st Backspace | `tod` (unchanged) | yes (span still in DOM) | `null` (dropped) | **verified — corpus claim confirmed** |
| After 2nd Backspace | `to` (character deleted) | no | — | verified |

### 3. Scheduler popover

Opened from the draft's "Set date" footer control.

| Field | Value | Status |
|---|---|---|
| `data-testid` | `scheduler-view` | verified |
| Size | 250×525 | verified |
| Border radius | 10px | verified |
| Background | `rgb(38, 38, 38)` | verified |
| Border | `1px solid rgb(61, 61, 61)` | verified |
| Box-shadow | `rgba(0,0,0,0.19) 0px 10px 20px 0px, rgba(0,0,0,0.23) 0px 6px 6px 0px` | verified |
| z-index | 1 | verified |
| position | relative | verified |

Quick-option rows, in order, with right-hand hints:

1. Today — Fri
2. Tomorrow — Sat
3. Next week — Mon 14 Sep
4. Next weekend — Sat 19 Sep

Below the quick rows is a full scrolling month calendar (Sep 2026 → onward),
then at the very bottom: a **Time** button and a **Repeat** button
(`data-testid="recurrence-menu-button"`) — both **present**, confirmed.

### 4. Repeat dialog (ledger SCHED-14 — previously never captured)

Opens as a `role="menu"` (not `role="dialog"`) anchored under the Repeat
button — no selection was made; closed with Escape.

| Field | Value | Status |
|---|---|---|
| Size | 282×206 | verified |
| Border radius | 10px | verified |
| Background | `rgb(40, 40, 40)` | verified |
| Border | `1px solid rgb(61, 61, 61)` | verified |
| Box-shadow | `rgba(0, 0, 0, 0.12) 0px 0px 8px 0px` | verified |
| z-index | 1000 | verified |

Items, in order:
1. Every day
2. Every week on Friday
3. Every weekday (Mon - Fri)
4. Every month on the 11th
5. Every year on September 11th
6. Custom…

One Escape closed both the Repeat menu and the scheduler popover underneath
it (Quick Add draft stayed open) — worth noting for anyone scripting this
flow.

### 5. Time dialog (ledger SCHED-11 — previously never captured)

Opens as `role="dialog" aria-label="Select start and end time"` — no
selection made; closed with Escape.

| Field | Value | Status |
|---|---|---|
| Size | 306×216 | verified |
| Border radius | 10px | verified |
| Background | `rgb(40, 40, 40)` | verified |
| Border | `1px solid rgb(61, 61, 61)` | verified |
| Box-shadow | `rgba(0, 0, 0, 0.16) 0px 2px 8px 0px` | verified |
| z-index | 1 | verified |
| Contents | "Start time" combobox (defaulted to current time, e.g. 2:15 PM), "Duration" ("No duration", with an "Upgrade" badge — **duration is a Pro-gated field**), "Time zone" ("Floating time"), Save/Cancel buttons | verified |

Same one-Escape-closes-both-layers behaviour observed here too.

### 6. Draft discard

Escape pressed twice, then a full page reload confirmed the task list is
unchanged (still the original 13 rows — "Room clean" … "Lld"; no task
titled "tod"/"to"/"totod" exists). **No task was created.** — verified.

Screenshots: `td-quickadd-dark.png`, `td-scheduler-dark.png`,
`td-repeat-dark.png`, `td-time-dark.png`, `td-inbox-dark.png`,
`td-today-dark.png`.

---

## Task B — LIGHT theme

**Bottom line: a genuine light/white Todoist theme could not be reached in
this account, despite an exhaustive attempt. This is reported as a
well-evidenced gap, not guessed at.** Details below so this doesn't have to
be re-litigated blind next time.

### What was tried

1. Settings → Theme lists 8 named themes: **Todoist, Dark, Moonstone,
   Tangerine** (free) and **Kale, Blueberry, Lavender, Raspberry** (Pro,
   locked behind Upgrade — not touched).
2. Selected **"Todoist"** (the presumed default/light theme) via the radio
   button, clicked **Update** (Todoist's theme picker requires this to
   persist — a plain click on the swatch does *not* save it), and confirmed
   via a full server round-trip (hard reload) that the account's persisted
   theme really is now "Todoist" — `aria-checked="true"` survived reload.
   Rendered result: `bodyBg = rgb(40, 28, 17)`, `bodyColor = rgb(212, 208, 202)`
   — a dark warm brown/cream palette, **not light**.
3. Turned off **"Sync theme"** and **"Auto Dark Mode"** (both persisted via
   Update, confirmed via reload) to rule out the app silently following the
   OS's dark-mode preference. Still rendered dark.
4. Forced the browser's `prefers-color-scheme` media feature to `light` via
   CDP (`Emulation.setEmulatedMedia`), confirmed `matchMedia("(prefers-color-scheme: light)").matches === true` inside the page, then hard-reloaded.
   Still rendered dark — the app does not appear to key its persisted theme's
   colours off this media query at runtime.
5. Read the app's own theme-bootstrap code (`initTheme`, `changeThemeByThemeName`
   exposed on `window`) and confirmed it only ever toggles a `theme_<name>`
   class on `<html>` — no separate light/dark axis exists in that code path.
6. Swept **every theme index 0–13** via the app's own `?theme=N` query-param
   hook (read-only client-side class swap, nothing persisted) to check for a
   hidden light variant:

   | idx | theme class | body background | verdict |
   |---|---|---|---|
   | 0 | theme_todoist | `rgb(40, 28, 17)` | dark |
   | 1 | theme_todoist (fallback) | `rgb(40, 28, 17)` | dark |
   | 2 | theme_moonstone | `rgb(27, 29, 30)` | dark |
   | 3 | theme_tangerine | `rgb(42, 31, 16)` | dark |
   | 4 | theme_todoist (fallback) | `rgb(40, 28, 17)` | dark |
   | 5 | theme_kale | `rgb(30, 30, 13)` | dark |
   | 6 | theme_blueberry | `rgb(21, 31, 37)` | dark |
   | 7 | theme_todoist (fallback) | `rgb(40, 28, 17)` | dark |
   | 8 | theme_lavender | `rgb(27, 29, 30)` | dark |
   | 9 | theme_todoist (fallback) | `rgb(40, 28, 17)` | dark |
   | 10 | theme_gold *(undocumented — not in Settings UI)* | `rgb(30, 26, 13)` | dark |
   | 11 | theme_dark | `rgb(38, 38, 38)` | dark (this is the session's original theme) |
   | 12 | theme_raspberry | `rgb(37, 21, 21)` | dark |
   | 13 | theme_todoist (fallback) | `rgb(40, 28, 17)` | dark |

   **Every single resolvable theme (all 8 named ones, plus a hidden 9th,
   "Gold") renders a dark background.** None is white/light.

   One transient reading immediately after clicking Update (before any
   navigation) showed `bodyBg = rgb(252, 250, 248)` — near-white. It could
   not be reproduced across ~6 further attempts under what looked like
   identical conditions, and is most likely a one-frame flash of an unstyled
   base state during the settings-dialog teardown rather than the theme's
   real palette. It is **not** reported as verified light data.

### Consequence for the requested light-theme measurements

Because no light palette is reachable, the following are **gap** (not a
guess, not inferred, not backfilled from the dark data):

| Item | Status |
|---|---|
| Body/sidebar/content background, text colour, border colour (light) | gap — no light theme reachable |
| Task row: title colour, row background, divider colour, row height (light) | gap |
| Date colours — Today / Tomorrow / overdue / completed (light) | gap |
| Checkbox rings — P1 ("hair wash") and P4 (light) | gap |
| Quick Add dialog + recognition span + scheduler popover (light) | gap |

### Bonus data actually captured (NOT light — do not cite as light)

While chasing this down, the "Todoist" named theme (a *second, distinct dark
palette* — warm brown/cream, different from the grey/black "Dark" theme) was
fully measured with the same leaf-walk methodology as the dark corpus. It is
recorded here only as incidental reference data, clearly **not** an answer to
THEME-01:

| Task | Date text | Date leaf colour ("Todoist" theme) | Dark-theme equivalent |
|---|---|---|---|
| Room clean (Today) | Today | `rgb(113, 250, 149)` | `rgb(37, 184, 76)` |
| hair wash (Tomorrow) | Tomorrow | `rgb(255, 180, 83)` | `rgb(255, 154, 20)` |
| add split… (overdue, 1 Sep) | 1 Sep | `rgb(168, 160, 149)` | `rgb(204, 204, 204)` |

| Checkbox | Ring size | Ring border | Ring colour ("Todoist" theme) | Dark-theme equivalent |
|---|---|---|---|---|
| hair wash (P1-visual, class `priority_4`) | 18×18 | 2px | bg `rgb(159, 45, 37)`, border `rgb(141, 40, 33)` (outer svg stroke `rgb(213,86,76)`) | bg `rgb(255, 112, 102)` |
| Room clean (P4-visual, class `priority_1`) | 18×18 | 1px | border `rgb(77, 83, 86)`, svg fill `rgb(168, 160, 149)` | svg fill `rgb(169, 169, 169)` |

Page-level, "Todoist" theme: `bodyBg = rgb(40, 28, 17)`, `mainBg = rgb(24, 26, 27)`,
row `rowBg = rgb(24, 26, 27)`, `rowBorderBottom = 1px solid rgb(53, 57, 59)`,
`rowHeight = 59px`. Confirms the class-name-vs-priority-colour inversion the
corpus already documented (`priority_4` class ⇒ visually red/P1;
`priority_1` class ⇒ visually grey/P4) holds in this theme too.

Screenshots: `td-inbox-light2.png`, `td-theme-moonstone.png`,
`td-theme-tangerine.png` (all confirm dark rendering despite the names).

---

## Theme restore (safety requirement)

Restored via Settings → Theme → **Dark** → Update, then verified with a full
clean page reload (no query params, no forced media):

```
htmlClass = "theme_dark todoist_loaded"
bodyBg    = rgb(38, 38, 38)
bodyColor = rgb(255, 255, 255)
```

`document.documentElement.className` contains `theme_dark` — **confirmed**.
`Sync theme` = true, `Auto Dark Mode` = false — both match the settings
observed before this investigation began, so no incidental preference change
was left behind. Task list still shows the original 13 tasks; no task was
created; no project was created.
