import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { NodeSqliteDriver } from "../sqlite/node-driver";
import { open } from "../sqlite/open";
import { entry } from "../test-support/entry-fixture";
import { backupTableNames, dumpDatabase, escapeSqlValue } from "./dump";

describe("escapeSqlValue", () => {
  it("renders null and undefined as the bare NULL literal", () => {
    expect(escapeSqlValue(null)).toBe("NULL");
    expect(escapeSqlValue(undefined)).toBe("NULL");
  });

  it("renders a number bare, with no quoting", () => {
    expect(escapeSqlValue(4)).toBe("4");
    expect(escapeSqlValue(-1.5)).toBe("-1.5");
    expect(escapeSqlValue(0)).toBe("0");
  });

  it("renders a bigint bare, the same as a plain number", () => {
    expect(escapeSqlValue(9007199254740993n)).toBe("9007199254740993");
  });

  it("renders true/false as 1/0", () => {
    expect(escapeSqlValue(true)).toBe("1");
    expect(escapeSqlValue(false)).toBe("0");
  });

  it("doubles every embedded single quote and wraps the result in single quotes", () => {
    expect(escapeSqlValue("O'Brien's")).toBe("'O''Brien''s'");
  });

  // The whole point of this function: SQL string literals have no
  // backslash-escape syntax, so a newline, a backslash and an emoji all sit
  // between the quotes exactly as typed — only a literal `'` needs doubling.
  it("leaves newlines, backslashes and emoji untouched inside the quotes", () => {
    const value = "line one\nline two\\with a backslash and an emoji 😀🔥 and café";
    expect(escapeSqlValue(value)).toBe(`'${value}'`);
  });

  it("renders a blob as an X'<hex>' literal", () => {
    expect(escapeSqlValue(new Uint8Array([0, 15, 255]))).toBe("X'000FFF'");
  });

  it("throws rather than silently emitting an invalid token for a non-finite number", () => {
    expect(() => escapeSqlValue(Number.NaN)).toThrow(/non-finite/);
    expect(() => escapeSqlValue(Number.POSITIVE_INFINITY)).toThrow(/non-finite/);
  });

  it("throws on a value shape it has no literal for", () => {
    expect(() => escapeSqlValue({})).toThrow(/cannot dump a value of type/);
  });
});

describe("dumpDatabase", () => {
  it("covers all eight entity tables plus kv and meologue_migrations, and excludes the FTS5 tables and their shadow tables", async () => {
    const driver = new NodeSqliteDriver();
    await open(driver);

    const names = await backupTableNames(driver);

    expect(names.sort()).toEqual([
      "comments",
      "entries",
      "events",
      "filters",
      "kv",
      "labels",
      "meologue_migrations",
      "projects",
      "sections",
      "tasks",
    ]);

    const dump = await dumpDatabase(driver);
    // Every search-index table (../sqlite/migrations/index.ts) and every
    // shadow table FTS5 creates alongside each one (`_data`, `_idx`,
    // `_content`, `_docsize`, `_config`) must be entirely absent — not just
    // missing a CREATE, but missing outright, so a stray mention in some
    // other table's row data doesn't accidentally pass this check.
    for (const name of ["entries_fts", "tasks_fts", "task_descriptions_fts"]) {
      expect(dump).not.toContain(name);
    }
  });

  it("emits a table's own CREATE TABLE from sqlite_master, then one INSERT per row, tombstones included", async () => {
    const driver = new NodeSqliteDriver();
    const { store } = await open(driver);
    await store.upsert([
      entry({ id: "live", body: "still here" }),
      entry({ id: "gone", body: "", deletedAt: "2026-08-16T00:00:00.000Z" }),
    ]);

    const dump = await dumpDatabase(driver);

    expect(dump).toContain("CREATE TABLE `entries`");
    expect(dump).toContain("INSERT INTO `entries` (`id`, `device_id`, `body`");
    // Both rows travel — the tombstone included, per this ticket's own "a
    // backup that quietly omits things is worse than none" rule (ADR 0016).
    expect(dump.match(/INSERT INTO `entries`/g)).toHaveLength(2);
    expect(dump).toContain("'live'");
    expect(dump).toContain("'gone'");
  });

  it("emits no INSERT statements for a table with no rows", async () => {
    const driver = new NodeSqliteDriver();
    await open(driver);

    const dump = await dumpDatabase(driver);

    expect(dump).toContain("CREATE TABLE `comments`");
    expect(dump).not.toContain("INSERT INTO `comments`");
  });

  // The acceptance criterion this pins shut: unzipping a Backup and feeding
  // its SQL dump to a fresh database must reproduce the data exactly,
  // proven rather than assumed. `DatabaseSync.exec()` runs a whole
  // multi-statement string as one batch — the same thing `sqlite3 db.sqlite
  // < database.sql` does on a real Device — so this feeds dumpDatabase's
  // own output straight into it, with no manual splitting on "\n" (which
  // would be wrong the moment a body's own embedded newline sits inside an
  // INSERT statement's string literal, exactly the case this test seeds).
  it("round-trips a body with quotes, newlines, backslashes, unicode and emoji through a fresh database", async () => {
    const driver = new NodeSqliteDriver();
    const { store } = await open(driver);
    const body = "She said \"hi\"\nand 'bye'\nwith a \\backslash\\ and café ☕ and 😀🔥.";
    await store.upsert([entry({ id: "tricky", body })]);

    const dump = await dumpDatabase(driver);

    const fresh = new DatabaseSync(":memory:");
    fresh.exec(dump);
    const row = fresh.prepare("SELECT body FROM entries WHERE id = ?").get("tricky") as
      | { body: string }
      | undefined;

    expect(row?.body).toBe(body);
  });
});
