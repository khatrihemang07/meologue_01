import { describe, expect, it } from "vitest";
import { entry } from "../test-support/entry-fixture";
import { task } from "../test-support/task-fixture";
import { groupEntriesIntoDayFiles } from "./day-file";
import { buildManifest, EXPORT_SCHEMA_VERSION } from "./manifest";

const OFFSET_IST = 330; // +05:30

describe("buildManifest", () => {
  it("is a lossless round trip of every Entry's metadata and body", () => {
    const entries = [
      entry({
        id: "e1",
        deviceId: "device-a",
        body: "went for a walk\nand the weather held",
        createdAt: "2026-08-16T11:42:03.000Z",
        seq: 7,
        syncedAt: "2026-08-16T11:42:10.000Z",
      }),
      entry({
        id: "e2",
        deviceId: "device-a",
        body: "never synced yet",
        createdAt: "2026-08-16T12:00:00.000Z",
        seq: null,
        syncedAt: null,
      }),
    ];
    const { fileForEntry } = groupEntriesIntoDayFiles(entries, OFFSET_IST);

    const manifest = buildManifest(entries, fileForEntry, [], {
      deviceId: "device-a",
      exportedAt: "2026-08-16T12:30:00.000Z",
      offsetMinutes: OFFSET_IST,
    });

    expect(manifest.schema).toBe(EXPORT_SCHEMA_VERSION);
    expect(manifest.exported_at).toBe("2026-08-16T12:30:00.000Z");
    expect(manifest.utc_offset).toBe("+05:30");
    expect(manifest.device_id).toBe("device-a");
    expect(manifest.entry_count).toBe(2);
    expect(manifest.task_count).toBe(0);
    expect(manifest.tasks).toEqual([]);
    expect(manifest.entries).toEqual([
      {
        id: "e1",
        device_id: "device-a",
        created_at: "2026-08-16T11:42:03.000Z",
        seq: 7,
        synced_at: "2026-08-16T11:42:10.000Z",
        file: "entries/2026-08-16.txt",
        body: "went for a walk\nand the weather held",
      },
      {
        id: "e2",
        device_id: "device-a",
        created_at: "2026-08-16T12:00:00.000Z",
        seq: null,
        synced_at: null,
        file: "entries/2026-08-16.txt",
        body: "never synced yet",
      },
    ]);
  });

  it("recovers a body exactly even when it contains a line shaped like a timestamp header", () => {
    // The day file (day-file.test.ts) can't tell this body apart from a
    // real header; the manifest is what makes it recoverable regardless.
    const trickyBody = "[11:42:03]\nthis looks like a header but is body text";
    const entries = [entry({ id: "tricky", body: trickyBody })];
    const { fileForEntry } = groupEntriesIntoDayFiles(entries, OFFSET_IST);

    const manifest = buildManifest(entries, fileForEntry, [], {
      deviceId: "device-a",
      exportedAt: "2026-08-16T12:30:00.000Z",
      offsetMinutes: OFFSET_IST,
    });

    expect(manifest.entries[0]?.body).toBe(trickyBody);
  });

  it("is a lossless round trip of every Task field, independent of the Entry list", () => {
    const tasks = [
      task({
        id: "t1",
        deviceId: "device-a",
        content: "buy milk",
        completedAt: null,
        orderKey: "V",
        createdAt: "2026-08-16T09:00:00.000Z",
        seq: 3,
        syncedAt: "2026-08-16T09:00:05.000Z",
        date: "2026-08-20",
        deadline: "2026-08-25",
        priority: 4,
        labelIds: ["label-1", "label-2"],
        dateString: "every week",
        projectId: "project-1",
        sectionId: "section-1",
        parentId: "task-parent",
      }),
      task({
        id: "t2",
        content: "never synced yet",
        seq: null,
        syncedAt: null,
        completedAt: "2026-08-17T10:00:00.000Z",
      }),
    ];

    const manifest = buildManifest([], new Map(), tasks, {
      deviceId: "device-a",
      exportedAt: "2026-08-16T12:30:00.000Z",
      offsetMinutes: OFFSET_IST,
    });

    expect(manifest.task_count).toBe(2);
    expect(manifest.tasks).toEqual([
      {
        id: "t1",
        device_id: "device-a",
        content: "buy milk",
        completed_at: null,
        order_key: "V",
        created_at: "2026-08-16T09:00:00.000Z",
        seq: 3,
        synced_at: "2026-08-16T09:00:05.000Z",
        date: "2026-08-20",
        deadline: "2026-08-25",
        priority: 4,
        label_ids: ["label-1", "label-2"],
        date_string: "every week",
        project_id: "project-1",
        section_id: "section-1",
        parent_id: "task-parent",
      },
      {
        id: "t2",
        device_id: "device-1",
        content: "never synced yet",
        completed_at: "2026-08-17T10:00:00.000Z",
        order_key: "V",
        created_at: "2026-01-01T00:00:00.000Z",
        seq: null,
        synced_at: null,
        date: null,
        deadline: null,
        priority: 1,
        label_ids: [],
        date_string: null,
        project_id: null,
        section_id: null,
        parent_id: null,
      },
    ]);
  });
});
