import { describe, expect, it } from "vitest";
import { rowContentUnchanged } from "./row-diff";

describe("rowContentUnchanged", () => {
  it("is false when there is no existing row at all", () => {
    expect(rowContentUnchanged(undefined, { id: "a", body: "hi" })).toBe(false);
  });

  it("is true when every content column matches exactly", () => {
    const row = { id: "a", body: "hi", created_at: "2026-01-01T00:00:00.000Z", deleted_at: null };
    expect(rowContentUnchanged(row, { ...row })).toBe(true);
  });

  it("is false when a content column differs", () => {
    const existing = { id: "a", body: "hi" };
    expect(rowContentUnchanged(existing, { id: "a", body: "bye" })).toBe(false);
  });

  // The whole point of this function (its own header comment): a `seq` or
  // `synced_at` that changed for Sync reasons must never make an otherwise
  // identical row look "different."
  it("ignores seq and synced_at when deciding whether content changed", () => {
    const existing = { id: "a", body: "hi", seq: 5, synced_at: "2026-01-02T00:00:00.000Z" };
    const incoming = { id: "a", body: "hi", seq: null, synced_at: null };
    expect(rowContentUnchanged(existing, incoming)).toBe(true);
  });

  it("only compares columns incoming actually carries, not every column existing has", () => {
    // incoming is missing a column this build's schema knows (an older
    // Backup, ../backup/parse.ts's own version-skew posture) — that column
    // is simply not part of the comparison.
    const existing = { id: "a", body: "hi", priority: 3 };
    const incoming = { id: "a", body: "hi" };
    expect(rowContentUnchanged(existing, incoming)).toBe(true);
  });

  it("compares blob columns byte-for-byte, not by reference", () => {
    const existing = { id: "a", data: new Uint8Array([1, 2, 3]) };
    const incoming = { id: "a", data: new Uint8Array([1, 2, 3]) };
    expect(rowContentUnchanged(existing, incoming)).toBe(true);
  });

  it("is false when blob columns differ in length or content", () => {
    const existing = { id: "a", data: new Uint8Array([1, 2, 3]) };
    expect(rowContentUnchanged(existing, { id: "a", data: new Uint8Array([1, 2]) })).toBe(false);
    expect(rowContentUnchanged(existing, { id: "a", data: new Uint8Array([1, 2, 9]) })).toBe(false);
  });
});
