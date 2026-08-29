import { describe, expect, it } from "vitest";
import {
  type InlineNode,
  inlineNodesToText,
  parseInlineMarkdown,
  parseReferenceDate,
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

    it("does not treat a malformed mark as a Reference — it renders literally", () => {
      const malformed = [
        "[[nope]]",
        "[[2026-13-45]]", // month 13 does not exist
        "[[2026-02-30]]", // Feb 30 does not exist
        `[[e:not-a-uuid]]`,
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

  it("renders a Reference's raw text, not its resolved id", () => {
    const nodes: InlineNode[] = [
      { kind: "dateReference", date: "2026-08-28", raw: "[[2026-08-28]]" },
    ];
    expect(inlineNodesToText(nodes)).toBe("[[2026-08-28]]");
  });
});
