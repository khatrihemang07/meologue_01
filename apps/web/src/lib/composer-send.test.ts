import { describe, expect, it } from "vitest";
import { decideSend } from "./composer-send";

describe("decideSend", () => {
  it("sends a brand-new Entry when not editing", () => {
    expect(decideSend({ editingEntryId: null, rawBody: "hello", dirty: false })).toEqual({
      kind: "send",
      body: "hello",
    });
  });

  it("refuses a whitespace-only new Entry", () => {
    expect(decideSend({ editingEntryId: null, rawBody: "   ", dirty: false })).toEqual({
      kind: "refuseEmpty",
    });
  });

  it("refuses a whitespace-only edit even if it were somehow marked dirty", () => {
    expect(decideSend({ editingEntryId: "42", rawBody: "   ", dirty: true })).toEqual({
      kind: "refuseEmpty",
    });
  });

  it("commits a dirty edit with the trimmed body", () => {
    expect(decideSend({ editingEntryId: "42", rawBody: "  edited body  ", dirty: true })).toEqual({
      kind: "commit",
      id: "42",
      body: "edited body",
    });
  });

  // ADR 0044's dirty-only commit rule: an Entry opened for editing and
  // closed without ever changing anything must write nothing, Sync
  // nothing, and mark no Digest stale.
  it("treats an unchanged edit as a cancel, not a commit", () => {
    expect(decideSend({ editingEntryId: "42", rawBody: "original body", dirty: false })).toEqual({
      kind: "cancelUnchanged",
    });
  });
});
