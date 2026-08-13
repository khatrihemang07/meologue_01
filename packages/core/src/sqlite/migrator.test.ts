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
    expect(result.rows).toEqual([["entries"], ["kv"], ["meologue_migrations"]]);
  });

  it("re-running is a no-op — an already-applied migration is not re-applied", async () => {
    const driver = new NodeSqliteDriver();

    await migrate(driver);
    await migrate(driver);

    const result = await driver.execute("SELECT version FROM meologue_migrations", [], "all");
    expect(result.rows).toEqual([[1]]);
  });
});
