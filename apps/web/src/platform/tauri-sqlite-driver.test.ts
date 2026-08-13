import { describe, expect, it, vi } from "vitest";
import type { TauriDatabase } from "./tauri-sqlite-driver";
import { TauriSqliteDriver, toNumberedPlaceholders } from "./tauri-sqlite-driver";

/**
 * Stands in for `@tauri-apps/plugin-sql`'s `Database`, so `execute()` can
 * be verified without a native bridge — mirrors capacitor-sqlite-driver.test.ts's
 * FakeConnection.
 */
class FakeDatabase implements TauriDatabase {
  readonly executeCalls: Array<{ query: string; bindValues?: unknown[] }> = [];
  readonly selectCalls: Array<{ query: string; bindValues?: unknown[] }> = [];
  selectResult: unknown[] = [];

  async execute(query: string, bindValues?: unknown[]): Promise<unknown> {
    this.executeCalls.push({ query, bindValues });
    return { rowsAffected: 1 };
  }

  async select<T>(query: string, bindValues?: unknown[]): Promise<T> {
    this.selectCalls.push({ query, bindValues });
    return this.selectResult as T;
  }
}

describe("toNumberedPlaceholders", () => {
  it("rewrites positional ? placeholders into numbered $1, $2, ... placeholders", () => {
    expect(toNumberedPlaceholders("insert into entries values (?, ?, ?)")).toBe(
      "insert into entries values ($1, $2, $3)",
    );
  });

  it("leaves a ? inside a single-quoted string literal untouched", () => {
    expect(toNumberedPlaceholders("select * from entries where body = 'really?' and id = ?")).toBe(
      "select * from entries where body = 'really?' and id = $1",
    );
  });

  it("leaves SQL with no placeholders unchanged", () => {
    expect(toNumberedPlaceholders("select * from entries")).toBe("select * from entries");
  });
});

describe("TauriSqliteDriver", () => {
  describe("connect", () => {
    it("loads the database at the fixed sqlite path", async () => {
      const db = new FakeDatabase();
      const load = vi.fn(async () => db);
      const driver = new TauriSqliteDriver(load);

      await driver.connect();

      expect(load).toHaveBeenCalledWith("sqlite:meologue.db");
    });
  });

  describe("execute", () => {
    it("rewrites placeholders and runs a statement for method 'run'", async () => {
      const db = new FakeDatabase();
      const driver = new TauriSqliteDriver(async () => db);
      await driver.connect();

      const result = await driver.execute("insert into entries values (?)", ["a"], "run");

      expect(db.executeCalls).toEqual([
        { query: "insert into entries values ($1)", bindValues: ["a"] },
      ]);
      expect(result).toEqual({ rows: [] });
    });

    it("maps a 'get' query's single row to a positional row", async () => {
      const db = new FakeDatabase();
      db.selectResult = [{ id: "1", body: "hi" }];
      const driver = new TauriSqliteDriver(async () => db);
      await driver.connect();

      const result = await driver.execute("select * from entries where id = ?", ["1"], "get");

      expect(db.selectCalls).toEqual([
        { query: "select * from entries where id = $1", bindValues: ["1"] },
      ]);
      expect(result).toEqual({ rows: ["1", "hi"] });
    });

    it("returns an empty row for a 'get' query with no match", async () => {
      const db = new FakeDatabase();
      db.selectResult = [];
      const driver = new TauriSqliteDriver(async () => db);
      await driver.connect();

      const result = await driver.execute("select * from entries limit 1", [], "get");

      expect(result).toEqual({ rows: [] });
    });

    it("maps every row for 'all'/'values' queries to positional rows", async () => {
      const db = new FakeDatabase();
      db.selectResult = [
        { id: "1", body: "a" },
        { id: "2", body: "b" },
      ];
      const driver = new TauriSqliteDriver(async () => db);
      await driver.connect();

      const result = await driver.execute("select * from entries", [], "all");

      expect(result).toEqual({
        rows: [
          ["1", "a"],
          ["2", "b"],
        ],
      });
    });

    it("throws when execute is called before connect", async () => {
      const driver = new TauriSqliteDriver(async () => new FakeDatabase());

      await expect(driver.execute("select 1", [], "all")).rejects.toThrow("before connect()");
    });
  });
});
