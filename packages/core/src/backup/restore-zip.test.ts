import { describe, expect, it } from "vitest";
import { NodeSqliteDriver } from "../sqlite/node-driver";
import { open } from "../sqlite/open";
import { entry } from "../test-support/entry-fixture";
import { createBackup } from "./backup-zip";
import { unzipBackup } from "./restore-zip";

describe("unzipBackup", () => {
  it("round-trips a real Backup's three files back out", async () => {
    const driver = new NodeSqliteDriver();
    const { store, deviceId } = await open(driver);
    await store.upsert([entry({ id: "e1", body: "hello" })]);

    const { bytes } = await createBackup(
      driver,
      { "meologue.theme": "dark" },
      { deviceId, now: new Date("2026-08-16T00:00:00.000Z"), utcOffsetMinutes: 0 },
    );

    const result = unzipBackup(bytes);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.backup.databaseSql).toContain("INSERT INTO `entries`");
    expect(JSON.parse(result.backup.settingsJson)).toEqual({ "meologue.theme": "dark" });
    expect(JSON.parse(result.backup.metaJson).device_id).toBe(deviceId);
  });

  it("refuses bytes that aren't a zip at all", () => {
    const result = unzipBackup(new TextEncoder().encode("not a zip"));
    expect(result.ok).toBe(false);
  });

  it("refuses a zip missing database.sql, settings.json or meta.json", async () => {
    const { zipSync, strToU8 } = await import("fflate");
    const bytes = zipSync({ "settings.json": strToU8("{}"), "meta.json": strToU8("{}") });

    const result = unzipBackup(bytes);

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toContain("database.sql");
  });
});
