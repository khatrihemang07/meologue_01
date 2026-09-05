import { describe, expect, it } from "vitest";
import { NodeSqliteDriver } from "../sqlite/node-driver";
import { open } from "../sqlite/open";
import { entry } from "../test-support/entry-fixture";
import { task } from "../test-support/task-fixture";
import { dumpDatabase } from "./dump";
import { parseBackupDatabase } from "./parse";

describe("parseBackupDatabase", () => {
  it("parses a real dump's INSERTs back into typed rows, one ParsedTable per entity table", async () => {
    const driver = new NodeSqliteDriver();
    const { store, taskStore } = await open(driver);
    await store.upsert([entry({ id: "e1", body: "hello" })]);
    await taskStore.upsert([task({ id: "t1", content: "buy milk" })]);

    const sql = await dumpDatabase(driver);
    const result = await parseBackupDatabase(sql, driver);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const entries = result.tables.find((t) => t.name === "entries");
    expect(entries?.rows).toHaveLength(1);
    expect(entries?.rows[0]?.values.id).toBe("e1");
    expect(entries?.rows[0]?.values.body).toBe("hello");

    const tasks = result.tables.find((t) => t.name === "tasks");
    expect(tasks?.rows).toHaveLength(1);
    expect(tasks?.rows[0]?.values.content).toBe("buy milk");

    expect(result.skippedTables).toEqual([]);
    expect(result.skippedColumns).toEqual([]);
  });

  it("preserves quotes, newlines and emoji in a body exactly", async () => {
    const driver = new NodeSqliteDriver();
    const { store } = await open(driver);
    const tricky = "O'Brien's \"quote\" test\nwith a newline and an emoji 😀🔥 and café";
    await store.upsert([entry({ id: "e1", body: tricky })]);

    const sql = await dumpDatabase(driver);
    const result = await parseBackupDatabase(sql, driver);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const entries = result.tables.find((t) => t.name === "entries");
    expect(entries?.rows[0]?.values.body).toBe(tricky);
  });

  it("includes a tombstoned row (blanked body, deleted_at set) exactly as dumped", async () => {
    const driver = new NodeSqliteDriver();
    const { store } = await open(driver);
    await store.upsert([entry({ id: "e1", body: "", deletedAt: "2026-08-16T00:00:00.000Z" })]);

    const sql = await dumpDatabase(driver);
    const result = await parseBackupDatabase(sql, driver);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const row = result.tables.find((t) => t.name === "entries")?.rows[0];
    expect(row?.values.deleted_at).toBe("2026-08-16T00:00:00.000Z");
    expect(row?.values.body).toBe("");
  });

  it("parses a table an empty database dumps to (zero rows) as an empty ParsedTable, not a missing one", async () => {
    const driver = new NodeSqliteDriver();
    await open(driver);

    const sql = await dumpDatabase(driver);
    const result = await parseBackupDatabase(sql, driver);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const filters = result.tables.find((t) => t.name === "filters");
    expect(filters?.rows).toEqual([]);
  });

  it("reports a table this build's own schema doesn't have as skipped, rather than refusing the file", async () => {
    const driver = new NodeSqliteDriver();
    await open(driver);
    const sql = `${[
      "CREATE TABLE `future_widgets` (\n\t`id` text PRIMARY KEY NOT NULL\n)",
      "INSERT INTO `future_widgets` (`id`) VALUES ('w1')",
    ].join(";\n")};`;

    const result = await parseBackupDatabase(sql, driver);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.skippedTables).toEqual(["future_widgets"]);
    expect(result.tables.some((t) => t.name === "future_widgets")).toBe(false);
  });

  it("reports a column this build's own schema doesn't have as skipped, keeping the rest of that row", async () => {
    const driver = new NodeSqliteDriver();
    await open(driver);
    // Hand-built rather than derived from a real dump: parseBackupDatabase
    // only ever checks a CREATE TABLE statement's *name* against the live
    // schema (never its column list), so a minimal CREATE TABLE plus one
    // INSERT naming an extra, unknown column is enough to exercise this
    // without depending on dumpDatabase's exact column ordering.
    const sql = `${[
      "CREATE TABLE `entries` (\n\t`id` text PRIMARY KEY NOT NULL\n)",
      "INSERT INTO `entries` (`id`, `body`, `some_future_column`) VALUES ('e1', 'hi', 'mystery')",
    ].join(";\n")};`;

    const result = await parseBackupDatabase(sql, driver);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.skippedColumns).toEqual(["entries.some_future_column"]);
    const row = result.tables.find((t) => t.name === "entries")?.rows[0];
    expect(row?.values.body).toBe("hi");
    expect(row?.values.some_future_column).toBeUndefined();
  });

  it("refuses a file with a column/value count mismatch, naming the table", async () => {
    const driver = new NodeSqliteDriver();
    await open(driver);
    const sql = "INSERT INTO `entries` (`id`, `body`) VALUES ('e1');";

    const result = await parseBackupDatabase(sql, driver);

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toContain("entries");
    expect(result.reason).toMatch(/2 column.*1 value/);
  });

  it("refuses a file with an unparseable value literal", async () => {
    const driver = new NodeSqliteDriver();
    await open(driver);
    const sql = "INSERT INTO `kv` (`key`, `value`) VALUES ('k', not_a_literal);";

    const result = await parseBackupDatabase(sql, driver);

    expect(result.ok).toBe(false);
  });

  it("refuses a file containing a statement that isn't CREATE TABLE or INSERT INTO", async () => {
    const driver = new NodeSqliteDriver();
    await open(driver);
    const sql = "DROP TABLE `kv`;";

    const result = await parseBackupDatabase(sql, driver);

    expect(result.ok).toBe(false);
  });

  it("refuses an INSERT into a known table whose own CREATE TABLE never appeared first", async () => {
    const driver = new NodeSqliteDriver();
    await open(driver);
    const sql = "INSERT INTO `kv` (`key`, `value`) VALUES ('k', 'v');";

    const result = await parseBackupDatabase(sql, driver);

    expect(result.ok).toBe(false);
  });

  it("leaves the target database completely untouched when it refuses a file", async () => {
    const driver = new NodeSqliteDriver();
    const { store } = await open(driver);
    await store.upsert([entry({ id: "e1", body: "still here" })]);

    await parseBackupDatabase("garbage not sql at all;", driver);

    const rows = await driver.execute("SELECT id FROM entries", [], "all");
    expect(rows.rows).toHaveLength(1);
  });
});
