/**
 * The canonical form is the instrument every parity row is measured with,
 * so it needs its own coverage rather than borrowing confidence from the
 * rows it judges. A silent bug here does not fail loudly — it makes a real
 * divergence read as parity, or an identical pair read as a difference,
 * which is the exact failure mode issue #230 exists to end.
 *
 * The load-bearing claim under test is the one thing the module is for:
 * **UpNote's sibling-`<ul>` nesting and this schema's child nesting must
 * produce byte-identical output for the same visible document.** Every
 * `divergence: "none"` row in `parity-fixture.ts` is only meaningful if
 * that holds, so it is asserted directly here on the shapes themselves
 * rather than inferred from a row passing.
 */
import { describe, expect, it } from "vitest";
import { entrySchema } from "../entry-schema";
import {
  type CanonicalDocument,
  entryDocumentToCanonical,
  entryMarkdownToCanonical,
  upnoteHtmlToCanonical,
} from "./canonical";

/** Builds a live `entrySchema` document from a plain JSON tree, the way a mounted view's own `toJSON()` would hand one back. */
function docOf(content: unknown[]): ReturnType<typeof entrySchema.nodeFromJSON> {
  return entrySchema.nodeFromJSON({ type: "doc", content });
}

function paragraph(text?: string) {
  return text === undefined || text === ""
    ? { type: "paragraph" }
    : { type: "paragraph", content: [{ type: "text", text }] };
}

function listItem(text: string | undefined, extra: unknown[] = [], checked: boolean | null = null) {
  return {
    type: "list_item",
    attrs: { checked },
    content: [paragraph(text), ...extra],
  };
}

function bulletList(content: unknown[]) {
  return { type: "bullet_list", content };
}

/** The levels a flattened list reports, in order — the shape both nesting dialects have to agree on. */
function levelsOf(canonical: CanonicalDocument): Array<[number, string]> {
  return canonical.blocks.flatMap((block) =>
    block.kind === "list"
      ? block.items.map(
          (item) =>
            [
              item.level,
              item.prose.lines
                .flat()
                .map((run) => ("text" in run ? run.text : ""))
                .join(""),
            ] as [number, string],
        )
      : [],
  );
}

describe("the two nesting dialects normalise to the same thing", () => {
  it("agrees on a one-level nest", () => {
    const ours = entryDocumentToCanonical(
      docOf([bulletList([listItem("top", [bulletList([listItem("mid")])])])]),
    );
    const theirs = upnoteHtmlToCanonical("<ul><li>top</li><ul><li>mid</li></ul></ul>");

    expect(levelsOf(ours)).toEqual([
      [0, "top"],
      [1, "mid"],
    ]);
    expect(ours).toEqual(theirs);
  });

  it("agrees three levels deep", () => {
    const ours = entryDocumentToCanonical(
      docOf([
        bulletList([
          listItem("top", [bulletList([listItem("mid", [bulletList([listItem("deep")])])])]),
        ]),
      ]),
    );
    const theirs = upnoteHtmlToCanonical(
      "<ul><li>top</li><ul><li>mid</li><ul><li>deep</li></ul></ul></ul>",
    );

    expect(levelsOf(ours)).toEqual([
      [0, "top"],
      [1, "mid"],
      [2, "deep"],
    ]);
    expect(ours).toEqual(theirs);
  });
});

describe("an empty parent item (ADR 0071) is elided, its level is not", () => {
  /**
   * Indenting the FIRST item of a list — which UpNote does, verified on
   * both platforms — has to mint a textless wrapper item here, because
   * this schema nests a list as a child of its item. UpNote needs no such
   * node. Counting it would make every first-item-indent row read as a
   * divergence between two documents that are identical on screen.
   */
  it("reports the nested item at level 1 with no wrapper row of its own", () => {
    const ours = entryDocumentToCanonical(
      docOf([bulletList([listItem(undefined, [bulletList([listItem("alpha")])])])]),
    );

    expect(levelsOf(ours)).toEqual([[1, "alpha"]]);
    expect(ours).toEqual(upnoteHtmlToCanonical("<ul><ul><li>alpha</li></ul></ul>"));
  });

  it("keeps a following top-level sibling at level 0", () => {
    const ours = entryDocumentToCanonical(
      docOf([
        bulletList([listItem(undefined, [bulletList([listItem("alpha")])]), listItem("bravo")]),
      ]),
    );

    expect(levelsOf(ours)).toEqual([
      [1, "alpha"],
      [0, "bravo"],
    ]);
  });

  it("does not elide an item that has prose of its own", () => {
    const ours = entryDocumentToCanonical(
      docOf([bulletList([listItem("parent", [bulletList([listItem("child")])])])]),
    );

    expect(levelsOf(ours)).toEqual([
      [0, "parent"],
      [1, "child"],
    ]);
  });

  it("does not elide a genuinely empty item the reader can see", () => {
    const ours = entryDocumentToCanonical(docOf([bulletList([listItem(undefined)])]));

    expect(levelsOf(ours)).toEqual([[0, ""]]);
  });
});

describe("break kinds", () => {
  it("distinguishes a block break from a soft break", () => {
    const twoBlocks = entryDocumentToCanonical(docOf([paragraph("alpha"), paragraph("bravo")]));
    const oneBlockSoftBroken = upnoteHtmlToCanonical("alpha<br>bravo");

    const breaksOf = (d: CanonicalDocument) =>
      d.blocks.flatMap((b) => (b.kind === "prose" ? [...b.prose.breaks] : []));

    expect(breaksOf(twoBlocks)).toEqual(["block"]);
    expect(breaksOf(oneBlockSoftBroken)).toEqual(["soft"]);
    expect(twoBlocks).not.toEqual(oneBlockSoftBroken);
  });

  it("reads UpNote's two adjacent divs as one block break", () => {
    expect(
      upnoteHtmlToCanonical("<div>alpha</div><div>bravo</div>").blocks.flatMap((b) =>
        b.kind === "prose" ? [...b.prose.breaks] : [],
      ),
    ).toEqual(["block"]);
  });
});

describe("checked state is carried, and is orthogonal to list kind", () => {
  it("round-trips an unchecked and a checked item", () => {
    const ours = entryDocumentToCanonical(
      docOf([bulletList([listItem("todo", [], false), listItem("done", [], true)])]),
    );
    const checked = ours.blocks.flatMap((b) =>
      b.kind === "list" ? b.items.map((i) => i.checked) : [],
    );

    expect(checked).toEqual([false, true]);
    expect(ours).toEqual(
      upnoteHtmlToCanonical(
        '<ul><li data-checked="false">todo</li><li data-checked="true">done</li></ul>',
      ),
    );
  });
});

describe("the markdown adapter agrees with the document adapter", () => {
  it("reads a nested bullet list to the same canonical form", () => {
    expect(entryMarkdownToCanonical("- top\n  - mid")).toEqual(
      entryDocumentToCanonical(
        docOf([bulletList([listItem("top", [bulletList([listItem("mid")])])])]),
      ),
    );
  });
});
