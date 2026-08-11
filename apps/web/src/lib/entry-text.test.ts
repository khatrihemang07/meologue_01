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
});
