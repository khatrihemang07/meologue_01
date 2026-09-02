import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { entry } from "../test-support/entry-fixture";
import { project } from "../test-support/project-fixture";
import { task } from "../test-support/task-fixture";
import { exportEntriesToZip, exportFileName } from "./export-zip";
import type { ExportManifest } from "./manifest";

const OFFSET_IST = 330; // +05:30

describe("exportFileName", () => {
  it("names the file from the exporting Device's local clock", () => {
    expect(exportFileName(new Date("2026-08-16T06:12:03.000Z"), OFFSET_IST)).toBe(
      "meologue-export-20260816-114203.zip",
    );
  });

  it("produces two distinct filenames for two exports a second apart", () => {
    const first = exportFileName(new Date("2026-08-16T06:12:03.000Z"), OFFSET_IST);
    const second = exportFileName(new Date("2026-08-16T06:12:04.000Z"), OFFSET_IST);
    expect(first).not.toBe(second);
  });
});

describe("exportEntriesToZip", () => {
  it("unzips to the expected manifest and day file", () => {
    const entries = [
      entry({
        id: "e1",
        deviceId: "device-a",
        body: "went for a walk\nand the weather held",
        createdAt: "2026-08-16T06:12:03.000Z", // 11:42:03 local at +05:30
        seq: 4,
        syncedAt: "2026-08-16T06:12:05.000Z",
      }),
    ];

    const { fileName, bytes } = exportEntriesToZip(entries, [], [], {
      deviceId: "device-a",
      now: new Date("2026-08-16T06:15:00.000Z"),
      utcOffsetMinutes: OFFSET_IST,
    });

    expect(fileName).toBe("meologue-export-20260816-114500.zip");

    const unzipped = unzipSync(bytes);
    expect(Object.keys(unzipped).sort()).toEqual([
      "entries/2026-08-16.txt",
      "manifest.json",
      "tasks.txt",
    ]);

    const dayFile = strFromU8(unzipped["entries/2026-08-16.txt"] as Uint8Array);
    expect(dayFile).toBe(
      [
        "# 2026-08-16  (times in +05:30)",
        "",
        "[11:42:03]",
        "went for a walk",
        "and the weather held",
        "",
      ].join("\n"),
    );

    const manifest = JSON.parse(
      strFromU8(unzipped["manifest.json"] as Uint8Array),
    ) as ExportManifest;
    expect(manifest.device_id).toBe("device-a");
    expect(manifest.utc_offset).toBe("+05:30");
    expect(manifest.entry_count).toBe(1);
    expect(manifest.entries).toEqual([
      {
        id: "e1",
        device_id: "device-a",
        created_at: "2026-08-16T06:12:03.000Z",
        seq: 4,
        synced_at: "2026-08-16T06:12:05.000Z",
        file: "entries/2026-08-16.txt",
        body: "went for a walk\nand the weather held",
      },
    ]);
  });

  it("produces a zip with just a manifest and an empty tasks file for an empty Entry and Task list", () => {
    const { bytes } = exportEntriesToZip([], [], [], {
      deviceId: "device-a",
      now: new Date("2026-08-16T06:15:00.000Z"),
      utcOffsetMinutes: OFFSET_IST,
    });

    const unzipped = unzipSync(bytes);
    expect(Object.keys(unzipped).sort()).toEqual(["manifest.json", "tasks.txt"]);
    const manifest = JSON.parse(
      strFromU8(unzipped["manifest.json"] as Uint8Array),
    ) as ExportManifest;
    expect(manifest.entry_count).toBe(0);
    expect(manifest.entries).toEqual([]);
    expect(manifest.task_count).toBe(0);
    expect(manifest.tasks).toEqual([]);
    expect(strFromU8(unzipped["tasks.txt"] as Uint8Array)).toBe("No Tasks.\n");
  });

  it("covers Tasks losslessly in the manifest and readably, grouped by Project, in tasks.txt", () => {
    const projects = [project({ id: "project-1", name: "Groceries" })];
    const tasks = [
      task({ id: "t1", content: "buy milk", projectId: "project-1", priority: 4 }),
      task({ id: "t2", content: "unfiled errand", projectId: null }),
    ];

    const { bytes } = exportEntriesToZip([], tasks, projects, {
      deviceId: "device-a",
      now: new Date("2026-08-16T06:15:00.000Z"),
      utcOffsetMinutes: OFFSET_IST,
    });

    const unzipped = unzipSync(bytes);
    const manifest = JSON.parse(
      strFromU8(unzipped["manifest.json"] as Uint8Array),
    ) as ExportManifest;
    expect(manifest.task_count).toBe(2);
    expect(manifest.tasks.map((t) => t.id)).toEqual(["t1", "t2"]);

    const tasksFile = strFromU8(unzipped["tasks.txt"] as Uint8Array);
    expect(tasksFile).toBe(
      [
        "# Inbox",
        "",
        "- [ ] unfiled errand",
        "",
        "# Groceries",
        "",
        "- [ ] buy milk (p1)",
        "",
      ].join("\n"),
    );
  });
});
