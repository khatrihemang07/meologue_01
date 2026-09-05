import type { Entry, EntryPage } from "@meologue/core";
import { describe, expect, it } from "vitest";
import { dayHasEntries, localDayEndUtc } from "./day-has-entries";

/**
 * A stand-in for the store's `list`, applying the same keyset rule
 * SqliteEntryStore and InMemoryEntryStore both do: newest first by createdAt,
 * ties broken by id descending, `before` bounding to Entries strictly older
 * than that pair, tombstones excluded.
 *
 * Written out rather than imported so the ordering this module depends on is
 * asserted here rather than assumed — if the real cursor rule ever changed,
 * this test would still describe what `dayHasEntries` needs from it.
 */
function fakeStore(entries: Entry[]) {
  return {
    list: async (page?: EntryPage): Promise<Entry[]> => {
      const live = entries.filter((entry) => entry.deletedAt === null);
      const sorted = [...live].sort((a, b) =>
        a.createdAt === b.createdAt
          ? b.id.localeCompare(a.id)
          : b.createdAt.localeCompare(a.createdAt),
      );
      const bounded =
        page?.before === undefined
          ? sorted
          : sorted.filter((entry) => {
              const cursor = page.before as { createdAt: string; id: string };
              return (
                entry.createdAt < cursor.createdAt ||
                (entry.createdAt === cursor.createdAt && entry.id < cursor.id)
              );
            });
      return page?.limit === undefined ? bounded : bounded.slice(0, page.limit);
    },
  };
}

function entry(id: string, createdAt: string, deletedAt: string | null = null): Entry {
  return {
    id,
    deviceId: "device-1",
    body: "captured",
    // Issue #196: updatedAt starts equal to createdAt
    createdAt,
    updatedAt: createdAt,
    seq: null,
    syncedAt: null,
    deletedAt,
  };
}

describe("localDayEndUtc", () => {
  it("is the instant the next local day begins, at UTC", () => {
    expect(localDayEndUtc("2026-08-28", 0)).toBe("2026-08-29T00:00:00.000Z");
  });

  it("shifts by the Device's offset, so a positive offset ends the day earlier in UTC", () => {
    // IST, UTC+5:30 — the local day ends at 18:30Z the evening before.
    expect(localDayEndUtc("2026-08-28", 330)).toBe("2026-08-28T18:30:00.000Z");
  });

  it("shifts the other way for a negative offset", () => {
    expect(localDayEndUtc("2026-08-28", -480)).toBe("2026-08-29T08:00:00.000Z");
  });

  it("rolls over a month boundary", () => {
    expect(localDayEndUtc("2026-08-31", 0)).toBe("2026-09-01T00:00:00.000Z");
  });

  it("rolls over a year boundary", () => {
    expect(localDayEndUtc("2026-12-31", 0)).toBe("2027-01-01T00:00:00.000Z");
  });

  it("refuses anything that is not a day key", () => {
    expect(localDayEndUtc("not-a-day", 0)).toBeNull();
    expect(localDayEndUtc("2026-8-28", 0)).toBeNull();
    expect(localDayEndUtc("", 0)).toBeNull();
  });
});

describe("dayHasEntries", () => {
  it("finds a day that holds one Entry", async () => {
    const store = fakeStore([entry("a", "2026-08-28T10:00:00.000Z")]);
    await expect(dayHasEntries(store, "2026-08-28", 0)).resolves.toBe(true);
  });

  it("reports an empty day as empty even when later days hold Entries", async () => {
    const store = fakeStore([
      entry("a", "2026-08-27T10:00:00.000Z"),
      entry("c", "2026-08-29T10:00:00.000Z"),
    ]);
    await expect(dayHasEntries(store, "2026-08-28", 0)).resolves.toBe(false);
  });

  it("reports a day before any Entry exists as empty", async () => {
    const store = fakeStore([entry("a", "2026-08-28T10:00:00.000Z")]);
    await expect(dayHasEntries(store, "2020-01-01", 0)).resolves.toBe(false);
  });

  it("reports an empty History as empty", async () => {
    await expect(dayHasEntries(fakeStore([]), "2026-08-28", 0)).resolves.toBe(false);
  });

  it("treats a day whose only Entry was removed as empty", async () => {
    const store = fakeStore([
      entry("a", "2026-08-28T10:00:00.000Z", "2026-08-29T00:00:00.000Z"),
      entry("b", "2026-08-20T10:00:00.000Z"),
    ]);
    await expect(dayHasEntries(store, "2026-08-28", 0)).resolves.toBe(false);
  });

  /**
   * The case the empty-string cursor id exists for. An Entry captured at
   * exactly midnight belongs to the day that is starting, not the one that
   * ended — so it must not be what answers for the day before it.
   */
  it("does not let an Entry at exactly midnight answer for the previous day", async () => {
    const store = fakeStore([entry("a", "2026-08-29T00:00:00.000Z")]);
    await expect(dayHasEntries(store, "2026-08-28", 0)).resolves.toBe(false);
    await expect(dayHasEntries(store, "2026-08-29", 0)).resolves.toBe(true);
  });

  it("groups by the Device's local day, not by UTC", async () => {
    // 22:00 on the 28th in UTC is 03:30 on the 29th at UTC+5:30.
    const store = fakeStore([entry("a", "2026-08-28T22:00:00.000Z")]);
    await expect(dayHasEntries(store, "2026-08-29", 330)).resolves.toBe(true);
    await expect(dayHasEntries(store, "2026-08-28", 330)).resolves.toBe(false);
  });

  it("refuses a malformed day key without asking the store", async () => {
    await expect(dayHasEntries(fakeStore([]), "2026-13-45", 0)).resolves.toBe(false);
  });

  it("reads a single row, not the whole History", async () => {
    const pages: Array<EntryPage | undefined> = [];
    const store = {
      list: async (page?: EntryPage) => {
        pages.push(page);
        return [entry("a", "2026-08-28T10:00:00.000Z")];
      },
    };
    await dayHasEntries(store, "2026-08-28", 0);
    expect(pages).toHaveLength(1);
    expect(pages[0]?.limit).toBe(1);
  });
});
