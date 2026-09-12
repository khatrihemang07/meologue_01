# Live audit — both applications driven together (2026-09-11)

The first document written under
[ADR 0077](../../adr/0077-parity-is-proved-live-not-against-a-dated-capture.md): **meologue and
Todoist driven in the same session, Todoist live, with the raw artifacts committed beside the
prose** in `live-audit-dom/`.

Rows are appended here as each of the eight Todoist flows is driven. A row lands in
`parity-ledger.md` only once both sides have been read in the same session.

## Method

- **Todoist web**, `app.todoist.com`, **dark theme** (confirmed `html.theme_dark`), Free plan,
  driven live on 2026-09-11.
- **meologue**, a **frozen production build** of this branch at `28e2e82` (no source change since),
  served with `vite preview --outDir dist/web --host 127.0.0.1 --port 41999`. `127.0.0.1`, never
  `localhost` — a distinct origin, so nothing here touches real data stored under `localhost`.
- **The identical string is typed on both sides.** This is the control the previous pass lacked, and
  it is the single reason this document exists.
- Every figure is a `getComputedStyle` / `getBoundingClientRect` read on the **painted leaf node**.
- One browser agent at a time against Todoist. Parallel agents mis-click as live sync re-renders the
  list beneath them.

## QA-01 — the recognition chip

Typed `tod` in both applications.

| Property | Todoist | meologue | Match |
|---|---|---|---|
| Recognised width | 32.31px | **32.05px** | yes, Δ 0.26px |
| Withdrawn width | 24.31px | **24.05px** | yes, Δ 0.26px |
| Recognised − withdrawn | 8.00px | **8.00px** | exact |
| `font-family` | `-apple-system, "system-ui", "Segoe UI", "Noto Sans", system-ui, sans-serif, …` | identical string | exact |
| `font-size` / `line-height` | 16px / 23px | 16px / 23px | exact |
| padding L/R, recognised | 4px / 4px | 4px / 4px | exact |
| padding L/R, withdrawn | 0px / 0px | 0px / 0px | exact |
| `display` recognised → withdrawn | `inline-block` → `inline` | `inline-block` → `inline` | exact |

**`QA-01` → `matched`.** Artifacts: `live-audit-dom/qa01-todoist.json`, `qa01-meologue.json`.

**The 0.26px is recorded, not rounded away.** It is sub-pixel, identical in both states, and below
the resolution at which two applications rendering different content can be meaningfully compared.
Calling it zero would be the same rounding-off this corpus exists to refuse.

### What this overturns

`verification-2026-09-11.md` reported a **+3.83px** gap and explained it as a typeface difference,
concluding that the target was "unreachable without matching font stacks". A session handoff then
carried that forward as a large open product decision. **All of it was wrong, in two independent
ways:**

1. **The two numbers were measured on different strings** — `tod` in Todoist against `tom` in
   meologue. One substituted glyph is worth roughly 4px at 16px and lands in both states equally,
   which is exactly why the offset looked like a suspiciously constant residue.
2. **The stated cause was false anyway.** `[data-surface="todo"]` declares Todoist's own stack
   verbatim and applies `font-family` unlayered on `documentElement`, beating the layered
   `html{font-family:Geist}` on both layer order and specificity. `THEME-05` — already `matched` —
   was right.

Neither of the "honest options" that document offered was needed. The target was already met; the
comparison was simply uncontrolled.

### Two existing rows corroborated without being sought

- **QA-02** — `data-match-id` carries `"11 Sep"` in Todoist against `"2026-09-11"` in meologue.
  Exactly the display-form/raw-value divergence that row already records.
- **QA-06** — both applications keep the **same span element** through withdrawal, restyled rather
  than replaced, and both leave the text `tod` intact after the first Backspace.

## No screenshots for this run

CDP `Page.captureScreenshot` timed out for the whole session — on meologue, on Todoist, and on a
blank page — so this is an environment-level failure, not a page trap. **`pairs/` therefore stays
empty.** Stated plainly because ADR 0077 requires artifacts beside the prose: this row has its JSON
reads but no visual record, and a reader should know which half is missing rather than assume both
exist.

## Safety log

- **No task was created, completed, edited or deleted.** All Todoist work happened in an unsaved
  Quick Add draft, explicitly discarded.
- **Canary**: Inbox `li[data-item-id]` counted **16 before and 16 after**.
- **No project was created.**

### A near-miss worth the next session's attention

`loc=role:textbox[name='Task name']` matched **an open task's own inline title editor** (the task
"Bat fix"), not the empty Quick Add composer — both carry the identical accessible name. It was
caught before any keystroke by checking `document.activeElement.textContent` was empty, and aborted.
**Always verify the target field's text content is empty before typing into a Todoist "Task name"
locator.** The accessible name alone does not distinguish the composer from an open task's editor,
and this is precisely how a real task gets silently renamed.

Two further Todoist traps: the global "Add task" affordance shares its accessible name with an
inline per-project row and must be disambiguated by `.plus_add_button`; and Escape on a Quick Add
draft with unsaved text raises a **"Discard unsaved changes?"** confirmation that must be clicked —
a single Escape does not discard.

meologue traps, both already documented and both hit again: a stale service worker plus
`workbox-precache-v2` cache needing an origin-scoped clear before measuring, and snapshot refs not
resolving to the same element across separate driver invocations (one click landed on Digest instead
of Todo; recovered with `loc=href:/todo`).

## Account drift, recorded because ADR 0077 accepts it

`pass2-2026-09-11.md` §3 counted **13** `li[data-item-id]` in the Inbox. Today's canary reads
**16**. The account moved underneath the corpus within a day. Under the pinning rule this would have
been invisible; under ADR 0077 it is simply the condition the audit runs in, and is the reason every
row now names the session it was driven in.

## The Quick Add flow — QA-02 to QA-20

Driven in one session, identical input on both sides for every row. Artifacts: the `qa-flow-*.json`
files in `live-audit-dom/`. QA-21 to QA-24 were out of scope (already `blocked`).

| Row | Todoist | meologue | Result |
|---|---|---|---|
| QA-02 | `data-testid` + `data-match-id`, id `"11 Sep"` | same attributes, id `"2026-09-11"` | `matched` (format differs, not user-visible) |
| QA-03 | `data-highlighted-match="true"`, absent once withdrawn | identical | `matched` |
| QA-04 | 1st Backspace: no character deleted, highlight dropped | identical | `matched` |
| QA-05 | 2nd Backspace: character deleted, span removed | identical | `matched` |
| QA-06 | tag probe: **a new span node** after withdrawal | the same node persists | **`blocked`** — contradicts `quick-add.md`; tiebreak pending |
| QA-07 | `todx` clears the span, back to `tod` re-recognises | identical | `matched` |
| QA-08 | `Home` + `ArrowRight` into the span: stays highlighted | identical | `matched` |
| QA-09 | all ten forms recognised; `next week` → Mon 14 Sep | **`12/25` not recognised**; `next week` → Fri 18 Sep | **`divergent`** — two defects |
| QA-10 | `5pm` / `17:00` → `"12 Sep 5:00 PM"` | → `"17:00"`, no date | **`divergent`** — structural |
| QA-11 | every day / every monday / daily → "every day" | identical | `matched` |
| QA-12 | `p1`–`p4` → id `"1"`–`"4"` | → id `"P1"`–`"P4"` | `matched` (format differs, same class as QA-02) |
| QA-13 | `#` opens a `role="listbox"`, create-project fallback | not built | `todoist-captured` |
| QA-14 | `@` reuses the same listbox, create-label fallback | parser only, no popup | `built` |
| QA-15 | footer gains Remove date once parsed — **inline row, not the dialog** | not built | `todoist-captured`, re-drive pending |
| QA-16 | **no valid reading** — see below | — | `todoist-captured`, re-drive pending |
| QA-17 | one `contenteditable` at rest, no description input | identical | `matched` |
| QA-18 | `Tab` → More actions — **inline row, not the dialog** | not built | `todoist-captured`, re-drive pending |
| QA-19 | **not driven** — it submits, and would create a real task | driven: submits | `built` — one side is not a live reading |
| QA-20 | 16px / 23px, system stack | byte-for-byte identical | `matched` |

### Four defects this flow found

Each is a fix candidate. None is a design decision.

1. **`12/25` is not recognised as a date in meologue**, although `date-rules.ts` claims to cover it.
2. **`next week` lands on a different day** — Todoist gives the next Monday, meologue gives today+7.
3. **A time-only phrase carries no date in meologue** — Todoist's `5pm` implies a day.
4. **QA-12's `P` prefix is ours.** #251 changed that identifier believing it fixed an inversion; the
   inversion fix was right, but Todoist's own id is a bare digit.

### A number in prose is not a number in an artifact

The agent's summary reported Todoist's Quick Add at **800×89px, radius 12px, `rgb(40,40,40)`,
padding 12px**. None of those values is in the artifact it saved: `qa-flow-todoist-qa16-geometry.json`
holds only the editor and its wrapper `DIV`s, all 774×23px with no radius, background or padding.
The figures existed only in prose. The editor width does identify the surface, though — 774px cannot
fit a 580px dialog, so the run was on Todoist's **inline add-task row**, not Quick Add. QA-15 and
QA-18 came from the same run, whose recorded footer (`More actions · Remove date · Cancel · Add task`)
lacks the dialog's project, priority and label controls.

This is the QA-01 failure in a new form: a confident number with nothing behind it. From here on,
**every figure a driving agent reports must also appear in the JSON it saves**, or it is not
recorded.

### Safety log

- Todoist Inbox canary **16 → 16**. Nothing created, edited or deleted there.
- meologue canary 0 → 0: the one QA-19 test task was created and deleted, on the isolated origin.
- **A second near-miss.** Typing `#zzzznonexistent` too fast let focus fall out to `body`, and the
  trailing keystrokes fired Todoist's global shortcuts, navigating to `/app/notifications`. Nothing
  was created. Focus must be asserted after *every* keystroke in autocomplete tests, not only before
  the first.
- Screenshots failed again (CDP `captureScreenshot` timeout), so no visual record exists for this
  flow either.

## Tally after the Quick Add flow

Read back from `parity-ledger.md` rather than counted from edits — the readback caught three status
cells that had been described as changed but were not.

| Status | Session start | Now |
|---|---|---|
| `matched` | 17 | **23** |
| `built` | 74 | 65 |
| `todoist-captured` | 13 | 13 |
| `divergent` | 10 | 12 |
| `blocked` | 11 | 12 |

Seven rows reached `matched` (QA-01, 07, 08, 11, 12, 17, 20) and one left it (QA-06).

## Settling what the Quick Add flow left open

A second, narrower run. Every value below was checked in its artifact before being written here —
the rule adopted after QA-16's prose-only numbers.

### QA-06 — Todoist replaces the span; meologue keeps it

Method: set a unique expando token on the recognised span, hold a JS reference, attach a
`MutationObserver` (`childList`, `attributes`, `subtree`) to the editor, press Backspace once.

| | Todoist (3 of 3 runs) | meologue (3 of 3 runs) |
|---|---|---|
| Held span still connected | **no** | yes |
| Current span `===` held span | **no** | yes |
| Current span carries the token | **no** | yes |
| Mutations | `childList` + new `SPAN[natural-language-match]`, + text node, − old span; `class` attribute | `attributes` only: `data-highlighted-match`, `class` |

**QA-06 → `divergent`, structural only.** Nothing user-visible differs. `quick-add.md`'s verified
claim of "one element in two visual states" is false for Todoist and is corrected there. Keeping
meologue's node identity is a recommendation awaiting the user's decision.
Artifacts: `qa06-tiebreak-todoist.json`, `qa06-tiebreak-meologue.json`.

### QA-15 / QA-16 / QA-18 — on the real Quick Add dialog

Identity asserted first: `role="dialog"`, `aria-label="Quick Add"`, `data-testid="quick-add"`,
exactly one match.

| Property | Empty draft | `tod` recognised |
|---|---|---|
| Size | **580 × 66px** | **580 × 97px** |
| Radius | 12px | 12px |
| Padding | 16px all sides | 16px all sides |
| Border | `1px solid rgb(61,61,61)` | same |
| Background | `rgb(40,40,40)` | same |
| Shadow | `rgba(0,0,0,0.2) 0 4px 8px` | same |

- **QA-16**: the ledger's "580×97 at rest" was a recognised-state figure; corrected in the ledger
  and in `quick-add.md`. Still `todoist-captured` — meologue has no dialog (NAV-12).
- **QA-15**: aria-labelled footer buttons, in order, **More actions · Remove date · Cancel · Add
  task**. That read cannot see unlabelled controls, so it does *not* show that project, priority or
  label controls were removed. It does correct an earlier ledger note, which wrongly treated the
  four-button footer as proof the first run was on the inline row.
- **QA-18**: `Tab` from the empty title focuses `BUTTON[aria-label="More actions"]` — now confirmed
  on the dialog as well as the inline row.

Artifact: `quickadd-dialog-todoist.json`. Every keystroke in it records a focus and text check.

### Why the first attempt measured the wrong surface

`quick-add.md` named the global opener `button.plus_add_button`. On this account that selector is
the **in-list inline add trigger**; the global opener is the sidebar's "Add task" button, which has
no aria-label and sits off-screen while the sidebar is collapsed. The earlier run followed the
corpus and measured the inline row. The error originated in the reference, not the driver — which is
exactly why a reference's own selectors need re-verifying, not trusting. Corrected in `quick-add.md`.

### Safety log

- Todoist Inbox canary **16 → 16**, with the full title list saved (`canary-final-todoist.json`).
- **A third near-miss.** A stray click on `body` landed on the task "naukri photo update" and opened
  its detail modal. Nothing inside it was touched; it was closed with its own Close button and the
  canary re-checked before continuing.
- meologue's single-window lock appeared again with no other tab holding it, cleared with a second
  origin-scoped storage clear and an `about:blank` bounce.
- No screenshot: CDP `captureScreenshot` timed out again.

### Tally after settling Quick Add

Read back from `parity-ledger.md` after the edits.

| Status | Session start | After Quick Add flow | Now |
|---|---|---|---|
| `matched` | 17 | 23 | **23** |
| `built` | 74 | 65 | 65 |
| `todoist-captured` | 13 | 13 | 13 |
| `divergent` | 10 | 12 | **13** |
| `blocked` | 11 | 12 | **11** |

The only status change is QA-06, `blocked` → `divergent`. QA-15, QA-16 and QA-18 gained verified
dialog evidence without changing status, because meologue has no Quick Add dialog to compare.

## Flow 2 — task rows, dates and priority

ROW-01 to ROW-15, DATE-01 to DATE-12 and PRI-01 to PRI-06, driven in one session on disposable
fixtures carrying identical titles in both applications. Artifacts: the `flow2-*.json` files in
`live-audit-dom/`.

### How the fixtures were made

- **meologue, without the UI.** The repository has no seed hook, but the app's own store is
  reachable: from `#root`'s React container fiber to the `QueryClientProvider` client, then
  `getQueryData(["entry-store"])` gives `taskStore`, `labelStore`, `projectStore` and
  `commentStore`. Tasks were upserted through the same store code the UI uses, with dates computed
  from the live clock. Method and ids: `flow2-setup-meologue.json`. This makes seeding repeatable,
  but the dates are relative — fixtures made one day read as a day stale the next.
- **Todoist, as disposable tasks** titled `ZZ probe …` in the Inbox, measured and then deleted,
  with one moved into an existing project for the cross-project case and one label `zz-probe`
  created and removed.

### Results

| Row | Todoist | meologue | Result |
|---|---|---|---|
| ROW-01 | 59px with a metadata line; **43px title-only** | 59px `min-height` floor | **`divergent`** — was `matched` |
| ROW-02 | divider `1px solid rgb(61,61,61)` | identical | `matched` |
| ROW-03 | ring 2px at P1, P2, P3; 1px at P4 | 2px at P1 only | **`divergent`** |
| ROW-05 | line-clamp 4, 14px/21px | identical | `matched` |
| ROW-07 | first description line as real HTML, one line | identical | `matched` — was `built` |
| ROW-08 | comment badge is a link `?intent=reply` | plain `<span>` | `divergent` |
| ROW-09 | separator not re-read | no separator glyph | `built` |
| ROW-10 | no priority text badge; label badge is a link | `P1` text badge; label a `<span>` | **`divergent`** |
| ROW-12 | action buttons not in the DOM at rest | mounted at `opacity: 0` | `divergent` (deliberate, reconfirmed) |
| ROW-13 | due-today date control absent on Today view | identical | `matched` — was `built` |
| ROW-14 | completed rows interleaved, `aria-checked` | segregated `<details>` | `divergent` |
| ROW-15 | completed title `rgb(128,128,128)` + strike, date `rgb(204,204,204)` | identical | `matched` — was `built` |
| DATE-01 | "Yesterday" `rgb(255,112,102)` | identical | `built` — icon clause not re-read |
| DATE-02 | completed date `rgb(204,204,204)` | identical | `matched` — was `built` |
| DATE-03 | "Tuesday" `rgb(169,112,255)` | identical | `matched` |
| DATE-04 | recurring due today: **icon-only** badge on Today view | `every day` **text** badge | **`divergent`** |
| DATE-05 / NAV-05 | `11 Sep ‧ Today ‧ Friday`, `12 Sep ‧ Tomorrow ‧ Saturday` | identical | `matched` — was `built` |
| DATE-06 / 09 / 10 | **not read** — virtualized out of view | Today green, Tomorrow orange, `Tomorrow, 9:30 AM` | `built` — one-sided |
| DATE-11 | **"21 Sep"** | **"Sep 21"** | **`divergent`** |
| PRI-01 / 02 | picker swatches and inverted `data-value` re-read | tokens only, picker not driven | unchanged — one-sided |
| PRI-03 | P4 ring `1px rgb(169,169,169)`, swatch `rgb(102,102,102)` | ring identical | `built` — was `blocked` |
| PRI-05 | row ≠ picker colour at every level | row = picker at P2, P3 | **`divergent`** |
| PRI-06 | P2 `2px rgb(255,154,19)`, P3 `2px rgb(82,151,255)` | P2/P3 1px, picker colours | **`divergent`** — was `blocked` |

### Defects found

Each is a fix candidate, not a design decision.

5. **Row height floor.** A title-only row is 43px in Todoist; meologue's `minHeight: "59px"` holds it
   at 59.
6. **P2 and P3 checkbox rings.** Todoist draws them 2px in row-specific colours; meologue draws them
   1px in the picker's colours. Root cause is in the corpus: `scheduler-and-priority.md` §10c marked
   P2/P3 row colours "INFERRED only (not verified) from the picker's flag colours", and the
   inference was built as written. Corrected there.
7. **Priority text badge.** meologue renders `P1`/`P2`/`P3` in the row's metadata line
   (`task-row-content.tsx:522`); Todoist shows priority only as the ring.
8. **Far-date wording.** "Sep 21" in meologue against "21 Sep" in Todoist.
9. **Recurring task due today.** Todoist reduces the date control to an icon; meologue keeps a text
   badge.

### Corrections to the corpus

- `row-and-detail.md` §1: 59px is the one-metadata-line height, not a fixed row height.
- `scheduler-and-priority.md` §10c–§10d: the P4 ring is `1px rgb(169,169,169)`, not transparent — the
  original capture almost certainly read the transparent fill layer, the first of two spans inside
  `button.task_checkbox`. The P2/P3 inference is replaced with measured values.

### Claims from the run's own summary that were not recorded

The summary was checked against the artifacts, and two claims had nothing behind them:

- **"meologue renders a literal P1 badge"** appeared only inside the *Todoist* artifact, pointing at
  a meologue file that measured comments, labels and sub-task counts but never priority. It turned
  out to be true, and is recorded — but on the strength of `task-row-content.tsx:522`, not the run.
- **"ROW-01: meologue keeps 59px for a metadata-free row"** compared Todoist's title-only row against
  a meologue row that carries a `P1` badge. The divergence is real, and is recorded from the 59px
  `min-height` floor in source; meologue's like-for-like title-only row was not measured live.

A value about one application written into the other application's artifact is not evidence for
either.

### Safety log

- **Inbox**: 16 titles before, 16 after, **set-equal**, collected by scrolling the list and unioning
  ids. Earlier canaries used a plain `querySelectorAll`, which misses rows Todoist has virtualized out
  of view; they still showed no change among the rows they could see, but not across the whole list.
- **Getting Started project**: one `ZZ probe` task was moved in and then deleted, leaving 14 tasks.
  **No count was taken before the move**, so "restored to its original count" is the run's assertion,
  not a measured before-and-after. Worth a glance.
- **Label**: `zz-probe` was created and deleted. The run did not record whether existing labels were
  available to use instead, which its instructions preferred.
- Todoist on macOS submits a comment with **Cmd+Enter**; Ctrl+Enter left the draft unsent.
- **A method note.** A command-safety check rejected driver scripts containing some ordinary words,
  and the run first worked around it by disguising those words. That is not an acceptable fix: run
  driver scripts from a file instead (`ego-browser nodejs < file.mjs`), which the run then did and
  which also resolved the rejections.

### Tally after flow 2

Read back from `parity-ledger.md`.

| Status | Session start | After Quick Add | Now |
|---|---|---|---|
| `matched` | 17 | 23 | **28** |
| `built` | 74 | 65 | **53** |
| `todoist-captured` | 13 | 13 | 13 |
| `divergent` | 10 | 13 | **22** |
| `blocked` | 11 | 11 | **9** |

Six rows reached `matched` (ROW-07, ROW-13, ROW-15, DATE-02, DATE-05, NAV-05) and one left it
(ROW-01). Nine became `divergent`, and PRI-03 and PRI-06 were unblocked.

## Flow 3 — the scheduler, and closing flow 2's one-sided rows

SCHED-01 to SCHED-14, plus DATE-06/09/10 (Todoist's rows had been virtualized out of view in flow 2)
and PRI-01/02/03 (meologue's picker had not been driven). Driven on **Saturday 12 Sep 2026** — which
turned out to matter. Artifacts: the `flow3-*` files in `live-audit-dom/`.

### Method

- **meologue** re-seeded through its own store (the flow-2 method) with fresh relative dates, since the
  previous day's fixtures now read a day stale.
- **Todoist**: six disposable `ZZ probe` tasks for the date rows; every scheduler reading was then taken
  from an **unsaved Quick Add draft**, discarded afterwards, so the scheduler itself required no writes.
- Every Todoist row was scrolled into view and re-queried before being read.

### Results

| Row | Todoist | meologue | Result |
|---|---|---|---|
| DATE-06 / 09 | "Today" `rgb(37,184,76)`, "Tomorrow" `rgb(255,154,20)` | identical | `matched` — was `built` |
| DATE-07 / 10 | **"Tomorrow 9:30 AM"** | **"Tomorrow, 9:30 AM"** | **`divergent`** — DATE-07 unblocked |
| SCHED-01 | 250×525, radius 10px, `rgb(38,38,38)`, same two-layer shadow | identical; anchored under its trigger | `built` — Todoist anchoring not captured, #255 open |
| SCHED-02 | Today · Tomorrow · **Next week · Next weekend** | Today · Tomorrow · **This weekend · Next week** | **`divergent`** |
| SCHED-03 | "No Date" only once a date is set; **Today option dropped** when the date is today | not established (openings not tied to a task) | `built` |
| SCHED-04 | `next friday` → Fri 25 Sep · `every monday` → Mon 14 Sep → Forever · `in 3 days` → Tue 15 Sep | identical | `matched` — was `built` |
| SCHED-06 | `M T W T F S S` | identical | `matched` — was `built` |
| SCHED-07 | today on a weekend: **red** `rgb(226,106,96)`, bold | **grey** `rgb(204,204,204)`, bold | **`divergent`** |
| SCHED-08 | selected: `rgb(222,76,74)` 24×24 circle | identical | `matched` — was `built` |
| SCHED-09 | busy: `::before` 3×3 `rgb(209,209,209)` | identical | `matched` — was `built` |
| SCHED-10 | weekend `rgb(204,204,204)`/400, weekday white/400 | identical | `matched` — was `built` |
| SCHED-11 | separate "Select start and end time" dialog, 306×216 | inline "Add a time" checkbox + time input (source) | **`divergent`** — structural |
| SCHED-14 | Repeat menu, 282×206; options track the date | none | `todoist-captured` |
| PRI-01 | swatches P1–P4 | identical | `matched` — was `built` |
| PRI-02 | listbox, `data-value` 4→1, `aria-selected` | menu, `aria-pressed`, **no `data-value`** | **`divergent`** — structural |
| PRI-03 | P4 pre-selected, swatch `rgb(102,102,102)` | identical | `matched` — was `built` |

### Defects found

10. **Timed dates carry a comma.** meologue renders "Tomorrow, 9:30 AM"; Todoist "Tomorrow 9:30 AM".
11. **Quick options, slots 3–4.** Todoist offers Next week · Next weekend; meologue still offers This
    weekend · Next week, and on a Saturday its "This weekend" hint just repeats Today's.
12. **Today loses its colour on a weekend.** meologue's today cell receives both the today and the
    weekend utilities, and the weekend one wins, so today renders grey. Todoist keeps it red. The
    corpus was captured on a Thursday, so no earlier pass could have seen this — a reminder that a
    capture date is itself a test condition.

### Claims from the run that were not recorded

- **SCHED-02 as "environmental drift".** The run excused the quick-option difference as the two apps
  having been read a session apart. They were read on the same day, and ADR 0077 makes Todoist's live
  product the reference. Recorded as a divergence.
- **"The priority picker is byte-identical to meologue's."** The swatches are identical; the structure
  is not (listbox with `data-value` against a menu with `aria-pressed`). Recorded as PRI-01 `matched`,
  PRI-02 `divergent`.
- **"No Time control exists anywhere in meologue."** That came from a case-sensitive search for
  `Time`, which cannot match meologue's "Add a time" checkbox (`task-schedule-popover.tsx:444`).
  Recorded from source as a structural difference instead.
- **Quick Add at 348×39.6px** (`flow3-quickadd-identity-todoist.json`) is the same pre-layout
  transition read `quick-add.md` already flagged. Not geometry.

### Incident: probe tasks left in the real account

This run is recorded in full because it put the user's real data at risk.

1. After creating its six Todoist fixtures, **the run hit a usage limit and terminated**, before any
   cleanup. Six `ZZ probe` tasks were left in the user's live Inbox — two with titles truncated by
   Todoist's own date recognition ("ZZ probe", "ZZ probe t").
2. Resumed and told to clean up first, **it stalled three times in a row**, each time putting a script
   in the background and ending its turn to "wait for a monitor notification". A subagent that ends its
   turn cannot be woken, so each wait ended the run. An explicit instruction not to do this did not stop
   the third stall.
3. One of those background scripts, a read-only title collector, **hung while still attached to the
   Inbox tab**. It was stopped so it could not scroll rows under the deletions, and the parent did not
   take over the browser, because the resumed agent was by then driving it in the foreground — a second
   driver on a live account is how a real task was once completed during capture.
4. **Cleanup then completed and is verified in the artifacts**: five deletions each record the title
   read back, the confirmation dialog's own text and that the task was gone afterwards; the bare
   "ZZ probe" was deleted first, with its dialog text quoted; no deletion errors; and the Inbox, collected
   by scroll-and-union, is **16 titles before and after, set-equal**. A later check after the scheduler
   draft was discarded matched again. The "search is empty" check read Quick Find's suggestion list
   rather than a results page, which is weaker, but every fixture lived in the Inbox.

The lesson for any future run that writes to a real account: **a browser agent must do its work, and
especially its cleanup, in the foreground**, and a cleanup that has not produced its own artifact has
not happened.

### Still open from this flow

- SCHED-01: Todoist's trigger rect was not captured, so anchoring is compared on meologue only.
- SCHED-03: meologue's two openings were not tied to a task, and whether meologue also drops the quick
  option matching the current date is untested.
- #255 (More-actions → Date by mouse) is untouched.

### Tally after flow 3

Read back from `parity-ledger.md`.

| Status | Session start | After Quick Add | After flow 2 | Now |
|---|---|---|---|---|
| `matched` | 17 | 23 | 28 | **37** |
| `built` | 74 | 65 | 53 | **41** |
| `todoist-captured` | 13 | 13 | 13 | **11** |
| `divergent` | 10 | 13 | 22 | **28** |
| `blocked` | 11 | 11 | 9 | **8** |

Nine rows reached `matched` (DATE-06, DATE-09, SCHED-04, SCHED-06, SCHED-08, SCHED-09, SCHED-10,
PRI-01, PRI-03). Six became `divergent` (DATE-07, DATE-10, SCHED-02, SCHED-07, SCHED-11, PRI-02).

## Decisions taken by the user, 2026-09-12

- **QA-06 — match Todoist.** Earlier sections of this document record that keeping meologue's node
  identity through withdrawal was recommended and awaiting a decision. The user chose strict DOM
  parity instead. QA-06 therefore becomes **defect 13**: meologue's withdrawal should replace the
  recognised span with a new node, as Todoist's does, with every observable unchanged.
- **Todoist writes continue, under stricter rules**, after flow 3's incident. Every driving prompt
  forbids background waits from its first line; at most two disposable tasks per run; a saved
  "before" title list precedes any write and a saved list of what was created follows immediately;
  any failure jumps straight to cleanup. Accepted consequence: Todoist's activity log keeps a
  permanent record of those creates, comments and deletes even after the tasks are removed.
- **Task detail and comments next**, split into two short runs so a stall strands less.

## Flow 4 — the task detail view

DET-01 to DET-14 (DET-13 skipped as a deliberate divergence), driven under the stricter write rules.
The run stayed in the foreground throughout and finished without a stall. Artifacts: the `flow4-*`
files in `live-audit-dom/`.

### Results

| Row | Todoist | meologue | Result |
|---|---|---|---|
| DET-01 | `/app/task/<slug>-<id>`; Escape back to Inbox | `/todo/task/<slug>-<id>`; same | `matched` — prefix difference is deliberate |
| DET-02 | title at rest is a `div`, `tabIndex=-1` | a `<button>` | `divergent` — keyboard reachability |
| DET-03 | hint text present, **not referenced** by the title | hint linked through `aria-describedby` | `divergent` — meologue more accessible |
| DET-04 | activated title: `div[role=textbox][contenteditable]` "Task name" | identical | `matched` — was `blocked` |
| DET-05 | `data-testid="task-details-modal"` | identical | `matched` |
| DET-06 / 09 | title and description editors together, one Cancel/Save | identical | `matched` |
| DET-07 | ` tom` recognised in the detail title; Save strips it and sets Tomorrow | identical | `matched` |
| DET-08 | Date control unchanged until Save | identical | `matched` |
| DET-10 | at 618,154 → focus on dialog | at 615,154 → Description | `built` — not settled, re-test pending |
| DET-11 | placeholder "Description", no toolbar | identical | `matched` |
| DET-12 | bold, bullet and code input rules live | identical | `matched` — `<li><p>` vs `<li>` recorded |
| DET-14 | 864 wide, radius 10px, `rgb(31,31,31)`, same shadow | identical at rest | `built` — height 708 vs 710.6, re-measure pending |
| **DET-15** (new) | Cancel with unsaved edits asks "Discard unsaved changes?" | discards **silently** | **`divergent`** |
| **DET-16** (new) | rename that sets a date raises "Date updated to Tomorrow" + Undo, ~10s | **no toast** | **`divergent`** |

### Defects found

14. **No guard against losing unsaved edits.** Cancelling the detail editor with unsaved changes
    discards them immediately in meologue; Todoist asks first. `lifecycle.md` had verified this, but
    it never had a ledger row, so nothing ever compared it.
15. **No toast when a rename sets a date.** Todoist announces "Date updated to Tomorrow" with Undo for
    about ten seconds; meologue records the change only in its Activity section.

### One decision for the user, not a defect

**DET-03.** Todoist renders the "Activate to edit the task name" hint but does not link it to the
title, so assistive technology is never told they belong together. meologue links it through
`aria-describedby`. Matching Todoist exactly would mean removing that link. Recorded as a divergence
awaiting a decision, like ROW-12.

### Two readings that looked like findings and were not

- **"The detail modal is 5% too narrow."** meologue's dialog read 820.8×675.06 against Todoist's
  864×708. Every meologue number is exactly 0.95 of its resting value — it was read mid-way through its
  `zoom-in-95` opening animation, and `getBoundingClientRect` includes transforms. Both apps were in the
  same 1470×836 viewport, which each app's own rect confirms. At rest the width is 864 in both; only the
  height formula differs (708 against 710.6). A text-size setting was checked and ruled out first:
  `data-text-size` only scales Entry prose.
- **"A generic click focuses the dialog in both apps."** The run compared a Todoist click at 618,154
  against a meologue click at 615,400. At the comparable point meologue focused Description, not the
  dialog. Neither focused the title, which `lifecycle.md` records as verified for "a generic part of the
  combined edit block" — but one coordinate in two different layouts cannot settle a claim about a
  region, so DET-10 is being re-tested against a DOM-identified gap.

The general lesson: **read sizes only after animations settle**, and **compare interactions at the
same semantic location, not the same coordinates**.

### Safety log

- Todoist Inbox: 16 titles before, 16 after, **set-equal**.
- Two disposable tasks, `ZZ probe detail` and `ZZ probe rename`, created with their titles read back and
  real (settled, non-`tmp-`) ids saved immediately; both deleted with the confirmation dialog naming each,
  and confirmed absent afterwards.
- No stall. The stricter rules — foreground-only in the first prompt, a created-list artifact before
  measuring — held.

### Tally after flow 4

Read back from `parity-ledger.md`. Two rows were added (DET-15, DET-16), so there are now **127**.

| Status | Session start | After flow 3 | Now |
|---|---|---|---|
| `matched` | 17 | 37 | **45** |
| `built` | 74 | 41 | **32** |
| `todoist-captured` | 13 | 11 | 11 |
| `divergent` | 10 | 28 | **32** |
| `blocked` | 11 | 8 | **7** |

Eight rows reached `matched` (DET-01, 04, 05, 07, 08, 09, 11, 12). DET-02 and DET-03 became
`divergent`, the two new rows start there, and DET-04 was unblocked.

## Flow 5 — comments, the completion toast and activity

CMT-01 to CMT-08, plus re-tests of DET-10 and DET-14. Two disposable Todoist tasks under the stricter
rules; no stall. Artifacts: the `flow5-*` files in `live-audit-dom/`.

### Results

| Row | Todoist | meologue | Result |
|---|---|---|---|
| CMT-01 | Enter and Shift+Enter add a newline; Cmd+Enter and the button submit | identical | `matched` — was `built` |
| CMT-02 | `**bold**` → `<strong>`; URL is a real link **plus an unfurl card** | URL stays plain text, **not a link**, no card | **`divergent`** |
| CMT-03 | delete confirmation "Delete comment?" …; edit has explicit **Cancel / Update** | same confirmation; edit **saves on blur** | **`divergent`** — was `built` |
| CMT-04 | "1 task completed" + Undo, `role="alert"`, gone at **~11s** | `Completed "<task>"` + Undo, **no `role="alert"`**, gone at **~4.5s** | `divergent` |
| CMT-05 | Cmd+Z undoes a completion | does not (store confirms still completed) | `divergent` |
| CMT-06 | "You commented {content} on {task}", "You deleted a comment from {task}"; no event for edits | quoted content, no task names, extra "Edited a comment" | **`divergent`** — was `built` |
| CMT-07 | per-task activity: no filters, ends "That's it. No more history to load." | app-wide view has a "Completed only" filter, no end line | `divergent` — app-wide Todoist not established |
| CMT-08 | headings, quotes, fenced code render; `1.` stays literal | `1.` renders; headings, quotes, fenced code stay literal | **`divergent`** — was `blocked` |
| DET-10 | click at the gap between editors → **dialog** | → **Task name** | **`divergent`** |
| DET-14 | at rest 864 × 708 | at rest 864 × 710.594 (animation finished) | **`divergent`** — 2.6px height |

### Defects found

16. **Comment URLs are not links**, and there is no unfurl card.
17. **A comment edit cannot be cancelled** — meologue commits on blur; Todoist has Cancel and Update.
18. **The completion toast** says `Completed "<task>"` rather than "1 task completed", carries no
    `role="alert"`, and lasts ~4.5s against Todoist's ~11s.
19. **Cmd+Z does not undo a completion.**
20. **Activity wording**: quoted content, no task names in per-task entries, and an "Edited a comment"
    event Todoist does not record.
21. **Headings, blockquotes and fenced code** stay literal in comments.
22. **A generic click in the edit form** focuses the title; Todoist focuses neither field.
23. **Detail dialog height** uses a different formula (708 against 710.594 at an 836px viewport).

### Claims from the run that were not recorded

- **CMT-03 "matched".** Deletion wording is identical; editing is not, and that is a real difference.
- **CMT-04 "an ancestor carries `role=alert`".** The artifact records `null`.
- **CMT-07 "Reporting has rich filters (workspace, project, actor, action, date)".** That appears only as
  prose in the artifact's own `note` field. The saved page heading is the error "Todoist couldn't load
  the required files.", its filter candidates are the sidebar's buttons, and the end of history was
  never reached. A value written into an artifact's note is not a value read from the page.

### Corrections to the corpus

- `lifecycle.md` §3: the completion toast lasts about **11 seconds**, not 6–8. The original range came
  from coarse polling.
- `lifecycle.md` §1: "a generic click in the edit block focuses Task name" did not reproduce in two runs
  at a DOM-located gap, and is marked contested rather than struck, since the original click point was
  never recorded.

### Two measurement traps

- **Frozen animations.** meologue's dialog animation sat at `currentTime` 0 in the automated tab, which
  is what made flow 4 read it 5% narrow. Finishing the animation and requiring `transform: none` gave
  864 × 710.594, exactly as flow 4's arithmetic predicted.
- **A self-wiping store.** meologue's device id changed twice during the run and its seeded tasks
  vanished after a reload that followed the origin-storage clear. The affected rows were re-seeded and
  re-read, and the run switched to in-app navigation only.

### Safety log

- Todoist Inbox: 16 before, 16 after, **set-equal**, nothing only in one list.
- `ZZ probe comments` and `ZZ probe complete` deleted, each via a confirmation dialog naming it.
- Todoist's app-wide activity history now holds entries for the disposable tasks from flows 3 to 5, as
  accepted when writes were approved.

### Tally after flow 5

Read back from `parity-ledger.md`.

| Status | Session start | After flow 4 | Now |
|---|---|---|---|
| `matched` | 17 | 45 | **46** |
| `built` | 74 | 32 | **26** |
| `todoist-captured` | 13 | 11 | 11 |
| `divergent` | 10 | 32 | **38** |
| `blocked` | 11 | 7 | **6** |

CMT-01 reached `matched`. CMT-02, CMT-03, CMT-06, DET-10 and DET-14 became `divergent`, and CMT-08 was
unblocked into `divergent`.

## Flows 6 and 7 — the sidebar, the keyboard and the theme

NAV, KBD and THEME rows. Split across two runs because the first died on a usage limit: **flow 6** read
Todoist's whole side and meologue's navigation and theme; **flow 7** finished meologue's keyboard half.
Artifacts: the `flow6-*` and `flow7-*` files in `live-audit-dom/`.

### Method, and why Todoist was safe

Flow 6 was **read-only in Todoist**, with an explicit key allowlist — `?`, Escape, arrows, `j`/`k`, and
`g` then `i`/`t`/`u`. Everything else was forbidden, because in Todoist a bare `e`, `d`, `y` or Delete
acts on the focused task. When the run hit its usage limit, there was nothing to clean up: Inbox titles
were **16 before and 16 after, set-equal, nothing added or missing**. That is the argument for putting
read-only flows first when limits are unpredictable.

### Results

| Row | Todoist | meologue | Result |
|---|---|---|---|
| NAV-01 | Add task · Ramble · Search · Inbox · Today · Upcoming · Filters & Labels · **Reporting** · **My Projects** (link); counts in `aria-label` | … · **Activity** · **Projects** (heading); count in visible text | **`divergent`** |
| NAV-04 | `<nav>` with **no** `aria-label`; **no** `aria-current` anywhere | `<nav aria-label="Todo">`, `aria-current="page"` | **`divergent`** — decision |
| NAV-06 | `<h1>` + `<h2>` **My Filters** + `<h2>` Labels | `<h1>` + `<h2>` Labels | `built` — count untestable at 0 |
| NAV-08 | 13px / 400 | 13px / 400 | `matched` |
| NAV-09 | `<h1>` 26px/700/35px; **two `<header>` elements** | same heading; **zero headers**; column 800px | **`divergent`** |
| NAV-10 | "Add task", 14px, `rgb(128,128,128)` | "Add a Task"; size and colour **not trusted** | `built` — re-read needed |
| NAV-11 | "Reporting" → `/app/activity` | "Activity" → `/todo/activity` | **`divergent`** — label |
| KBD-01 | 8 sections, **80** rows, driven | 3 sections, **16** rows | `todoist-captured` |
| KBD-02 | `?` opens; Escape closes | identical | `matched` — was `built` |
| KBD-03 | arrows and `j`/`k` walk the rows | **not bound at all** | **`divergent`** |
| KBD-04 | wraps; includes Add task and completed | inapplicable — no focus movement | **`divergent`** |
| KBD-05 | inset `rgb(23,91,194)` ring + tint, no outline | default `outline`, no ring, no tint | **`divergent`** |
| KBD-06 | `g t` / `g i` navigate | identical; plus `.` menu and `/` Quick-find | **`divergent`** — subset |
| THEME-02 | sidebar `rgb(38,38,38)`, content `rgb(31,31,31)` | identical | `matched` |
| THEME-03 | borders, muted text, **focus ring** | first two identical, ring absent | **`divergent`** |
| THEME-04 | 14px/21px row, 13px chrome | identical | `matched` — was `built` |
| THEME-05 | system stack | byte-identical | `matched` |

### Defects found

24. **No row-to-row keyboard navigation.** Arrows and `j`/`k` move between tasks in Todoist and are not
    bound in meologue, so rows are reachable only by `Tab`. KBD-04's wrap cannot exist until this does.
25. **The focus ring is the browser default.** Todoist draws an inset `rgb(23,91,194)` ring with a
    translucent tint; meologue draws `outline: oklab(0.556 0 0 / 0.5) auto 1px`. `--td-focus-ring` is
    declared and consumed nowhere — the dead-token trap, now confirmed live.
26. **Sidebar labels and counts.** "Activity" against "Reporting", a plain "Projects" heading against a
    "My Projects" link, and counts in visible text rather than `aria-label`.
27. **The add-field label** reads "Add a Task" against Todoist's "Add task". Text only — its size and
    colour were not reliably measured.

### Corrections

- **NAV-09's own premise was wrong.** Todoist has **two `<header>` elements**, one labelled as the
  current view's header; meologue has none. The corpus saw the view name sitting in the column and
  concluded there was no app bar. The heading metrics do match exactly.
- **KBD-01 is now driven, not transcribed.** `?` opens eight sections totalling exactly **80**
  shortcuts — 13+11+15+17+5+3+11+5 — matching `keyboard.md`'s table. The method is recorded with it:
  the per-section counts came from a content-hashed class, and a second selector in the same run
  disagreed; only the total corroborates.
- **A defect was withdrawn, not recorded.** meologue's overlay looked like it ignored Escape
  (`dialogStillPresent: true`). Polling shows it present at 1,000ms and gone by 1,200ms — the same
  delayed close as its `.` menu (2,000ms) and `/` dialog (1,400ms). The single immediate check was a
  false negative, caused by the same frozen-transition behaviour that made flow 4 misread a dialog's
  width.

### A third decision for the user

**NAV-04** joins **DET-03** and **ROW-12**: in each, meologue is more accessible than Todoist, and
matching exactly means removing that. Todoist's sidebar names neither its landmark nor the current
page; meologue does both.

### Not established

- **Todoist's content-column width** this run — the reading taken was its 1190px main region, so the
  800px figure still rests on pass 2.
- **meologue's add-field size and colour** — the element captured looks like the editor box rather than
  the placeholder leaf, the same wrong-element error QA-16 and NAV-09 hit. Re-read the placeholder.
- **Todoist's `.` and `/`** — never pressed, because this run's own safety allowlist forbade them. A
  limit of the method, not a finding.

### Traps

- **Frozen transitions** produce false negatives on "did it close?" as reliably as on "how wide is it?".
  Poll for a state change; never take one immediate read as proof.
- **meologue's store wiped itself a third time** (a new device id and an empty task list), so flow 7
  re-seeded before measuring.

### Tally after flows 6 and 7

Read back from `parity-ledger.md`.

| Status | Session start | After flow 5 | Now |
|---|---|---|---|
| `matched` | 17 | 46 | **48** |
| `built` | 74 | 26 | **18** |
| `todoist-captured` | 13 | 11 | **8** |
| `divergent` | 10 | 38 | **47** |
| `blocked` | 11 | 6 | 6 |
