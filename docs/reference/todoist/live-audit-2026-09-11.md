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
