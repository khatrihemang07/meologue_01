import { describe, expect, it, vi } from "vitest";
import type { SqliteConnectionFactory, SqliteDbConnection } from "./capacitor-sqlite-driver";
import { CapacitorSqliteDriver } from "./capacitor-sqlite-driver";

/**
 * Stands in for the real `SQLiteDBConnection`, so `execute()` can be
 * verified without a native bridge — mirrors sqlite-worker-driver.test.ts's
 * FakePort.
 */
class FakeConnection implements SqliteDbConnection {
  readonly runCalls: Array<{ statement: string; values?: unknown[]; transaction?: boolean }> = [];
  readonly queryCalls: Array<{ statement: string; values?: unknown[] }> = [];
  queryResult: { values?: unknown[] } = { values: [] };

  async open(): Promise<void> {}

  async run(statement: string, values?: unknown[], transaction?: boolean): Promise<unknown> {
    this.runCalls.push({ statement, values, transaction });
    return { changes: { changes: 1 } };
  }

  async query(statement: string, values?: unknown[]): Promise<{ values?: unknown[] }> {
    this.queryCalls.push({ statement, values });
    return this.queryResult;
  }
}

/** Stands in for `SQLiteConnection`, so `connect()`'s branching is testable without Capacitor. */
class FakeSqlite implements SqliteConnectionFactory {
  readonly connection = new FakeConnection();
  consistent = false;
  alreadyOpen = false;
  readonly createConnection = vi.fn(async () => this.connection);
  readonly retrieveConnection = vi.fn(async () => this.connection);

  async checkConnectionsConsistency(): Promise<{ result?: boolean }> {
    return { result: this.consistent };
  }

  async isConnection(): Promise<{ result?: boolean }> {
    return { result: this.alreadyOpen };
  }
}

describe("CapacitorSqliteDriver", () => {
  describe("connect", () => {
    it("creates a new connection when none is already open natively", async () => {
      const sqlite = new FakeSqlite();
      const driver = new CapacitorSqliteDriver(sqlite);

      await driver.connect();

      expect(sqlite.createConnection).toHaveBeenCalledWith(
        "meologue",
        false,
        "no-encryption",
        1,
        false,
      );
      expect(sqlite.retrieveConnection).not.toHaveBeenCalled();
    });

    it("reattaches to an already-open connection instead of creating a second one", async () => {
      const sqlite = new FakeSqlite();
      sqlite.consistent = true;
      sqlite.alreadyOpen = true;
      const driver = new CapacitorSqliteDriver(sqlite);

      await driver.connect();

      expect(sqlite.retrieveConnection).toHaveBeenCalledWith("meologue", false);
      expect(sqlite.createConnection).not.toHaveBeenCalled();
    });
  });

  describe("execute", () => {
    it("runs a statement with transactions disabled for method 'run'", async () => {
      const sqlite = new FakeSqlite();
      const driver = new CapacitorSqliteDriver(sqlite);
      await driver.connect();

      const result = await driver.execute("insert into entries values (?)", ["a"], "run");

      expect(sqlite.connection.runCalls).toEqual([
        { statement: "insert into entries values (?)", values: ["a"], transaction: false },
      ]);
      expect(result).toEqual({ rows: [] });
    });

    it("maps a 'get' query's single row to a positional row", async () => {
      const sqlite = new FakeSqlite();
      sqlite.connection.queryResult = { values: [{ id: "1", body: "hi" }] };
      const driver = new CapacitorSqliteDriver(sqlite);
      await driver.connect();

      const result = await driver.execute("select * from entries limit 1", [], "get");

      expect(result).toEqual({ rows: ["1", "hi"] });
    });

    it("returns an empty row for a 'get' query with no match", async () => {
      const sqlite = new FakeSqlite();
      sqlite.connection.queryResult = { values: [] };
      const driver = new CapacitorSqliteDriver(sqlite);
      await driver.connect();

      const result = await driver.execute("select * from entries limit 1", [], "get");

      expect(result).toEqual({ rows: [] });
    });

    it("maps every row for 'all'/'values' queries to positional rows", async () => {
      const sqlite = new FakeSqlite();
      sqlite.connection.queryResult = {
        values: [
          { id: "1", body: "a" },
          { id: "2", body: "b" },
        ],
      };
      const driver = new CapacitorSqliteDriver(sqlite);
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
      const driver = new CapacitorSqliteDriver(new FakeSqlite());

      await expect(driver.execute("select 1", [], "all")).rejects.toThrow("before connect()");
    });
  });
});
