import { describe, expect, it } from "vitest";
import type { SqliteDriver, SqliteMethod, SqliteResult } from "../sqlite/driver";
import { NodeSqliteDriver } from "../sqlite/node-driver";
import { open } from "../sqlite/open";
import { comment } from "../test-support/comment-fixture";
import { entry } from "../test-support/entry-fixture";
import { event } from "../test-support/event-fixture";
import { filter } from "../test-support/filter-fixture";
import { label } from "../test-support/label-fixture";
import { project, section } from "../test-support/project-fixture";
import { task } from "../test-support/task-fixture";
import { backupTableNames, dumpDatabase } from "./dump";
import { restoreFromBackup, type SafetyBackupOutcome, type TakeSafetyBackup } from "./restore";

/** Deletes every row from every entity table this build's own schema knows about — never `kv` or `meologue_migrations` — simulating "wipe this Device" ahead of a Restore in the round-trip tests below (issue #197's own acceptance criterion: "Back up, wipe, Restore"). */
async function wipeEntityTables(driver: SqliteDriver): Promise<void> {
  for (const name of await backupTableNames(driver)) {
    if (name === "kv" || name === "meologue_migrations") {
      continue;
    }
    await driver.execute(`DELETE FROM \`${name}\``, [], "run");
  }
}

/** A `takeSafetyBackup` that always succeeds, reporting a fixed file name — every test below except the "safety Backup itself failed" ones just needs Restore to get past this step, not to exercise it. */
const okSafetyBackup: TakeSafetyBackup = async () => ({
  ok: true,
  fileName: "meologue-safety-backup-20260101-000000.zip",
});

describe("restoreFromBackup", () => {
  it("round-trips every entity type, tricky bodies and tombstones included, through Backup, wipe, Restore", async () => {
    const driver = new NodeSqliteDriver();
    const { store, taskStore, labelStore, projectStore, commentStore, eventStore, filterStore } =
      await open(driver);

    const tricky = "O'Brien's \"quote\" test\nwith a newline and an emoji 😀🔥 and café";
    await store.upsert([
      entry({ id: "e1", body: tricky }),
      entry({ id: "e2", body: "", deletedAt: "2026-08-16T00:00:00.000Z" }),
    ]);
    await taskStore.upsert([task({ id: "t1", content: "buy milk" })]);
    await labelStore.upsert([label({ id: "l1" })]);
    await projectStore.upsertProjects([project({ id: "p1" })]);
    await projectStore.upsertSections([section({ id: "s1", projectId: "p1" })]);
    await commentStore.upsert([comment({ id: "c1", taskId: "t1" })]);
    await eventStore.record(event({ id: "ev1" }));
    await filterStore.upsert([filter({ id: "f1" })]);

    const sql = await dumpDatabase(driver);
    await wipeEntityTables(driver);

    const outcome = await restoreFromBackup({
      driver,
      databaseSql: sql,
      takeSafetyBackup: okSafetyBackup,
    });

    expect(outcome.ok).toBe(true);

    const restoredEntries = await store.list();
    expect(restoredEntries.map((e) => e.id).sort()).toEqual(["e1"]);
    expect(restoredEntries[0]?.body).toBe(tricky);
    // The tombstone travels too, even though list() itself excludes it —
    // asserted directly against the table.
    const tombstoneRow = await driver.execute(
      "SELECT deleted_at, body FROM entries WHERE id = 'e2'",
      [],
      "get",
    );
    expect(tombstoneRow.rows).toEqual(["2026-08-16T00:00:00.000Z", ""]);

    expect((await taskStore.list()).map((t) => t.id)).toEqual(["t1"]);
    expect((await labelStore.list()).map((l) => l.id)).toEqual(["l1"]);
    expect((await projectStore.listProjects()).map((p) => p.id)).toEqual(["p1"]);
    expect((await projectStore.listSections("p1")).map((s) => s.id)).toEqual(["s1"]);
    expect((await commentStore.listByTask("t1")).map((c) => c.id)).toEqual(["c1"]);
    expect((await eventStore.list()).map((e) => e.id)).toEqual(["ev1"]);
    expect((await filterStore.list()).map((f) => f.id)).toEqual(["f1"]);
  });

  it("reports (almost) everything unchanged when restoring a Backup onto the Device that produced it", async () => {
    const driver = new NodeSqliteDriver();
    const { store, taskStore } = await open(driver);
    await store.upsert([entry({ id: "e1", body: "hello" })]);
    await taskStore.upsert([task({ id: "t1", content: "buy milk" })]);

    const sql = await dumpDatabase(driver);
    const outcome = await restoreFromBackup({
      driver,
      databaseSql: sql,
      takeSafetyBackup: okSafetyBackup,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.result.inserted).toBe(0);
    expect(outcome.result.updated).toBe(0);
    // entries, tasks, kv's non-cursor rows (device_id) all unchanged —
    // "close to" rather than exactly a no-op per issue #197's own framing,
    // since the cursor reset below always runs regardless.
    expect(outcome.result.unchanged).toBeGreaterThan(0);
  });

  it("names the safety Backup it took in a successful outcome's own result", async () => {
    const driver = new NodeSqliteDriver();
    await open(driver);
    const sql = await dumpDatabase(driver);

    const outcome = await restoreFromBackup({
      driver,
      databaseSql: sql,
      takeSafetyBackup: async () => ({ ok: true, fileName: "meologue-safety-backup-x.zip" }),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.result.safetyBackupFileName).toBe("meologue-safety-backup-x.zip");
  });

  it("keeps this Device's own device_id, resets cursors and epochs to 0, and preserves seq/synced_at verbatim from the file", async () => {
    // Two different "Devices": the Backup came from `sourceDriver`, and is
    // restored onto `targetDriver`, which already has its own, different
    // device_id and a real, nonzero Cursor (as if it had synced before).
    const sourceDriver = new NodeSqliteDriver();
    const { store: sourceStore, deviceId: sourceDeviceId } = await open(sourceDriver);
    await sourceStore.upsert([
      entry({ id: "e1", body: "from source", seq: 42, syncedAt: "2026-01-02T00:00:00.000Z" }),
    ]);
    const sql = await dumpDatabase(sourceDriver);

    const targetDriver = new NodeSqliteDriver();
    const { store: targetStore, deviceId: targetDeviceId } = await open(targetDriver);
    expect(targetDeviceId).not.toBe(sourceDeviceId);
    await targetStore.setCursor(7);

    const outcome = await restoreFromBackup({
      driver: targetDriver,
      databaseSql: sql,
      takeSafetyBackup: okSafetyBackup,
    });
    expect(outcome.ok).toBe(true);

    const kvRows = await targetDriver.execute("SELECT key, value FROM kv", [], "all");
    const kv = Object.fromEntries(kvRows.rows.map((row) => row as [string, string]));
    expect(kv.device_id).toBe(targetDeviceId);
    expect(kv.cursor).toBe("0");

    const restoredEntry = (await targetStore.list())[0];
    expect(restoredEntry?.seq).toBe(42);
    expect(restoredEntry?.syncedAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("makes Search work immediately after a Restore, on a database with no prior FTS5 rows at all", async () => {
    const sourceDriver = new NodeSqliteDriver();
    const { store: sourceStore, taskStore: sourceTaskStore } = await open(sourceDriver);
    await sourceStore.upsert([entry({ id: "e1", body: "walk the dog" })]);
    await sourceTaskStore.upsert([task({ id: "t1", content: "walk the dog" })]);
    const sql = await dumpDatabase(sourceDriver);

    const targetDriver = new NodeSqliteDriver();
    const { store: targetStore, taskStore: targetTaskStore } = await open(targetDriver);

    const outcome = await restoreFromBackup({
      driver: targetDriver,
      databaseSql: sql,
      takeSafetyBackup: okSafetyBackup,
    });
    expect(outcome.ok).toBe(true);

    expect((await targetStore.search("walk")).map((e) => e.id)).toEqual(["e1"]);
    expect((await targetTaskStore.search("walk")).map((t) => t.id)).toEqual(["t1"]);
  });

  it("restores best-effort when the file names a table or column this build doesn't know, reporting the skip", async () => {
    const driver = new NodeSqliteDriver();
    await open(driver);
    const sql = `${[
      "CREATE TABLE `future_widgets` (\n\t`id` text PRIMARY KEY NOT NULL\n)",
      "INSERT INTO `future_widgets` (`id`) VALUES ('w1')",
      "CREATE TABLE `entries` (\n\t`id` text PRIMARY KEY NOT NULL\n)",
      "INSERT INTO `entries` (`id`, `device_id`, `body`, `created_at`, `some_future_column`) VALUES ('e1', 'device-1', 'hi', '2026-01-01T00:00:00.000Z', 'mystery')",
    ].join(";\n")};`;

    const outcome = await restoreFromBackup({
      driver,
      databaseSql: sql,
      takeSafetyBackup: okSafetyBackup,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.result.skippedTables).toEqual(["future_widgets"]);
    expect(outcome.result.skippedColumns).toEqual(["entries.some_future_column"]);
  });

  it("refuses a malformed database.sql with a reason, leaving the database untouched", async () => {
    const driver = new NodeSqliteDriver();
    const { store } = await open(driver);
    await store.upsert([entry({ id: "e1", body: "still here" })]);

    const outcome = await restoreFromBackup({
      driver,
      databaseSql: "garbage not sql at all;",
      takeSafetyBackup: okSafetyBackup,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.reason).toBeTruthy();
    expect((await store.list()).map((e) => e.id)).toEqual(["e1"]);
  });

  it("removes a row the target has but the Backup doesn't name — Restore replaces, it doesn't merge", async () => {
    const sourceDriver = new NodeSqliteDriver();
    const { store: sourceStore } = await open(sourceDriver);
    await sourceStore.upsert([entry({ id: "e1", body: "kept" })]);
    const sql = await dumpDatabase(sourceDriver);

    const targetDriver = new NodeSqliteDriver();
    const { store: targetStore } = await open(targetDriver);
    await targetStore.upsert([
      entry({ id: "e1", body: "kept" }),
      entry({ id: "e2", body: "only ever local, never in the Backup" }),
    ]);

    const outcome = await restoreFromBackup({
      driver: targetDriver,
      databaseSql: sql,
      takeSafetyBackup: okSafetyBackup,
    });

    expect(outcome.ok).toBe(true);
    expect((await targetStore.list()).map((e) => e.id)).toEqual(["e1"]);
  });
});

describe("restoreFromBackup — the safety Backup itself (issue #204)", () => {
  it("never calls BEGIN, and writes nothing, when takeSafetyBackup reports failure", async () => {
    const driver = new NodeSqliteDriver();
    const { store } = await open(driver);
    await store.upsert([entry({ id: "e1", body: "still here" })]);
    const sql = await dumpDatabase(driver);

    let sawBegin = false;
    const observingDriver: SqliteDriver = {
      execute: (statementSql, params, method) => {
        if (statementSql === "BEGIN") {
          sawBegin = true;
        }
        return driver.execute(statementSql, params, method);
      },
    };

    const outcome = await restoreFromBackup({
      driver: observingDriver,
      databaseSql: sql,
      takeSafetyBackup: async () => ({ ok: false, reason: "disk full" }),
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.reason).toContain("disk full");
    expect(sawBegin).toBe(false);
    expect((await store.list()).map((e) => e.id)).toEqual(["e1"]);
  });

  it("treats a thrown takeSafetyBackup the same as a reported failure — ok:false, nothing written", async () => {
    const driver = new NodeSqliteDriver();
    const { store } = await open(driver);
    await store.upsert([entry({ id: "e1", body: "still here" })]);
    const sql = await dumpDatabase(driver);

    const outcome = await restoreFromBackup({
      driver,
      databaseSql: sql,
      takeSafetyBackup: async () => {
        throw new Error("save panel crashed");
      },
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.reason).toContain("save panel crashed");
    expect((await store.list()).map((e) => e.id)).toEqual(["e1"]);
  });

  it("never even calls takeSafetyBackup for a malformed file — refusing the file needs no safety net", async () => {
    const driver = new NodeSqliteDriver();
    await open(driver);
    let called = false;
    const takeSafetyBackup: TakeSafetyBackup = async () => {
      called = true;
      return { ok: true, fileName: "unused.zip" };
    };

    const outcome = await restoreFromBackup({
      driver,
      databaseSql: "garbage not sql at all;",
      takeSafetyBackup,
    });

    expect(outcome.ok).toBe(false);
    expect(called).toBe(false);
  });
});

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
 * transaction would quietly absorb the interruption `InterruptingDriver`
 * below injects, and the recovery this test suite exists to prove would
 * never actually be exercised.
 */
class NoTransactionDriver implements SqliteDriver {
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
 * `BEGIN`/`COMMIT` this file's own `restoreFromBackup` wraps its apply in*
 * reaches it, simulating a Restore interrupted partway through that apply
 * on a driver that cannot guarantee a transaction — issue #204's own
 * acceptance criteria call for a test that actually interrupts a Restore,
 * not one that merely asserts the intent, and this is how: the
 * interruption is a real, uncaught statement failure at a real point in
 * the real sequence restoreTable/resetCursorsAndEpochs (./restore.ts)
 * issue, not a mocked "and then it fails" shortcut.
 *
 * Only counts statements between `BEGIN` and `COMMIT`/`ROLLBACK`
 * (`inTransaction` below) — the FTS5 rebuild that runs *after* `COMMIT`
 * (restoreFromBackup's own doc comment explains why it isn't inside the
 * transaction) issues its own `INSERT`s into the search index, and those
 * are no part of "the apply" this class exists to interrupt: a failure
 * there lands outside `restoreFromBackup`'s own `try`/`catch`, so it
 * would never carry the safety-Backup-naming message this whole suite is
 * about, and testing that failure mode isn't this class's job.
 *
 * `onMutation` fires for every counted mutating statement seen (including
 * the one that throws), letting a test record the interruption's position
 * relative to when the safety Backup itself finished.
 */
class InterruptingDriver implements SqliteDriver {
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

/**
 * Builds a fresh "this Device, before a Restore" — one Entry the incoming
 * Backup below will update, and nothing else. Deliberately holds no row
 * the incoming Backup *doesn't* also mention: `restoreTable`'s delete pass
 * (./restore.ts) would otherwise remove it, and recovering it during the
 * safety-Backup replay would re-`INSERT` it under a brand-new rowid rather
 * than its original one — since `dumpDatabase`'s own `SELECT` (./dump.ts)
 * carries no `ORDER BY`, that would make the recovered dump's row order
 * (and so its exact text) differ from `preRestoreSql`'s even though the
 * *data* fully matches, which would make this test's own "compare full
 * dumps" assertion fail for a reason that has nothing to do with whether
 * the recovery actually worked. Every row this fixture creates keeps its
 * original rowid across the whole test, whatever gets mutated around it.
 */
async function buildPreRestoreTarget(): Promise<{ driver: NodeSqliteDriver; deviceId: string }> {
  const driver = new NodeSqliteDriver();
  const { store, deviceId } = await open(driver);
  await store.upsert([entry({ id: "e1", body: "original e1" })]);
  return { driver, deviceId };
}

/**
 * The Backup being restored onto `buildPreRestoreTarget`'s Device —
 * deliberately from a *different* Device, the same "two different
 * Devices" shape the round-trip test above already uses. `e2`/`e3`/`t1`
 * are rows the target never had: restoring them is a plain `INSERT` that
 * the safety-Backup replay can undo with a plain `DELETE`, never a
 * `DELETE` followed by a repositioning `INSERT` — see
 * `buildPreRestoreTarget`'s own doc comment for why that distinction is
 * what keeps this suite's dump-equality assertions meaningful.
 */
async function buildIncomingBackupSql(): Promise<string> {
  const sourceDriver = new NodeSqliteDriver();
  const { store: sourceStore, taskStore: sourceTaskStore } = await open(sourceDriver);
  await sourceStore.upsert([
    entry({ id: "e1", body: "from the Backup, different from target's" }),
    entry({ id: "e2", body: "only ever in the Backup" }),
    entry({ id: "e3", body: "also only ever in the Backup" }),
  ]);
  await sourceTaskStore.upsert([task({ id: "t1", content: "buy milk" })]);
  return dumpDatabase(sourceDriver);
}

describe("restoreFromBackup — an interrupted apply is recoverable from its own safety Backup (issue #204)", () => {
  /**
   * Runs the interrupted Restore itself, against a driver stack that (a)
   * behaves like `TauriSqliteDriver` — no real transaction, `ROLLBACK`
   * does nothing — and (b) throws partway through, at `failAtMutationNumber`.
   * Returns the pre-Restore dump (captured before anything ran), the
   * mutation-order log (to prove the safety Backup finished before any
   * mutation reached the driver), and the now-interrupted `driver` itself,
   * so a test can go on to prove that driver is recoverable.
   */
  async function runInterruptedRestore(failAtMutationNumber: number) {
    const { driver: rawDriver } = await buildPreRestoreTarget();
    const preRestoreSql = await dumpDatabase(rawDriver);
    const incomingSql = await buildIncomingBackupSql();

    const events: string[] = [];
    const pooledDriver = new NoTransactionDriver(rawDriver);
    const interruptingDriver = new InterruptingDriver(pooledDriver, failAtMutationNumber, () =>
      events.push("mutation"),
    );

    // The safety Backup callback dumps the Device's pre-Restore state the
    // same way apps/web/src/components/settings/data-section.tsx's real
    // callback does via `createBackup` — through the identical `driver`
    // Restore is about to write into, before it writes into it.
    let safetyBackupSql: string | null = null;
    const takeSafetyBackup: TakeSafetyBackup = async (): Promise<SafetyBackupOutcome> => {
      events.push("safety-backup-start");
      safetyBackupSql = await dumpDatabase(interruptingDriver);
      events.push("safety-backup-done");
      return { ok: true, fileName: "meologue-safety-backup-20260101-000000.zip" };
    };

    let thrown: unknown;
    try {
      await restoreFromBackup({
        driver: interruptingDriver,
        databaseSql: incomingSql,
        takeSafetyBackup,
      });
    } catch (error) {
      thrown = error;
    }

    return {
      rawDriver,
      preRestoreSql,
      safetyBackupSql: safetyBackupSql as string | null,
      events,
      thrown,
    };
  }

  it("interrupted early — after just one mutating statement already committed", async () => {
    const { rawDriver, preRestoreSql, safetyBackupSql, events, thrown } =
      await runInterruptedRestore(2);

    // The failure propagates...
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("meologue-safety-backup-20260101-000000.zip");

    // ...and the safety Backup was fully produced before any mutating
    // statement reached the driver — observed from the actual call order,
    // not merely from how restoreFromBackup happens to be written.
    expect(events[0]).toBe("safety-backup-start");
    expect(events[1]).toBe("safety-backup-done");
    expect(events.filter((event) => event === "mutation").length).toBe(2);
    expect(safetyBackupSql).toBe(preRestoreSql);
    // The one statement that did commit before the interruption actually
    // changed rawDriver — proving the recovery below has real corruption
    // to undo, not a no-op.
    expect(await dumpDatabase(rawDriver)).not.toBe(preRestoreSql);

    // Applying the safety Backup's own database.sql — a second,
    // independent Restore — returns the Device to its exact pre-Restore
    // state, proven by comparing full dumps rather than a spot check.
    const recovery = await restoreFromBackup({
      driver: rawDriver,
      databaseSql: safetyBackupSql as string,
      takeSafetyBackup: okSafetyBackup,
    });
    expect(recovery.ok).toBe(true);
    expect(await dumpDatabase(rawDriver)).toBe(preRestoreSql);
  });

  it("interrupted partway through, after several tables were already mutated", async () => {
    // A dry run (real transaction, so fully recoverable on its own)
    // against an identical setup, just to learn how many mutating
    // statements the apply produces in total — so the number chosen below
    // is a genuinely different point in the sequence, not a guess.
    const { driver: dryRunDriver } = await buildPreRestoreTarget();
    const dryRunSql = await buildIncomingBackupSql();
    let totalMutations = 0;
    const countingDriver = new InterruptingDriver(dryRunDriver, Number.POSITIVE_INFINITY, () => {
      totalMutations += 1;
    });
    const dryRunOutcome = await restoreFromBackup({
      driver: countingDriver,
      databaseSql: dryRunSql,
      takeSafetyBackup: okSafetyBackup,
    });
    expect(dryRunOutcome.ok).toBe(true);
    expect(totalMutations).toBeGreaterThan(3);

    const midpoint = Math.ceil(totalMutations / 2);
    const { rawDriver, preRestoreSql, safetyBackupSql, events, thrown } =
      await runInterruptedRestore(midpoint);

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("meologue-safety-backup-20260101-000000.zip");
    expect(events[0]).toBe("safety-backup-start");
    expect(events[1]).toBe("safety-backup-done");
    // More than one mutation actually reached the driver this time,
    // proving `midpoint` is a genuinely different interruption point from
    // the "very first statement" test above.
    expect(events.filter((event) => event === "mutation").length).toBe(midpoint);
    expect(safetyBackupSql).toBe(preRestoreSql);

    const recovery = await restoreFromBackup({
      driver: rawDriver,
      databaseSql: safetyBackupSql as string,
      takeSafetyBackup: okSafetyBackup,
    });
    expect(recovery.ok).toBe(true);
    expect(await dumpDatabase(rawDriver)).toBe(preRestoreSql);
  });
});
