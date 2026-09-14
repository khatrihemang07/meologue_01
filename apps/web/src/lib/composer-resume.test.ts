import { beforeEach, describe, expect, it } from "vitest";
import {
  clearComposerResumeDay,
  readComposerResumeDay,
  writeComposerResumeDay,
} from "./composer-resume";

describe("composer-resume", () => {
  // The module holds its memory in a plain variable, not storage (see the
  // module's own doc comment for why) — reset it directly rather than
  // reaching for `sessionStorage.clear()`/`localStorage.clear()` the way
  // last-session.test.ts does for its own, storage-backed module.
  beforeEach(() => {
    clearComposerResumeDay();
  });

  it("returns null when nothing has been remembered yet", () => {
    expect(readComposerResumeDay()).toBeNull();
  });

  it("returns what was last written", () => {
    writeComposerResumeDay("2026-09-12");
    expect(readComposerResumeDay()).toBe("2026-09-12");
  });

  it("a later write replaces the earlier one, rather than accumulating", () => {
    writeComposerResumeDay("2026-09-12");
    writeComposerResumeDay("2026-09-13");
    expect(readComposerResumeDay()).toBe("2026-09-13");
  });

  it("writing null forgets the remembered day, the same as clear", () => {
    writeComposerResumeDay("2026-09-12");
    writeComposerResumeDay(null);
    expect(readComposerResumeDay()).toBeNull();
  });

  it("clear forgets the remembered day", () => {
    writeComposerResumeDay("2026-09-12");
    clearComposerResumeDay();
    expect(readComposerResumeDay()).toBeNull();
  });

  it("clear is a no-op when nothing was remembered", () => {
    expect(() => clearComposerResumeDay()).not.toThrow();
    expect(readComposerResumeDay()).toBeNull();
  });

  it("survives across separate reads the way a remount needs it to — the memory is not consumed by reading it", () => {
    writeComposerResumeDay("2026-09-12");
    expect(readComposerResumeDay()).toBe("2026-09-12");
    expect(readComposerResumeDay()).toBe("2026-09-12");
  });
});
