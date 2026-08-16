import { describe, expect, it } from "vitest";
import { entry } from "../test-support/entry-fixture";
import { groupEntriesIntoDayFiles } from "./day-file";

const OFFSET_IST = 330; // +05:30

describe("groupEntriesIntoDayFiles", () => {
  it("groups an Entry into the local day it falls in, not the UTC day", () => {
    // 2026-08-15T19:00:00Z is 2026-08-16T00:30 local at +05:30 — just past
    // local midnight, but still 2026-08-15 in UTC. A UTC-day grouping would
    // file this under the previous day; the local day is 2026-08-16.
    const entries = [entry({ id: "e1", createdAt: "2026-08-15T19:00:00.000Z" })];

    const { files } = groupEntriesIntoDayFiles(entries, OFFSET_IST);

    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe("entries/2026-08-16.txt");
  });

  it("splits Entries either side of a local-midnight boundary into two day files", () => {
    const beforeMidnight = entry({
      id: "before",
      createdAt: "2026-08-15T18:00:00.000Z", // 2026-08-15T23:30 local
    });
    const afterMidnight = entry({
      id: "after",
      createdAt: "2026-08-15T19:00:00.000Z", // 2026-08-16T00:30 local
    });

    const { files, fileForEntry } = groupEntriesIntoDayFiles(
      [afterMidnight, beforeMidnight], // list() order: newest first
      OFFSET_IST,
    );

    expect(files.map((file) => file.path)).toEqual([
      "entries/2026-08-15.txt",
      "entries/2026-08-16.txt",
    ]);
    expect(fileForEntry.get("before")).toBe("entries/2026-08-15.txt");
    expect(fileForEntry.get("after")).toBe("entries/2026-08-16.txt");
  });

  it("orders Entries within a day oldest-first, the reverse of list()'s newest-first order", () => {
    const earlier = entry({ id: "earlier", createdAt: "2026-08-16T02:00:00.000Z", body: "first" });
    const later = entry({ id: "later", createdAt: "2026-08-16T10:00:00.000Z", body: "second" });

    // Passed in newest-first, as EntryStore.list() returns.
    const { files } = groupEntriesIntoDayFiles([later, earlier], OFFSET_IST);

    const contents = files[0]?.contents ?? "";
    expect(contents.indexOf("first")).toBeLessThan(contents.indexOf("second"));
  });

  it("records the offset used in the day file's header line", () => {
    const entries = [entry({ createdAt: "2026-08-16T11:42:03.000Z" })];

    const { files } = groupEntriesIntoDayFiles(entries, OFFSET_IST);

    expect(files[0]?.contents.split("\n")[0]).toBe("# 2026-08-16  (times in +05:30)");
  });

  it("preserves a multi-line body byte-for-byte, including its own newlines", () => {
    const body = "went for a walk\nand the weather held";
    const entries = [entry({ createdAt: "2026-08-16T11:42:03.000Z", body })];

    const { files } = groupEntriesIntoDayFiles(entries, OFFSET_IST);

    expect(files[0]?.contents).toContain(`[17:12:03]\n${body}\n`);
  });

  it("does not corrupt a day file when a body itself contains a line shaped like a timestamp header", () => {
    const trickyBody = "[11:42:03]\nthis looks like a header but is body text";
    const entries = [
      entry({ id: "tricky", createdAt: "2026-08-16T06:00:00.000Z", body: trickyBody }),
    ];

    const { files } = groupEntriesIntoDayFiles(entries, OFFSET_IST);

    // The day file renders without throwing and contains the body verbatim —
    // it's allowed to be ambiguous on read-back (that's what manifest.json
    // is for, see manifest.test.ts), just not corrupted or truncated.
    expect(files[0]?.contents).toContain(trickyBody);
  });

  it("produces no files for an empty Entry list", () => {
    expect(groupEntriesIntoDayFiles([], OFFSET_IST).files).toEqual([]);
  });
});
