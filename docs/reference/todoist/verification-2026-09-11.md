# meologue measured in a real browser (2026-09-11)

The other half of `pass2-2026-09-11.md`. That file measured **Todoist**; this one measures
**meologue**, against those same numbers, so the ledger's own bar for `matched` — both applications
driven and measured — can actually be met rather than asserted.

Covers issues **#250, #251, #252, #254**. Issue **#253** is NOT covered: it had not landed when this
was taken, and its central claim (a popover anchored under its trigger) is still unverified.

## Method

- **A frozen production build, not a dev server.** `apps/web/dist/web` built from commit `f3fbf91`,
  served with `npx vite preview --outDir dist/web --host 127.0.0.1 --port 41999`. Another agent was
  editing source at the time; a dev server would have hot-reloaded half-written code into the middle
  of the measurements.
- **`127.0.0.1`, never `localhost`** — a distinct browser origin, so the Tasks created for this run
  are isolated from any real data stored under `localhost`.
- **Dark theme**, confirmed (`html.dark`, body `oklch(0.145 0 0)`). The entire corpus is Dark-theme.
- Every colour read from the **painted leaf node**, named per row below, never its wrapper.
- Bundle checked before measuring: the built CSS carries `td-date-today:#25b84c` and
  `td-add-task-font-size:14px`, and `todo-page-*.js` carries `max-w-[800px]` — so a stale reading
  would have meant a stale browser, not stale code.

### Traps hit, recorded for the next session

- **A stale service worker and a `workbox-precache-v2` cache were present** from an earlier visit to
  this origin. Both were cleared (`getRegistrations()` → `unregister()`, `caches.keys()` →
  `delete()`) and the page hard-reloaded before anything was measured. Skipping this reads exactly
  like a broken build.
- **"meologue is already open in another window" with no other window open.** The single-window lock
  survives in IndexedDB/localStorage, not just in live tabs, so clearing the service worker alone
  does not release it. Fixed with an origin-scoped `Storage.clearDataForOrigin`. It also recurred on
  repeated hard reloads as a heartbeat race; in-app SPA navigation avoids it. This is a second,
  distinct form of the known stale-tab trap.

## Issue #250 — row colours and states: every value matched

| What | Expected | Measured | Painted node |
|---|---|---|---|
| Date, due **today** | `rgb(37, 184, 76)` | `rgb(37, 184, 76)` | inner `<span>` on `--td-date-today` |
| Date, due **tomorrow** | `rgb(255, 154, 20)` | `rgb(255, 154, 20)` | inner `<span>` on `--td-date-tomorrow` |
| Date, **2–6 days out** | `rgb(169, 112, 255)`, unchanged | `rgb(169, 112, 255)` | inner `<span>` ("Tuesday") |
| Today view, due-today row | date control **absent from the DOM** | absent — no date wrapper anywhere in the row's `outerHTML` | the task `<li>` subtree |
| Completed title | `rgb(128,128,128)` + `line-through` | `rgb(128, 128, 128)`, `line-through` | `span.completed-task-text` |
| Completed date | `rgb(204,204,204)`, present | `rgb(204, 204, 204)`, present | inner `<span>` on `--td-date-muted` |
| Checkbox ring, **P1** | 2px | `rgb(255,112,102) 0 0 0 2px` | the `<input type=checkbox>` |
| Checkbox ring, others | 1px | `rgb(169,169,169) 0 0 0 1px` | same, three rows sampled |

## Issue #252 — the add field: every value matched

| What | Expected | Measured |
|---|---|---|
| Position | after the list | DOM order in Inbox: `<ul>` → add field `<div>` → completed `<details>` |
| Quiet row | no border box | resting: `border-color: rgba(0,0,0,0)`, `background: rgba(0,0,0,0)`, `box-shadow: none` |
| Resting placeholder | 14px | 14px, on `span.ProseMirror-widget` |

## Issue #254 — page chrome: every value matched

| What | Expected | Measured |
|---|---|---|
| Column above 900px | 800px, centred | at 1470px: `width: 800px`, gutters **171px / 171px** (equal — the centring the capture correction called for) |
| Column below 900px, narrow | 97% | at 700px: 679 / 700 = **97.00%** |
| Column below 900px, `md` | 85% | at 850px: 722.5 / 850 = **85.00%** |
| View name | real `<h1>`, 26px / 700 / 35px | 26px, 700, 35px — on Inbox, Today, Upcoming **and** a Project's own name |
| Todo app bar | none | `document.querySelectorAll("header").length === 0` |
| Back + sync | in the heading row | `<a aria-label="Back to chats">`, `<h1>`, sync indicator — siblings in one row |
| Other Destinations | unchanged | Composer still has its `<header>` (count 1) |

## Issue #251 — the type scale matched; the chip width did NOT

| What | Expected | Measured | Verdict |
|---|---|---|---|
| Typed text font-size | 16px | 16px | matched |
| Typed text line-height | 23px | 23px | matched |
| Chip width, recognised | 32.31px | **36.14px** | **divergent, +3.83px** |
| Chip width, withdrawn | 24.31px | **28.14px** | **divergent, +3.83px** |
| Recognised − withdrawn | 8.00px | **8.00px** | matched exactly |

**This acceptance criterion is not met, and the ticket's framing of it was wrong.** #251 reasoned
that the chip was too narrow *because the font was too small*, and that fixing 14px → 16px would
bring 29.41px up to Todoist's 32.31px. The font-size fix landed and is confirmed at 16px/23px — and
the chip overshot in the other direction, to 36.14px.

What the numbers actually say: the **delta** between recognised and withdrawn is 8.00px in both
applications, exactly the 4px + 4px horizontal padding the highlighted span adds and the withdrawn
span drops. So the padding implementation is correct and is not the variable. The constant +3.83px
offset in *both* states is glyph width — the same string ("tom") at the same 16px in a different
typeface. meologue renders Geist; Todoist renders its own stack.

**A chip width therefore cannot be matched to the pixel while the two applications use different
fonts**, and no amount of padding or font-size work will close it. The honest options are to match
the font stack (a far larger decision than this ticket, and not one the corpus has evidence for) or
to restate the row's target as the 8px padding delta, which *is* matched and *is* implementation.
Recorded here rather than quietly rounded off: the previous programme's whole failure mode was rows
marked healthy on numbers nobody re-measured.

## Two judgements that needed a screen, not a test

- **The 14px → 16px step when typing into the add field is not jarring.** Line-height stays 23px in
  both states, so only glyph size changes and the baseline barely moves. This was the accepted cost
  of deferring the click-to-reveal composer (NAV-12); on screen it is a non-event.
- **The predicted 1px overflow is real but invisible.** The field's `h-8` box gives a 22px content
  area against a 23px line-height, confirmed by computed style — but `overflow-y: visible` means
  nothing clips, and at 1px there is no crowding or cut glyph in a tight crop. Not worth a fix.

## Issue #253 — anchoring measured, and one entry point broken

Taken after #253 landed, against a rebuilt bundle. **Anchoring is confirmed**, with both rects read
rather than eyeballed — the failure mode here is a popover rendering at the viewport origin, which
no test in this repo can observe:

| Entry point | Trigger rect | Popover rect | Anchored |
|---|---|---|---|
| Row hover Date button | 1123, 84 | 1123, **132** | yes |
| More-actions → "Date…" | 1227, 84 | 1123, 132 | yes (shared row instance) |
| `T` shortcut | 1123, 143 | 1123, **191** | yes |
| Detail view Date attribute | 931, 159.7 | 931, **196** | yes |

Measured 250×525 at 10px radius. The bottom sheet offers only Deadline and Priority. Setting a
date, clearing it and setting a recurrence all worked from two different entry points.

**But the More-actions item does not reliably open it by mouse — filed as issue #255.** Measured
**2 of 10** mouse attempts against **3 of 3** by keyboard, and the failure is *deterministic by row
position* (bottom rows open, upper rows never do), unchanged by a 900ms pause before the click. Two
fixes were attempted and both reverted; the second failed informatively, ruling out the
focus-return theory both had assumed. #255 carries the evidence.

## macOS (Tauri) — 6 of 6 checks passed on screen

Driven against `build/sandbox/meologue-sandbox.app` (binary stamped 18:46). Freshness proven
against `dist/macos/assets/todo-page-DREeNhsq.js`, which carries the `max-w-[800px]` cap — not
against the binary, which Tauri brotli-compresses, so `strings` finds no UI text either way.

Passed, each backed by a screenshot: the in-column `<h1>` with no app bar (#254); the column capped
and centred at 1360px and proportional at 700px (#254); today green / tomorrow orange (#250); the
add field below the list and unboxed at rest (#252); **the scheduler popover anchored under its
control** (#253); and a rename of `… tom` stripping the phrase and setting Tomorrow (#247).

The sixth: **a completed row showing strikethrough *and* its date together**, found in the Inbox's
collapsed `Completed` disclosure — the surface `completed-tasks.tsx` renders — with colours sampled
from the capture rather than eyeballed: title `rgb(128,128,128)` struck through, date
`rgb(204,204,204)`. An earlier attempt had looked in **Search**, whose rows render through a
different component that shows no date and was never in #250's scope; that was a gap in where it
looked, not a native divergence.

### `open` cannot be trusted to launch the build you name

Recorded because it silently produced a wrong measurement before it was caught.
`open build/sandbox/meologue-sandbox.app` was **redirected by LaunchServices** to
`/Applications/meologue.app` — a build eight days older, different SHA256 — with no visible sign.
The fix is to launch the executable directly
(`…/Contents/MacOS/meologue`), bypassing `open`, and then prove which binary is live by comparing
`shasum -a 256` against the one you meant to test. **A process start time "consistent with" the
build stamp proves nothing**, since both binaries can start at the same moment.

This also raises the question of whether the earlier five checks measured the right build, since
they used `open` too. They did: every feature they verified landed the same day, and an
eight-day-old binary cannot render any of it. That inference rescues a finished run only because
the features were new — it would prove nothing about a run verifying older behaviour.

## Android — 6 of 6 checks passed on a real device

Bundle passes both corrected budgets (`check-bundle-size.mjs` exits 0, no `exceeds` lines). APK
installed and confirmed on the device as `com.meologue.app.sandbox`, versionName 0.4.0,
`lastUpdateTime=2026-09-11 18:48:52`, packaging `todo-page-bpfj1-CD.js` — the same chunk hash the
budget check measured. Driven on a **motorola edge 50 neo (ZD222P9VZC), 1200×2670 @ density 450**.

Passed, each backed by a screenshot actually read: the view name as a single large heading with no
separate toolbar beneath the status bar, on Inbox and Activity both (#254); the column at **full
device width with no 800px cap** and the bottom nav present, which is the correct behaviour below
the 900px breakpoint, with Activity reachable from it (#254/#248); today green and tomorrow orange
as distinct colours, and a completed row struck through with its date still shown inside the
`Completed (1)` disclosure (#250); the add field below the list as a quiet borderless row (#252);
the scheduler anchored to its Date control (#253); and a rename resolving `Buy milk tom` (#247).

**#247 was confirmed at the data layer, not just on screen** — logcat showed the SQLite row's
`content` staying `"Buy milk"` while `date` became `"2026-09-12"`. That is the strongest evidence
in this file for the rename door: the phrase is stripped from what is stored, not merely from what
is displayed.

Three observations recorded rather than smoothed over:

- **The scheduler popover opened *upward*** from the Date control, sharing its left edge, because
  the control sat near the bottom of the detail sheet with no room below. Still anchored to its
  trigger — a flip to stay on screen is the sensible fallback, and is a narrow-screen difference
  rather than the viewport-origin failure #253 exists to prevent.
- **The software keyboard was visible behind the popover on first capture**, with no text field
  intentionally focused — likely residual focus from the sheet's own sub-task/comment fields. It
  did not obscure the calendar and produced no console errors. Not confirmed as a regression; noted
  so it is not rediscovered as a surprise.
- **One transient landscape capture at first launch**, self-corrected within two seconds, on a
  device whose rotation lock is off. Not attributable to the app with any confidence.

`Capacitor/Console` carried only routine SQLite-plugin debug lines — no errors or warnings.

## A divergence the spec review surfaced, recorded here

Issue #252's criterion reads "renders as a quiet 14px row in the muted grey, with no border box."
The border is gone, and the **resting** row is 14px — but that 14px lives on the placeholder widget
alone. Typed content renders at 16px through the Quick Add title tokens the same field shares. So
the row is 14px only while empty. That follows directly from deferring the click-to-reveal composer
(NAV-12), which is what would otherwise separate the two surfaces and let each carry its own scale.
On screen the step is a non-event, because line-height stays 23px throughout — but the criterion as
literally worded is not met, and that is worth stating rather than reading the word "row" loosely.

## What remains unverified

All three platforms are now driven and measured. What is left is scoped and named:

- **Issue #255** — the More-actions "Date…" item opens the scheduler on roughly 2 of 10 mouse
  clicks in a desktop browser. Unfixed, filed with evidence. Note the Android run reached the
  scheduler through the detail sheet rather than that menu, so it neither reproduces nor clears
  this; the defect is recorded against the browser, where it was measured.
- **Issue #251's chip width** — 36.14px against Todoist's 32.31px, a glyph-width difference between
  typefaces. Unreachable without matching font stacks; see QA-01.
- **Issue #252's "14px row"** — true of the resting placeholder, not of typed content, which
  renders at 16px through the shared Quick Add tokens.
- **Light theme everywhere** — the corpus is Dark-theme only by decision (`THEME-01`, `divergent`).

Test data left behind by these runs: a completed "pay rent" on the macOS sandbox, and "Buy milk"
plus a completed "Walk dog" in the Android sandbox app. Both are Sandbox instances, not Production.
