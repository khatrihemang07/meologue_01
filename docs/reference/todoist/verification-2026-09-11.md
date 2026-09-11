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

## What remains unverified after this pass

- **Everything in issue #253** — the anchored scheduler popover, its 250×525 geometry and 10px
  radius, and above all *whether it anchors under its trigger at all*. That failure mode is
  invisible to the test suite by construction and has shipped broken here once before.
- **Android and macOS.** This was measured in a desktop browser only.
