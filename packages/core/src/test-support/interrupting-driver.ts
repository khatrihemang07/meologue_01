import type { SqliteDriver, SqliteMethod, SqliteResult } from "../sqlite/driver";

/**
 * `TauriSqliteDriver` (apps/web/src/platform/tauri-sqlite-driver.ts) runs
 * every statement through `@tauri-apps/plugin-sql`'s connection pool,
 * which has no transaction API — `BEGIN`/`COMMIT`/`ROLLBACK` reach it like
 * any other statement, with no guarantee any of the three does anything at
 * all. This wraps a real (transactional) `NodeSqliteDriver` to reproduce
 * exactly that: the three keywords are swallowed as no-ops rather than
 * forwarded, so every other statement commits the moment it runs, the same
 * autocommit behaviour node:sqlite itself falls back to outside an
 * explicit transaction. Without this, `NodeSqliteDriver`'s own real
 * transaction would quietly absorb an interruption `InterruptingDriver`
 * below injects, and the recovery both ../backup/restore.test.ts (issue
 * #204) and ../backup/merge.test.ts (issue #208) exist to prove would
 * never actually be exercised.
 *
 * Shared by both test files rather than defined twice — issue #208's own
 * acceptance criteria call for reusing this harness, not copying it, since
 * a driver that quietly diverged between the two suites would make one of
 * them stop proving what it claims to.
 */
export class NoTransactionDriver implements SqliteDriver {
  constructor(private readonly inner: SqliteDriver) {}

  async execute(sql: string, params: unknown[], method: SqliteMethod): Promise<SqliteResult> {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
      return { rows: [] };
    }
    return this.inner.execute(sql, params, method);
  }
}

/**
 * Throws once the Nth mutating statement (`INSERT`/`UPDATE`/`DELETE` —
 * never `BEGIN`/`COMMIT`/`ROLLBACK`, and never a read) *inside the
 * `BEGIN`/`COMMIT` a caller's own apply wraps itself in* reaches it,
 * simulating a Restore or a Merge interrupted partway through that apply
 * on a driver that cannot guarantee a transaction. Issue #204's own
 * acceptance criteria (and issue #208's, extending the identical
 * requirement to Merge) call for a test that actually interrupts the
 * operation, not one that merely asserts the intent, and this is how: the
 * interruption is a real, uncaught statement failure at a real point in
 * the real sequence ../backup/restore.ts's `restoreTable`/
 * `resetCursorsAndEpochs` or ../backup/merge.ts's `mergeTable` issues, not
 * a mocked "and then it fails" shortcut.
 *
 * Only counts statements between `BEGIN` and `COMMIT`/`ROLLBACK`
 * (`inTransaction` below) — the FTS5 rebuild that runs *after* `COMMIT`
 * (both `restoreFromBackup`'s and `mergeBackupIntoDevice`'s own doc
 * comments explain why it isn't inside the transaction) issues its own
 * `INSERT`s into the search index, and those are no part of "the apply"
 * this class exists to interrupt: a failure there lands outside either
 * function's own `try`/`catch`, so it would never carry the safety-
 * Backup-naming message these test suites are about, and testing that
 * failure mode isn't this class's job.
 *
 * `onMutation` fires for every counted mutating statement seen (including
 * the one that throws), letting a test record the interruption's position
 * relative to when the safety Backup itself finished.
 */
export class InterruptingDriver implements SqliteDriver {
  private mutationCount = 0;
  private inTransaction = false;

  constructor(
    private readonly inner: SqliteDriver,
    private readonly failAtMutationNumber: number,
    private readonly onMutation?: (mutationNumber: number) => void,
  ) {}

  async execute(sql: string, params: unknown[], method: SqliteMethod): Promise<SqliteResult> {
    if (sql === "BEGIN") {
      this.inTransaction = true;
    } else if (sql === "COMMIT" || sql === "ROLLBACK") {
      this.inTransaction = false;
    } else if (
      this.inTransaction &&
      method === "run" &&
      /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql)
    ) {
      this.mutationCount += 1;
      this.onMutation?.(this.mutationCount);
      if (this.mutationCount === this.failAtMutationNumber) {
        throw new Error(
          `simulated interruption at mutating statement #${this.failAtMutationNumber}`,
        );
      }
    }
    return this.inner.execute(sql, params, method);
  }
}
