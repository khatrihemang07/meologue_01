/**
 * The property that matters most in this file — stated in issue #154 and
 * ADR 0043 — is that converting is *stable*: once an Entry's body has gone
 * through `entryMarkdownToDocument` and back through `entryDocumentToMarkdown`
 * once, doing it again produces the identical string. Formally, for the
 * composed round trip `roundTrip = entryDocumentToMarkdown ∘
 * entryMarkdownToDocument`, `roundTrip(roundTrip(x)) === roundTrip(x)` for
 * every `x` — a fixed point, not necessarily `roundTrip(x) === x`. The
 * Composer (issue #155) will call `roundTrip` every time an Entry is
 * committed; a body a user never even opened the Composer for must not
 * silently reformat on its second edit, or its fifth.
 *
 * `CORPUS` below is table-driven rather than a handful of examples, per the
 * ticket's own instruction — it is built by combining a set of independent
 * inline and block *fragments* (`INLINE_FRAGMENTS`, `BLOCK_FRAGMENTS`) in
 * every pairing, rather than writing out every composite body by hand. That
 * combinatorial expansion is what actually exercises the interactions this
 * serializer is fragile around — a bold span that starts mid-list-item, a
 * Reference as the very first or very last thing in an item, an escaped
 * marker immediately followed by a real one — which a curated list of
 * "interesting" bodies, however long, tends to under-sample precisely
 * because a person has to think of each case.
 */
import { describe, expect, it } from "vitest";
import { entryDocumentToMarkdown, entryMarkdownToDocument } from "./entry-document";

const ENTRY_ID = "0192abcd-1234-7890-abcd-0123456789ab";

function roundTrip(body: string): string {
  return entryDocumentToMarkdown(entryMarkdownToDocument(body));
}

// ---------------------------------------------------------------------------
// Table-driven corpus, part 1: individually-named cases the ticket calls out
// by name, kept as their own table so a failure here names exactly which
// acceptance-criteria case broke.
// ---------------------------------------------------------------------------

const NAMED_CASES: ReadonlyArray<readonly [string, string]> = [
  ["empty body", ""],
  ["body of only whitespace", "   "],
  ["body of only blank lines", "\n\n\n"],

  ["a Reference inside a list item", "- see [[2026-08-28]]"],
  ["a Reference inside a nested list item", `- outer\n  - see [[e:${ENTRY_ID}]]`],
  ["a Reference immediately followed by more text", "[[2026-08-28]] happened"],
  ["a malformed Reference stays literal", "[[not-a-real-reference]]"],

  ["nested emphasis inside strong", "**bold *and* italic**"],
  ["nested strong inside emphasis", "*italic **and** bold*"],
  ["bold spanning an entire list item", "- **the whole item is bold**"],
  ["emphasis spanning part of a list item, part plain", "- plain **bold** plain again"],

  ["an escaped asterisk", "\\*not bold\\*"],
  ["an escaped backtick", "\\`not code\\`"],
  ["an escaped backslash", "a\\\\b"],
  ["an escaped bullet marker", "\\- not a list, just a dash"],
  ["an escaped ordered marker", "1\\. not a list, just a number"],
  ["an escaped Reference opener", "\\[[2026-08-28]]"],

  ["a heading-shaped line stays literal", "# not a heading"],
  ["a blockquote-shaped line stays literal", "> not a blockquote"],
  ["a fenced-code-shaped block stays literal", "```\nnot a code block\n```"],
  ["a thematic-break-shaped line stays literal", "---"],
  ["four-space indentation stays literal", "    not an indented code block"],

  ["a list immediately after a paragraph, no blank line", "some text\n- item"],
  ["a paragraph immediately after a list, no blank line", "- item\nnot part of the item"],
  ["a list after a paragraph, with a blank line", "some text\n\n- item"],

  ["an unchecked task", "- [ ] todo"],
  ["a checked task", "- [x] done"],
  ["a checked task, capital X", "- [X] done"],
  ["an empty unchecked task", "- [ ] "],
  ["mixed checked, unchecked, and plain items", "- [ ] one\n- [x] two\n- plain three"],
  ["a task with a nested list under it", "- [ ] parent\n  - child"],

  ["a nested bullet list, two levels", "- a\n  - b"],
  ["a nested bullet list, three levels", "- a\n  - b\n    - c"],
  ["a bullet list nested under an ordered list", "1. a\n   - b"],
  ["an ordered list nested under a bullet list", "- a\n  1. b"],
  [
    "a bullet item that opens directly with a nested list",
    "- - nested, no text on the parent line",
  ],

  ["an ordered list starting at 1", "1. a\n2. b"],
  ["an ordered list starting at 5", "5. a\n6. b"],
  ["an ordered list starting at 10", "10. a\n11. b\n12. c"],
  ["an ordered list using the ) delimiter", "1) a\n2) b"],

  ["inline code containing an asterisk", "`a*b`"],
  ["inline code containing two asterisks", "`**not bold**`"],
  ["inline code containing a backtick", "`a`b`"],
  ["inline code adjacent to bold with no space", "`code`**bold**"],
  ["bold code", "**`code`**"],

  ["a multi-line paragraph (soft-wrapped)", "line one\nline two continues"],
  ["a multi-line paragraph inside a list item", "- first line\n  second line continues"],
  ["blank line inside one merged paragraph", "para one\n\npara two, no list between"],

  [
    "a realistic mixed Entry",
    "Picked up **milk** and *bread*, see [[2026-08-28]].\n\n" +
      "- [ ] call the vet\n" +
      "- [x] pay rent\n" +
      "  - confirmation: `#12345`\n" +
      "- groceries\n\n" +
      "1. wake up\n" +
      "2. stretch\n\n" +
      "Not \\*emphasis\\*, just \\- a dash and 1\\. a number.",
  ],
];

// ---------------------------------------------------------------------------
// Table-driven corpus, part 2: a generated cross-product of fragments. Each
// inline fragment stands in for "some text with a particular kind of inline
// content"; each block fragment stands in for "an Entry shaped a particular
// way, with a `%s` placeholder for one inline fragment to land in." Every
// (inline, block) pair, plus every ordered pair of block fragments glued
// together (with and without a blank line between them), becomes one corpus
// entry — hundreds of bodies from a few dozen lines of fragments.
// ---------------------------------------------------------------------------

const INLINE_FRAGMENTS: readonly string[] = [
  "plain text",
  "**bold**",
  "*em*",
  "`code`",
  "[[2026-08-28]]",
  `[[e:${ENTRY_ID}]]`,
  "\\*escaped\\*",
  "**bold *and em* together**",
  "a *sentence* with **several** `marks` and [[2026-08-28]] in it",
];

function fillIn(template: string, inline: string): string {
  return template.replace("%s", inline);
}

const BLOCK_FRAGMENTS: readonly string[] = [
  "%s",
  "- %s",
  "- %s\n- second item",
  "- %s\n  - nested %s",
  "1. %s",
  "1. %s\n2. second item",
  "5. %s",
  "- [ ] %s",
  "- [x] %s",
  "- [ ] %s\n- [x] second\n- plain third",
];

function generatedCorpus(): ReadonlyArray<readonly [string, string]> {
  const cases: Array<readonly [string, string]> = [];

  for (const block of BLOCK_FRAGMENTS) {
    for (const inline of INLINE_FRAGMENTS) {
      // `fillIn` only needs to satisfy every `%s` in a template; a template
      // with two placeholders (the nested-list fragment) reuses the same
      // inline fragment for both, which is fine — the point is exercising
      // that inline fragment at each of those positions, not pairing every
      // fragment with every other one there too (that combinatorial blow-up
      // buys nothing this one doesn't already cover once for each position).
      let body = block;
      while (body.includes("%s")) {
        body = fillIn(body, inline);
      }
      cases.push([`generated: ${JSON.stringify(block)} × ${JSON.stringify(inline)}`, body]);
    }
  }

  // Every ordered pair of block shapes, glued together directly and with a
  // blank line between — this is what exercises the separator logic between
  // sibling blocks (a list right after another list, a list right after a
  // paragraph, etc.) across every combination the single-fragment cases
  // above never juxtapose.
  const sample = ["plain text", "**bold**", "[[2026-08-28]]"];
  for (const first of BLOCK_FRAGMENTS) {
    for (const second of BLOCK_FRAGMENTS) {
      const a = fillIn(first, sample[0] as string);
      const bTight = fillIn(second, sample[1] as string);
      const bLoose = fillIn(second, sample[2] as string);
      cases.push([
        `generated pair (tight): ${JSON.stringify(first)} then ${JSON.stringify(second)}`,
        `${a}\n${bTight}`,
      ]);
      cases.push([
        `generated pair (blank line): ${JSON.stringify(first)} then ${JSON.stringify(second)}`,
        `${a}\n\n${bLoose}`,
      ]);
    }
  }

  return cases;
}

const CORPUS: ReadonlyArray<readonly [string, string]> = [...NAMED_CASES, ...generatedCorpus()];

describe("entryMarkdownToDocument / entryDocumentToMarkdown round trip", () => {
  it("has a non-trivial corpus", () => {
    // A guard against this file accidentally losing its generation step —
    // the ticket's own requirement is "a generated or table-driven corpus,
    // not three examples."
    expect(CORPUS.length).toBeGreaterThan(200);
  });

  describe.each(CORPUS)("%s", (_name, body) => {
    it("is stable: converting a converted body does not convert it again", () => {
      const once = roundTrip(body);
      const twice = roundTrip(once);
      expect(twice).toBe(once);
    });

    it("produces a document that satisfies the schema", () => {
      // `entryMarkdownToDocument` uses `Schema.node`, which does not itself
      // validate content against the schema's content expressions — only
      // `.check()` (or `createChecked`) does. A malformed document (e.g. a
      // `list_item` with no leading paragraph) would still construct
      // successfully and only fail here, which is exactly why this needs
      // its own assertion rather than trusting construction not to throw.
      expect(() => entryMarkdownToDocument(body).check()).not.toThrow();
    });
  });
});

describe("entryMarkdownToDocument", () => {
  it("never produces a heading, blockquote, code block, or horizontal rule node — there is no such node to produce", () => {
    for (const [, body] of CORPUS) {
      const doc = entryMarkdownToDocument(body);
      doc.descendants((node) => {
        expect([
          "doc",
          "paragraph",
          "text",
          "reference",
          "bullet_list",
          "ordered_list",
          "list_item",
        ]).toContain(node.type.name);
      });
    }
  });

  it("gives an empty body a document holding a single empty paragraph", () => {
    const doc = entryMarkdownToDocument("");
    expect(doc.childCount).toBe(1);
    expect(doc.firstChild?.type.name).toBe("paragraph");
    expect(doc.firstChild?.childCount).toBe(0);
  });

  it("resolves a dateReference to a reference node carrying the date", () => {
    const doc = entryMarkdownToDocument("[[2026-08-28]]");
    const leaf = doc.firstChild?.firstChild;
    expect(leaf?.type.name).toBe("reference");
    expect(leaf?.attrs).toMatchObject({ kind: "date", date: "2026-08-28", raw: "[[2026-08-28]]" });
  });

  it("resolves an entryReference to a reference node carrying the Entry id", () => {
    const doc = entryMarkdownToDocument(`[[e:${ENTRY_ID}]]`);
    const leaf = doc.firstChild?.firstChild;
    expect(leaf?.type.name).toBe("reference");
    expect(leaf?.attrs).toMatchObject({
      kind: "entry",
      entryId: ENTRY_ID,
      raw: `[[e:${ENTRY_ID}]]`,
    });
  });

  it("carries a checkbox's state onto list_item's checked attribute", () => {
    const doc = entryMarkdownToDocument("- [x] done\n- [ ] not done\n- plain");
    const list = doc.firstChild;
    expect(list?.child(0).attrs.checked).toBe(true);
    expect(list?.child(1).attrs.checked).toBe(false);
    expect(list?.child(2).attrs.checked).toBe(null);
  });

  it("carries an ordered list's start number onto order", () => {
    const doc = entryMarkdownToDocument("5. five\n6. six");
    expect(doc.firstChild?.attrs.order).toBe(5);
  });
});

describe("entryDocumentToMarkdown", () => {
  it("round-trips a plain body exactly, with no drift on the first pass", () => {
    // For inputs with no escaping and no list-marker ambiguity, the first
    // pass should already be a no-op — this is a stronger check than
    // stability alone (which only requires the *second* pass to match the
    // first) for the cases simple enough to support it.
    const exact = [
      "hello world",
      "**bold** and *italic* and `code`",
      "see [[2026-08-28]]",
      "- a\n- b\n- c",
      "1. a\n2. b",
      "- [ ] todo\n- [x] done",
      "- outer\n  - inner",
    ];
    for (const body of exact) {
      expect(roundTrip(body)).toBe(body);
    }
  });

  it("emits an empty document as an empty string", () => {
    expect(roundTrip("")).toBe("");
  });
});
