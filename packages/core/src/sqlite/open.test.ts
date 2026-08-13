import { describe, expect, it } from "vitest";
import { NodeSqliteDriver } from "./node-driver";
import { open } from "./open";

describe("open", () => {
  it("mints a Device id on first run", async () => {
    const { deviceId } = await open(new NodeSqliteDriver());

    expect(deviceId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("returns the same Device id opening the same database again", async () => {
    const driver = new NodeSqliteDriver();

    const first = await open(driver);
    const second = await open(driver);

    expect(second.deviceId).toBe(first.deviceId);
  });

  it("returns a store that already has its schema migrated", async () => {
    const { store } = await open(new NodeSqliteDriver());

    await expect(store.list()).resolves.toEqual([]);
  });
});
