import { DOMSerializer } from "prosemirror-model";
import { describe, expect, it } from "vitest";
import { entrySchema } from "./entry-schema";
import { formatTaskReference } from "./inline-markdown";

describe("entrySchema", () => {
  it("has exactly the node types an Entry's body needs, and no more", () => {
    // Headings, blockquotes, code blocks and horizontal rules are absent on
    // purpose (ADR 0043) — this is the test that would fail if one of them
    // ever got added back.
    expect(Object.keys(entrySchema.nodes).sort()).toEqual(
      [
        "doc",
        "paragraph",
        "text",
        "reference",
        "task_reference",
        "bullet_list",
        "ordered_list",
        "list_item",
      ].sort(),
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

  it("makes task_reference an inline atom too, carrying taskId/label/checked", () => {
    const taskReference = entrySchema.nodes.task_reference;
    expect(taskReference?.isInline).toBe(true);
    expect(taskReference?.isAtom).toBe(true);

    const node = taskReference?.create({ taskId: "abc123", label: "buy milk", checked: true });
    expect(node?.attrs).toMatchObject({ taskId: "abc123", label: "buy milk", checked: true });
  });

  it("rejects a doc with no blocks at all — block+ requires at least one", () => {
    expect(() => entrySchema.nodes.doc?.createChecked(null, [])).toThrow();
  });

  it("rejects a heading-shaped node — there is no such node type to create", () => {
    expect(entrySchema.nodes.heading).toBeUndefined();
  });

  // Issue #177: before this fix, `checked` had no `default` — any
  // ProseMirror path that synthesizes a `task_reference` without an
  // explicit `checked` attr (`createAndFill`, `ContentMatch.fillBefore`, a
  // paste rule) threw `RangeError: No value supplied for attribute
  // checked` the moment it tried to build the node.
  describe("task_reference's checked default (issue #177)", () => {
    it("defaults checked to false when a caller creates one without it", () => {
      const node = entrySchema.nodes.task_reference?.create({
        taskId: "11111111-2222-4333-8444-555555555555",
        label: "buy milk",
      });
      expect(node?.attrs.checked).toBe(false);
    });

    // The exact crash this ticket fixes: `createAndFill` (unlike `create`
    // above) is what `ContentMatch.fillBefore` and a paste rule reach for
    // when ProseMirror itself needs to synthesize a node with only SOME
    // attrs known (`taskId`/`label`, never `checked`) — before this fix,
    // `checked`'s missing `default` meant `computeAttrs`
    // (prosemirror-model) threw the moment it found no value and no
    // fallback for that one key.
    it("no longer throws from createAndFill with taskId/label but no checked", () => {
      const attrs = { taskId: "11111111-2222-4333-8444-555555555555", label: "buy milk" };
      expect(() => entrySchema.nodes.task_reference?.createAndFill(attrs)).not.toThrow();
      expect(entrySchema.nodes.task_reference?.createAndFill(attrs)?.attrs.checked).toBe(false);
    });

    it("still honours an explicit checked: true rather than always falling back", () => {
      const node = entrySchema.nodes.task_reference?.create({
        taskId: "11111111-2222-4333-8444-555555555555",
        label: "buy milk",
        checked: true,
      });
      expect(node?.attrs.checked).toBe(true);
    });
  });

  // Issue #177: `DOMSerializer.fromSchema` (prosemirror-model) silently
  // drops any node type with no `toDOM` from the map it builds, so
  // copying a Composer selection that spanned a `task_reference` called
  // `undefined(node)` and threw — the clipboard-side twin of the
  // NodeView-less render crash this ticket's own diagnosis opens with.
  // `taskReferenceNodeView`'s own doc comment (composer-editor.ts)
  // explains why a NodeView renders the live editor but this `toDOM`
  // exists purely for this path.
  describe("task_reference's toDOM (issue #177)", () => {
    it("serializes to the mark's own literal characters, not a checkbox+label rendering", () => {
      const node = entrySchema.nodes.task_reference?.create({
        taskId: "11111111-2222-4333-8444-555555555555",
        label: "buy milk",
        checked: true,
      });
      const serializer = DOMSerializer.fromSchema(entrySchema);
      const dom = serializer.serializeNode(node as NonNullable<typeof node>) as HTMLElement;
      expect(dom.textContent).toBe(
        formatTaskReference("11111111-2222-4333-8444-555555555555", "buy milk"),
      );
    });

    it("does not throw serializing a fragment that holds a task_reference (the actual copy path)", () => {
      const paragraph = entrySchema.nodes.paragraph?.create(
        null,
        entrySchema.nodes.task_reference?.create({
          taskId: "11111111-2222-4333-8444-555555555555",
          label: "buy milk",
        }),
      );
      const serializer = DOMSerializer.fromSchema(entrySchema);
      expect(() =>
        serializer.serializeFragment((paragraph as NonNullable<typeof paragraph>).content),
      ).not.toThrow();
    });

    // Closes the loop: there is deliberately no `parseDOM` paired with
    // this `toDOM` (that node spec's own comment), so pasting the copied
    // HTML anywhere in an `entrySchema` document degrades to the mark's
    // own literal text rather than a live `task_reference` node — ADR
    // 0042's "unresolved is plain text" rule. What proves "copy/paste
    // works" isn't that the paste lands as a live node immediately; it's
    // that the exact text a copy produces is the exact text
    // `entryMarkdownToDocument` (entry-document.ts) turns back into one —
    // the same reparse a Send, or the paste target's own next reload,
    // already performs on ordinary stored text.
    it("what a copy serializes reparses into the identical task_reference on the next parse", async () => {
      const { entryMarkdownToDocument } = await import("./entry-document");
      const taskId = "11111111-2222-4333-8444-555555555555";
      const original = entrySchema.nodes.task_reference?.create({
        taskId,
        label: "buy milk",
        checked: true,
      });
      const serializer = DOMSerializer.fromSchema(entrySchema);
      const copiedText = serializer.serializeNode(
        original as NonNullable<typeof original>,
      ).textContent;

      const reparsedDoc = entryMarkdownToDocument(`- [x] ${copiedText}`);
      const reparsed = reparsedDoc.firstChild?.firstChild?.firstChild?.lastChild;

      expect(reparsed?.type.name).toBe("task_reference");
      expect(reparsed?.attrs).toMatchObject({ taskId, label: "buy milk", checked: true });
    });
  });
});
