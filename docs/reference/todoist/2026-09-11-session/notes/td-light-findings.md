# Todoist THEME-01 — light-theme capture, pass 3 (final)

Task space 31, page `p1`, https://app.todoist.com/app/settings/theme and
`/app/today`. This pass actually exercised the one untested combination:
OS confirmed Light, select a non-Dark theme, click **Update** to persist it,
then hard-reload (`Page.reload({ ignoreCache: true })`) and measure the
**settled** state (`document.readyState === "complete"`, htmlClass stable
across repeated reads) rather than the transient post-click paint.

## Headline result: light does NOT render under this account, for any theme tried

| Theme tried | Selected + Update clicked | Pre-reload paint (transient) | Settled state after hard reload |
|---|---|---|---|
| Todoist | yes | `theme_todoist`, body `rgb(252,250,248)` (looked light) | `theme_todoist todoist_loaded`, body `rgb(40,28,17)` — dark warm-brown, **identical to Attempt 1's corpus value** |
| Moonstone | yes | not captured separately | `theme_moonstone todoist_loaded`, body `rgb(27,29,30)` — dark, near-black |

**The pre-reload "light" paint was a false signal, not a real render.** Screenshot
`l08-after-reload.png` caught only the loading splash; the settled screenshot
(`l09-settled.png`) — taken after `readyState === "complete"` and a stable
htmlClass — shows the same warm-brown/sepia palette that Attempt 1 already
measured under OS-Dark. `l11-moonstone-settled.png` likewise shows Moonstone
fully dark (near-black, not the light preview swatch). Both screenshots show
the Settings → Theme swatch grid with a checkmark confirming the selection
was actually saved (not just clicked), so this is not a case of Update failing
to persist.

**Conclusion:** OS appearance has no bearing on which palette these themes
render. "Todoist" and "Moonstone" are just themed dark/sepia palettes on this
account regardless of `prefers-color-scheme`; the white/light card art in the
Settings picker is decorative and does not represent the actual rendered
palette (this was already suspected from Attempt 2 and is now confirmed with
an actual Update+reload on both candidates).

Per the mission's stop condition (both candidates dark ⇒ stop, do not sweep
all 9 again): **stopping here.** `THEME-01` remains blocked; a genuine light
render of Todoist has not been produced in three attempts across OS-Dark and
OS-Light, with and without an explicit Update save.

## Dark Reader contamination check (re-verified this pass)

Measured on the live page before any theme change (dark, `theme_dark`) and
again after the Dark-theme restore at the end of this pass:

| Signal | Count |
|---|---|
| `style.darkreader` nodes | 0 |
| `[class*="darkreader"]` nodes | 0 |
| `[data-darkreader-inline-bgcolor]` nodes | 0 |

**Clean**, consistent with both prior passes. Dark Reader's proxy is present
(`data-darkreader-proxy-injected="true"` on `<html>`, seen in `l04-resume-check.log`)
but not applying any restyle markers.

## Dark-vs-light comparison table

Every light-side row is **gap** — no theme tested in any of the three passes
produced a genuinely light render to measure against. Dark-side values are
carried forward from the existing corpus (verified in prior passes on this
account, `theme_dark`).

| Item | Dark (verified) | Light | Status |
|---|---|---|---|
| body / sidebar background | `rgb(38,38,38)` | — | gap — no theme rendered light (Todoist → `rgb(40,28,17)`, Moonstone → `rgb(27,29,30)`, both dark) |
| content pane background | `rgb(31,31,31)` | — | gap |
| row divider | `1px solid rgb(61,61,61)` | — | gap |
| row title colour | `rgb(255,255,255)` | — | gap |
| row height / title size | 59px; 14px/21px | — | gap |
| date: Today | `rgb(37,184,76)` | — | gap |
| date: Tomorrow | `rgb(255,154,20)` | — | gap |
| date: completed task | `rgb(204,204,204)` | — | gap |
| completed title | `rgb(128,128,128)` + line-through | — | gap |
| checkbox ring P1 (hair wash) | 18×18, 2px, `rgb(255,112,102)` | — | gap |
| checkbox ring P4 (naukri photo update) | 18×18, 1px, `rgb(169,169,169)` | — | gap |
| Quick Add dialog | 580×97, r12, pad16, bg `rgb(40,40,40)`, border `1px solid rgb(61,61,61)` | — | gap |
| recognition span ("tod") | inline-block, 4/4 pad, bg `rgb(111,38,37)`, colour white, r3, 16px/23px | — | gap |
| scheduler popover | 250×525, r10, bg `rgb(38,38,38)`, border `1px solid rgb(61,61,61)` | — | gap |
| view heading (`<h1>`) | 26px / 700 / 35px | — | gap |
| content column / sidebar width | 800px / 280px | — | gap |

## Mandatory cleanup — verbatim proof

Restored via Settings → Theme → **Dark** → **Update**, then hard-reloaded
(`Page.reload({ ignoreCache: true })`), waited for `readyState === "complete"`:

```
DARK RESTORE VERIFY: {
  "htmlClass": "theme_dark todoist_loaded",
  "bodyBg": "rgb(38, 38, 38)",
  "bodyColor": "rgb(255, 255, 255)",
  "darkReaderStyleCount": 0,
  "darkReaderClassCount": 0,
  "darkReaderInlineBgCount": 0,
  "readyState": "complete",
  "url": "https://app.todoist.com/app/settings/theme"
}
```

Screenshot `l13-dark-restored.png` shows the Dark swatch checked and the full
app rendered dark. **Sync theme** was left ON and **Auto Dark Mode** left OFF
throughout — neither was touched at any point in this pass.

## Task list unchanged (read-only confirmation)

Read via nav aria-labels immediately after the Dark restore, compared against
the same read at the start of this pass (`l05-snapshot.log`):

| Nav item | Start of pass | After cleanup |
|---|---|---|
| Inbox | 7 tasks | 7 tasks |
| Today | 2 tasks | 2 tasks |
| Getting Started 👋 (project) | 14 tasks | 14 tasks |

No task, project, filter, or label was created, completed, edited, or deleted.

## Bottom line for whoever reads the ledger next

`THEME-01` is blocked, and this closes out the investigation rather than
leaving it open: three passes have now tested — (a) Todoist theme selected
and saved under OS-Dark [Attempt 1], (b) OS switched to Light with no
Todoist setting touched [Attempt 2], and (c) Todoist and Moonstone themes
each explicitly selected and saved via Update while OS is Light, verified
after a hard reload past the transient loading paint [this pass]. All three
produced a dark render. The account's available themes (on the Free plan:
Todoist, Dark, Moonstone, Tangerine) do not include a theme that renders a
true light palette matching the target design system; capturing a light
Todoist palette on this account is not achievable without a Pro-tier theme
(Kale/Blueberry/Lavender/Raspberry, all locked) or a different account.
Recommend closing `THEME-01` as blocked-on-plan-tier, or re-scoping it to
build the light palette from Todoist's public brand/marketing colors instead
of a live capture.
