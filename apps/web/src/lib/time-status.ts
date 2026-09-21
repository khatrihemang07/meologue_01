import { format, isSameDay, subDays } from "date-fns";
import type { TimeSource } from "@/lib/time-transport";

/**
 * Making a finished refresh run diagnosable (issue #418).
 *
 * "Refresh now" imported nothing and the UI gave no clue why. The root cause
 * was operational — every configured source pointed at a stale snapshot copy
 * of its recorder database, so every refresh correctly found 0 new records —
 * but nothing on screen said which file a source reads or how recent its
 * newest record already is, so a frozen source looked identical to a healthy
 * one that simply has nothing new right now. These two pure functions close
 * that gap: what the finish message says, and how a raw `newest_record_at`
 * instant reads as a sentence rather than an ISO string.
 */

/**
 * How recent a source's newest stored record is, in the reader's words.
 *
 * `now` is a required argument rather than read from `Date.now()` inside this
 * function, so the "today"/"yesterday" boundary is exact and testable rather
 * than depending on when the suite happens to run.
 */
export function formatNewestRecord(instant: string | null | undefined, now: Date): string {
  if (!instant) {
    return "never";
  }
  const at = new Date(instant);
  if (isSameDay(at, now)) {
    return format(at, "HH:mm");
  }
  if (isSameDay(at, subDays(now, 1))) {
    return `${format(at, "HH:mm")} yesterday`;
  }
  return format(at, "MMM d, HH:mm");
}

function sourceClause(source: TimeSource): string {
  if (source.last_error) {
    return `${source.name} failed — ${source.last_error}`;
  }
  return `${source.name}: ${source.last_inserted_count} new`;
}

/**
 * The message shown once a refresh run finishes, across every source it
 * touched.
 *
 * Per source, not one verdict for the whole run — the same reason the Server
 * records outcomes against sources rather than against runs (issue #421): a
 * single failing recorder must not make every other recorder's result
 * unreadable. When every source that actually ran found nothing new, that is
 * named explicitly, alongside each source's newest stored record — the fact
 * that turns "0 new, again" from a shrug into something a reader can act on
 * (repoint the source, or accept the file really hasn't grown).
 *
 * Only enabled sources are considered: the Server's refresh only runs
 * enabled sources (`enabled_sources` / `run_enabled_sources` in
 * server/src/time.rs), so an archived source's `last_inserted_count` /
 * `last_error` / `newest_record_at` are always left over from whichever run
 * last touched it — quoting them here would re-report a past run's outcome
 * as if this run produced it. The filter lives here, not in each caller, so
 * a caller that (rightly) still renders archived rows in a status list — see
 * `refresh-row.tsx` — cannot also leak them into the finish message.
 */
export function importSummary(sources: readonly TimeSource[], now: Date): string {
  const ran = sources.filter((source) => source.enabled);
  if (ran.length === 0) {
    return "Import finished.";
  }

  const failed = ran.filter((source) => source.last_error);
  const attempted = ran.filter((source) => !source.last_error);
  const allFoundNothing =
    attempted.length > 0 && attempted.every((source) => source.last_inserted_count === 0);

  if (!allFoundNothing) {
    return `Import finished — ${ran.map(sourceClause).join(" · ")}`;
  }

  const newest = attempted
    .map((source) => `${source.name} ${formatNewestRecord(source.newest_record_at, now)}`)
    .join(" · ");
  const failures = failed.length > 0 ? ` ${failed.map(sourceClause).join(" · ")}` : "";
  return `Nothing new. Newest records: ${newest}.${failures}`;
}
