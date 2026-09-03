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
      ["comments"],
      ["entries"],
      ["entries_fts"],
      ["entries_fts_config"],
      ["entries_fts_content"],
      ["entries_fts_data"],
      ["entries_fts_docsize"],
      ["entries_fts_idx"],
      ["kv"],
      ["labels"],
      ["meologue_migrations"],
      ["projects"],
      ["sections"],
      ["tasks"],
      ["tasks_fts"],
      ["tasks_fts_config"],
      ["tasks_fts_content"],
      ["tasks_fts_data"],
      ["tasks_fts_docsize"],
      ["tasks_fts_idx"],
    ]);
  });

  it("re-running is a no-op — an already-applied migration is not re-applied", async () => {
    const driver = new NodeSqliteDriver();

    await migrate(driver);
    await migrate(driver);

    const result = await driver.execute("SELECT version FROM meologue_migrations", [], "all");
    // version 7 is packages/core/src/recurrence/'s own migration
    // (../migrations/index.ts's own comment on MIGRATIONS has the full
    // story of why it's sequenced before the labels migration's own
    // version 8 despite landing after it in this tree). version 9 is
    // issue #171's projects/sections migration. version 10 is issue #179's
    // drop of `tasks.duration`. version 11 is issue #180's
    // `tasks.description` column; version 12 is that same issue's
    // `comments` table.
    expect(result.rows).toEqual([
      [1],
      [2],
      [3],
      [4],
      [5],
      [6],
      [7],
      [8],
      [9],
      [10],
      [11],
      [12],
      [13],
    ]);
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
      "INSERT INTO entries VALUES ('a', 'device-1', 'a recurring task', '2026-01-01T00:00:00.000Z', null, null, null)",
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

  // The scenario ../migrator.ts's DUPLICATE_COLUMN_NAME guard exists for
  // (ADR 0007's amendment, ADR 0028): a process that dies after migration
  // 3's `ALTER TABLE ADD COLUMN` lands but before its ledger row is
  // written. Simulate that by applying the migration's own DDL directly —
  // bypassing migrate() — without recording it in the ledger, then run
  // migrate() for real and assert it completes rather than throwing
  // `duplicate column name`, and that the store it leaves behind is
  // usable. Without the guard this test fails with exactly that error,
  // and a real device in this state would never open again.
  it("re-running migrate() after an interrupted ALTER TABLE does not throw and leaves the store usable", async () => {
    const driver = new NodeSqliteDriver();
    // A full, uninterrupted migrate() already runs migration 3's `ALTER
    // TABLE ADD deleted_at` — the DDL landing is what "interrupted"
    // actually means here, so this call stands in for that. Deleting only
    // its ledger row below (mirroring the earlier search-index test) is
    // what turns this into the interrupted scenario: the column exists,
    // but the ledger doesn't yet know it.
    await migrate(driver);
    await driver.execute("DELETE FROM meologue_migrations WHERE version = 3", [], "run");

    await expect(migrate(driver)).resolves.toBeUndefined();

    const ledger = await driver.execute("SELECT version FROM meologue_migrations", [], "all");
    expect(ledger.rows).toEqual([
      [1],
      [2],
      [3],
      [4],
      [5],
      [6],
      [7],
      [8],
      [9],
      [10],
      [11],
      [12],
      [13],
    ]);

    // The store isn't just "didn't throw" — it's actually usable: a write
    // that touches the new column succeeds.
    await driver.execute(
      "INSERT INTO entries VALUES ('a', 'device-1', 'hello', '2026-01-01T00:00:00.000Z', null, null, null)",
      [],
      "run",
    );
    const row = await driver.execute("SELECT deleted_at FROM entries WHERE id = 'a'", [], "all");
    expect(row.rows).toEqual([[null]]);
  });

  // The mirror-image scenario for ../migrator.ts's NO_SUCH_COLUMN guard
  // (issue #179): a process that dies after migration 10's `ALTER TABLE
  // tasks DROP COLUMN duration` lands but before its ledger row is
  // written. Simulate that exactly the way the ADD COLUMN test above
  // does: run migrate() for real (which drops the column for real), then
  // delete only migration 10's own ledger row, then run migrate() again
  // and assert it completes rather than throwing `no such column`.
  it("re-running migrate() after an interrupted DROP COLUMN does not throw and leaves the store usable", async () => {
    const driver = new NodeSqliteDriver();
    await migrate(driver);
    await driver.execute("DELETE FROM meologue_migrations WHERE version = 10", [], "run");

    await expect(migrate(driver)).resolves.toBeUndefined();

    const ledger = await driver.execute("SELECT version FROM meologue_migrations", [], "all");
    expect(ledger.rows).toEqual([
      [1],
      [2],
      [3],
      [4],
      [5],
      [6],
      [7],
      [8],
      [9],
      [10],
      [11],
      [12],
      [13],
    ]);

    // The store isn't just "didn't throw" — `duration` is actually gone,
    // and the rest of the row still reads and writes normally.
    await driver.execute(
      "INSERT INTO tasks (id, device_id, content, order_key, created_at) VALUES ('t', 'device-1', 'buy milk', 'V', '2026-01-01T00:00:00.000Z')",
      [],
      "run",
    );
    const columns = await driver.execute("PRAGMA table_info(tasks)", [], "all");
    const columnNames = columns.rows.map((row) => (row as unknown[])[1]);
    expect(columnNames).not.toContain("duration");
  });
});
