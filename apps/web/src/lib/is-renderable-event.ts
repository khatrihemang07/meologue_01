import type { Event } from "@meologue/core";

/**
 * Whether an Event belongs in a rendered feed at all — `false` for exactly
 * one shape: a comment's `"updated"` Event, the "Edited a comment" line
 * CMT-06 (re-driven live, flow 5) found Todoist never shows. use-comments.ts's
 * `editComment` no longer records this Event going forward (the fix at the
 * source), but an existing store or a restored backup can still carry ones
 * recorded before that change (backups defeat "migrated everywhere") —
 * this is how the feed tolerates that old shape without ever showing a
 * line Todoist itself would never have. `activity-feed.tsx` filters with
 * this before grouping (`groupEventsByDay`) and before calling
 * `describeEventLine`, so a day made up only of old edit Events shows no
 * empty heading, and any caller that needs an accurate count of what will
 * actually render (`task-detail-view.tsx`'s own "Activity (N)" badge)
 * should filter through this first too, rather than counting `events`
 * itself.
 *
 * **Pulled out of `format-event.ts` on its own (issue #288's bundle
 * follow-up)**, not merged in above `describeEventLine`/
 * `groupEventsByDay`/`eventTimestamp` the way it originally lived: this
 * function is the only one of format-event.ts's exports `task-detail-
 * view.tsx` needs (for the `renderableEvents` count behind its own
 * "Activity (N)" title, computed before `ActivityFeed` ever mounts —
 * see that file's own comment on why). It also needs nothing
 * format-event.ts's other exports do (no `date-fns`, no
 * `format-task-date.ts`, no `inline-markdown.ts`, no `local-day-key.ts`,
 * no `task-detail-route.ts`) — a plain `Event` field check. Rollup
 * bundles a module as one atomic unit per chunk, so as long as this
 * lived inside format-event.ts, importing just this one function still
 * pulled every byte of `describeEventLine`'s ~240-line per-event-type
 * formatter into whichever chunk reached it — `lazy-activity-feed.ts`
 * made `ActivityFeed` itself lazy, but `task-detail-view.tsx`'s own
 * still-static need for this predicate kept dragging the rest of
 * format-event.ts along behind it regardless (measured: task-detail-
 * view.tsx's route rose to 73,598 gzip bytes with `ActivityFeed` lazy
 * but this predicate still imported from format-event.ts, against a
 * 73,000 ceiling — *worse* than the 73,130 it started at, since Rollup's
 * chunk boundaries shifted rather than shrank). Splitting this predicate
 * into its own tiny module removes format-event.ts from task-detail-
 * view.tsx's reachable graph entirely; `check-bundle-size.mjs`'s own
 * CHUNK_BUDGETS entry for task-detail-view.tsx has the measured
 * before/after.
 */
export function isRenderableEvent(event: Event): boolean {
  return !(event.objectType === "comment" && event.eventType === "updated");
}
