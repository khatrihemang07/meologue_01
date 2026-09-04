import type { QuickAddOptions } from "@meologue/core";
import { describe, expect, it } from "vitest";
import { entryMarkdownToDocument } from "./entry-document";
import { formatTaskReference } from "./inline-markdown";
import { type ActiveChecklistPromotion, promoteBareCheckboxes } from "./promote-tasks";
import { tokenSignature } from "./quick-add-highlight";

/** A deterministic `mintId` for these tests — "task-1", "task-2", ... in call order. */
function sequentialMintId() {
  let count = 0;
  return () => {
    count += 1;
    return `task-${count}`;
  };
}

// Fixed and Wednesday, matching packages/core/src/quick-add/quick-add.test.ts's
// own `NOW` — every date expectation below is worked out against this exact
// value, not against whatever the parser happens to compute.
const NOW = "2026-09-02";
const OPTIONS: QuickAddOptions = { now: NOW, smartDates: true };

describe("promoteBareCheckboxes", () => {
  it("mints a Task for a bare checkbox and rewrites the line as a Reference", () => {
    const result = promoteBareCheckboxes("- [ ] buy milk", sequentialMintId(), OPTIONS);

    expect(result.tasks).toEqual([
      {
        id: "task-1",
        checked: false,
        content: "buy milk",
        date: null,
        deadline: null,
        priority: 1,
        dateString: null,
        labelNames: [],
      },
    ]);
    expect(result.body).toBe(`- [ ] ${formatTaskReference("task-1", "buy milk")}`);
  });

  it("carries a checked marker onto the minted Task", () => {
    const result = promoteBareCheckboxes("- [x] already done", sequentialMintId(), OPTIONS);

    expect(result.tasks[0]?.checked).toBe(true);
    expect(result.tasks[0]?.content).toBe("already done");
    expect(result.body).toBe(`- [x] ${formatTaskReference("task-1", "already done")}`);
  });

  it("promotes every bare checkbox in one Entry, each its own Task, in document order", () => {
    const result = promoteBareCheckboxes(
      "- [ ] first\n- [x] second\n- plain third",
      sequentialMintId(),
      OPTIONS,
    );

    expect(result.tasks.map((t) => ({ id: t.id, content: t.content, checked: t.checked }))).toEqual(
      [
        { id: "task-1", content: "first", checked: false },
        { id: "task-2", content: "second", checked: true },
      ],
    );
    expect(result.body).toBe(
      `- [ ] ${formatTaskReference("task-1", "first")}\n- [x] ${formatTaskReference("task-2", "second")}\n- plain third`,
    );
  });

  it("promotes a checkbox nested inside another item's own trailing content", () => {
    const result = promoteBareCheckboxes(
      "- outer\n  - [ ] nested task",
      sequentialMintId(),
      OPTIONS,
    );

    expect(result.tasks[0]?.content).toBe("nested task");
    expect(result.body).toBe(`- outer\n  - [ ] ${formatTaskReference("task-1", "nested task")}`);
  });

  it("keeps a nested list AFTER a promoted checkbox's own line intact", () => {
    const result = promoteBareCheckboxes(
      "- [ ] parent\n  - a note about it",
      sequentialMintId(),
      OPTIONS,
    );

    expect(result.tasks[0]?.content).toBe("parent");
    expect(result.body).toBe(
      `- [ ] ${formatTaskReference("task-1", "parent")}\n  - a note about it`,
    );
  });

  it("flattens inline formatting out of the minted Task's own content", () => {
    const result = promoteBareCheckboxes(
      "- [ ] call **mum** about *dinner*",
      sequentialMintId(),
      OPTIONS,
    );

    expect(result.tasks[0]?.content).toBe("call mum about dinner");
  });

  // Issue #173's own follow-up: promotion must apply the SAME parse
  // `checklistHighlightPlugin` already highlighted, not just flatten the
  // line to raw words — so the checkbox line genuinely "files itself."
  describe("applying the parse (issue #173 follow-up)", () => {
    it("resolves a date token, a priority token, and strips both from content", () => {
      const result = promoteBareCheckboxes(
        "- [ ] buy milk tomorrow p1",
        sequentialMintId(),
        OPTIONS,
      );

      const task = result.tasks[0];
      expect(task?.content).toBe("buy milk");
      // "tomorrow" against a Wednesday NOW of 2026-09-02.
      expect(task?.date).toBe("2026-09-03");
      // p1 is the most urgent UI priority, stored as 4 (storedPriorityOf).
      expect(task?.priority).toBe(4);
      expect(result.body).toBe(`- [ ] ${formatTaskReference("task-1", "buy milk")}`);
    });

    it("a line with no tokens promotes to its full text, unchanged behaviour", () => {
      const result = promoteBareCheckboxes(
        "- [ ] just a plain checkbox",
        sequentialMintId(),
        OPTIONS,
      );

      const task = result.tasks[0];
      expect(task?.content).toBe("just a plain checkbox");
      expect(task?.date).toBeNull();
      expect(task?.priority).toBe(1);
    });

    it("an unsupported #project token is kept as literal text, not consumed (quick-add-task.ts's own UNSUPPORTED_TOKEN_KINDS)", () => {
      const result = promoteBareCheckboxes(
        "- [ ] buy milk tomorrow p1 #Shopping",
        sequentialMintId(),
        OPTIONS,
      );

      const task = result.tasks[0];
      // #Shopping is a PROJECT token in this parser's own grammar (the
      // `%` sigil is what marks a Label — packages/core/src/quick-add/
      // rules.ts's own matchLabel/matchProject), and Task has no `#`-typed
      // project field to resolve it into (quick-add-task.ts's own
      // UNSUPPORTED_TOKEN_KINDS, issue #171's own sequencing) — so it
      // stays literal, exactly as it would typed straight into Todo's own
      // add field.
      expect(task?.content).toBe("buy milk #Shopping");
      expect(task?.date).toBe("2026-09-03");
      expect(task?.priority).toBe(4);
    });

    it("resolves a %label token into labelNames, stripped from content", () => {
      const result = promoteBareCheckboxes("- [ ] buy milk %Shopping", sequentialMintId(), OPTIONS);

      const task = result.tasks[0];
      expect(task?.content).toBe("buy milk");
      expect(task?.labelNames).toEqual(["Shopping"]);
    });

    it("a line consumed entirely by recognised tokens falls back to the full text rather than an empty Task name", () => {
      const result = promoteBareCheckboxes("- [ ] tomorrow p1", sequentialMintId(), OPTIONS);

      const task = result.tasks[0];
      expect(task?.content).toBe("tomorrow p1");
      // The parse still resolved real fields even though the fallback
      // kept the words — nothing about the fallback un-recognises them.
      expect(task?.date).toBe("2026-09-03");
      expect(task?.priority).toBe(4);
    });
  });

  // A demotion the reader clicked in the Composer (quick-add-highlight.ts's
  // own click-to-demote) must survive into promotion, or the "click to
  // demote back to plain text" gesture would be a lie: the reader would see
  // a word un-highlight, then have it silently consumed anyway on Send.
  describe("a demoted token is not consumed", () => {
    it("keeps a demoted date token as literal content and does not set `date`", () => {
      const demoted = new Set([tokenSignature({ kind: "date", raw: "tomorrow" })]);
      const active: ActiveChecklistPromotion = { ordinal: 0, demoted };

      const result = promoteBareCheckboxes(
        "- [ ] buy milk tomorrow p1",
        sequentialMintId(),
        OPTIONS,
        active,
      );

      const task = result.tasks[0];
      // "tomorrow" stays put; "p1" was never demoted, so it's still
      // recognised and still stripped.
      expect(task?.content).toBe("buy milk tomorrow");
      expect(task?.date).toBeNull();
      expect(task?.priority).toBe(4);
    });

    it("only applies a demotion to the ONE item named by `ordinal`, not every checkbox in the Entry", () => {
      const demoted = new Set([tokenSignature({ kind: "date", raw: "tomorrow" })]);
      // Ordinal 1 — the SECOND bare checkbox, not the first.
      const active: ActiveChecklistPromotion = { ordinal: 1, demoted };

      const result = promoteBareCheckboxes(
        "- [ ] first tomorrow\n- [ ] second tomorrow",
        sequentialMintId(),
        OPTIONS,
        active,
      );

      expect(result.tasks[0]?.content).toBe("first");
      expect(result.tasks[0]?.date).toBe("2026-09-03");
      expect(result.tasks[1]?.content).toBe("second tomorrow");
      expect(result.tasks[1]?.date).toBeNull();
    });
  });

  // The loop guard (ADR 0048): "Promotion fires only on a bare checkbox
  // with no Reference" — so a Task can never create an Entry that creates
  // a Task, and a line this function already promoted on an earlier Send
  // is never re-promoted on a later one.
  describe("the loop guard", () => {
    it("does not re-promote a line that already carries a task Reference", () => {
      const already = `- [ ] ${formatTaskReference("0192abcd-1234-7890-abcd-0123456789ac", "already promoted")}`;

      const result = promoteBareCheckboxes(already, sequentialMintId(), OPTIONS);

      expect(result.tasks).toEqual([]);
      expect(result.body).toBe(already);
    });

    it("returns the exact same string, not merely an equal one, when nothing was promoted", () => {
      const body = "no checkbox here at all";

      const result = promoteBareCheckboxes(body, sequentialMintId(), OPTIONS);

      // `promoteBareCheckboxes` must not round-trip an Entry through
      // `entryMarkdownToDocument`/`entryDocumentToMarkdown` when there is
      // nothing to promote — this proves it by identity, not just value
      // equality, since a normalizing round trip could still produce an
      // equal-looking string for simple input.
      expect(result.body).toBe(body);
      expect(result.tasks).toEqual([]);
    });

    it("promotes only the bare checkbox in a mix of bare and already-referenced lines", () => {
      const body = `- [ ] a fresh one\n- [x] ${formatTaskReference("0192abcd-1234-7890-abcd-0123456789ac", "old one")}`;

      const result = promoteBareCheckboxes(body, sequentialMintId(), OPTIONS);

      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0]?.content).toBe("a fresh one");
      expect(result.body).toBe(
        `- [ ] ${formatTaskReference("task-1", "a fresh one")}\n- [x] ${formatTaskReference("0192abcd-1234-7890-abcd-0123456789ac", "old one")}`,
      );
    });
  });

  it("still produces a document that satisfies the schema", () => {
    const result = promoteBareCheckboxes(
      "- [ ] first\n  - a nested note\n- [x] second\n- plain third",
      sequentialMintId(),
      OPTIONS,
    );

    expect(() => entryMarkdownToDocument(result.body).check()).not.toThrow();
  });
});
