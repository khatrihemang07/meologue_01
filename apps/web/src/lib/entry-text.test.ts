import { describe, expect, it } from "vitest";
import { normalizeEntryBody } from "./entry-text";

describe("normalizeEntryBody", () => {
  it("trims surrounding whitespace", () => {
    expect(normalizeEntryBody("  hello  ")).toBe("hello");
  });

  it("preserves internal line breaks", () => {
    expect(normalizeEntryBody("line one\nline two")).toBe("line one\nline two");
  });

  it("rejects empty input", () => {
    expect(normalizeEntryBody("")).toBeNull();
  });

  it("rejects whitespace-only input", () => {
    expect(normalizeEntryBody("   \n\t  ")).toBeNull();
  });

  // Issue #212: a body holding nothing but soft breaks — `insertSoftBreak`
  // (composer-commands.ts) pressed one or more times with nothing else ever
  // typed — is exactly what the Composer's own document serializes to in
  // that case, and it must refuse to Send exactly as an empty draft always
  // has. `\n` is `White_Space` under `String.prototype.trim`'s own
  // definition, so this already worked before this ticket touched Enter at
  // all; asserted directly here because it is now a real, reachable path a
  // reader can produce with the keyboard, not merely an edge case of the
  // trim/whitespace grammar.
  it("rejects a body of only newlines", () => {
    expect(normalizeEntryBody("\n\n\n")).toBeNull();
  });
});
