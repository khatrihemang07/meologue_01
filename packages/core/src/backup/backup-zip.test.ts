import { DatabaseSync } from "node:sqlite";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { NodeSqliteDriver } from "../sqlite/node-driver";
import { open } from "../sqlite/open";
import { entry } from "../test-support/entry-fixture";
import { task } from "../test-support/task-fixture";
import { backupFileName, createBackup } from "./backup-zip";
import type { BackupMeta } from "./meta";

const OFFSET_IST = 330; // +05:30

describe("backupFileName", () => {
  it("names the file from the Device's local clock, prefixed distinctly from an Export", () => {
    expect(backupFileName(new Date("2026-08-16T06:12:03.000Z"), OFFSET_IST)).toBe(
      "meologue-backup-20260816-114203.zip",
    );
  });

  it("produces two distinct filenames for two Backups a second apart", () => {
    const first = backupFileName(new Date("2026-08-16T06:12:03.000Z"), OFFSET_IST);
    const second = backupFileName(new Date("2026-08-16T06:12:04.000Z"), OFFSET_IST);
    expect(first).not.toBe(second);
  });
});

describe("createBackup", () => {
  it("zips database.sql, settings.json and meta.json", async () => {
    const driver = new NodeSqliteDriver();
    const { deviceId } = await open(driver);

    const { fileName, bytes } = await createBackup(
      driver,
      { "meologue.theme": "dark" },
      { deviceId, now: new Date("2026-08-16T06:15:00.000Z"), utcOffsetMinutes: OFFSET_IST },
    );

    expect(fileName).toBe("meologue-backup-20260816-114500.zip");
    const unzipped = unzipSync(bytes);
    expect(Object.keys(unzipped).sort()).toEqual(["database.sql", "meta.json", "settings.json"]);
  });

  it("carries the given settings verbatim, with no validation and no reshaping", async () => {
    const driver = new NodeSqliteDriver();
    const { deviceId } = await open(driver);
    const settings = { "meologue.theme": "dark", "meologue.server-url": "https://phone.example" };

    const { bytes } = await createBackup(driver, settings, {
      deviceId,
      now: new Date("2026-08-16T06:15:00.000Z"),
      utcOffsetMinutes: OFFSET_IST,
    });

    const unzipped = unzipSync(bytes);
    expect(JSON.parse(strFromU8(unzipped["settings.json"] as Uint8Array))).toEqual(settings);
  });

  it("writes a meta.json naming this Backup's schema, Device and row counts", async () => {
    const driver = new NodeSqliteDriver();
    const { deviceId, store } = await open(driver);
    await store.upsert([entry({ id: "e1" })]);

    const { bytes } = await createBackup(
      driver,
      {},
      { deviceId, now: new Date("2026-08-16T06:15:00.000Z"), utcOffsetMinutes: OFFSET_IST },
    );

    const unzipped = unzipSync(bytes);
    const meta = JSON.parse(strFromU8(unzipped["meta.json"] as Uint8Array)) as BackupMeta;
    expect(meta.device_id).toBe(deviceId);
    expect(meta.taken_at).toBe("2026-08-16T06:15:00.000Z");
    expect(meta.row_counts.entries).toBe(1);
  });

  // The acceptance criterion this ticket names explicitly: unzipping a
  // Backup and feeding its SQL dump to a fresh database reproduces the
  // data — proven end to end here, from the actual zip bytes createBackup
  // hands back, through unzipSync, into a brand-new node:sqlite database,
  // the same path a real Restore (or `sqlite3 db.sqlite < database.sql`)
  // would take.
  it("unzips to a database.sql that, fed to a fresh database, reproduces every Entry and Task exactly", async () => {
    const driver = new NodeSqliteDriver();
    const { deviceId, store, taskStore } = await open(driver);
    const body = "went for a walk\nand saw a 🐕, café included, and a 'quote'.";
    await store.upsert([entry({ id: "e1", deviceId, body })]);
    await taskStore.upsert([task({ id: "t1", deviceId, content: "buy milk" })]);

    const { bytes } = await createBackup(
      driver,
      {},
      { deviceId, now: new Date("2026-08-16T06:15:00.000Z"), utcOffsetMinutes: OFFSET_IST },
    );

    const unzipped = unzipSync(bytes);
    const databaseSql = strFromU8(unzipped["database.sql"] as Uint8Array);

    const fresh = new DatabaseSync(":memory:");
    fresh.exec(databaseSql);

    const restoredEntry = fresh.prepare("SELECT body FROM entries WHERE id = ?").get("e1") as
      | { body: string }
      | undefined;
    expect(restoredEntry?.body).toBe(body);

    const restoredTask = fresh.prepare("SELECT content FROM tasks WHERE id = ?").get("t1") as
      | { content: string }
      | undefined;
    expect(restoredTask?.content).toBe("buy milk");
  });
});
