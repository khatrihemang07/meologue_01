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

### Three further answers, given at the close of session 5

These were spoken after flow 8 was committed and are recorded here because no other artifact carried
them. They govern flow 9 and the fix phase.

- **The browser is released, so resume driving.** The user had held the ego-browser task space
  themselves during flow 8; they handed it back. No further wait for it is warranted.
- **STR-01, STR-02 and STR-07 get exactly one disposable project.** The account stands at 1 project
  of the free plan's 5, so `todoist-free-tier-caps-at-five-projects` does not bite here — the cap
  risk that blocked earlier structural rows simply does not arise at 1/5. The protocol: name it
  `ZZ probe`, take the measurements, delete it, and **read the project list back both before and
  after**, committing each reading. This is narrower than "Todoist writes are allowed" in general:
  one project, not one per row.
- **The fix phase is ordered by user impact, not by cost.** The cheapest-first ordering is
  explicitly rejected. The numbered defect list in this document is therefore re-read as an
  impact ranking when the fix phase begins, and a cheap fix does not jump the queue for being cheap.

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

## Flow 8 — the six readings that were refused

Not a new area: the six rows this audit had declined to close on weak evidence. Each had been left
open deliberately — a wrong element measured, a claim carried over from another session, or a question
the artifacts could not answer. Artifacts: the `flow8-*` files in `live-audit-dom/`.

### Results

| Row | Todoist | meologue | Result |
|---|---|---|---|
| NAV-09 | heading block 800px and list 800px, **two independent siblings**, 5px offset, shared ancestor 1175px | one 800px column | `divergent` — width confirmed, framing corrected |
| NAV-10 | "Add task", 14px, `rgb(128,128,128)` | "Add a Task", **14px**, `rgb(204,204,204)` | **`divergent`** — size resolved, colour and wording differ |
| SCHED-01 | trigger 1209.5,652 → popover 127,1097, 250×525 (flips up-left) | trigger 1123,379 → popover 427,1123, 250×525 | `built` — anchoring matched; #255 still blocks |
| SCHED-03 | hides the quick option matching the current date | **still lists "Today"** on a task due today | **`divergent`** |
| DATE-01 | date control holds an inline calendar `<svg>` | no icon | **`divergent`** — icon clause closed |
| QA-19 | `Shift+Enter` closed Quick Add and created the task | driven earlier in the programme | `built` — halves in different sessions |

### Defects found

28. **The add-field placeholder is the wrong grey** — `rgb(204,204,204)` against `rgb(128,128,128)` —
    and reads "Add a Task" against "Add task". Its 14px size is correct; the earlier "16px white"
    reading was the editor box, not the placeholder.
29. **The scheduler does not hide the option matching a task's current date.** Todoist drops "Today"
    for a task already due today; meologue still offers it.
30. **The date badge has no calendar icon.** Todoist's date control carries an inline 12×12 `<svg>`.

### What each refusal was worth

Every one of the six had been held back for a stated reason, and in four cases the reason was right:

- **NAV-10** was refused because the captured tag looked like a container. It was: the placeholder is
  14px, not 16px, and recording the earlier reading would have invented a size defect while missing
  the real colour one.
- **NAV-09** was refused because the reading taken was the 1190px main region. The column is 800px —
  but so is the heading block, separately, and their shared ancestor is 1175px. The naive common
  ancestor would have been a third wrong answer.
- **SCHED-03** was refused because neither opening was tied to a task. Tying them found that
  meologue's own rule holds *and* that the follow-on question fails.
- **DATE-01's** icon clause had never been read on Todoist's side at all.
- **QA-19** stays `built` on a technicality — both halves are now driven, but in different sessions,
  and ADR 0077 wants them in one. Stated rather than waved through.

### Safety log

- Todoist Inbox: 16 titles before, 16 after, **set-equal**.
- **Three tasks were created, and all three deleted**, each against a confirmation dialog quoting its
  name. One of them, `ted`, was **unintended**: the first Quick Add attempt typed after a fixed 400ms
  wait instead of polling for focus, so only the last three characters landed and Todoist created a
  task from them. It was found, confirmed by title and removed. The fix — poll `document.activeElement`
  until it is inside the dialog, then assert the accumulated text after every keystroke — is now
  recorded, because a fixed wait is precisely how an agent writes unintended data into a live account.

### Tally after flow 8

Read back from `parity-ledger.md`. Two status cells had to be corrected first: DATE-01 and SCHED-03
were described as divergent in their notes while their status column still read `built`.

| Status | Session start | After flows 6–7 | Now |
|---|---|---|---|
| `matched` | 17 | 48 | 48 |
| `built` | 74 | 18 | **15** |
| `todoist-captured` | 13 | 8 | 8 |
| `divergent` | 10 | 47 | **50** |
| `blocked` | 11 | 6 | 6 |

## Flow 9 — labels, filters and the structural objects

The last flow, and the only one driven across two sessions. Todoist's label and filter readings were
taken on 11 Sep; meologue's half, and everything about Projects and Sections, on 12 Sep.

### Method, and the ADR problem it had to solve first

ADR 0077 is explicit: *a row is established by driving both applications in the same session.* Flow
9 began already in breach of that — four rows (STR-03…06) had a committed Todoist half from the day
before and nothing on meologue's side. Pairing those across two days would have produced seven
terminal rows resting on a rule the repo had just adopted and then quietly bent.

So Todoist's side was **re-read on the 12th before any status was set**, and it reproduced the 11 Sep
reading in every particular: the label options menu's five items in the same DOM order, the Add and
Edit dialog shapes with their 0/60 and 14/60 counters, the filter cap still at `Used: 3/3`, and the
unquoted name in the delete body. That re-read is committed as
`live-audit-dom/flow9-todoist-reread-2026-09-12.json`, and every STR-03…06 note now says the row is
same-session rather than cross-day.

Two disposable objects were written to the real account, both under the stricter rules: a label
(`zz probe label`, id 2185034826) and a project (`ZZ probe`, id `zz-probe-6hVXq42jpVmjG5Wr`, carrying
one section). Both were deleted against confirmation dialogs quoting their names. Nothing else was
created; the user's three filters, one project and Inbox were read only, with the `Priority 1` Edit
dialog and the section menu both closed with Escape without saving.

### Results

All seven STR rows were `built` and one-sided at the start of this flow. All seven are now terminal,
and all seven are `divergent` — but for three different reasons, which matters more than the count.

**One real defect, with two sites.** STR-03 and STR-01 are the same bug. Todoist writes
`The zz probe label label will be permanently deleted.` and `The ZZ probe project and all its tasks
will be permanently deleted. This action cannot be undone.` — the name bare. meologue reproduces
every character of both except that it wraps the name in ASCII double quotes. Headings, button pairs
and, for the project, both sentences match exactly. The ledger's meologue-evidence column claimed
"verbatim" for both rows; it was wrong for both.

What makes this worth fixing rather than arguing about is that **meologue already contradicts
itself**: `todo-page.tsx:1059` renders the Task delete body with the name bare, exactly as Todoist
does, while `labels-view.tsx:150` and `project-view.tsx:416` quote it. The intended style is already
in the tree at one of three call sites.

**Capability parity, divergent surface.** STR-02, STR-04, STR-05 and STR-07 all match on what the
nuance actually claims and differ only in how it is reached. Todoist routes label create/rename/
recolour and project editing through modal dialogs; meologue does all of it inline, following
`projects-view.tsx`. Two findings inside this group are worth more than their rows:

- **The palettes are a 20-for-20 match** — berry red, red, orange, yellow, olive green, lime green,
  green, mint green, teal, sky blue, light blue, blue, grape, violet, lavender, magenta, salmon,
  charcoal, grey, taupe — identical membership in identical order, differing only in casing.
- **Todoist is not uniformly modal, and Sections are where the two apps agree.** Todoist's project
  *create* is an inline tiptap editor at the foot of the project tree, not a dialog; its section
  create and rename are both inline too. Sections are the one structural object where meologue's
  inline shape is also Todoist's.

**One row a free plan cannot close.** STR-06's capability parity holds — meologue drove all four
filter operations end to end, and the filter id held steady across rename and recolour — and the
live preview matches on both sides. But Todoist sits at `Used: 3/3` with an "Unlock more filters"
button, so its create/rename/recolour could not be executed and **its filter delete wording remains
uncaptured**. A fourth filter is forbidden and editing one of the user's three real ones is
destructive. Recorded as a tier limit, as this row's note already predicted.

### Defects found

- **Defect 31 — the destructive confirmation quotes the name where Todoist leaves it bare.** Two
  sites: `labels-view.tsx:150` (STR-03) and `project-view.tsx:416` (STR-01). `todo-page.tsx:1059`
  is already correct and shows the intended style. Cheap, and it removes an internal inconsistency
  as well as a parity gap.
- **Defect 32 — no character counter on the Label name field.** Todoist's Add/Edit label dialogs
  carry `0/60` and `14/60`; meologue's name input has no `maxLength` and no counter. The project
  equivalent is `8/120` and also absent. Minor, and cosmetic rather than functional.

### A fourth decision for the user

Three rows already await ratification because meologue is *more* accessible than Todoist (NAV-04,
DET-03, ROW-12). Flow 9 adds a fourth, and it recurs on both delete dialogs:

- **meologue's destructive dialogs are `role="alertdialog"`; Todoist's are `role="dialog"`.**
  `alertdialog` is the correct role for a confirmation that interrupts to prevent data loss, so
  strict DOM parity here means *downgrading* meologue's ARIA. Recorded on STR-01 and STR-03 as a
  difference in meologue's favour, not as a defect.

meologue's reorder controls are a milder instance of the same tension: `Move "x" earlier` / `Move "x"
later` buttons are keyboard-operable where Todoist's section drag is not.

### Measurement traps, all three new

- **`offsetParent === null` is not a visibility test.** It is null for every `position: fixed`
  element, and meologue's dialogs are fixed — so the visibility filter that correctly excludes
  Todoist's permanent invisible `<h1>` silently finds *no dialog at all* in meologue. Filter on
  `data-state="open"` instead, or do not filter.
- **`textContent` does not include input values.** A section created successfully was reported
  missing because its name lives in an `<input value>`; the heading counter (`Sections (1/20)`) and
  the per-row `aria-label`s were the evidence that it existed. The same trap makes a Todoist filter
  row read `"Priority 11"` once its task-count badge loads, which is why the row had to be found by
  `href` rather than by name.
- **A counter read from concatenated text can be wrong by a digit.** Sweeping
  `/\d+\/\d+/` over Todoist's Edit filter dialog returns `110/1024`, because the query value
  `priority 1` abuts the counter `10/1024`. The real counter is `10/1024`.

A fourth, already known but seen from the other side: an immediate read after clicking Delete
reported meologue's dialog still mounted. That was its exit animation in flight, not a stuck dialog —
a probe one round later found no dialog node, and finishing every running animation changed nothing.

### Safety log

- Todoist projects: **1 before, 1 after**, the same `Getting Started` project.
- Todoist labels: **0 before, 0 after**.
- Todoist filters: **3 before, 3 after**, the same three hrefs, unchanged after both Escapes.
- **Two objects created, both deleted**, each against a dialog quoting its name. No unintended
  writes this time — the Add-label and Add-project names were typed only after polling for focus
  inside the editor and were asserted character-exact before submitting, which is flow 8's `ted`
  lesson applied.
- meologue's test origin: the `zz probe` label and filter and the `ZZ probe` project and its section
  were all created and deleted; both lists are back to their empty states and no Task was touched.

### Tally after flow 9

Read back from `parity-ledger.md` with `awk` over the status column, not counted from the edits.

| Status | Session start | After flow 8 | Now |
|---|---|---|---|
| `matched` | 17 | 48 | 48 |
| `built` | 74 | 15 | **8** |
| `todoist-captured` | 13 | 8 | 8 |
| `divergent` | 10 | 50 | **57** |
| `blocked` | 11 | 6 | 6 |

127 rows, and **flow 9 closed the last of the STR rows: all seven are terminal.**

The eight rows still reading `built` are the honest residue, and the first draft of this section
described them wrongly as belonging to no flow. They do not: they sit inside areas flows 2–8 drove
and were simply never closed individually.

| Row | What is still open |
|---|---|
| `QA-14` | the `@` label popup's "Label not found. Create X" fallback |
| `QA-19` | whether `Shift+Enter` submits rather than inserting a newline |
| `SCHED-01` | the scheduler popover's 250×525px geometry, radius and colours |
| `ROW-06` | Markdown in a title staying literal |
| `ROW-09` | metadata blocks as adjacent flex children with no separator glyph |
| `NAV-02` | the sidebar rendering only inside `/todo/*` at ≥900px |
| `NAV-03` | no sidebar below 900px, bottom bar remaining |
| `NAV-06` | "Filters & Labels" as one destination with a combined count |

Five of these look cheap. `NAV-02`, `NAV-03` and `NAV-06` are viewport-width and DOM-presence reads
needing no writes to either account, and `ROW-06`/`ROW-09` are single computed-style reads. `QA-14`,
`QA-19` and `SCHED-01` need real typing and a popover measured after its animation settles.

So the bar the user set — every row `matched` or `divergent` with a recorded reason — is **not yet
met for these eight**. Every other row in the ledger meets it.

## Flow 10 — the eight rows flow 9 left behind

Flow 9's own section closed with a table of eight rows still reading `built` and the admission that
the user's bar was not met for them. This flow went after those eight. **Seven are now terminal.
One cannot be closed by measuring at all**, and saying which is the point.

### What could not be closed, and why

`SCHED-01` is held on **issue #255** — More-actions → "Date…" opens the scheduler on roughly 2 of 10
mouse clicks, deterministic by row position. Its geometry (250×525, radius 10px, `rgb(38,38,38)`,
`1px solid rgb(61,61,61)`) and its anchoring are **already** read on both sides, in one session, in
flow 8. Nothing is missing from the measurement. The row is waiting on a fix, and #255 and #256 are
both still open. So the target was seven, not eight, and re-measuring it would have been busywork.

### Results

**Two rows had no second app to drive.** `NAV-02` and `NAV-03` cite **ADR 0076**, not Todoist — they
are claims about meologue's own shell. Driven by CDP at 1200, 900, 899 and 600 CSS px with SPA
navigation only: at ≥900px the sidebar is a single 306×900 left pane, present inside `/todo/*` and
**absent on `/`** (`navCount: 0`); at 899 and 600px it is gone and the bottom bar is a 53px full-width
strip flush with the viewport bottom. **Exactly one `nav[aria-label="Todo"]` exists at every width** —
they swap rather than coexist — and the boundary is inclusive at 900, matching `WIDE_LAYOUT_QUERY`.

Both are recorded `matched`, which **stretches the vocabulary**: the ledger defines `matched` as
"driven in both apps side by side", and these cannot be that. Here it means "conforms to its ADR,
verified live". The status vocabulary has no word for an architecture-conformance row. That is
flagged for the user rather than resolved by fiat.

**One row's own reference document was wrong.** `ROW-06` claimed, on `row-and-detail.md` §1's
authority, that *Todoist keeps markdown in a title literal*. It does not. Todoist **parses markdown
in a task title at render time**.

Proving that took three attempts, because the obvious tests destroy the evidence. Todoist's Quick Add
is a ProseMirror field whose input rules convert `**bold**` as you type; its **paste handler converts
a pasted markdown string too**; and a single undo reverts the entire typing burst rather than just
the auto-format transaction. The route that worked: type the pattern **one character short** of
completion (`**bold2*`, an odd delimiter count the input-rule regex cannot match), then paste **only
the closing character**, which completes the pattern without triggering conversion. The composer was
verified as a single plain text node with **zero marks**, and the created row still rendered
`<div class="task_content">ZZ probe <strong>bold2</strong> <em>em2</em> <code>code2</code></div>`.
Corroboration that two distinct mechanisms are in play: this task's tab title preserved `_em2_`
**unnormalized**, where a compose-time-converted task's normalized to `*em*`.

**Why the original inference failed is worth more than the row.** It reasoned from
`div.task_content` carrying no nested markup across the 7 observed tasks — while explicitly noting
that none of those 7 had markdown in its title, and calling that a gap. A plain div is exactly what a
*rendered* container looks like when there is nothing to render. The argument was careful, hedged,
honest about its own limit, and wrong. `row-and-detail.md` now carries a dated correction block.

This is the clearest vindication so far of **ADR 0077**: a pinned capture claim stood until somebody
typed the characters. Note the direction of the divergence — **meologue keeps title markdown
literal**, so meologue implements what the corpus predicted of Todoist.

**One row was a hedge that had to be unpicked.** `ROW-09`'s first verdict reported Todoist's metadata
container as `gap: normal` and meologue's as `8px`, then called the row a MATCH anyway on the grounds
that both are "simple adjacent flex children either way". That concealed a real question: if Todoist
sets no gap, what makes its spacing? Re-measured per child: Todoist's 8px comes **entirely from
`margin-right: 8px` on the first child** (edge-to-edge 506.55 → 514.55) with no column-gap on the
container; meologue's children carry zero margin and padding and its 8px is a real
`column-gap: 8px`. Identical 8px on screen, different mechanism. Recorded `matched` because every
observable the row asserts holds on both sides — adjacent flex children, 8px apart, **no separator
glyph** (checked as text nodes) — with the mechanism difference noted rather than scored. If the
corpus means to cover both apps it should say "with 8px of separation", not "with a gap".

**Two rows were straightforward divergences.** `QA-14`: Todoist opens a real autocomplete after `@`
(`role=listbox`, `data-testid="content-editor-suggestions-dropdown"`) with a
**"Label not found.Create …"** fallback — re-run with the nonsense token `zzznotalabel` to prove it
is a genuine fallback and not a coincidental match. meologue has **no popup of any kind**, only the
inline `.td-recognition-match` highlight. One honest caveat: with 0 labels in the account, the
*populated* suggestion list was never seen, only the fallback.

`NAV-06`'s count clause is settled after being untestable in flow 6. Todoist's sidebar entry renders
**no count at all**, confirmed in a state that would show one (3 filters). meologue renders a **live
combined sum**, measured across five states: 0/0 → nothing, 1 filter → `1`, 1 filter + 1 label →
`2`, 1 label → `1`, back to 0/0 → nothing. So it is `filters.length + labels.length`, live, and
suppressed at zero — a feature Todoist does not have. This also corrected the guess this flow started
from, which had only half the model. meologue still has **no "My Filters" heading**.

**One row needed only a paired pass.** `QA-19` was already driven on both sides, but in different
sessions. Both halves were re-driven now: `Shift+Enter` **submitted and closed/cleared the composer
in both apps** — Todoist's `[data-testid="quick-add"]` left the DOM and its Inbox went 9 → 10;
meologue's row appeared. Both disposable tasks were deleted against each app's own "Delete task?"
dialog.

### A conflict the ledger cannot resolve

The user's own Todoist Inbox contains a task complaining that, in meologue, "Shift enter is also
counting just like enter. Wrong."

`QA-19` now certifies that exact behaviour as **correct parity**, because Todoist does submit on
`Shift+Enter`. So parity with Todoist and what the user wants point in opposite directions on this
row. This is recorded, not resolved: it is the user's call whether parity or their own preference
wins, and it is the first row in this programme where the two are known to conflict.

### Defect found

- **Defect 33 — the two navigations do not cover the same destinations, and `/todo/projects` is
  unreachable at ≥900px.** Sidebar: Add task · Search · Inbox · Today · Upcoming · Filters & Labels ·
  Activity. Bottom bar: Inbox · Today · Upcoming · **Projects** · Activity · Filters. At ≥900px there
  is **no link to `/todo/projects` anywhere on the page**, while the sidebar simultaneously prints
  "No Projects yet — add one from the Projects list." — naming a destination the reader cannot reach.
  The route works when typed.

  This is **NAV-03's own warning coming true in reverse**. That row's note already records Upcoming
  being added to `todo-sidebar.tsx` alone and stranding touch users; Projects lives in
  `todo-nav.tsx` alone and strands desktop users. And the principle it states — "a new destination
  has to enter both" — is **enforced by nothing**: no test asserts parity between the two navs, and
  each holds its own separate destination list. `Add task` and `Search` are likewise sidebar-only,
  and the same destination reads "Filters & Labels" in one nav and "Filters" in the other.

  Worth noting for whoever probes this next: **both navs carry the identical `aria-label="Todo"`**
  (`todo-sidebar.tsx:203`, `todo-nav.tsx:96`), so that selector cannot tell them apart — distinguish
  them by rect or link set.

### Measurement traps, two more

- **`offsetParent === null` is not a visibility test** — it is null for every `position: fixed`
  element, and meologue's dialogs are fixed, so the filter that correctly excludes Todoist's
  permanent invisible `<h1>` finds *no dialog at all* in meologue. The two apps need opposite
  filters. (First recorded in flow 9; it bit again here.)
- **The single-window lock and the store wipe are different failures, and the wipe is permanent.**
  meologue's test origin showed "already open in another window" with an empty Inbox. The lock was
  held by **whole leftover task spaces** from earlier flows (42, 43, 45), not just loose tabs, and it
  took roughly five minutes to clear after they were closed — long enough to look permanent. Once it
  cleared the Inbox was **still genuinely empty**: the seeded `ZZ probe` fixtures were gone, not
  merely unreachable. An empty list *plus* `locked: false` means the store really is empty — re-seed,
  and never read a fixture's values from a previous session's notes. `ROW-09`'s meologue half was
  therefore measured on a like-for-like row recreated for the purpose, which is flagged in its
  artifact rather than passed off as the original.

### Safety log

- Todoist projects, labels, filters and **all 16 Inbox titles: set-equal before and after.**
- **Two disposable tasks** created across this flow (one for QA-19/ROW-06, one for ROW-06's decisive
  test) and both deleted, each title read back first. The QA-14 probing created nothing — Todoist
  interposed a **"Discard unsaved changes?"** confirmation rather than closing on Escape, and it was
  explicitly discarded.
- One deletion hit a genuine Todoist UI bug: the confirm dialog's Delete button was covered by an
  intercepting `<div>` when the confirm opens from inside the task-detail dialog. Resolved without
  forcing anything — the button already held DOM focus, so `Enter` was pressed. No coordinate hacks.
- meologue's test origin: every object created in this flow was deleted.

### Tally after flow 10

Read back from `parity-ledger.md` with `awk` over the status column.

| Status | Session start | After flow 9 | Now |
|---|---|---|---|
| `matched` | 17 | 48 | **52** |
| `built` | 74 | 8 | **1** |
| `todoist-captured` | 13 | 8 | 8 |
| `divergent` | 10 | 57 | **60** |
| `blocked` | 11 | 6 | 6 |

127 rows. **One row still reads `built`: `SCHED-01`, and it is blocked on a fix rather than on a
reading.** Every other row in the ledger is `matched`, `divergent`, `blocked` or `todoist-captured`
with its reason recorded — so the user's bar is met everywhere except that one row, and the reason it
is not met there is itself recorded.

The eight `todoist-captured` rows remain what they have always been: things known about Todoist that
meologue has not built.

## The fix phase — five rows, and four bugs no test could see

Ordered by user impact, as the user directed, not by cost. The cheapest fix on the list (defect 31,
the quoted name in a delete dialog) is still unfixed, deliberately, because it sits low on impact.

Five rows moved to `matched`: KBD-03, KBD-04, KBD-05, THEME-03, CMT-03, CMT-05 — and SCHED-01, which
was held at `built` by issue #255 alone. **With SCHED-01 closed, every one of the ledger's 127 rows
is terminal for the first time: 59 `matched`, 54 `divergent`, 8 `todoist-captured`, 6 `blocked`, 0
`built`.**

Each row's own ledger note carries its implementation detail. What follows is only what generalises.

### Four bugs that passed a green suite

Every one of these was invisible to a suite that grew from 3,287 to 3,312 passing tests across the
phase. They are worth listing together because the *reasons* they were invisible differ.

1. **A focus trap in the Add-task composer** (row navigation). Arrows could enter the composer from
   either side and never leave, in either direction — worse than the keys being unbound, because it
   looks broken. The suite was green because **two individually-correct tests combine into the bug**:
   one asserting "arrows in a text field don't move row focus", another asserting "the cycle includes
   the Add-task field". Both true. Together they describe a trap.

   The deeper reason: **jsdom does not implement `HTMLElement.isContentEditable` at all** — it reads
   `undefined`, probed rather than assumed. So `isTypingTarget()` never classifies a contenteditable
   as a typing target under test, and **no test in this repo can verify that any binding is
   suppressed while typing in the real composer.** The existing "text field" test used a bare
   `<input>` outside the composer, and the composer's own test double was a `role="textbox"` div that
   jsdom would not have honoured either way. That is a standing blind spot, not a one-off.

2. **Escape was silently saving the comment edit it was meant to discard.** The handler called
   `setDraft(original)` then `.blur()` synchronously; React state does not flush in that window, so
   `onBlur={commit}` still saw the edited text. Proved with a failing test first — and it only
   reproduces when the textarea is genuinely focused, since `.blur()` on an unfocused element is a
   no-op in jsdom and in browsers alike, which produced a false negative on the first probe.

3. **`Cmd+Z` had never worked in any Task title editor.** `task-title-editor.tsx` bound
   `"Mod-z": undo` but never registered `history()`, the plugin those commands read their state
   from — so it was a silent no-op in the composer, a row's inline rename and the detail view's
   title alike. `composer-editor.ts` registers it correctly, which is what makes this an oversight
   rather than a decision.

   **This is the same shape as this ledger's dead `--td-*` tokens**: wiring that reads as finished
   and does nothing. `--td-focus-ring` was declared and consumed by nothing; here a keymap was bound
   to commands with no plugin behind them. Three instances of the token version (QA-16, QA-20,
   KBD-05) and now one of the keymap version. **A name being present is not evidence it is wired.**

4. **Issue #255's mechanism was not what anyone thought.** See below.

### Issue #255, and why two prior fixes missed

Everyone — the issue's author, both reverted attempts, and the brief this phase wrote — assumed the
**pointer** path: a click landing on whatever sits beneath the menu as it unmounts, read as an
interact-outside. It is not. `document.body`'s `pointer-events` guard stayed benign throughout the
failing sequence.

It is a **focus fight between two simultaneously-mounted Radix `FocusScope`s.** Selecting the item
opens the popover in the same tick, but the menu's `Content` is still alive through `Presence`'s exit
animation, and `@radix-ui/react-focus-scope`'s autofocus effect — unconditional, and recomposed fresh
on every render — re-runs, sees focus now outside its own container, and yanks it back. The popover's
`DismissableLayer` reads that as focus leaving and dismisses itself. A same-tick open-then-close never
paints, which is exactly the reported "no DOM node at all".

Found by instrumenting `EventTarget.prototype.dispatchEvent` to log Radix's internal discrete events,
so the mechanism is traced rather than inferred. Both earlier attempts assumed the menu was returning
focus to its *trigger*; `modal={false}` only removes the trapped-focus variant of an effect that
exists regardless of modality. **The positional determinism — bottom rows always worked, upper rows
never did — was a real clue pointing at the wrong thing.**

The fix defers the open to the menu's `onCloseAutoFocus`, the one signal meaning nothing is left to
steal focus back. Verified independently of the fixing agent: **6 of 6 mouse attempts** across four
upper rows and two bottom ones, where upper rows had been 0 of 7.

### What the fixes deliberately did NOT do

- **Extend the focus ring past what was measured.** Tailwind v4's layer order means a `@layer base`
  rule loses to any `focus-visible:ring-*` utility, so the composer and dialog buttons keep their own
  rings. Left that way on purpose: the audit measured Todoist's ring **on a row** and never measured
  Todoist's own composer or dialog-button focus, so painting it there would be extrapolation past the
  evidence. The checkbox is untouched for a stronger reason still — its inline `box-shadow` is the
  **priority** ring (PRI-05/PRI-06), and taking it over would destroy one measured behaviour to
  satisfy another.
- **Force `role="alert"` onto the toast.** sonner 2.0.8 exposes no `role` field on any of its option
  types and its rendered `<li>` hardcodes props with no spread, leaving only `toast.custom()` with
  hand-built JSX or a runtime DOM patch. CMT-04 stays open on that point, with the reason evidenced.
- **Change CMT-04's wording.** `Completed "buy milk"` names the task; Todoist's `1 task completed`
  does not. Matching would make the message *less* informative, so it waits on the user.

### Two costs this phase introduced, recorded rather than hidden

- **The scheduler popover now opens after the menu's exit animation completes** — measured ~215ms on
  two rows and ~1150ms on four. The long readings are almost certainly the automated tab throttling
  animations rather than what a reader sees, but the fix is now **coupled to that animation's
  duration**: slow it or add one, and the delay grows with it.
- **A test harness was found to be inert.** `task-command-menu.test.tsx` pinned `open: true` forever,
  so Radix's close transition — and therefore the entire code path #255 lives in — was never
  exercised by it at all. Two other tests asserted the popover appeared synchronously and became
  genuinely wrong once the open was deferred.

### Method notes for the re-drive

- **Two agent reports were materially wrong and both were caught by checking them.** One declared a
  feature absent from the running build, having grepped the *main* checkout rather than this
  worktree — its DOM claim was false too, since the attribute was present four times on the page.
  Another called a row `MATCH` while its own numbers showed `gap: normal` against `8px`. The rule
  that catches these is the one this document already runs on: **verify every agent claim against
  its artifact, and re-read the artifact rather than the summary.**
- **A service worker serves stale assets.** This app registers one, so a rebuild is not enough:
  unregister it, clear caches, and **compare the served `index-*.js` hash against the build output**
  before believing any on-screen reading. Several checks in this phase would have measured the old
  app otherwise.
- **Commands are split by package.** `pnpm build:web` and `pnpm vitest run` exist only in
  `apps/web` — there is no root vitest binary at all — while `biome:check` and `graphify` run from
  the repo root. Handoffs quote these bare and send you to the wrong directory.
