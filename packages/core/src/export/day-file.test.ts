import { describe, expect, it } from "vitest";
import { entry } from "../test-support/entry-fixture";
import { groupEntriesIntoDayFiles, normalizeBodyForPlainText } from "./day-file";

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

  // ADR 0069/issue #234's normalization boundary: a soft break's own
  // backslash and a Tab-inserted em space are Composer-internal spelling,
  // never meant to reach a plain-text export.
  it("strips a soft break's backslash, keeping the line break it introduced", () => {
    const body = "alpha\\\nbravo";
    const entries = [entry({ createdAt: "2026-08-16T11:42:03.000Z", body })];

    const { files } = groupEntriesIntoDayFiles(entries, OFFSET_IST);

    expect(files[0]?.contents).toContain("alpha\nbravo");
    expect(files[0]?.contents).not.toContain("\\");
  });

  it("replaces a Tab-inserted em space with an ordinary space", () => {
    const body = "alpha bravo";
    const entries = [entry({ createdAt: "2026-08-16T11:42:03.000Z", body })];

    const { files } = groupEntriesIntoDayFiles(entries, OFFSET_IST);

    expect(files[0]?.contents).toContain("alpha bravo");
    expect(files[0]?.contents).not.toContain(" ");
  });

  it("still preserves a genuine \\n\\n block break — only the markers are stripped, nothing else", () => {
    expect(normalizeBodyForPlainText("alpha\n\nbravo")).toBe("alpha\n\nbravo");
  });

  // Issue #239/ADR 0069: a deliberately blank line (`entryDocumentToMarkdown`'s
  // own U+00A0 marker, entry-document.ts) must not leak into the exported
  // .txt as a literal no-break space — it should read like the blank line
  // it represents.
  it("renders a deliberately blank line as an actual empty line, not a literal no-break space", () => {
    const body = `alpha\n\n${"\u00A0"}\n\nbravo`;
    const entries = [entry({ createdAt: "2026-08-16T11:42:03.000Z", body })];

    const { files } = groupEntriesIntoDayFiles(entries, OFFSET_IST);

    expect(files[0]?.contents).toContain("alpha\n\n\n\nbravo");
    expect(files[0]?.contents).not.toContain("\u00A0");
  });
});

describe("normalizeBodyForPlainText", () => {
  it("turns a backslash hard break into a bare newline", () => {
    expect(normalizeBodyForPlainText("alpha\\\nbravo")).toBe("alpha\nbravo");
  });

  it("turns an em space into an ordinary space", () => {
    expect(normalizeBodyForPlainText("alpha bravo")).toBe("alpha bravo");
  });

  it("leaves a body with neither marker unchanged", () => {
    expect(normalizeBodyForPlainText("plain text, nothing to strip")).toBe(
      "plain text, nothing to strip",
    );
  });

  // Issue #239: the export half of the blank-line encoding decision. A line
  // consisting of exactly the U+00A0 marker becomes an empty line — the way
  // a blank line reads in plain text — never a literal space sitting alone
  // on its own line (that would just be invisible trailing whitespace).
  describe("issue #239's blank-line marker", () => {
    it("turns a line that is exactly the marker into an empty line", () => {
      const body = `alpha\n\n${"\u00A0"}\n\nbravo`;
      expect(normalizeBodyForPlainText(body)).toBe("alpha\n\n\n\nbravo");
    });

    it("turns a body that is only the marker into an empty string", () => {
      expect(normalizeBodyForPlainText("\u00A0")).toBe("");
    });

    it("turns every blank-line marker line in a body with several", () => {
      const nbsp = "\u00A0";
      const body = `a\n\n${nbsp}\n\nb\n\n${nbsp}\n\nc`;
      expect(normalizeBodyForPlainText(body)).toBe("a\n\n\n\nb\n\n\n\nc");
    });

    // The whole-line scoping this ticket's own brief calls out by name: a
    // no-break space is legitimate ordinary content in the middle of a
    // sentence (a unit like "10 km"), and deleting every occurrence the
    // way EM_SPACE's own blanket substitution does would be silent data
    // loss. Only a line whose ENTIRE content is the marker qualifies.
    it("leaves a no-break space embedded in a sentence untouched — not a whole-line match", () => {
      const body = `the distance is 10${"\u00A0"}km today`;
      expect(normalizeBodyForPlainText(body)).toBe(body);
    });

    it("leaves a line untouched when the marker shares it with other text", () => {
      const body = `a${"\u00A0"}\n\nbravo`;
      expect(normalizeBodyForPlainText(body)).toBe(body);
    });

    it("leaves a line untouched when the marker sits beside ordinary whitespace on the same line", () => {
      // Not a whole-line match: the line is the marker PLUS a trailing
      // space, two characters, not the marker alone.
      const body = `alpha\n\n${"\u00A0"} \n\nbravo`;
      expect(normalizeBodyForPlainText(body)).toBe(body);
    });
  });
});
