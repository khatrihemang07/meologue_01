import { describe, expect, it } from "vitest";
import type { SqliteDriver } from "../sqlite/driver";
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
import { restoreFromBackup } from "./restore";

/** Deletes every row from every entity table this build's own schema knows about — never `kv` or `meologue_migrations` — simulating "wipe this Device" ahead of a Restore in the round-trip tests below (issue #197's own acceptance criterion: "Back up, wipe, Restore"). */
async function wipeEntityTables(driver: SqliteDriver): Promise<void> {
  for (const name of await backupTableNames(driver)) {
    if (name === "kv" || name === "meologue_migrations") {
      continue;
    }
    await driver.execute(`DELETE FROM \`${name}\``, [], "run");
  }
}

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

    const outcome = await restoreFromBackup(driver, sql);

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
    const outcome = await restoreFromBackup(driver, sql);

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

    const outcome = await restoreFromBackup(targetDriver, sql);
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

    const outcome = await restoreFromBackup(targetDriver, sql);
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

    const outcome = await restoreFromBackup(driver, sql);

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

    const outcome = await restoreFromBackup(driver, "garbage not sql at all;");

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

    const outcome = await restoreFromBackup(targetDriver, sql);

    expect(outcome.ok).toBe(true);
    expect((await targetStore.list()).map((e) => e.id)).toEqual(["e1"]);
  });
});
