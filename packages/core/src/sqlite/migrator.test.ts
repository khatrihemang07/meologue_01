import { describe, expect, it } from "vitest";
import { migrate } from "./migrator";
import { NodeSqliteDriver } from "./node-driver";

describe("migrate", () => {
  it("creates every table the generated migration describes", async () => {
    const driver = new NodeSqliteDriver();

    await migrate(driver);

    const result = await driver.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      [],
      "all",
    );
    expect(result.rows).toEqual([
      ["entries"],
      ["entries_fts"],
      ["entries_fts_config"],
      ["entries_fts_content"],
      ["entries_fts_data"],
      ["entries_fts_docsize"],
      ["entries_fts_idx"],
      ["kv"],
      ["meologue_migrations"],
    ]);
  });

  it("re-running is a no-op — an already-applied migration is not re-applied", async () => {
    const driver = new NodeSqliteDriver();

    await migrate(driver);
    await migrate(driver);

    const result = await driver.execute("SELECT version FROM meologue_migrations", [], "all");
    expect(result.rows).toEqual([[1], [2]]);
  });

  it("backfills Entries that existed before the search index migration shipped", async () => {
    const driver = new NodeSqliteDriver();
    // Simulates a device that already had migration 1 applied and Entries
    // written before this migration shipped: create just the `entries`
    // table by hand and insert directly into it, bypassing the store (and
    // so the search index it would normally maintain).
    await driver.execute(
      `CREATE TABLE entries (
         id text primary key, device_id text not null, body text not null,
         created_at text not null, seq integer, synced_at text
       )`,
      [],
      "run",
    );
    await driver.execute(
      "INSERT INTO entries VALUES ('a', 'device-1', 'a recurring task', '2026-01-01T00:00:00.000Z', null, null)",
      [],
      "run",
    );

    await migrate(driver);

    const found = await driver.execute(
      "SELECT id FROM entries_fts WHERE entries_fts MATCH ?",
      ['"recur"*'],
      "all",
    );
    expect(found.rows).toEqual([["a"]]);
  });

  it("re-running the search index migration's own statements does not duplicate rows", async () => {
    const driver = new NodeSqliteDriver();
    await migrate(driver);
    await driver.execute(
      "INSERT INTO entries VALUES ('a', 'device-1', 'a recurring task', '2026-01-01T00:00:00.000Z', null, null)",
      [],
      "run",
    );
    // The migration runner records a migration's ledger row only after all
    // of its statements ran, so a process that dies in between leaves the
    // ledger believing the migration is still unapplied. Simulate that by
    // deleting the ledger row and re-running the migration's own DDL and
    // backfill directly against a database where the index already has
    // this row — the same shape a retry would see.
    await driver.execute("DELETE FROM meologue_migrations WHERE version = 2", [], "run");
    await driver.execute(
      "CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(id UNINDEXED, body, tokenize='unicode61')",
      [],
      "run",
    );
    await driver.execute(
      "INSERT INTO entries_fts (id, body) VALUES ('a', 'a recurring task')",
      [],
      "run",
    );

    await migrate(driver);

    const count = await driver.execute(
      "SELECT count(*) FROM entries_fts WHERE id = 'a'",
      [],
      "all",
    );
    expect(count.rows).toEqual([[1]]);
  });
});
