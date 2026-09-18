/**
 * Todoist Android has no toast for this at all — a Material snackbar
 * (`LENGTH_LONG`) instead. Issue #286's live drive (2026-09-14, both apps
 * completing the identical Task in one session) only bounded it coarsely:
 * present at 1.6s, gone by 4.6s, read against `LENGTH_LONG`'s own ~3.5s
 * default rather than measured to the millisecond the way the web toast
 * was. A later drive (parity ledger's CMT-05 row, issue #350, 2026-09-18)
 * tightened the lower bound — confirmed present at **>=3.23s** — which is
 * consistent with that ~3.5s but is not the same reading as, and does not
 * exactly pin, the figure from issue #286. Treat this as "~3.5s, bounded
 * but not measured precisely," not as an exact figure the way
 * `completion-toast-duration.web.ts`'s 10,545ms/11,226ms readings are.
 *
 * Issue #356 is what stops this real, ~3x-smaller figure from either being
 * forced onto every target or being ignored in favour of the web reading —
 * meologue is one Vite application built for four targets (ADR 0005), and
 * only this one, Android's own build, resolves to this file.
 */
export const COMPLETION_TOAST_DURATION_MS = 3_500;
