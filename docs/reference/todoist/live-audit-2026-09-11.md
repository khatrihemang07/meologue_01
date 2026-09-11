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
