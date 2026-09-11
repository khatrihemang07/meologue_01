import { describe, expect, it } from "vitest";
import { descriptionDocFromText, descriptionTextFromDoc } from "./task-description-editor";

/**
 * `descriptionDocFromText`/`descriptionTextFromDoc` are pure — no
 * `EditorView` to mount, so this suite drives them directly the same way
 * `composer-editor.test.ts` builds `entrySchema` nodes without a real
 * browser (that file's own header comment on why: jsdom cannot usefully
 * mount ProseMirror at all). DET-12: bold, bullet list, inline code.
 */
function roundTrip(text: string): string {
  return descriptionTextFromDoc(descriptionDocFromText(text));
}

describe("descriptionDocFromText / descriptionTextFromDoc", () => {
  it("round-trips plain text unchanged", () => {
    expect(roundTrip("just a plain line")).toBe("just a plain line");
  });

  it("round-trips multiple plain paragraphs, one per line", () => {
    expect(roundTrip("first line\nsecond line\nthird line")).toBe(
      "first line\nsecond line\nthird line",
    );
  });

  it("parses **bold** into a strong mark and serialises it back", () => {
    const doc = descriptionDocFromText("buy the **good** milk");
    const bold = doc.firstChild?.content.content.find((node) =>
      node.marks.some((mark) => mark.type.name === "strong"),
    );
    expect(bold?.text).toBe("good");
    expect(descriptionTextFromDoc(doc)).toBe("buy the **good** milk");
  });

  it("parses `code` into a code mark and serialises it back", () => {
    const doc = descriptionDocFromText("run `npm install` first");
    const code = doc.firstChild?.content.content.find((node) =>
      node.marks.some((mark) => mark.type.name === "code"),
    );
    expect(code?.text).toBe("npm install");
    expect(descriptionTextFromDoc(doc)).toBe("run `npm install` first");
  });

  it("groups consecutive '- ' lines into one bullet list", () => {
    const doc = descriptionDocFromText("- step one\n- step two");
    expect(doc.childCount).toBe(1);
    expect(doc.firstChild?.type.name).toBe("bullet_list");
    expect(doc.firstChild?.childCount).toBe(2);
    expect(descriptionTextFromDoc(doc)).toBe("- step one\n- step two");
  });

  it("normalises a '* ' marker to '-' on save", () => {
    expect(roundTrip("* item one")).toBe("- item one");
  });

  it("keeps a plain paragraph between two separate bullet lists distinct", () => {
    expect(roundTrip("- a\nnote\n- b")).toBe("- a\nnote\n- b");
  });

  it("preserves an empty line as an empty paragraph", () => {
    expect(roundTrip("first\n\nthird")).toBe("first\n\nthird");
  });

  it("an empty string round-trips to an empty string", () => {
    expect(roundTrip("")).toBe("");
  });

  it("leaves a construct outside bold/code/bullet as literal text", () => {
    expect(roundTrip("# not a heading here")).toBe("# not a heading here");
  });
});
