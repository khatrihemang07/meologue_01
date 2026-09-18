/**
 * CMT-05 (parity ledger) — how long a completion toast stays up, measured
 * live rather than trusted from `meologue-reference/todoist/lifecycle.md`'s own
 * once-coarse estimate. That doc's "6-8 seconds" came from 2-second polling
 * and doesn't reproduce; a 300ms re-poll (flow 5,
 * `meologue-reference/todoist/live-audit-dom/flow5-CMT-05-todoist.json`) found
 * Todoist's own toast still present at 10,775ms and gone by 11,081ms.
 * meologue's matching toast (`flow5-CMT-05-meologue.json`) was gone between
 * 4,346ms and 4,651ms — sonner's own unconfigured default, not a value
 * anyone chose. ADR 0077 makes the live reading the reference over the
 * dated capture, so this targets Todoist's measured ~11s rather than the
 * ledger row's own nuance text.
 *
 * **Corrected to 10s by flow 11 R3 (Sun 13 Sep).** Measured from when the
 * toast *appears*, both Todoist readings are about 10s plus an exit animation:
 * flow 5 first saw it at 360ms, gone 10,775–11,081ms; R3 at 388ms, gone
 * 10,469–10,774ms, so "~11s" folded the appearance delay and the exit into
 * the duration. R3 read meologue at 11s as gone 11,068–11,372ms, about
 * 600ms late. Todoist's "Date updated" toast (DET-16, task-detail-view.tsx's
 * own `RENAME_DATE_TOAST_DURATION_MS`) reads the same ~10s, and meologue's
 * 10s copy of it landed within 50ms of Todoist's in the same session — the
 * two constants aren't sharing a source, they just happen to match.
 *
 * **Re-measured precisely by the CMT-05 fix-phase drive (flow 11,
 * 2026-09-12):** both toasts agree at **Todoist 10,545ms, meologue
 * 11,226ms** — the figure this file now carries.
 *
 * **Moved behind the build-time platform seam by issue #356.** Todoist
 * Android does not share this figure — its snackbar was separately measured
 * at ~3.5s (`completion-toast-duration.android.ts`), a real 3x difference
 * from this web reading, not measurement noise. meologue is one Vite
 * application built for four targets (ADR 0005), so a single constant here
 * would be wrong for at least one of them; this file is now the web,
 * macOS and sandbox target's own value (`completion-toast-duration.macos.ts`
 * and `completion-toast-duration.sandbox.ts` both re-export it unchanged,
 * the same reasoning `wake-signals.macos.ts`/`.sandbox.ts` already use for
 * their own seams), and `use-completion-toast.tsx` imports whichever target
 * this resolves to rather than hard-coding a value itself.
 */
export const COMPLETION_TOAST_DURATION_MS = 10_000;
