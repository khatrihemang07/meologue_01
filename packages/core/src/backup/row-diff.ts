/**
 * "Is this row's actual content the same" — the one question Restore
 * (#197) and Merge (#199, not built by this ticket) both have to answer
 * before writing anything, and the reason this lives in its own file
 * rather than inside ./restore.ts: issue #197 explicitly asks for this
 * comparison to sit "somewhere Merge can reuse it" rather than travel
 * along for the ride inside Restore's own module, the same "shared once,
 * not duplicated twice and left to drift" reasoning `dump.ts`'s
 * `backupTableNames` already gives for row counting.
 *
 * A row already byte-identical to what is on disk must be skipped
 * entirely — not rewritten, not queued to Sync, and counted as unchanged
 * rather than as work done (issue #197's own acceptance criteria). Getting
 * "identical" right is what makes Restoring a Backup onto the Device that
 * produced it close to a no-op, and what stops a same-content row from
 * being needlessly re-marked pending for the next Sync tick.
 */

/**
 * The columns a row's own Sync bookkeeping owns rather than its content —
 * `seq` (assigned by the Server once a row is pushed) and `synced_at`
 * (when this Device last confirmed the Server has it). Both can change for
 * reasons that have nothing to do with what the row actually says: a row
 * pushed to the Server between when a Backup was taken and when it is
 * later Restored gains a `seq` the file never recorded, and comparing that
 * value would make an otherwise-identical row look "different" — which
 * would trigger a write that overwrites this Device's fresher `seq`/
 * `synced_at` with the file's older, unsynced one, regressing an
 * already-synced row back to pending and re-queuing it for Sync. Excluding
 * both from the comparison, while still writing them verbatim from the
 * file whenever a row IS written for some other reason (../backup/
 * restore.ts's own rule — "preserve seq/synced_at verbatim," never
 * "compare and correct them"), is what keeps those two concerns —
 * deciding whether a row changed, and what to write when it did — from
 * fighting each other.
 */
const SYNC_BOOKKEEPING_COLUMNS: ReadonlySet<string> = new Set(["seq", "synced_at"]);

/**
 * Byte-for-byte equality for one column's value. `dump.ts`'s
 * `escapeSqlValue` never actually produces a blob for any column this
 * schema declares today (its own header comment says so), but a driver's
 * `execute` can still hand one back for a future column that does, so this
 * compares `Uint8Array` contents rather than object identity — the same
 * defensiveness `escapeSqlValue` itself already takes for a value shape
 * nothing currently produces.
 */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    if (a.length !== b.length) {
      return false;
    }
    return a.every((byte, index) => byte === b[index]);
  }
  return a === b;
}

/**
 * True when every content column `incoming` carries — every column but
 * `seq` and `synced_at` (`SYNC_BOOKKEEPING_COLUMNS` above) — is
 * byte-identical to the same column on `existing`. `existing === undefined`
 * (no row with this primary key on the target yet) is always "not equal":
 * there is nothing to compare against, so the caller inserts rather than
 * skips.
 *
 * Compares exactly the columns `incoming` carries, not every column this
 * build's schema knows: the caller (../backup/parse.ts) has already
 * narrowed `incoming` to the columns an older Backup's file actually
 * mentioned, so a column this build recognises but the file never
 * mentioned is correctly left out of "content" here too, the same
 * version-skew posture `parse.ts` itself takes rather than this file
 * re-deciding it a second way.
 */
export function rowContentUnchanged(
  existing: Record<string, unknown> | undefined,
  incoming: Record<string, unknown>,
): boolean {
  if (existing === undefined) {
    return false;
  }
  for (const column of Object.keys(incoming)) {
    if (SYNC_BOOKKEEPING_COLUMNS.has(column)) {
      continue;
    }
    if (!valuesEqual(existing[column], incoming[column])) {
      return false;
    }
  }
  return true;
}
