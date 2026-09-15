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
import type { Node as PMNode } from "prosemirror-model";
import { describe, expect, it } from "vitest";
import { entryDocumentToMarkdown, entryMarkdownToDocument } from "./entry-document";
import { entrySchema } from "./entry-schema";
import { formatTaskReference } from "./inline-markdown";
import { halveSoftBreakRuns } from "./soft-break-migration";

const ENTRY_ID = "0192abcd-1234-7890-abcd-0123456789ab";
const TASK_ID = "0192abcd-1234-7890-abcd-0123456789ac";

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

  [
    "an unchecked task reference — Promotion's own output shape",
    `- [ ] ${formatTaskReference(TASK_ID, "buy milk")}`,
  ],
  ["a checked task reference", `- [x] ${formatTaskReference(TASK_ID, "buy milk")}`],
  [
    "a task reference nested under another item",
    `- outer\n  - [ ] ${formatTaskReference(TASK_ID, "buy milk")}`,
  ],
  [
    "a task reference with a nested list under it",
    `- [ ] ${formatTaskReference(TASK_ID, "buy milk")}\n  - a note about it`,
  ],
  [
    "a task reference sitting outside any checkbox — not Promotion's shape, but not an error",
    `see ${formatTaskReference(TASK_ID, "buy milk")} for details`,
  ],
  ["a bare `[[task:…]]` with no label is not a Reference at all", `[[task:${TASK_ID}]]`],
  [
    "a task reference whose cached label needs escaping — brackets and a backslash",
    `- [ ] ${formatTaskReference(TASK_ID, "close]] and \\ backslash, then a | pipe")}`,
  ],

  ["nested emphasis inside strong", "**bold *and* italic**"],
  ["nested strong inside emphasis", "*italic **and** bold*"],
  ["bold spanning an entire list item", "- **the whole item is bold**"],
  ["emphasis spanning part of a list item, part plain", "- plain **bold** plain again"],

  // Issue #211: strikethrough, nesting with the other two marks in both
  // directions — the shape `localMarkRank`'s generalized span-ranking
  // exists to get right for a THIRD nestable mark, not just the strong/em
  // pair it used to hard-code.
  ["struck text", "~~struck~~"],
  ["strikethrough containing bold", "~~struck **bold** back~~"],
  ["bold containing strikethrough", "**bold ~~struck~~ back**"],
  ["emphasis containing strikethrough", "*em ~~struck~~*"],
  ["strikethrough containing emphasis", "~~struck *em* back~~"],
  // All three nestable marks at once, three levels deep — `localMarkRank`'s
  // generalized span-ranking has to order THREE spans correctly here, not
  // just break a tie between two.
  ["strong containing emphasis containing strikethrough", "**bold *em ~~struck~~ back* end**"],
  // `escapeUserText` escapes every `~` unconditionally (this file's own
  // comment on why: a struck run ending in `~` would otherwise serialize a
  // `~~~` closer that `@lezer/markdown`'s Strikethrough parser refuses).
  // This body already has that escape in its source — an escaped tilde
  // (`\~` -> literal `~`) as the LAST character of a struck run — so its
  // round trip is a genuine identity, not merely a stable second pass; see
  // the "round-trips ... exactly" list below for the actual assertion.
  ["a struck run whose text ends in ~, via an escaped tilde", "~~a\\~~~"],
  ["a lone ~ survives as ordinary prose text", "before ~ after"],
  ["a triple tilde is not a valid strikethrough pair, stays literal", "~~~"],
  ["an escaped strikethrough delimiter stays literal", "\\~\\~not struck\\~\\~"],

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
  "~~struck~~",
  "`code`",
  "[[2026-08-28]]",
  `[[e:${ENTRY_ID}]]`,
  formatTaskReference(TASK_ID, "buy milk"),
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

/**
 * Issue #214 / ADR 0067: the invariant that stands in for a safety Backup
 * on the one-time newline-halving migration (`soft-break-migration.ts`).
 * No safety Backup is taken before that migration runs — on web that would
 * mean a download prompt on every app open, worse than the defect it
 * fixes — so what makes running it unattended survivable has to be a
 * property of the transform itself, asserted here rather than assumed:
 * `halveSoftBreakRuns` only ever removes `\n` characters. It can shorten a
 * run of newlines; it can never touch a word, a mark, a Reference, or a
 * list, and it can never touch a non-newline character full stop.
 *
 * Asserted by stripping every `\n` from both `halveSoftBreakRuns(body)`
 * and `roundTrip(body)` (the plain round trip, with no halving at all) and
 * requiring the two to come out identical — across the *entire* existing
 * round-trip corpus above, not a handful of newline-shaped examples,
 * because the property this is meant to prove is "nothing here can ever
 * lose a word," and that has to hold for every shape this dialect can
 * produce, not merely the ones this ticket was written to think about.
 *
 * This is also why `halveSoftBreakRuns` itself always parses and
 * re-serializes, even a body with no `"\n\n"` at all, rather than
 * short-circuiting by returning it verbatim (that file's own doc comment
 * on `halveSoftBreakRuns` has the full reasoning): several entries in this
 * very corpus — `"1) a\n2) b"`, `"before ~ after"` — have no double
 * newline yet still change under the plain round trip (an ordered list's
 * `)` delimiter normalises to `.`; a lone `~` gains an escaping
 * backslash), and a short-circuit would make `halveSoftBreakRuns` disagree
 * with `roundTrip` on exactly those non-newline characters — the one
 * thing this invariant exists to rule out.
 */
describe("halveSoftBreakRuns only ever removes newline characters (issue #214)", () => {
  describe.each(CORPUS)("%s", (_name, body) => {
    it("agrees with the plain round trip once newlines are stripped from both", () => {
      const halved = halveSoftBreakRuns(body).replace(/\n/g, "");
      const plain = roundTrip(body).replace(/\n/g, "");
      expect(halved).toBe(plain);
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
          "task_reference",
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

  // Issue #245: the mandatory single space between a checkbox's `[ ]`/`[x]`
  // and whatever follows it is not itself typed content — it is syntax, the
  // same way the `- ` bullet marker's own separator is (`itemContentStart`'s
  // comment, inline-markdown.ts). It is deliberately kept in the parsed
  // `EntryBlockNode` tree (`referencedTaskOf`/`isReferencedChecklistItem`
  // both rely on that), but it must NOT survive into the ProseMirror
  // document, where it stops being a marker and becomes real,
  // caret-addressable text a person never typed. A plain bullet (no
  // checkbox) has no such marker-adjacent separator to strip at all.
  it("drops a checkbox item's mandatory separator space — it is syntax, not typed content", () => {
    expect(entryMarkdownToDocument("- [ ] alpha").textContent).toBe("alpha");
    expect(entryMarkdownToDocument("- [x] alpha").textContent).toBe("alpha");
    expect(entryMarkdownToDocument("- alpha").textContent).toBe("alpha");
  });

  // Regression found independently against this exact fix, and confirmed
  // against unmodified `main`: only the FIRST space after `[ ]`/`[x]` is the
  // mandatory separator; a SECOND one is the person's own typed content and
  // must survive both the document (as real text) and a save (byte-identical
  // storage) — the corpus above has no double-space-after-checkbox case, so
  // it stayed green while `writeListItem`'s old `needsTaskSeparator` guard
  // silently ate this exact character (see that function's own comment for
  // why the guard had to become unconditional to stop doing that).
  it("keeps a checkbox item's own SECOND leading space as real content, on both halves of the round trip", () => {
    expect(entryMarkdownToDocument("- [ ]  alpha").textContent).toBe(" alpha");
    expect(roundTrip("- [ ]  alpha")).toBe("- [ ]  alpha");
  });

  // `.firstChild`, not `.lastChild`: issue #245 fixed the leading paragraph
  // so its first child is the reference itself — the mandatory separator
  // space between `[ ]` and its content is dropped at the `blocksToPM`
  // seam (entry-document.ts) rather than surviving as a text(" ") node.
  it("resolves a taskReference to a task_reference node carrying the id and decoded cached label", () => {
    const doc = entryMarkdownToDocument(`- [ ] ${formatTaskReference(TASK_ID, "buy milk")}`);
    const item = doc.firstChild?.firstChild;
    const leaf = item?.firstChild?.firstChild;
    expect(leaf?.type.name).toBe("task_reference");
    expect(leaf?.attrs).toMatchObject({ taskId: TASK_ID, label: "buy milk", checked: false });
  });

  it("carries the enclosing item's own checked state onto a task_reference's checked attribute — the cache, not the write path", () => {
    const doc = entryMarkdownToDocument(`- [x] ${formatTaskReference(TASK_ID, "buy milk")}`);
    const item = doc.firstChild?.firstChild;
    const leaf = item?.firstChild?.lastChild;
    expect(leaf?.attrs.checked).toBe(true);
  });

  it("decodes a task_reference's label even when it needed escaping", () => {
    const label = "close]] and \\ backslash";
    const doc = entryMarkdownToDocument(`- [ ] ${formatTaskReference(TASK_ID, label)}`);
    const item = doc.firstChild?.firstChild;
    const leaf = item?.firstChild?.lastChild;
    expect(leaf?.attrs.label).toBe(label);
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
      `- [ ] ${formatTaskReference(TASK_ID, "buy milk")}`,
      "~~struck~~ and **bold** and *em*",
      // The struck run's own text already ends in an escaped tilde
      // (`\~` -> literal `~`), so the write side has nothing further to
      // escape and this is a genuine no-op first pass — the case
      // `escapeUserText`'s own comment on refusing a `~~~` closer exists
      // to keep true.
      "~~a\\~~~",
    ];
    for (const body of exact) {
      expect(roundTrip(body)).toBe(body);
    }
  });

  it("emits an empty document as an empty string", () => {
    expect(roundTrip("")).toBe("");
  });

  it("a literal ~ in ordinary prose survives a round trip", () => {
    // Not byte-identical (escapeUserText now escapes every `~`
    // unconditionally, the same way it already did for `*`), but the
    // reader-facing TEXT is unchanged — reparsing the written form gives
    // back a document whose visible text still reads "before ~ after",
    // never a dropped or duplicated tilde.
    const written = roundTrip("before ~ after");
    expect(entryMarkdownToDocument(written).textContent).toBe("before ~ after");
  });
});

/**
 * Documents the Composer BUILDS, which the corpus above structurally cannot
 * reach.
 *
 * Every case in `CORPUS` starts life as a Markdown string and is turned into
 * a document by `entryMarkdownToDocument`. That is only half of what this
 * serializer is asked to write. The other half is a document ProseMirror
 * assembled from live keystrokes, and the two disagree about where a blank
 * line lives: parsing keeps it inside the paragraph's own text (an Entry's
 * body has always been one string, rendered `whitespace-pre-wrap`), while
 * pressing Enter genuinely splits the block and leaves the new paragraph's
 * text bare.
 *
 * The gap was not theoretical. `writeBlocks` used to return before writing
 * any separator for a paragraph, so a live-edited document with two of them
 * serialized to `"line oneline two"` — an Entry losing its line break the
 * moment it was Sent — and Enter-ing out of a checklist produced
 * `"- [ ] call mumafter"`, fusing the trailing prose onto the last item's
 * text. The fixpoint property above passed straight through both, because
 * the second pass reproduces the same glued output the first one did.
 *
 * These build their documents the way the Composer does, from schema nodes,
 * which is the only way to see it.
 */
describe("documents built by editing, not by parsing", () => {
  // `noUncheckedIndexedAccess` makes every `schema.nodes[name]` lookup
  // optional, so these are resolved once through a helper that throws rather
  // than sprinkling non-null assertions (which Biome's `recommended` refuses)
  // through the cases below.
  const nodeType = (name: string) => {
    const type = entrySchema.nodes[name];
    if (type === undefined) {
      throw new Error(`entrySchema has no ${name} node`);
    }
    return type;
  };
  const para = (text: string) =>
    nodeType("paragraph").create(null, text === "" ? null : entrySchema.text(text));
  const doc = (...blocks: PMNode[]) => nodeType("doc").create(null, blocks);
  const task = (text: string, checked: boolean) =>
    nodeType("bullet_list").create(null, [nodeType("list_item").create({ checked }, para(text))]);

  it("keeps the break between two paragraphs typed with Enter", () => {
    const written = entryDocumentToMarkdown(doc(para("line one"), para("line two")));
    expect(written).toBe("line one\n\nline two");
    expect(roundTrip(written)).toBe(written);
  });

  it("does not fuse prose onto the list it was escaped out of", () => {
    const written = entryDocumentToMarkdown(doc(task("call mum", false), para("after")));
    expect(written).toBe("- [ ] call mum\n\nafter");
    // And the prose must come back as its own block, not as more of the item.
    const reparsed = entryMarkdownToDocument(written);
    expect(reparsed.childCount).toBe(2);
    expect(reparsed.child(1).type.name).toBe("paragraph");
    expect(roundTrip(written)).toBe(written);
  });

  it("does not compound the blank line a parsed body already carries", () => {
    // The mirror of the two cases above: here the paragraph's own text
    // supplies the separator, so writing another one would grow the gap on
    // every single commit — one round trip at a time.
    for (const body of ["- a\n\nb", "x\n\ny", "- [ ] t\n\ntail"]) {
      expect(roundTrip(body)).toBe(body);
      expect(roundTrip(roundTrip(body))).toBe(body);
    }
  });

  it("separates three typed paragraphs, not just the first pair", () => {
    const written = entryDocumentToMarkdown(doc(para("a"), para("b"), para("c")));
    expect(written).toBe("a\n\nb\n\nc");
    expect(roundTrip(written)).toBe(written);
  });

  // Issue #211. Typing "check~" and then toggling strikethrough on the
  // selection is a leaf whose text ends in `~` and carries the mark — a
  // shape the Markdown-sourced corpus above cannot easily produce directly
  // (parsing never leaves a mark's own delimiter characters inside the
  // parsed text), but an ordinary thing to do in a live editor.
  it("escapes a struck run's own trailing ~ rather than emitting an ambiguous ~~~ closer", () => {
    const strikethroughMarkType = entrySchema.marks.strikethrough;
    if (strikethroughMarkType === undefined) {
      throw new Error("entrySchema has no strikethrough mark");
    }
    const written = entryDocumentToMarkdown(
      doc(
        nodeType("paragraph").create(
          null,
          entrySchema.text("check~", [strikethroughMarkType.create()]),
        ),
      ),
    );
    // Three raw tildes DO appear adjacent in the output (`\~~~`) — but the
    // first of the three is the escaped character, not part of the closing
    // delimiter, so this is not the ambiguous case at all. The actual
    // invariant — that the close delimiter itself is exactly two characters,
    // never three, is what the reparse assertions below confirm directly:
    // if the write side had instead emitted an unescaped closer (`~~check~~~`,
    // three-in-a-row with none of them escaped), `@lezer/markdown`'s
    // Strikethrough parser would refuse it (`cx.char(pos+2) == 126` in its
    // own delimiter scan) and `reparsed` below would come back as plain,
    // unstruck text instead.
    expect(written).toBe("~~check\\~~~");
    const reparsed = entryMarkdownToDocument(written);
    expect(reparsed.textContent).toBe("check~");
    const leaf = reparsed.firstChild?.firstChild;
    expect(leaf?.marks.some((mark) => mark.type.name === "strikethrough")).toBe(true);
    expect(roundTrip(written)).toBe(written);
  });

  // Issue #239/ADR 0069's Consequences: "a deliberately authored blank
  // line still cannot be told apart from the same defect this ADR fixes."
  // `alpha` Enter Enter `bravo` in the Composer is exactly `doc(p("alpha"),
  // p(""), p("bravo"))` — the empty middle paragraph `splitBlock` leaves
  // behind for a second Enter — and before this ticket,
  // `entryDocumentToMarkdown` had no way to write that middle paragraph
  // back out as anything other than nothing, so the blank line vanished on
  // reload. The blank-line marker (`BLANK_LINE_MARKER`, entry-document.ts)
  // is what closes that gap.
  describe("a deliberately blank line (issue #239)", () => {
    const blankLineDoc = doc(para("alpha"), para(""), para("bravo"));

    it("writes the empty middle paragraph as the blank-line marker, not nothing", () => {
      const written = entryDocumentToMarkdown(blankLineDoc);
      expect(written).toBe("alpha\n\n\u00A0\n\nbravo");
    });

    it("survives Send and reload: document -> markdown -> document keeps three paragraphs, the middle one empty", () => {
      const written = entryDocumentToMarkdown(blankLineDoc);
      const reparsed = entryMarkdownToDocument(written);
      expect(reparsed.childCount).toBe(3);
      expect(reparsed.child(0).type.name).toBe("paragraph");
      expect(reparsed.child(0).textContent).toBe("alpha");
      expect(reparsed.child(1).type.name).toBe("paragraph");
      expect(reparsed.child(1).childCount).toBe(0);
      expect(reparsed.child(2).type.name).toBe("paragraph");
      expect(reparsed.child(2).textContent).toBe("bravo");
    });

    it("is a distinct shape from a single block break — alpha/bravo with no blank line between", () => {
      const withBlankLine = entryDocumentToMarkdown(blankLineDoc);
      const withoutBlankLine = entryDocumentToMarkdown(doc(para("alpha"), para("bravo")));
      expect(withBlankLine).not.toBe(withoutBlankLine);
      expect(withoutBlankLine).toBe("alpha\n\nbravo");

      const reparsedWithBlankLine = entryMarkdownToDocument(withBlankLine);
      const reparsedWithoutBlankLine = entryMarkdownToDocument(withoutBlankLine);
      expect(reparsedWithBlankLine.childCount).toBe(3);
      expect(reparsedWithoutBlankLine.childCount).toBe(2);
    });

    it("is stable: writing, reading, and writing again produces the identical body", () => {
      const written = entryDocumentToMarkdown(blankLineDoc);
      expect(roundTrip(written)).toBe(written);
    });

    it("does not mark the sole empty paragraph of an untouched Entry — that one still writes as nothing", () => {
      // The one empty paragraph in a brand-new Entry (or one whose only
      // content was deleted back to nothing) has no siblings at all — it
      // is not a deliberate blank line between two others, it is the
      // entire document, and must keep writing "" (this file's own "emits
      // an empty document as an empty string" test already covers the
      // `entryMarkdownToDocument("")` path; this covers the equivalent
      // document built directly, the way the Composer would leave it).
      expect(entryDocumentToMarkdown(doc(para("")))).toBe("");
    });
  });
});

/**
 * Issue #239/ADR 0069: the reader-tolerance half of the acceptance
 * criteria — "a body written before this change still reads correctly
 * (reader tolerance, no migration — ADR-0069)". A body already on disk
 * before this ticket landed was written by the OLD `entryDocumentToMarkdown`,
 * which had no marker at all — a run of newlines with nothing between them
 * is exactly what that old writer (and, further back, ADR 0066's model)
 * produced for what a person meant as a blank line, and it is
 * indistinguishable, once written, from the forced separator ADR 0066's own
 * Context names as the original defect. `collectBlocks`'s "any non-empty
 * run of bare `\n` is exactly one block boundary" rule (ADR 0069's own
 * Decision) is untouched by this ticket — no migration walks old bodies
 * looking for this shape and rewrites them, per ADR 0069's own Consequences
 * ("a migration cannot retire an ambiguity that a Backup file can
 * resurrect at any later date; only the reader can").
 */
describe("a pre-#239 body (a run of newlines, no marker) still collapses to one block break — no migration", () => {
  it("four newlines between two paragraphs still reads as exactly two blocks, not three", () => {
    const legacyBody = "alpha\n\n\n\nbravo";
    const doc = entryMarkdownToDocument(legacyBody);
    expect(doc.childCount).toBe(2);
    expect(doc.child(0).textContent).toBe("alpha");
    expect(doc.child(1).textContent).toBe("bravo");
  });

  it("still round-trips (and re-saves) to the collapsed two-block shape, unchanged from before this ticket", () => {
    // This is the documented, accepted lossiness this ticket does NOT fix
    // for old data — ADR 0069's Consequences names it explicitly, and this
    // ticket only adds a way for a FRESH blank line to survive; it does not
    // retroactively recover one a pre-#239 client already lost on write.
    expect(roundTrip("alpha\n\n\n\nbravo")).toBe("alpha\n\nbravo");
  });

  it("a single already-blank paragraph line (one plain space, ADR 0069's own pre-existing tolerance) still round-trips byte-identical — unaffected by the new marker", () => {
    // Not this ticket's marker (that is U+00A0, not U+0020) — this is the
    // OTHER shape ADR 0069's reader already tolerated before this ticket
    // touched anything, named explicitly in this ticket's own brief: proof
    // that adding the U+00A0 marker didn't disturb it.
    expect(roundTrip("alpha\n\n \n\nbravo")).toBe("alpha\n\n \n\nbravo");
  });
});
