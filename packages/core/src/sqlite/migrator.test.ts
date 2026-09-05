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
      ["events"],
      ["filters"],
      ["kv"],
      ["labels"],
      ["meologue_migrations"],
      ["projects"],
      ["sections"],
      ["task_descriptions_fts"],
      ["task_descriptions_fts_config"],
      ["task_descriptions_fts_content"],
      ["task_descriptions_fts_data"],
      ["task_descriptions_fts_docsize"],
      ["task_descriptions_fts_idx"],
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
      [14],
      [15],
      [16],
      [17],
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
    // 8 positional values, not 7: `updated_at` (migration 17, issue #196)
    // is appended at the *end* of the real, physical column order by its
    // own `ALTER TABLE ADD COLUMN` — unlike schema.ts's declared order
    // (which lists it beside `created_at` for readability), a positional
    // `INSERT ... VALUES` has to match the table's actual on-disk column
    // order, and `ADD COLUMN` always appends.
    await driver.execute(
      "INSERT INTO entries VALUES ('a', 'device-1', 'a recurring task', '2026-01-01T00:00:00.000Z', null, null, null, null)",
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

  // Migration 14 (issue #183) rebuilds `tasks_fts` with a `trigram`
  // tokenizer instead of `tasks_search_index.sql`'s original `unicode61` —
  // this is the "changing a tokenizer means rebuilding the index" case
  // ../migrations/index.ts's own comment on migration 14 describes, and
  // this test is its mirror of "backfills Entries that existed before the
  // search index migration shipped" above: a Task written directly against
  // `tasks` (bypassing SqliteTaskStore, so bypassing its own indexForSearch
  // too) still ends up findable by a substring match once migrate() runs.
  it("rebuilds tasks_fts with substring matching, backfilling Tasks that predate the rebuild", async () => {
    const driver = new NodeSqliteDriver();
    await driver.execute(
      `CREATE TABLE tasks (
         id text primary key, device_id text not null, content text not null,
         completed_at text, order_key text not null, day_order text not null,
         created_at text not null, seq integer, synced_at text, deleted_at text,
         date text, deadline text, priority integer not null default 1,
         label_ids text not null default '[]', date_string text,
         project_id text, section_id text, parent_id text, description text
       )`,
      [],
      "run",
    );
    await driver.execute(
      `INSERT INTO tasks (id, device_id, content, order_key, day_order, created_at)
       VALUES ('a', 'device-1', 'a recurring task', 'V', 'V', '2026-01-01T00:00:00.000Z')`,
      [],
      "run",
    );

    await migrate(driver);

    // "urring" is a fragment from the *middle* of "recurring" — the
    // headline substring-matching change this migration exists for
    // (`unicode61`, migration 5's own tokenizer, only ever matched a
    // prefix).
    const found = await driver.execute(
      `SELECT id FROM tasks_fts WHERE tasks_fts MATCH '"urring"'`,
      [],
      "all",
    );
    expect(found.rows).toEqual([["a"]]);
  });

  // Mirrors "re-running the search index migration's own statements does
  // not duplicate rows" above, for migration 14's drop-recreate-backfill
  // shape specifically: a process that died after the DROP/CREATE but
  // before the ledger row landed must not duplicate rows on retry.
  it("re-running migration 14's rebuild does not duplicate rows", async () => {
    const driver = new NodeSqliteDriver();
    await migrate(driver);
    await driver.execute(
      `INSERT INTO tasks (id, device_id, content, order_key, day_order, created_at)
       VALUES ('a', 'device-1', 'a recurring task', 'V', 'V', '2026-01-01T00:00:00.000Z')`,
      [],
      "run",
    );
    await driver.execute(
      "INSERT INTO tasks_fts (id, content) VALUES ('a', 'a recurring task')",
      [],
      "run",
    );
    await driver.execute("DELETE FROM meologue_migrations WHERE version = 14", [], "run");

    await migrate(driver);

    const count = await driver.execute("SELECT count(*) FROM tasks_fts WHERE id = 'a'", [], "all");
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
      [14],
      [15],
      [16],
      [17],
    ]);

    // The store isn't just "didn't throw" — it's actually usable: a write
    // that touches the new column succeeds. 8 positional values — see the
    // identical comment on the search-index test above for why.
    await driver.execute(
      "INSERT INTO entries VALUES ('a', 'device-1', 'hello', '2026-01-01T00:00:00.000Z', null, null, null, null)",
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
      [14],
      [15],
      [16],
      [17],
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

  // Issue #196 / migration 17 (../migrations/0014_updated_at.sql):
  // `updated_at` is backfilled to `created_at`, not to whenever the
  // migration happens to run — see that migration's own comment for why.
  // This is the client-side mirror of "backfills Entries that existed
  // before the search index migration shipped" above, for the new column
  // instead of the FTS5 index.
  it("backfills updated_at to created_at for an Entry that predates migration 17", async () => {
    const driver = new NodeSqliteDriver();
    // Simulates a pre-#196 device: the `entries` table exists (through
    // migration 3) but has no `updated_at` column yet.
    await driver.execute(
      `CREATE TABLE entries (
         id text primary key, device_id text not null, body text not null,
         created_at text not null, seq integer, synced_at text, deleted_at text
       )`,
      [],
      "run",
    );
    await driver.execute(
      "INSERT INTO entries (id, device_id, body, created_at) VALUES ('a', 'device-1', 'hello', '2026-01-01T00:00:00.000Z')",
      [],
      "run",
    );

    await migrate(driver);

    const row = await driver.execute(
      "SELECT created_at, updated_at FROM entries WHERE id = 'a'",
      [],
      "all",
    );
    expect(row.rows).toEqual([["2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"]]);
  });

  // The idempotency half of the same guarantee: the migration's own
  // `WHERE updated_at IS NULL` guard (mirroring migration 13's identical
  // shape for `day_order`) means a second application only ever backfills
  // rows still holding `NULL` — it must never re-clobber a value an
  // ordinary edit already moved past the backfill. Simulated the same way
  // "re-running migrate() after an interrupted ALTER TABLE" above does:
  // delete the migration's own ledger row (the process-died-partway-
  // through shape), plant a value that could only exist after a real
  // post-backfill edit, then run migrate() again.
  it("re-running migration 17 does not overwrite an updated_at an edit already moved past the backfill", async () => {
    const driver = new NodeSqliteDriver();
    await migrate(driver);
    await driver.execute(
      "INSERT INTO entries (id, device_id, body, created_at, updated_at, seq, synced_at, deleted_at) VALUES ('a', 'device-1', 'hello', '2026-01-01T00:00:00.000Z', '2026-02-02T00:00:00.000Z', null, null, null)",
      [],
      "run",
    );
    await driver.execute("DELETE FROM meologue_migrations WHERE version = 17", [], "run");

    await migrate(driver);

    const row = await driver.execute("SELECT updated_at FROM entries WHERE id = 'a'", [], "all");
    expect(row.rows).toEqual([["2026-02-02T00:00:00.000Z"]]);
  });

  // The tie property Merge (issue #199) depends on: two Devices that
  // already share a pre-existing row, migrated independently (and, in
  // this test, at genuinely different real times — `migrate()` is never
  // told what "now" is, so this is exercising the real backfill, not a
  // mocked clock), must end up with the *identical* backfilled
  // `updated_at`. Backfilling to `created_at` — stable, and already
  // identical on both Devices before this migration ever ran — is what
  // makes that true; backfilling to migration-run-time would instead make
  // whichever Device happened to migrate second look like it touched the
  // row last, a tie this ticket's own design explicitly refuses to break.
  it("two Devices holding the same pre-existing Entry backfill to the identical updated_at", async () => {
    const deviceA = new NodeSqliteDriver();
    const deviceB = new NodeSqliteDriver();
    const sharedRow = () =>
      `CREATE TABLE entries (
         id text primary key, device_id text not null, body text not null,
         created_at text not null, seq integer, synced_at text, deleted_at text
       )`;
    for (const driver of [deviceA, deviceB]) {
      await driver.execute(sharedRow(), [], "run");
      await driver.execute(
        "INSERT INTO entries (id, device_id, body, created_at) VALUES ('shared', 'device-1', 'hello', '2026-01-01T00:00:00.000Z')",
        [],
        "run",
      );
    }

    // Migrated one after the other, not concurrently — if the backfill
    // depended on wall-clock time at all, this ordering is exactly what
    // would expose it.
    await migrate(deviceA);
    await migrate(deviceB);

    const [rowA, rowB] = await Promise.all([
      deviceA.execute("SELECT updated_at FROM entries WHERE id = 'shared'", [], "all"),
      deviceB.execute("SELECT updated_at FROM entries WHERE id = 'shared'", [], "all"),
    ]);
    expect(rowA.rows).toEqual(rowB.rows);
    expect(rowA.rows).toEqual([["2026-01-01T00:00:00.000Z"]]);
  });
});
