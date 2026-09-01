import { describe, expect, it } from "vitest";
import { entrySchema } from "./entry-schema";

describe("entrySchema", () => {
  it("has exactly the node types an Entry's body needs, and no more", () => {
    // Headings, blockquotes, code blocks and horizontal rules are absent on
    // purpose (ADR 0043) — this is the test that would fail if one of them
    // ever got added back.
    expect(Object.keys(entrySchema.nodes).sort()).toEqual(
      ["doc", "paragraph", "text", "reference", "bullet_list", "ordered_list", "list_item"].sort(),
    );
  });

  it("has exactly the mark set: strong, em, code", () => {
    expect(Object.keys(entrySchema.marks).sort()).toEqual(["strong", "em", "code"].sort());
  });

  it("gives list_item a nullable checked attribute rather than a second node type", () => {
    const plain = entrySchema.nodes.list_item?.create(null, entrySchema.nodes.paragraph?.create());
    expect(plain?.attrs.checked).toBe(null);

    const task = entrySchema.nodes.list_item?.create(
      { checked: false },
      entrySchema.nodes.paragraph?.create(),
    );
    expect(task?.attrs.checked).toBe(false);
  });

  it("gives ordered_list an order attribute defaulting to 1", () => {
    const list = entrySchema.nodes.ordered_list?.create(
      null,
      entrySchema.nodes.list_item?.create(null, entrySchema.nodes.paragraph?.create()),
    );
    expect(list?.attrs.order).toBe(1);
  });

  it("makes reference an inline atom — it cannot be typed into", () => {
    const reference = entrySchema.nodes.reference;
    expect(reference?.isInline).toBe(true);
    expect(reference?.isAtom).toBe(true);
  });

  it("rejects a doc with no blocks at all — block+ requires at least one", () => {
    expect(() => entrySchema.nodes.doc?.createChecked(null, [])).toThrow();
  });

  it("rejects a heading-shaped node — there is no such node type to create", () => {
    expect(entrySchema.nodes.heading).toBeUndefined();
  });
});
