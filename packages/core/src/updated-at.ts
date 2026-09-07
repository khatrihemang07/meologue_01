/**
 * Ordering two `updated_at` values by the instant they name, rather than by
 * byte order (issue #217, ADR 0065's own amendment).
 *
 * **`updated_at` must never be compared as a raw string.** The two writers do
 * not agree on its shape and nothing ever made them:
 *
 * - This client stamps `new Date().toISOString()`, which always emits exactly
 *   three fractional digits — `2026-09-06T12:00:00.500Z`.
 * - The Server carries `DateTime<Utc>` and serialises RFC 3339 through
 *   chrono's default, which emits as many digits as it needs — six in
 *   practice, and **none at all** when the nanosecond component is zero:
 *   `2026-09-06T12:00:00.794113Z`, or `2026-09-06T12:00:00Z`.
 *
 * `'.'` is `0x2E` and `'Z'` is `0x5A`, so byte order and chronological order
 * disagree, and the likely direction is the damaging one: a Server value
 * landing on a whole second compares GREATER than every client value inside
 * that same second, while being up to a second earlier. Both shapes are
 * already in the wild together — a real Device database held 137
 * Server-written rows beside 4 client-written ones.
 *
 * **This is permanent, not a migration-era workaround.** Normalising the
 * stored corpus would improve the steady state and still would not make this
 * removable: Backup is a time machine. `dump.ts` writes the database exactly
 * as it stands and `restore.ts` puts those values back verbatim (reason 3 in
 * its own header), so a Backup taken before any such migration reintroduces
 * pre-migration shapes into a normalised database whenever someone Restores
 * it. The set of restorable Backups is unbounded and grows every time someone
 * clicks Back up, so "everything is normalised now" is never true — and
 * Restore is what people reach for when something has already gone wrong.
 *
 * **Millisecond resolution, deliberately.** `Date.parse` truncates below the
 * millisecond, which is the finest this client can express anyway, and it
 * matches what `SqliteEntryStore.applyPulled` does with
 * `strftime('%Y-%m-%dT%H:%M:%f', …)` on the SQL side — including for a
 * timestamp carrying no timezone designator, which readAsUtc below exists to
 * keep the two sides agreeing about. Two values inside the
 * same millisecond therefore tie rather than order, and each caller decides
 * what a tie means — see ADR 0065's amendment for why a tie is the safe
 * resting place on both sides of that fence. Sub-millisecond ordering is not
 * worth reconstructing by hand: it is far below the clock skew between
 * Devices that ADR 0065 already accepts.
 */

/**
 * Whether `candidate` names a strictly later instant than `reference`.
 *
 * `false` when either value cannot be read as a timestamp, so a caller that
 * asks "should this overwrite what I have?" gets "no" rather than an answer
 * derived from a comparison nobody can trust. That is the direction that
 * keeps data: the row stays, and whatever pushes or merges it next gets
 * another chance.
 */
export function isStrictlyNewerThan(candidate: unknown, reference: unknown): boolean {
  const candidateMs = parseInstant(candidate);
  const referenceMs = parseInstant(reference);
  if (candidateMs === undefined || referenceMs === undefined) {
    return false;
  }
  return candidateMs > referenceMs;
}

/**
 * Whether `candidate` names an instant at least as late as `reference` — the
 * `>=` sibling of isStrictlyNewerThan, for callers whose safe default on a tie
 * is to accept rather than refuse (`EntryStore.applyPulled`'s in-memory mirror
 * is one; see EntryStore.applyPulled's own doc comment for why a tie applies
 * there).
 *
 * `false` on an unreadable value, for the same reason.
 */
export function isAtLeastAsNewAs(candidate: unknown, reference: unknown): boolean {
  const candidateMs = parseInstant(candidate);
  const referenceMs = parseInstant(reference);
  if (candidateMs === undefined || referenceMs === undefined) {
    return false;
  }
  return candidateMs >= referenceMs;
}

/**
 * A trailing timezone designator: `Z`, or an offset like `+05:30`/`-0800`.
 * Anything with a time but without one of these is a "naive" timestamp, and
 * the two sides of this rule read those differently — see readAsUtc.
 */
const TIMEZONE_DESIGNATOR = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/** A time component, i.e. `HH:MM`. A date on its own is already unambiguous. */
const HAS_TIME = /\d{2}:\d{2}/;

/**
 * **A timestamp with no timezone designator is read as UTC, because that is
 * what the SQL side does with it.**
 *
 * `strftime` treats `2026-01-01T10:00:00` as UTC on every machine.
 * `Date.parse` treats that same string as **local time** — per the ECMA-262
 * rule for a date-time form with no designator — so the two implementations
 * of one documented rule would disagree by the Device's own UTC offset, and
 * silently: no exception, just a plausible wrong answer that changes when the
 * Device moves.
 *
 * That is not hypothetical where it matters most. `merge.ts` orders whatever
 * `updated_at` a Backup file happens to hold, and `parse.ts` does not
 * constrain its shape — so without this, merging the *same* Backup on two
 * Devices in different timezones could pick a different winner for the same
 * conflicting row. Device-independent conflict resolution is exactly the
 * property ADR 0065 and issue #217 exist to protect.
 *
 * A date with no time at all is left alone: both sides already read
 * `2026-01-01` as UTC midnight, and appending anything would only break it.
 */
function readAsUtc(value: string): string {
  const trimmed = value.trim();
  if (!HAS_TIME.test(trimmed) || TIMEZONE_DESIGNATOR.test(trimmed)) {
    return trimmed;
  }
  return `${trimmed}Z`;
}

/**
 * Milliseconds since the epoch, or `undefined` for anything that is not a
 * readable timestamp string. `undefined` rather than `NaN` so callers cannot
 * accidentally propagate a value that compares false against everything
 * including itself.
 */
function parseInstant(value: unknown): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const ms = Date.parse(readAsUtc(value));
  return Number.isNaN(ms) ? undefined : ms;
}
