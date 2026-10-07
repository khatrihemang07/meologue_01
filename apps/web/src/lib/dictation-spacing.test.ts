import type { NodeType, Node as PMNode } from "prosemirror-model";
import { describe, expect, it } from "vitest";
import { dictationNeedsLeadingSpace } from "./dictation-spacing";
import { entrySchema } from "./entry-schema";

function type(name: string): NodeType {
  const found = entrySchema.nodes[name];
  if (found === undefined) {
    throw new Error(`no ${name} node`);
  }
  return found;
}

function para(...content: PMNode[]): PMNode {
  return type("paragraph").create(null, content);
}

function word(value: string): PMNode {
  return entrySchema.text(value);
}

function docOf(...blocks: PMNode[]): PMNode {
  return type("doc").create(null, blocks);
}

function spaceAt(root: PMNode, pos: number): boolean {
  return dictationNeedsLeadingSpace(root.resolve(pos));
}

describe("dictationNeedsLeadingSpace", () => {
  it("is false at the start of the document", () => {
    expect(spaceAt(docOf(para(word("hi"))), 1)).toBe(false);
  });

  it("is true after a word", () => {
    expect(spaceAt(docOf(para(word("hi"))), 3)).toBe(true);
  });

  it("is false after a space", () => {
    expect(spaceAt(docOf(para(word("hi "))), 4)).toBe(false);
  });

  it("is false at the start of a second paragraph", () => {
    expect(spaceAt(docOf(para(word("hi")), para(word("yo"))), 5)).toBe(false);
  });

  // The schema has no hard_break node; a block boundary is its only line break.

  it("is true after a Reference, which reads like a word", () => {
    const ref = type("reference").create({
      kind: "day",
      raw: "[[2026-01-01]]",
      date: "2026-01-01",
    });
    expect(spaceAt(docOf(para(ref)), 2)).toBe(true);
  });

  it("is false after a task reference, which is not word-like inline content", () => {
    const task = type("task_reference").create({ taskId: "t1", label: "x", checked: false });
    const list = type("bullet_list").create(null, [type("list_item").create(null, [para(task)])]);
    // list > item > paragraph content starts at 3; the atom spans 3..4
    expect(spaceAt(docOf(list), 4)).toBe(false);
  });
});
