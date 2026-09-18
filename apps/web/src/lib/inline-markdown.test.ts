import { describe, expect, it } from "vitest";
import {
  entryBlocksToText,
  flattenCommentPreview,
  formatTaskReference,
  type InlineNode,
  inlineNodesToText,
  parseCommentMarkdown,
  parseEntryMarkdown,
  parseInlineMarkdown,
  parseReferenceDate,
  parseReferenceTask,
  refreshTaskReferenceLabel,
} from "./inline-markdown";

const ENTRY_ID = "0192abcd-1234-7890-abcd-0123456789ab";

describe("parseInlineMarkdown", () => {
  it("round-trips plain text unchanged", () => {
    expect(parseInlineMarkdown("a recurring Question")).toEqual([
      { kind: "text", text: "a recurring Question" },
    ]);
  });

  it("returns an empty list for an empty body", () => {
    expect(parseInlineMarkdown("")).toEqual([]);
  });

  describe("the mark set", () => {
    it("parses **bold** as strong", () => {
      expect(parseInlineMarkdown("**bold**")).toEqual([
        { kind: "strong", children: [{ kind: "text", text: "bold" }] },
      ]);
    });

    it("parses *italic* as emphasis", () => {
      expect(parseInlineMarkdown("*italic*")).toEqual([
        { kind: "emphasis", children: [{ kind: "text", text: "italic" }] },
      ]);
    });

    it("parses _italic_ as emphasis", () => {
      expect(parseInlineMarkdown("_italic_")).toEqual([
        { kind: "emphasis", children: [{ kind: "text", text: "italic" }] },
      ]);
    });

    it("parses `code` as an inline code node", () => {
      expect(parseInlineMarkdown("`code`")).toEqual([{ kind: "code", text: "code" }]);
    });

    // Issue #211.
    it("parses ~~struck~~ as strikethrough", () => {
      expect(parseInlineMarkdown("~~struck~~")).toEqual([
        { kind: "strikethrough", children: [{ kind: "text", text: "struck" }] },
      ]);
    });

    it("nests an emphasis inside a strong", () => {
      expect(parseInlineMarkdown("**a *b* c**")).toEqual([
        {
          kind: "strong",
          children: [
            { kind: "text", text: "a " },
            { kind: "emphasis", children: [{ kind: "text", text: "b" }] },
            { kind: "text", text: " c" },
          ],
        },
      ]);
    });

    it("nests a strong inside a strikethrough", () => {
      expect(parseInlineMarkdown("~~a **b** c~~")).toEqual([
        {
          kind: "strikethrough",
          children: [
            { kind: "text", text: "a " },
            { kind: "strong", children: [{ kind: "text", text: "b" }] },
            { kind: "text", text: " c" },
          ],
        },
      ]);
    });
  });

  describe("backslash escapes", () => {
    it("renders an escaped bold marker as literal asterisks, with no strong node", () => {
      const nodes = parseInlineMarkdown("\\*\\*not bold\\*\\*");
      expect(nodes).toEqual([{ kind: "text", text: "**not bold**" }]);
      expect(nodes.some((node) => node.kind === "strong")).toBe(false);
    });
  });

  describe("unbalanced markers render literally", () => {
    it("leaves an unclosed ** as text", () => {
      expect(parseInlineMarkdown("**oops")).toEqual([{ kind: "text", text: "**oops" }]);
    });

    it("leaves an unclosed * as text", () => {
      expect(parseInlineMarkdown("*dangling")).toEqual([{ kind: "text", text: "*dangling" }]);
    });

    it("leaves an unclosed backtick as text", () => {
      expect(parseInlineMarkdown("`unclosed")).toEqual([{ kind: "text", text: "`unclosed" }]);
    });

    it("leaves an unclosed ~~ as text", () => {
      expect(parseInlineMarkdown("~~oops")).toEqual([{ kind: "text", text: "~~oops" }]);
    });

    it("leaves a lone ~ as text — GFM Strikethrough is always a two-character pair", () => {
      expect(parseInlineMarkdown("a ~ b")).toEqual([{ kind: "text", text: "a ~ b" }]);
    });

    it("leaves a run of three ~ as text — @lezer/markdown's Strikethrough refuses that as a delimiter", () => {
      expect(parseInlineMarkdown("~~~")).toEqual([{ kind: "text", text: "~~~" }]);
    });
  });

  it("renders marks inside inline code literally, as a single code node", () => {
    expect(parseInlineMarkdown("`**x**`")).toEqual([{ kind: "code", text: "**x**" }]);
  });

  // This is the guarantee the whole module rests on (see the file's own
  // doc comment): `parseInline` never invokes the block layer, so nothing
  // that only means something at the start of a line — a heading, a list
  // item, a blockquote, a thematic break — is special here. Each input
  // below must come back as the single, untouched text node the user
  // typed, never a strong/emphasis/code node manufactured from it.
  it("never produces a block construct — heading, list, quote, and rule markers all render literally", () => {
    const blockLooking = ["# heading", "- item", "1. item", "> quote", "---"];
    for (const body of blockLooking) {
      expect(parseInlineMarkdown(body)).toEqual([{ kind: "text", text: body }]);
    }
  });

  // A fenced code block shares its delimiter (a run of backticks) with
  // CommonMark's inline code span, so at the inline layer it is
  // indistinguishable from `` `code` `` and legitimately becomes a `code`
  // node rather than plain text. That is still safe: `code` is an inline
  // node type (renders as a `<code>` span, never a block element), so the
  // "no block layer" guarantee still holds — what this asserts is that no
  // *block* markup, and no strong/emphasis, comes out of it, and that
  // every character of the input survives somewhere in the output.
  it("treats a fenced code block as inline code, not as a block — no strong/emphasis, no character lost", () => {
    const fenced = "```\nconst x = 1;\n```";
    const nodes = parseInlineMarkdown(fenced);
    expect(nodes).toEqual([{ kind: "code", text: "\nconst x = 1;\n" }]);
    for (const node of nodes) {
      expect(node.kind === "strong" || node.kind === "emphasis").toBe(false);
    }
    // The backtick fences are punctuation, like any code mark — consumed
    // rather than kept — so the surviving content is the fenced text minus
    // its delimiters.
    expect(inlineNodesToText(nodes)).toBe("\nconst x = 1;\n");
  });

  describe("raw HTML never becomes markup", () => {
    const htmlLooking = ["<b>hi</b>", "<script>alert(1)</script>", "<img src=x onerror=y>"];

    it("comes back as plain text nodes containing the exact characters", () => {
      for (const body of htmlLooking) {
        expect(parseInlineMarkdown(body)).toEqual([{ kind: "text", text: body }]);
      }
    });
  });

  it("does not treat [label](url) as a link — link syntax is deliberately excluded", () => {
    expect(parseInlineMarkdown("[label](http://x)")).toEqual([
      { kind: "text", text: "[label](http://x)" },
    ]);
  });

  it("does not autolink a bare URL", () => {
    expect(parseInlineMarkdown("http://example.com")).toEqual([
      { kind: "text", text: "http://example.com" },
    ]);
  });

  describe("References", () => {
    it("parses [[YYYY-MM-DD]] as a dateReference", () => {
      expect(parseInlineMarkdown("[[2026-08-28]]")).toEqual([
        { kind: "dateReference", date: "2026-08-28", raw: "[[2026-08-28]]" },
      ]);
    });

    it("parses [[e:<uuid>]] as an entryReference with the bare uuid", () => {
      expect(parseInlineMarkdown(`[[e:${ENTRY_ID}]]`)).toEqual([
        { kind: "entryReference", entryId: ENTRY_ID, raw: `[[e:${ENTRY_ID}]]` },
      ]);
    });

    it("parses [[task:<uuid>|label]] as a taskReference carrying the id and cached label", () => {
      const raw = `[[task:${ENTRY_ID}|buy milk]]`;
      expect(parseInlineMarkdown(raw)).toEqual([
        { kind: "taskReference", taskId: ENTRY_ID, label: "buy milk", raw },
      ]);
    });

    it("decodes a task reference's escaped label — a run of two ] never terminates it early", () => {
      const raw = formatTaskReference(ENTRY_ID, "close]] and \\ backslash, a | pipe too");
      expect(parseInlineMarkdown(raw)).toEqual([
        {
          kind: "taskReference",
          taskId: ENTRY_ID,
          label: "close]] and \\ backslash, a | pipe too",
          raw,
        },
      ]);
    });

    it("does not treat a malformed mark as a Reference — it renders literally", () => {
      const malformed = [
        "[[nope]]",
        "[[2026-13-45]]", // month 13 does not exist
        "[[2026-02-30]]", // Feb 30 does not exist
        `[[e:not-a-uuid]]`,
        `[[task:not-a-uuid|label]]`,
        `[[task:${ENTRY_ID}]]`, // no `|label` at all
        "[[2026-08-28", // unclosed
      ];
      for (const body of malformed) {
        expect(parseInlineMarkdown(body)).toEqual([{ kind: "text", text: body }]);
      }
    });

    it("does not treat an escaped [[ as the start of a Reference", () => {
      expect(parseInlineMarkdown("\\[[2026-08-28]]")).toEqual([
        { kind: "text", text: "[[2026-08-28]]" },
      ]);
    });

    it("still parses a Reference nested inside emphasis", () => {
      expect(parseInlineMarkdown("**[[2026-08-28]]**")).toEqual([
        {
          kind: "strong",
          children: [{ kind: "dateReference", date: "2026-08-28", raw: "[[2026-08-28]]" }],
        },
      ]);
    });
  });

  // The most valuable property test here: no visible character the user
  // typed is ever silently dropped. Escapes and marks legitimately change
  // what inlineNodesToText reconstructs (an escape consumes its backslash,
  // a mark's punctuation carries no text of its own — inlineNodesToText is
  // documented as ignoring formatting), so this is checked two ways: an
  // exact round-trip for inputs with no escapes or marks, and a
  // no-character-dropped check (every character of the input appears,
  // in order, in the reconstructed text) for every input, escapes and
  // marks included.
  describe("text preservation", () => {
    const plainInputs = [
      "a recurring Question",
      "# heading",
      "- item",
      "1. item",
      "> quote",
      "---",
      "<b>hi</b>",
      "[label](http://x)",
      "http://example.com",
      "[[nope]]",
      "[[2026-13-45]]",
      "",
    ];

    it("round-trips exactly for inputs with no escapes and no marks", () => {
      for (const body of plainInputs) {
        expect(inlineNodesToText(parseInlineMarkdown(body))).toBe(body);
      }
    });

    // Subsequence, not equality: a mark's punctuation (the `**`, the
    // backslash of an escape) is consumed, but every remaining character
    // must still appear, in order.
    function isSubsequence(reconstructed: string, original: string): boolean {
      let cursor = 0;
      for (const ch of reconstructed) {
        cursor = original.indexOf(ch, cursor);
        if (cursor === -1) {
          return false;
        }
        cursor += 1;
      }
      return true;
    }

    it("drops no character for inputs that do carry escapes or marks", () => {
      const markedInputs = [
        "**bold**",
        "*italic*",
        "_italic_",
        "`code`",
        "**a *b* c**",
        "\\*\\*not bold\\*\\*",
        "**oops",
        "`**x**`",
        "[[2026-08-28]]",
        `[[e:${ENTRY_ID}]]`,
        "\\[[2026-08-28]]",
        "**[[2026-08-28]]**",
        ...plainInputs,
      ];
      for (const body of markedInputs) {
        const reconstructed = inlineNodesToText(parseInlineMarkdown(body));
        expect(isSubsequence(reconstructed, body)).toBe(true);
      }
    });
  });
});

describe("parseReferenceDate", () => {
  it("accepts a real calendar date", () => {
    expect(parseReferenceDate("2026-08-28")).toBe("2026-08-28");
  });

  it("rejects a month that does not exist", () => {
    expect(parseReferenceDate("2026-13-45")).toBeNull();
  });

  it("rejects a day that does not exist in the given month", () => {
    expect(parseReferenceDate("2026-02-30")).toBeNull();
  });

  it("rejects text that is not date-shaped at all", () => {
    expect(parseReferenceDate("nope")).toBeNull();
  });

  it("accepts Feb 29 on a leap year", () => {
    expect(parseReferenceDate("2024-02-29")).toBe("2024-02-29");
  });

  it("rejects Feb 29 on a non-leap year", () => {
    expect(parseReferenceDate("2025-02-29")).toBeNull();
  });
});

describe("parseReferenceTask / formatTaskReference", () => {
  it("round-trips a plain label through format then parse", () => {
    const raw = formatTaskReference(ENTRY_ID, "buy milk");
    expect(raw).toBe(`[[task:${ENTRY_ID}|buy milk]]`);
    expect(parseReferenceTask(raw.slice(2, -2))).toEqual({ taskId: ENTRY_ID, label: "buy milk" });
  });

  it("escapes and recovers a label containing ]] — the mark's own closing delimiter", () => {
    const raw = formatTaskReference(ENTRY_ID, "wrap this up]]");
    // The escaped form never contains two consecutive, unescaped `]`
    // characters ahead of the mark's real close — verified directly
    // rather than trusted, since that is the one property this scheme
    // depends on.
    expect(raw.slice(0, -2)).not.toMatch(/(?<!\\)\]\]/);
    expect(parseReferenceTask(raw.slice(2, -2))).toEqual({
      taskId: ENTRY_ID,
      label: "wrap this up]]",
    });
  });

  it("escapes and recovers a label containing a literal backslash", () => {
    const raw = formatTaskReference(ENTRY_ID, "C:\\path\\to\\file");
    expect(parseReferenceTask(raw.slice(2, -2))).toEqual({
      taskId: ENTRY_ID,
      label: "C:\\path\\to\\file",
    });
  });

  it("does not need to escape a pipe — only the first | ever delimits", () => {
    const raw = formatTaskReference(ENTRY_ID, "milk | eggs | bread");
    expect(parseReferenceTask(raw.slice(2, -2))).toEqual({
      taskId: ENTRY_ID,
      label: "milk | eggs | bread",
    });
  });

  it("rejects a head that is not task:<uuid>, however label-shaped the rest is", () => {
    expect(parseReferenceTask("task:not-a-uuid|label")).toBeNull();
    expect(parseReferenceTask("e:not-even-task-prefixed|label")).toBeNull();
  });

  it("rejects a task: head with no | at all — a task reference always has a cached label", () => {
    expect(parseReferenceTask(`task:${ENTRY_ID}`)).toBeNull();
  });

  it("accepts an empty label", () => {
    expect(parseReferenceTask(`task:${ENTRY_ID}|`)).toEqual({ taskId: ENTRY_ID, label: "" });
  });
});

describe("inlineNodesToText", () => {
  it("joins text across nested emphasis and strong, ignoring formatting", () => {
    const nodes: InlineNode[] = [
      { kind: "text", text: "a " },
      { kind: "strong", children: [{ kind: "text", text: "b" }] },
      { kind: "text", text: " " },
      { kind: "emphasis", children: [{ kind: "text", text: "c" }] },
    ];
    expect(inlineNodesToText(nodes)).toBe("a b c");
  });

  it("joins text across a strikethrough the same way, ignoring formatting", () => {
    const nodes: InlineNode[] = [
      { kind: "text", text: "a " },
      { kind: "strikethrough", children: [{ kind: "text", text: "b" }] },
      { kind: "text", text: " c" },
    ];
    expect(inlineNodesToText(nodes)).toBe("a b c");
  });

  it("renders a Reference's raw text, not its resolved id", () => {
    const nodes: InlineNode[] = [
      { kind: "dateReference", date: "2026-08-28", raw: "[[2026-08-28]]" },
    ];
    expect(inlineNodesToText(nodes)).toBe("[[2026-08-28]]");
  });

  // The opposite rule from a date/Entry Reference just above — deliberately
  // so, per ADR 0048: a task reference's whole point is to show real words
  // even before the Task itself has Synced, so `entrySnippet`/the `[[`
  // picker (this function's own callers) get the cached label, never the
  // `[[task:…]]` mark itself.
  it("renders a task reference's cached label, not its mark", () => {
    const nodes: InlineNode[] = [
      {
        kind: "taskReference",
        taskId: ENTRY_ID,
        label: "buy milk",
        raw: `[[task:${ENTRY_ID}|buy milk]]`,
      },
    ];
    expect(inlineNodesToText(nodes)).toBe("buy milk");
  });
});

// issue #152: an Entry may now carry a bullet list, an ordered list, and a
// task-list checkbox — the one construct ADR 0041 refused, deliberately
// reversed for this one case. `parseEntryMarkdown` is used ONLY by
// `entryProse` (entry-prose.tsx); every other prose surface still calls
// `parseInlineMarkdown` above, unchanged.
describe("parseEntryMarkdown", () => {
  it("returns an empty list for an empty body, same as parseInlineMarkdown", () => {
    expect(parseEntryMarkdown("")).toEqual([]);
  });

  it("parses a body with no list exactly as one prose run of parseInlineMarkdown's own nodes", () => {
    const body = "a recurring **Question** with a `code` span and [[2026-08-28]]";
    expect(parseEntryMarkdown(body)).toEqual([
      { kind: "prose", children: parseInlineMarkdown(body) },
    ]);
  });

  // Issue #211: `walkEntryInline` (this parser's own inline walker, a
  // separate function from `walk` above because the two parser APIs don't
  // share a node shape) needs the SAME `Strikethrough` case `walk` gets —
  // missing it here is exactly the one-dialect-two-parsers failure ADR
  // 0043/0045 exist to prevent, and it would not show up in the test right
  // above (a list-free body already delegates entirely to `parseInlineMarkdown`
  // through a different code path than a body that has to walk a list).
  it("parses ~~struck~~ inside a list item the same way parseInlineMarkdown parses it bare", () => {
    expect(parseEntryMarkdown("- ~~struck~~")).toEqual([
      {
        kind: "bulletList",
        items: [
          {
            task: undefined,
            content: [{ kind: "prose", children: parseInlineMarkdown("~~struck~~") }],
          },
        ],
      },
    ]);
  });

  describe("the mark set", () => {
    it("parses a bullet list, one item per line", () => {
      expect(parseEntryMarkdown("- milk\n- eggs")).toEqual([
        {
          kind: "bulletList",
          items: [
            {
              task: undefined,
              content: [{ kind: "prose", children: [{ kind: "text", text: "milk" }] }],
            },
            {
              task: undefined,
              content: [{ kind: "prose", children: [{ kind: "text", text: "eggs" }] }],
            },
          ],
        },
      ]);
    });

    it("parses an ordered list, carrying its own start number", () => {
      expect(parseEntryMarkdown("5. five\n6. six")).toEqual([
        {
          kind: "orderedList",
          start: 5,
          items: [
            {
              task: undefined,
              content: [{ kind: "prose", children: [{ kind: "text", text: "five" }] }],
            },
            {
              task: undefined,
              content: [{ kind: "prose", children: [{ kind: "text", text: "six" }] }],
            },
          ],
        },
      ]);
    });

    it("defaults an ordered list's start to 1 when the body doesn't say otherwise", () => {
      const [block] = parseEntryMarkdown("1. first\n2. second");
      expect(block).toMatchObject({ kind: "orderedList", start: 1 });
    });

    it("nests a bullet list inside an ordered list item, and vice versa", () => {
      const body = "1. outer\n   - inner";
      const [outer] = parseEntryMarkdown(body);
      expect(outer).toMatchObject({ kind: "orderedList", start: 1 });
      if (outer?.kind !== "orderedList") throw new Error("expected orderedList");
      const [item] = outer.items;
      expect(item?.content).toEqual([
        { kind: "prose", children: [{ kind: "text", text: "outer" }] },
        {
          kind: "bulletList",
          items: [
            {
              task: undefined,
              content: [{ kind: "prose", children: [{ kind: "text", text: "inner" }] }],
            },
          ],
        },
      ]);
    });

    describe("task-list checkboxes", () => {
      it("parses an unchecked box", () => {
        const body = "- [ ] call mum";
        const [block] = parseEntryMarkdown(body);
        expect(block?.kind).toBe("bulletList");
        if (block?.kind !== "bulletList") throw new Error("expected bulletList");
        const [item] = block.items;
        expect(item?.task).toEqual({ checked: false, markerFrom: 2, markerTo: 5 });
        // The marker's own offsets point at exactly "[ ]" in the body — the
        // splice target issue #153 needs to flip it to "[x]" in place.
        expect(body.slice(2, 5)).toBe("[ ]");
      });

      it("parses a checked box, lower or upper case x", () => {
        for (const body of ["- [x] done", "- [X] done"]) {
          const [block] = parseEntryMarkdown(body);
          if (block?.kind !== "bulletList") throw new Error("expected bulletList");
          expect(block.items[0]?.task?.checked).toBe(true);
        }
      });

      it("only recognises a checkbox at the very start of a list item, not elsewhere", () => {
        const [block] = parseEntryMarkdown("- not [ ] a checkbox mid-line");
        if (block?.kind !== "bulletList") throw new Error("expected bulletList");
        expect(block.items[0]?.task).toBeUndefined();
      });

      it("keeps a mark inside a task item's own text", () => {
        const [block] = parseEntryMarkdown("- [ ] **call** mum");
        if (block?.kind !== "bulletList") throw new Error("expected bulletList");
        const [item] = block.items;
        expect(item?.task?.checked).toBe(false);
        expect(item?.content).toEqual([
          {
            kind: "prose",
            children: [
              { kind: "text", text: " " },
              { kind: "strong", children: [{ kind: "text", text: "call" }] },
              { kind: "text", text: " mum" },
            ],
          },
        ]);
      });

      // Promotion's own output shape (issue #173, ADR 0048): a checkbox
      // whose entire line is one task reference. The checkbox marker
      // itself (`item.task`) is unaffected by the mark it happens to
      // contain — `- [ ] [[task:…]]` parses its `[ ]` exactly the way a
      // bare `- [ ] call mum` does; the reference sits inside `content`
      // like any other inline node the mark set recognises.
      it("parses a task reference inside a checkbox item, beside its own [ ]/[x] marker", () => {
        const raw = formatTaskReference(ENTRY_ID, "buy milk");
        const [block] = parseEntryMarkdown(`- [ ] ${raw}`);
        if (block?.kind !== "bulletList") throw new Error("expected bulletList");
        const [item] = block.items;
        expect(item?.task?.checked).toBe(false);
        expect(item?.content).toEqual([
          {
            kind: "prose",
            children: [
              { kind: "text", text: " " },
              { kind: "taskReference", taskId: ENTRY_ID, label: "buy milk", raw },
            ],
          },
        ]);
      });
    });

    it("resolves a Reference inside a list item, not just outside one", () => {
      const [block] = parseEntryMarkdown("- see [[2026-08-28]] for context");
      if (block?.kind !== "bulletList") throw new Error("expected bulletList");
      expect(block.items[0]?.content).toEqual([
        {
          kind: "prose",
          children: [
            { kind: "text", text: "see " },
            { kind: "dateReference", date: "2026-08-28", raw: "[[2026-08-28]]" },
            { kind: "text", text: " for context" },
          ],
        },
      ]);
    });

    it("keeps a backslash escape literal inside a list item", () => {
      const [block] = parseEntryMarkdown("- \\*not bold\\*");
      if (block?.kind !== "bulletList") throw new Error("expected bulletList");
      expect(block.items[0]?.content).toEqual([
        { kind: "prose", children: [{ kind: "text", text: "*not bold*" }] },
      ]);
    });
  });

  // The construct this ticket deliberately keeps out of the mark set: each
  // of these has a block parser in stock CommonMark, and each one is
  // removed from `entryParser` rather than filtered after the fact — see
  // that parser's own comment. What survives should be exactly the
  // characters typed, read back as ordinary prose. Two of these bodies
  // (the fenced code block, the Setext heading) contain a bare `\n` of
  // their own, which ADR 0069 now reads as a block break the same as any
  // other prose — `entryBlocksToText` still recovers every word, just not
  // the exact whitespace, which is checked separately, further below.
  describe("structure that is not in the mark set — still the literal characters typed", () => {
    const blockLooking = [
      "# heading",
      "## still a heading",
      "> a blockquote",
      "```\nfenced code\n```",
      "    four-space indented code",
      "---",
      "Setext heading\n===",
    ];

    it("produces one prose run per input, with no bullet/ordered list and no other block kind", () => {
      for (const body of blockLooking) {
        const blocks = parseEntryMarkdown(body);
        for (const block of blocks) {
          expect(block.kind).toBe("prose");
        }
      }
    });

    it("reconstructs the exact characters typed, not just their kind, for bodies with no embedded newline of their own", () => {
      for (const body of blockLooking) {
        if (body.includes("\n")) {
          continue;
        }
        expect(entryBlocksToText(parseEntryMarkdown(body))).toBe(body);
      }
    });

    it("still keeps a real list next to a removed construct — each renders as its own kind", () => {
      const body = "# heading\n- item\n> quote";
      const blocks = parseEntryMarkdown(body);
      expect(blocks.map((b) => b.kind)).toEqual(["prose", "bulletList", "prose"]);
    });

    // The specific way IndentedCode's removal "bites" (entryParser's own
    // comment): a list item's first line loses exactly one mandatory
    // separator character after its marker, never more — extra
    // indentation beyond that is ordinary content, not syntax, and has to
    // survive intact even though nothing recognises it as "code" anymore.
    it("does not swallow indentation beyond a list marker's own mandatory separator", () => {
      const [block] = parseEntryMarkdown("-     five extra spaces before text");
      if (block?.kind !== "bulletList") throw new Error("expected bulletList");
      expect(block.items[0]?.content).toEqual([
        { kind: "prose", children: [{ kind: "text", text: "    five extra spaces before text" }] },
      ]);
    });

    it("does not swallow indentation on a second paragraph inside a list item either", () => {
      // A blank line is a block break (ADR 0069) even inside a list item:
      // "item" and the six-space-indented second line become two separate
      // `"prose"` blocks, not one merged run — and `pushProseRuns`'s own
      // running `cursor` (`collectBlocks`) is what keeps the second block's
      // leading six spaces from being swallowed the way a `Paragraph`
      // node's own `.from` would otherwise swallow them.
      const [block] = parseEntryMarkdown("- item\n\n      six spaces before the second paragraph");
      if (block?.kind !== "bulletList") throw new Error("expected bulletList");
      expect(block.items[0]?.content).toEqual([
        { kind: "prose", children: [{ kind: "text", text: "item" }] },
        {
          kind: "prose",
          children: [{ kind: "text", text: "      six spaces before the second paragraph" }],
        },
      ]);
    });
  });

  describe("raw HTML never becomes markup", () => {
    it("comes back as a plain prose run containing the exact characters", () => {
      const body = "<b>hi</b><script>alert(1)</script>";
      expect(parseEntryMarkdown(body)).toEqual([
        { kind: "prose", children: [{ kind: "text", text: body }] },
      ]);
    });
  });
});

// ADR 0069/issue #234: Enter splits a block, Shift+Enter is a soft break
// encoded as a backslash hard break, and a bare `\n` is tolerated as a block
// break forever (it is exactly what ADR 0066's model wrote into storage for
// one Enter, and there is deliberately no migration for it). Both readers of
// a stored body — `entryProse` (entry-prose.tsx) and `entryMarkdownToDocument`
// (entry-document.ts, the Composer's own load path) — go through this same
// function; there is no separate display-only parser any more (ADR 0069's
// own Decision, amended by this ticket).
describe("parseEntryMarkdown — block break / soft break splitting (ADR 0069)", () => {
  it("splits outside a list on a bare \\n — one Enter, one block break", () => {
    expect(parseEntryMarkdown("alpha\nbravo")).toEqual([
      { kind: "prose", children: [{ kind: "text", text: "alpha" }] },
      { kind: "prose", children: [{ kind: "text", text: "bravo" }] },
    ]);
  });

  it("splits outside a list on \\n\\n exactly the same way, with no extra blank block", () => {
    // CommonMark's own block parser already treats any blank-line run as
    // ONE paragraph boundary, consuming it entirely as the gap between two
    // `Paragraph` siblings — `collectBlocks` never merges them back
    // together, so a genuine blank line renders identically to a single
    // bare `\n`: the blank line these authors never asked for (ADR 0066's
    // own defect) does not come back.
    expect(parseEntryMarkdown("alpha\n\nbravo")).toEqual([
      { kind: "prose", children: [{ kind: "text", text: "alpha" }] },
      { kind: "prose", children: [{ kind: "text", text: "bravo" }] },
    ]);
  });

  it("keeps a longer run of bare newlines to the same one block break", () => {
    expect(parseEntryMarkdown("alpha\n\n\n\nbravo")).toEqual([
      { kind: "prose", children: [{ kind: "text", text: "alpha" }] },
      { kind: "prose", children: [{ kind: "text", text: "bravo" }] },
    ]);
  });

  it("keeps `\\` + newline inside the SAME block, as a soft break, with the backslash gone", () => {
    expect(parseEntryMarkdown("alpha\\\nbravo")).toEqual([
      { kind: "prose", children: [{ kind: "text", text: "alpha\nbravo" }] },
    ]);
  });

  it("keeps a soft break inside a list item, not splitting the item", () => {
    expect(parseEntryMarkdown("- alpha\\\nbravo")).toEqual([
      {
        kind: "bulletList",
        items: [
          {
            task: undefined,
            content: [{ kind: "prose", children: [{ kind: "text", text: "alpha\nbravo" }] }],
          },
        ],
      },
    ]);
  });

  it("mixes all three forms in one body — soft break, then a block break, then another", () => {
    const body = "alpha\\\nbravo\ncharlie\n\ndelta";
    expect(parseEntryMarkdown(body)).toEqual([
      { kind: "prose", children: [{ kind: "text", text: "alpha\nbravo" }] },
      { kind: "prose", children: [{ kind: "text", text: "charlie" }] },
      { kind: "prose", children: [{ kind: "text", text: "delta" }] },
    ]);
  });

  it("keeps a soft break's own \\n in search-flattened text, same as any other text character", () => {
    // A soft break becomes a literal `\n` in the node stream (this file's
    // own `walkEntryInline` comment on why — an ordinary text character,
    // not a dedicated node kind), so it survives `entryBlocksToText`
    // exactly the way any other character would, unlike the space
    // `entryBlocksToText` inserts BETWEEN two separate blocks or list
    // items, which is a join this function adds, not a character the
    // parser produced.
    expect(entryBlocksToText(parseEntryMarkdown("alpha\\\nbravo"))).toBe("alpha\nbravo");
  });

  it("splits a blank line inside a list item into two blocks, neither losing its own indentation", () => {
    // A blank line is a block break (ADR 0069) even inside a list item —
    // covered again here (see also the "does not swallow indentation on a
    // second paragraph" case above) because it is the same property this
    // whole describe block exists to pin down.
    const [block] = parseEntryMarkdown("- item\n\n      six spaces before the second paragraph");
    if (block?.kind !== "bulletList") throw new Error("expected bulletList");
    expect(block.items[0]?.content).toEqual([
      { kind: "prose", children: [{ kind: "text", text: "item" }] },
      {
        kind: "prose",
        children: [{ kind: "text", text: "      six spaces before the second paragraph" }],
      },
    ]);
  });

  // A construct removed from the block-level mark set (ADR 0043) still
  // falls through to ordinary paragraph text, subject to the identical
  // block-break splitting any other prose is.
  it("keeps every word across a block break for structure that isn't in the mark set, just not the exact whitespace", () => {
    for (const body of ["```\nfenced code\n```", "Setext heading\n==="]) {
      expect(entryBlocksToText(parseEntryMarkdown(body))).toBe(body.replace(/\n/g, " "));
    }
  });
});

describe("entryBlocksToText", () => {
  it("matches inlineNodesToText for a body with no list", () => {
    const body = "a recurring **Question**";
    expect(entryBlocksToText(parseEntryMarkdown(body))).toBe(
      inlineNodesToText(parseInlineMarkdown(body)),
    );
  });

  it("flattens a bullet list to space-joined words, with no marker leaking through", () => {
    expect(entryBlocksToText(parseEntryMarkdown("- milk\n- eggs"))).not.toContain("-");
    expect(
      entryBlocksToText(parseEntryMarkdown("- milk\n- eggs")).replace(/\s+/g, " ").trim(),
    ).toBe("milk eggs");
  });

  it("flattens an ordered list with no digit or delimiter leaking through", () => {
    const flat = entryBlocksToText(parseEntryMarkdown("1. first\n2. second"));
    expect(flat.replace(/\s+/g, " ").trim()).toBe("first second");
  });

  it("flattens a task list with no [ ] / [x] leaking through", () => {
    const flat = entryBlocksToText(parseEntryMarkdown("- [ ] call mum\n- [x] done"));
    expect(flat).not.toMatch(/\[[ xX]\]/);
    expect(flat.replace(/\s+/g, " ").trim()).toBe("call mum done");
  });

  it("flattens a nested list into one space-joined run", () => {
    const flat = entryBlocksToText(parseEntryMarkdown("- top\n  - nested"));
    expect(flat.replace(/\s+/g, " ").trim()).toBe("top nested");
  });
});

// Issue #211: `collectTaskReferenceRawsInline` recurses only into
// `emphasis`/`strong`/`strikethrough` — missing any one of the three makes a
// `[[task:…]]` inside that mark invisible to `refreshTaskReferenceLabel`
// with no error anywhere, since `refreshTaskReferenceLabel` itself returns
// the body UNCHANGED when it finds no occurrences (there is nothing to
// distinguish "the label already matched" from "the mark was invisible").
describe("refreshTaskReferenceLabel finds a task reference nested inside a mark", () => {
  const oldRaw = formatTaskReference(ENTRY_ID, "buy milk");
  const newRaw = formatTaskReference(ENTRY_ID, "buy oat milk");

  it("inside a strikethrough", () => {
    const body = `- [ ] ~~${oldRaw} (cancelled)~~`;
    expect(refreshTaskReferenceLabel(body, ENTRY_ID, "buy oat milk")).toBe(
      `- [ ] ~~${newRaw} (cancelled)~~`,
    );
  });

  it("inside a strikethrough nested inside a strong — all three levels at once", () => {
    const body = `**~~${oldRaw}~~**`;
    expect(refreshTaskReferenceLabel(body, ENTRY_ID, "buy oat milk")).toBe(`**~~${newRaw}~~**`);
  });

  it("inside an emphasis, and inside a strong, for the same coverage the mark set already had", () => {
    expect(refreshTaskReferenceLabel(`*${oldRaw}*`, ENTRY_ID, "buy oat milk")).toBe(`*${newRaw}*`);
    expect(refreshTaskReferenceLabel(`**${oldRaw}**`, ENTRY_ID, "buy oat milk")).toBe(
      `**${newRaw}**`,
    );
  });
});

describe("parseCommentMarkdown", () => {
  it("returns an empty list for an empty body, same contract as parseEntryMarkdown", () => {
    expect(parseCommentMarkdown("")).toEqual([]);
  });

  it("renders `# heading` as a heading block, unlike parseEntryMarkdown's literal prose", () => {
    expect(parseCommentMarkdown("# heading")).toEqual([
      { kind: "heading", level: 1, children: [{ kind: "text", text: "heading" }] },
    ]);
    expect(parseEntryMarkdown("# heading")).toEqual([
      { kind: "prose", children: [{ kind: "text", text: "# heading" }] },
    ]);
  });

  it("renders `> quote` as a blockquote block, unlike parseEntryMarkdown's literal prose", () => {
    expect(parseCommentMarkdown("> quote")).toEqual([
      {
        kind: "blockquote",
        content: [{ kind: "prose", children: [{ kind: "text", text: "quote" }] }],
      },
    ]);
    expect(parseEntryMarkdown("> quote")).toEqual([
      { kind: "prose", children: [{ kind: "text", text: "> quote" }] },
    ]);
  });

  it("renders a fenced block as a codeBlock, carrying its info string, unlike parseEntryMarkdown's literal prose", () => {
    expect(parseCommentMarkdown("```js\nconsole.log(1)\n```")).toEqual([
      { kind: "codeBlock", text: "console.log(1)\n", lang: "js" },
    ]);
    expect(parseEntryMarkdown("```js\nconsole.log(1)\n```")).toEqual([
      { kind: "prose", children: [{ kind: "text", text: "```js" }] },
      { kind: "prose", children: [{ kind: "text", text: "console.log(1)" }] },
      { kind: "prose", children: [{ kind: "text", text: "```" }] },
    ]);
  });

  it("carries no info string when the fence has none", () => {
    expect(parseCommentMarkdown("```\nplain\n```")).toEqual([
      { kind: "codeBlock", text: "plain\n", lang: undefined },
    ]);
  });

  it("linkifies a bare https URL, unlike parseEntryMarkdown's literal text", () => {
    expect(parseCommentMarkdown("see https://example.com now")).toEqual([
      {
        kind: "prose",
        children: [
          { kind: "text", text: "see " },
          { kind: "link", url: "https://example.com", text: "https://example.com" },
          { kind: "text", text: " now" },
        ],
      },
    ]);
    expect(parseEntryMarkdown("see https://example.com now")).toEqual([
      { kind: "prose", children: [{ kind: "text", text: "see https://example.com now" }] },
    ]);
  });

  it("linkifies a bare http URL too", () => {
    expect(parseCommentMarkdown("http://example.com")).toEqual([
      {
        kind: "prose",
        children: [{ kind: "link", url: "http://example.com", text: "http://example.com" }],
      },
    ]);
  });

  it("does not linkify a www./mailto: URL missing an http(s) scheme", () => {
    expect(parseCommentMarkdown("www.example.com")).toEqual([
      { kind: "prose", children: [{ kind: "text", text: "www.example.com" }] },
    ]);
    expect(parseCommentMarkdown("mailto:a@example.com")).toEqual([
      { kind: "prose", children: [{ kind: "text", text: "mailto:a@example.com" }] },
    ]);
  });

  // A `javascript:` URL is never even recognised as a `URL` node by
  // `Autolink` in the first place (verified directly against the parser),
  // so this is a second, independent gate over that fact — `isSafeAutolinkUrl`
  // — rather than a test that could only ever pass by relying on the same
  // upstream behaviour it exists to guard against changing.
  it("never linkifies a javascript: URL", () => {
    const body = "javascript:alert(1)";
    // `Autolink` never recognises this scheme as a `URL` node in the first
    // place (verified directly against the parser), so this stays
    // byte-identical to `parseEntryMarkdown`'s own output — no `"link"`
    // node anywhere in it.
    expect(parseCommentMarkdown(body)).toEqual(parseEntryMarkdown(body));
    expect(entryBlocksToText(parseCommentMarkdown(body))).toBe(body);
  });

  it("still renders a real bullet list, the gap says runs the other way (only a numbered list stays literal in Todoist, not this app's)", () => {
    expect(parseCommentMarkdown("- milk\n- eggs")).toEqual([
      {
        kind: "bulletList",
        tight: true,
        items: [
          {
            task: undefined,
            content: [{ kind: "prose", children: [{ kind: "text", text: "milk" }] }],
          },
          {
            task: undefined,
            content: [{ kind: "prose", children: [{ kind: "text", text: "eggs" }] }],
          },
        ],
      },
    ]);
  });

  it("still renders a real ordered list — leaves meologue's <ol> alone", () => {
    const blocks = parseCommentMarkdown("1. first\n2. second");
    expect(blocks[0]?.kind).toBe("orderedList");
  });

  it("injects no HTML — an HTML-looking string stays literal text, same as parseEntryMarkdown", () => {
    const body = "<script>alert(1)</script>";
    expect(parseCommentMarkdown(body)).toEqual(parseEntryMarkdown(body));
    expect(entryBlocksToText(parseCommentMarkdown(body))).toBe(body);
  });

  it("keeps bold/italic/strikethrough/inline-code the same as parseEntryMarkdown", () => {
    const body = "**bold** *italic* ~~struck~~ `code`";
    expect(parseCommentMarkdown(body)).toEqual(parseEntryMarkdown(body));
  });
});

describe("flattenCommentPreview", () => {
  it("reproduces Todoist's own measured single-line flattening — marks stripped, a bare URL kept", () => {
    expect(flattenCommentPreview("**bold** and https://example.com")).toBe(
      "bold and https://example.com",
    );
  });

  it("reproduces Todoist's own measured multi-line flattening — fence lines dropped, # and > kept, lines joined with single spaces", () => {
    const body = "*italic*\n~~strike~~\n# heading\n> quote\n```\ncode block\n```\n1. first";
    expect(flattenCommentPreview(body)).toBe("italic strike # heading > quote code block 1. first");
  });

  it("returns an empty string for an empty body", () => {
    expect(flattenCommentPreview("")).toBe("");
  });

  it("drops a fence line even when it carries an info string", () => {
    expect(flattenCommentPreview("```js\nconsole.log(1)\n```")).toBe("console.log(1)");
  });
});
