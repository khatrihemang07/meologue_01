import type { Entry } from "@meologue/core";
import { describe, expect, it } from "vitest";
import { dayReferrers } from "./day-referrers";

function entry(overrides: Partial<Entry>): Entry {
  return {
    id: "1",
    deviceId: "device-1",
    body: "captured",
    // Issue #196: updatedAt starts equal to createdAt
    createdAt: "2026-08-29T10:00:00.000Z",
    updatedAt: "2026-08-29T10:00:00.000Z",
    seq: 1,
    syncedAt: "2026-08-29T10:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

/**
 * A stand-in for `EntryStore.search`, handed exactly what this test wants
 * back — dayReferrers only ever calls `search` once, with the day key
 * itself, so there is nothing here worth reimplementing FTS5's own
 * matching rules for (that belongs to sqlite-entry-store's own contract
 * tests). Records every query it was called with, so a test can assert
 * dayReferrers asked for the right thing.
 */
function fakeStore(results: Entry[]) {
  const calls: string[] = [];
  return {
    calls,
    search: async (query: string) => {
      calls.push(query);
      return results;
    },
  };
}

describe("dayReferrers", () => {
  it("searches the index for the day's own text", async () => {
    const store = fakeStore([]);
    await dayReferrers(store, "2026-08-28", 0);
    expect(store.calls).toEqual(["2026-08-28"]);
  });

  it("keeps a later Entry that actually marks the day with [[...]]", async () => {
    const referrer = entry({
      id: "later",
      body: "circling back to [[2026-08-28]]",
      createdAt: "2026-08-29T10:00:00.000Z",
    });
    const store = fakeStore([referrer]);

    await expect(dayReferrers(store, "2026-08-28", 0)).resolves.toEqual([referrer]);
  });

  // The test that proves step 2 is doing its job: search's own index over-
  // matches (the tokens "2026", "08", "28" appear whether or not the Entry
  // ever used the [[...]] mark), so an Entry that only *mentions* the date
  // as plain prose must not count as a Reference.
  it("does not count an Entry that only mentions the date in prose, with no [[...]] mark", async () => {
    const mentionsOnly = entry({
      id: "prose",
      body: "renewed the lease on 2026-08-28",
      createdAt: "2026-08-29T10:00:00.000Z",
    });
    const store = fakeStore([mentionsOnly]);

    await expect(dayReferrers(store, "2026-08-28", 0)).resolves.toEqual([]);
  });

  it("finds a Reference nested inside bold or italic text", async () => {
    const referrer = entry({
      id: "bold",
      body: "**[[2026-08-28]]** was the day",
      createdAt: "2026-08-29T10:00:00.000Z",
    });
    const store = fakeStore([referrer]);

    await expect(dayReferrers(store, "2026-08-28", 0)).resolves.toEqual([referrer]);
  });

  it("ignores a mark for a different day, even one search's index also surfaced", async () => {
    const wrongDay = entry({ id: "wrong", body: "see [[2026-08-29]]" });
    const store = fakeStore([wrongDay]);

    await expect(dayReferrers(store, "2026-08-28", 0)).resolves.toEqual([]);
  });

  // The self-Reference exclusion this ticket calls for: an Entry captured
  // ON the day it Refers to is not a *later* Entry pointing back at it —
  // the day already holds it.
  it("excludes an Entry that Refers to the very day it was captured on", async () => {
    const sameDay = entry({
      id: "same-day",
      body: "reminder for [[2026-08-28]]",
      createdAt: "2026-08-28T23:00:00.000Z",
    });
    const store = fakeStore([sameDay]);

    await expect(dayReferrers(store, "2026-08-28", 0)).resolves.toEqual([]);
  });

  it("still counts a Reference from a later day even when an earlier candidate is a self-Reference", async () => {
    const sameDay = entry({
      id: "same-day",
      body: "reminder for [[2026-08-28]]",
      createdAt: "2026-08-28T23:00:00.000Z",
    });
    const later = entry({
      id: "later",
      body: "still thinking about [[2026-08-28]]",
      createdAt: "2026-08-30T09:00:00.000Z",
    });
    const store = fakeStore([sameDay, later]);

    await expect(dayReferrers(store, "2026-08-28", 0)).resolves.toEqual([later]);
  });

  // A removed Entry never reaches this function at all — EntryStore.search
  // already excludes tombstones (ADR 0028, same contract list() has) — so
  // dayReferrers only has to pass through whatever search reports, and a
  // day whose only referrer was removed correctly reads as having none.
  it("counts nothing once search no longer returns the removed Entry", async () => {
    await expect(dayReferrers(fakeStore([]), "2026-08-28", 0)).resolves.toEqual([]);
  });

  it("groups the self-Reference check by the Device's local day, not by UTC", async () => {
    // 22:00 on the 28th in UTC is 03:30 on the 29th at UTC+5:30 — captured
    // on the 29th locally, so a Reference to the 28th from this Entry is
    // NOT a self-Reference at that offset.
    const referrer = entry({
      id: "boundary",
      body: "about [[2026-08-28]]",
      createdAt: "2026-08-28T22:00:00.000Z",
    });
    const store = fakeStore([referrer]);

    await expect(dayReferrers(store, "2026-08-28", 330)).resolves.toEqual([referrer]);
  });
});
