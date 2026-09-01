import { beforeEach, describe, expect, it } from "vitest";
import { orderKeyBetween } from "../order-key";
import type { TaskStore } from "../task-store";
import { task } from "./task-fixture";

/**
 * The behaviour every TaskStore implementation (ADR 0047) must satisfy —
 * the Task-shaped sibling of entryStoreContract (./entry-store-contract.ts),
 * mirrored section for section so a reader who knows one recognises the
 * other. Call this from inside a `describe` block, passing a factory for
 * the implementation under test.
 */
export function taskStoreContract(createStore: () => TaskStore | Promise<TaskStore>): void {
  let store: TaskStore;

  beforeEach(async () => {
    store = await createStore();
  });

  it("returns a locally created Task immediately, before any sync", async () => {
    const local = task({ id: "local-1", seq: null });

    await store.upsert([local]);

    expect(await store.list()).toEqual([local]);
  });

  it("deduplicates Tasks arriving twice by id, rather than appending twice", async () => {
    const first = task({ id: "dup-1", content: "first version" });
    const second = task({ id: "dup-1", content: "second version", seq: 1 });

    await store.upsert([first]);
    await store.upsert([second]);

    const all = await store.list();
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual(second);
  });

  it("orders Tasks by orderKey ascending, breaking ties by id ascending", async () => {
    const b = task({ id: "b", orderKey: "b" });
    const a = task({ id: "a", orderKey: "a" });
    const tieB = task({ id: "tie-b", orderKey: "m" });
    const tieA = task({ id: "tie-a", orderKey: "m" });

    await store.upsert([b, a, tieB, tieA]);

    expect((await store.list()).map((t) => t.id)).toEqual(["a", "b", "tie-a", "tie-b"]);
  });

  it("a completed Task leaves list()", async () => {
    await store.upsert([task({ id: "a", seq: 1 })]);

    await store.complete("a", "2026-01-05T00:00:00.000Z");

    expect(await store.list()).toEqual([]);
  });

  it("listCompleted() returns a completed Task, newest completion first", async () => {
    await store.upsert([task({ id: "a", seq: 1 }), task({ id: "b", seq: 1, orderKey: "z" })]);

    await store.complete("a", "2026-01-01T00:00:00.000Z");
    await store.complete("b", "2026-01-02T00:00:00.000Z");

    expect((await store.listCompleted()).map((t) => t.id)).toEqual(["b", "a"]);
  });

  it("listCompleted() excludes a tombstoned Task", async () => {
    await store.upsert([task({ id: "a", seq: 1 })]);
    await store.complete("a", "2026-01-01T00:00:00.000Z");

    await store.remove("a");

    expect(await store.listCompleted()).toEqual([]);
  });

  describe("listByProject() — issue #171", () => {
    it("returns only active, top-level Tasks in the given Project, in orderKey order", async () => {
      await store.upsert([
        task({ id: "b", projectId: "project-1", orderKey: "b", seq: 1 }),
        task({ id: "a", projectId: "project-1", orderKey: "a", seq: 1 }),
        task({ id: "other-project", projectId: "project-2", seq: 1 }),
        task({ id: "inbox", projectId: null, seq: 1 }),
      ]);

      expect((await store.listByProject("project-1")).map((t) => t.id)).toEqual(["a", "b"]);
    });

    // `null` is Inbox (../project-types.ts's own header comment) — the
    // one case listByProject exists to answer that list() alone cannot,
    // now that a Task can also live in a named Project.
    it("returns Inbox Tasks — projectId null — when passed null", async () => {
      await store.upsert([
        task({ id: "inbox-task", projectId: null, seq: 1 }),
        task({ id: "project-task", projectId: "project-1", seq: 1 }),
      ]);

      expect((await store.listByProject(null)).map((t) => t.id)).toEqual(["inbox-task"]);
    });

    it("excludes a sub-task even when it shares the Project", async () => {
      await store.upsert([
        task({ id: "parent", projectId: "project-1", seq: 1 }),
        task({ id: "child", projectId: "project-1", parentId: "parent", seq: 1 }),
      ]);

      expect((await store.listByProject("project-1")).map((t) => t.id)).toEqual(["parent"]);
    });

    it("excludes a completed Task", async () => {
      await store.upsert([task({ id: "a", projectId: "project-1", seq: 1 })]);
      await store.complete("a", "2026-01-05T00:00:00.000Z");

      expect(await store.listByProject("project-1")).toEqual([]);
    });
  });

  describe("listChildren() — issue #171", () => {
    // "Sub-tasks keep their own order regardless of any sorting or
    // grouping applied to the list above them" (CONTEXT.md's Sub-task
    // entry) — this is what makes that true structurally: listChildren's
    // own orderKey sort is untouched by whatever order the parent's own
    // list happens to be in.
    it("returns active, direct sub-tasks in their own orderKey order", async () => {
      await store.upsert([
        task({ id: "parent", seq: 1 }),
        task({ id: "child-b", parentId: "parent", orderKey: "b", seq: 1 }),
        task({ id: "child-a", parentId: "parent", orderKey: "a", seq: 1 }),
      ]);

      expect((await store.listChildren("parent")).map((t) => t.id)).toEqual(["child-a", "child-b"]);
    });

    it("excludes a grandchild — only direct children", async () => {
      await store.upsert([
        task({ id: "parent", seq: 1 }),
        task({ id: "child", parentId: "parent", seq: 1 }),
        task({ id: "grandchild", parentId: "child", seq: 1 }),
      ]);

      expect((await store.listChildren("parent")).map((t) => t.id)).toEqual(["child"]);
    });

    it("excludes a completed sub-task", async () => {
      await store.upsert([
        task({ id: "parent", seq: 1 }),
        task({ id: "child", parentId: "parent", seq: 1 }),
      ]);
      await store.complete("child", "2026-01-05T00:00:00.000Z");

      expect(await store.listChildren("parent")).toEqual([]);
    });
  });

  describe("listInSection() — issue #171", () => {
    // Deliberately includes completed Tasks, unlike listByProject/
    // listChildren above — see TaskStore.listInSection's own doc comment
    // for why deleteSection/archiveSection need that.
    it("returns active and completed Tasks filed in the Section, excluding a different one", async () => {
      await store.upsert([
        task({ id: "active", sectionId: "section-1", seq: 1 }),
        task({ id: "done", sectionId: "section-1", seq: 1 }),
        task({ id: "elsewhere", sectionId: "section-2", seq: 1 }),
      ]);
      await store.complete("done", "2026-01-05T00:00:00.000Z");

      expect((await store.listInSection("section-1")).map((t) => t.id).sort()).toEqual([
        "active",
        "done",
      ]);
    });

    it("excludes a tombstoned Task", async () => {
      await store.upsert([task({ id: "a", sectionId: "section-1", seq: 1 })]);
      await store.remove("a");

      expect(await store.listInSection("section-1")).toEqual([]);
    });
  });

  describe("listDescendants() — issue #171", () => {
    it("returns every descendant at every depth, active and completed alike", async () => {
      await store.upsert([
        task({ id: "root", seq: 1 }),
        task({ id: "child", parentId: "root", seq: 1 }),
        task({ id: "grandchild", parentId: "child", seq: 1 }),
        task({ id: "unrelated", seq: 1 }),
      ]);
      await store.complete("grandchild", "2026-01-05T00:00:00.000Z");

      expect((await store.listDescendants("root")).map((t) => t.id).sort()).toEqual([
        "child",
        "grandchild",
      ]);
    });

    it("excludes a tombstoned descendant", async () => {
      await store.upsert([
        task({ id: "root", seq: 1 }),
        task({ id: "child", parentId: "root", seq: 1 }),
      ]);
      await store.remove("child");

      expect(await store.listDescendants("root")).toEqual([]);
    });

    it("returns an empty array for a Task with no sub-tasks", async () => {
      await store.upsert([task({ id: "a", seq: 1 })]);

      expect(await store.listDescendants("a")).toEqual([]);
    });
  });

  describe("complete() / uncomplete()", () => {
    it("complete() sets completedAt and clears seq, making the Task pending again", async () => {
      const synced = task({ id: "a", seq: 5, syncedAt: "2026-01-01T00:00:00.000Z" });
      await store.upsert([synced]);

      await store.complete("a", "2026-01-05T00:00:00.000Z");

      const [found] = await store.listCompleted();
      expect(found).toMatchObject({
        id: "a",
        completedAt: "2026-01-05T00:00:00.000Z",
        seq: null,
      });
      expect((await store.pending()).map((t) => t.id)).toEqual(["a"]);
    });

    it("uncomplete() clears completedAt and clears seq, returning the Task to list()", async () => {
      await store.upsert([task({ id: "a", seq: 1 })]);
      await store.complete("a", "2026-01-05T00:00:00.000Z");

      await store.uncomplete("a");

      const [found] = await store.list();
      expect(found).toMatchObject({ id: "a", completedAt: null, seq: null });
      expect(await store.listCompleted()).toEqual([]);
    });

    it("complete() then uncomplete() round-trips a Task back to its original content and order", async () => {
      const original = task({ id: "a", seq: 1, content: "buy milk", orderKey: "m" });
      await store.upsert([original]);

      await store.complete("a", "2026-01-05T00:00:00.000Z");
      await store.uncomplete("a");

      const [found] = await store.list();
      expect(found).toMatchObject({ id: "a", content: "buy milk", orderKey: "m" });
    });

    // CONTEXT.md's Sub-task entry: "Completing a parent completes its
    // sub-tasks along with it" — proven down every level, not just the
    // first, since a shallow implementation (cascade one level, forget to
    // recurse) would still pass a single-level test.
    it("completing a parent completes its active sub-tasks, recursively down every level", async () => {
      await store.upsert([
        task({ id: "parent", seq: 1 }),
        task({ id: "child", parentId: "parent", seq: 1 }),
        task({ id: "grandchild", parentId: "child", seq: 1 }),
      ]);

      await store.complete("parent", "2026-01-05T00:00:00.000Z");

      expect(await store.get("child")).toMatchObject({
        completedAt: "2026-01-05T00:00:00.000Z",
        seq: null,
      });
      expect(await store.get("grandchild")).toMatchObject({
        completedAt: "2026-01-05T00:00:00.000Z",
        seq: null,
      });
    });

    it("does not overwrite a sub-task that was already completed on its own", async () => {
      await store.upsert([
        task({ id: "parent", seq: 1 }),
        task({ id: "child", parentId: "parent", seq: 1 }),
      ]);
      await store.complete("child", "2026-01-01T00:00:00.000Z");

      await store.complete("parent", "2026-01-05T00:00:00.000Z");

      const child = await store.get("child");
      expect(child?.completedAt).toBe("2026-01-01T00:00:00.000Z");
    });

    // The rule's other half, named explicitly by CONTEXT.md and issue
    // #171's acceptance criteria — not a bidirectional cascade, and no
    // such behaviour should be invented.
    it("completing every sub-task does not complete the parent", async () => {
      await store.upsert([
        task({ id: "parent", seq: 1 }),
        task({ id: "only-child", parentId: "parent", seq: 1 }),
      ]);

      await store.complete("only-child", "2026-01-05T00:00:00.000Z");

      const parent = await store.get("parent");
      expect(parent?.completedAt).toBeNull();
    });
  });

  it("rename() changes content and clears seq", async () => {
    const synced = task({ id: "a", content: "original", seq: 5 });
    await store.upsert([synced]);

    await store.rename("a", "changed");

    const [found] = await store.list();
    expect(found).toMatchObject({ id: "a", content: "changed", seq: null });
  });

  it("rename() updates the search index — found by the new word, not the old", async () => {
    await store.upsert([task({ id: "a", content: "a recurring task", seq: 1 })]);

    await store.rename("a", "a completed chore");

    expect((await store.search("chore")).map((t) => t.id)).toEqual(["a"]);
    expect(await store.search("recur")).toEqual([]);
  });

  describe("reorder()", () => {
    it("changes orderKey and clears seq", async () => {
      const synced = task({ id: "a", orderKey: "m", seq: 5 });
      await store.upsert([synced]);

      const newKey = orderKeyBetween(null, "m");
      await store.reorder("a", newKey);

      const [found] = await store.list();
      expect(found).toMatchObject({ id: "a", orderKey: newKey, seq: null });
    });

    // The property fractional indexing exists to give (ADR 0050): a drag
    // touches the dragged Task's own row and nothing else. Asserted here
    // by checking every sibling's orderKey and seq are byte-identical to
    // what was upserted — not merely that the dragged Task ended up in
    // the right place, which a naive "recompute every sibling's order"
    // implementation could also achieve while still rewriting rows it
    // had no business touching.
    it("touches only the reordered Task — every sibling's orderKey and seq are untouched", async () => {
      const a = task({ id: "a", orderKey: "a", seq: 1 });
      const b = task({ id: "b", orderKey: "b", seq: 2 });
      const c = task({ id: "c", orderKey: "c", seq: 3 });
      await store.upsert([a, b, c]);

      await store.reorder("c", orderKeyBetween(null, "a"));

      const [first, second, third] = await store.list();
      expect(first).toMatchObject({ id: "c" });
      expect(second).toEqual(a);
      expect(third).toEqual(b);
    });
  });

  describe("setDate()", () => {
    it("changes date and clears seq", async () => {
      await store.upsert([task({ id: "a", seq: 5 })]);

      await store.setDate("a", "2026-01-05");

      const [found] = await store.list();
      expect(found).toMatchObject({ id: "a", date: "2026-01-05", seq: null });
    });

    it("accepts a floating timed date (no Z, no offset)", async () => {
      await store.upsert([task({ id: "a", seq: 5 })]);

      await store.setDate("a", "2026-01-05T09:00");

      const [found] = await store.list();
      expect(found).toMatchObject({ id: "a", date: "2026-01-05T09:00" });
    });

    it("clears the date back to null — a Task returning to Inbox's undated state", async () => {
      await store.upsert([task({ id: "a", date: "2026-01-05", seq: 5 })]);

      await store.setDate("a", null);

      const [found] = await store.list();
      expect(found).toMatchObject({ id: "a", date: null, seq: null });
    });

    it("refuses a date carrying a UTC Z or an offset — that's a different encoding than the floating one this field stores", async () => {
      await store.upsert([task({ id: "a", seq: 1 })]);

      await expect(store.setDate("a", "2026-01-05T09:00:00.000Z")).rejects.toThrow();
    });
  });

  describe("setDeadline()", () => {
    it("changes deadline and clears seq", async () => {
      await store.upsert([task({ id: "a", seq: 5 })]);

      await store.setDeadline("a", "2026-01-10");

      const [found] = await store.list();
      expect(found).toMatchObject({ id: "a", deadline: "2026-01-10", seq: null });
    });

    it("clears the deadline back to null", async () => {
      await store.upsert([task({ id: "a", deadline: "2026-01-10", seq: 5 })]);

      await store.setDeadline("a", null);

      const [found] = await store.list();
      expect(found).toMatchObject({ id: "a", deadline: null, seq: null });
    });

    // A Deadline is date-only by definition (CONTEXT.md's Deadline entry)
    // — this is the store-level refusal ../task-fields.ts's
    // assertValidDeadline exists for, and the one the issue calls out as
    // the most likely to get silently bypassed.
    it("refuses a deadline carrying a time", async () => {
      await store.upsert([task({ id: "a", seq: 1 })]);

      await expect(store.setDeadline("a", "2026-01-10T09:00")).rejects.toThrow();
    });
  });

  describe("setDuration()", () => {
    it("changes duration (minutes) and clears seq, given a Task with a timed date", async () => {
      await store.upsert([task({ id: "a", date: "2026-01-05T09:00", seq: 5 })]);

      await store.setDuration("a", 30);

      const [found] = await store.list();
      expect(found).toMatchObject({ id: "a", duration: 30, seq: null });
    });

    it("clears the duration back to null", async () => {
      await store.upsert([task({ id: "a", date: "2026-01-05T09:00", duration: 30, seq: 5 })]);

      await store.setDuration("a", null);

      const [found] = await store.list();
      expect(found).toMatchObject({ id: "a", duration: null, seq: null });
    });

    it("refuses a duration on a Task with no date at all", async () => {
      await store.upsert([task({ id: "a", date: null, seq: 1 })]);

      await expect(store.setDuration("a", 30)).rejects.toThrow();
    });

    it("refuses a duration on an all-day Task — there's nothing to measure a length from without a time", async () => {
      await store.upsert([task({ id: "a", date: "2026-01-05", seq: 1 })]);

      await expect(store.setDuration("a", 30)).rejects.toThrow();
    });

    it("refuses a duration over 24 hours (1440 minutes)", async () => {
      await store.upsert([task({ id: "a", date: "2026-01-05T09:00", seq: 1 })]);

      await expect(store.setDuration("a", 1441)).rejects.toThrow();
    });

    it("accepts exactly 1440 minutes — the cap is inclusive", async () => {
      await store.upsert([task({ id: "a", date: "2026-01-05T09:00", seq: 1 })]);

      await store.setDuration("a", 1440);

      const [found] = await store.list();
      expect(found).toMatchObject({ duration: 1440 });
    });
  });

  describe("setPriority()", () => {
    it("changes priority and clears seq", async () => {
      await store.upsert([task({ id: "a", seq: 5 })]);

      await store.setPriority("a", 4);

      const [found] = await store.list();
      expect(found).toMatchObject({ id: "a", priority: 4, seq: null });
    });

    it("refuses a priority outside 1-4", async () => {
      await store.upsert([task({ id: "a", seq: 1 })]);

      await expect(store.setPriority("a", 0)).rejects.toThrow();
      await expect(store.setPriority("a", 5)).rejects.toThrow();
    });
  });

  describe("setLabelIds()", () => {
    it("changes labelIds and clears seq", async () => {
      await store.upsert([task({ id: "a", seq: 5 })]);

      await store.setLabelIds("a", ["work", "urgent"]);

      const [found] = await store.list();
      expect(found).toMatchObject({ id: "a", labelIds: ["work", "urgent"], seq: null });
    });

    it("replaces the array wholesale rather than merging", async () => {
      await store.upsert([task({ id: "a", labelIds: ["work"], seq: 5 })]);

      await store.setLabelIds("a", ["home"]);

      const [found] = await store.list();
      expect(found).toMatchObject({ labelIds: ["home"] });
    });

    it("clears labels back to an empty array", async () => {
      await store.upsert([task({ id: "a", labelIds: ["work"], seq: 5 })]);

      await store.setLabelIds("a", []);

      const [found] = await store.list();
      expect(found).toMatchObject({ labelIds: [] });
    });

    it("preserves the order Labels were passed in", async () => {
      await store.upsert([task({ id: "a", seq: 5 })]);

      await store.setLabelIds("a", ["c", "a", "b"]);

      const [found] = await store.list();
      expect(found?.labelIds).toEqual(["c", "a", "b"]);
    });
  });

  describe("setProject() — issue #171", () => {
    it("changes projectId and clears seq", async () => {
      await store.upsert([task({ id: "a", seq: 5 })]);

      await store.setProject("a", "project-1");

      expect(await store.get("a")).toMatchObject({ projectId: "project-1", seq: null });
    });

    it("clears projectId back to Inbox", async () => {
      await store.upsert([task({ id: "a", projectId: "project-1", seq: 5 })]);

      await store.setProject("a", null);

      expect(await store.get("a")).toMatchObject({ projectId: null, seq: null });
    });

    // A Section belongs to exactly one Project (../project-types.ts's
    // Section.projectId doc comment) — TaskStore.setProject's own doc
    // comment explains why a sectionId from the old Project can't validly
    // survive the move.
    it("clears sectionId unconditionally when the project changes", async () => {
      await store.upsert([
        task({ id: "a", projectId: "project-1", sectionId: "section-1", seq: 5 }),
      ]);

      await store.setProject("a", "project-2");

      expect(await store.get("a")).toMatchObject({ projectId: "project-2", sectionId: null });
    });
  });

  describe("setSection() — issue #171", () => {
    it("changes sectionId and clears seq", async () => {
      await store.upsert([task({ id: "a", seq: 5 })]);

      await store.setSection("a", "section-1");

      expect(await store.get("a")).toMatchObject({ sectionId: "section-1", seq: null });
    });

    it("clears sectionId back to null", async () => {
      await store.upsert([task({ id: "a", sectionId: "section-1", seq: 5 })]);

      await store.setSection("a", null);

      expect(await store.get("a")).toMatchObject({ sectionId: null, seq: null });
    });
  });

  describe("setParent() — issue #171", () => {
    it("changes parentId and clears seq", async () => {
      await store.upsert([task({ id: "parent", seq: 1 }), task({ id: "child", seq: 5 })]);

      await store.setParent("child", "parent");

      expect(await store.get("child")).toMatchObject({ parentId: "parent", seq: null });
    });

    it("clears parentId back to top-level", async () => {
      await store.upsert([
        task({ id: "parent", seq: 1 }),
        task({ id: "child", parentId: "parent", seq: 5 }),
      ]);

      await store.setParent("child", null);

      expect(await store.get("child")).toMatchObject({ parentId: null, seq: null });
    });

    it("refuses a Task becoming its own parent", async () => {
      await store.upsert([task({ id: "a", seq: 1 })]);

      await expect(store.setParent("a", "a")).rejects.toThrow();
    });

    it("refuses a parentId that does not exist", async () => {
      await store.upsert([task({ id: "a", seq: 1 })]);

      await expect(store.setParent("a", "never-seen")).rejects.toThrow();
    });

    // Walking up from `b`'s own new parent (`a`) would pass back through
    // `a` itself — the exact shape a cycle takes.
    it("refuses a parentId that would create a cycle", async () => {
      await store.upsert([task({ id: "a", seq: 1 }), task({ id: "b", parentId: "a", seq: 1 })]);

      await expect(store.setParent("a", "b")).rejects.toThrow();
    });

    // The four-level nesting cap (CONTEXT.md's Sub-task entry, issue
    // #171's acceptance criteria). level1-level4 are wired up directly via
    // upsert(), which does not itself validate depth (mirroring every
    // other #169/#171 field) — this test exercises only setParent's own
    // enforcement, not upsert's.
    it("refuses nesting a fifth level deep", async () => {
      await store.upsert([
        task({ id: "level1", seq: 1 }),
        task({ id: "level2", parentId: "level1", seq: 1 }),
        task({ id: "level3", parentId: "level2", seq: 1 }),
        task({ id: "level4", parentId: "level3", seq: 1 }),
        task({ id: "level5-candidate", seq: 1 }),
      ]);

      await expect(store.setParent("level5-candidate", "level4")).rejects.toThrow();
    });

    it("accepts nesting exactly four levels deep — the cap is inclusive", async () => {
      await store.upsert([
        task({ id: "level1", seq: 1 }),
        task({ id: "level2", parentId: "level1", seq: 1 }),
        task({ id: "level3", parentId: "level2", seq: 1 }),
        task({ id: "level4-candidate", seq: 1 }),
      ]);

      await store.setParent("level4-candidate", "level3");

      expect(await store.get("level4-candidate")).toMatchObject({ parentId: "level3" });
    });
  });

  // Store-level mechanics only — every grammar form and every anchor's
  // computed date lives in ../recurrence/recurrence.test.ts's own
  // table-driven spec, "large enough to be the specification" on its
  // own. These prove the store wraps that pure engine correctly: `seq`
  // clearing, the tombstone no-op, and the one behaviour that can't be
  // tested against the engine alone — a recurring Task never enters the
  // completed list.
  describe("advanceRecurring()", () => {
    it("advances date and clears seq, but never sets completedAt — a recurring Task never enters the completed list", async () => {
      await store.upsert([task({ id: "a", dateString: "every day", date: "2026-01-05", seq: 5 })]);

      await store.advanceRecurring("a", "2026-01-05T00:00:00.000Z");

      const [found] = await store.list();
      expect(found).toMatchObject({ id: "a", date: "2026-01-06", completedAt: null, seq: null });
      expect(await store.listCompleted()).toEqual([]);
    });

    it("a due-anchored rule keeps the due date's own phase, not the completion day", async () => {
      await store.upsert([
        task({ id: "a", dateString: "every month", date: "2026-01-15", seq: 5 }),
      ]);

      await store.advanceRecurring("a", "2026-01-20T00:00:00.000Z");

      const [found] = await store.list();
      expect(found).toMatchObject({ date: "2026-02-15" });
    });

    // The exact case CLAUDE.md's brief calls out by name — re-checked at
    // the store's own boundary, not only inside ../recurrence/'s own
    // suite, since this is the path a real completion actually takes.
    it("skips missed occurrences — a yearly task completed eighteen months late lands two years out, not one", async () => {
      await store.upsert([task({ id: "a", dateString: "every year", date: "2025-01-01", seq: 5 })]);

      await store.advanceRecurring("a", "2026-07-01T00:00:00.000Z");

      const [found] = await store.list();
      expect(found).toMatchObject({ date: "2027-01-01" });
    });

    it("files the Task as an ordinary completed Task once a bounded rule's window has ended", async () => {
      await store.upsert([
        task({ id: "a", dateString: "every day ending 8 Jan", date: "2026-01-01", seq: 5 }),
      ]);

      await store.advanceRecurring("a", "2026-01-08T00:00:00.000Z");

      expect(await store.list()).toEqual([]);
      const [found] = await store.listCompleted();
      expect(found).toMatchObject({
        id: "a",
        completedAt: "2026-01-08T00:00:00.000Z",
        dateString: null,
        seq: null,
      });
    });

    it("throws when the Task has no dateString — a caller error, not something to paper over", async () => {
      await store.upsert([task({ id: "a", dateString: null, seq: 5 })]);

      await expect(store.advanceRecurring("a", "2026-01-05T00:00:00.000Z")).rejects.toThrow();
    });

    it("throws when the stored dateString no longer parses", async () => {
      await store.upsert([task({ id: "a", dateString: "not a recurrence rule", seq: 5 })]);

      await expect(store.advanceRecurring("a", "2026-01-05T00:00:00.000Z")).rejects.toThrow();
    });

    it("no-ops against an unknown id", async () => {
      await expect(
        store.advanceRecurring("never-seen", "2026-01-05T00:00:00.000Z"),
      ).resolves.toBeUndefined();
    });
  });

  describe("completeForever()", () => {
    it("sets completedAt for real and clears dateString — ends the series, files an ordinary completed Task", async () => {
      await store.upsert([task({ id: "a", dateString: "every day", date: "2026-01-05", seq: 5 })]);

      await store.completeForever("a", "2026-01-10T00:00:00.000Z");

      expect(await store.list()).toEqual([]);
      const [found] = await store.listCompleted();
      expect(found).toMatchObject({
        id: "a",
        completedAt: "2026-01-10T00:00:00.000Z",
        dateString: null,
        seq: null,
        // `date` is left exactly as it was — the last occurrence is as
        // meaningful a record as it is for a Task that never recurred.
        date: "2026-01-05",
      });
    });
  });

  describe("postpone()", () => {
    it("moves an overdue Task's date to tomorrow, relative to `today` — not to the day after the stale date", async () => {
      await store.upsert([task({ id: "a", date: "2025-06-01", seq: 5 })]);

      await store.postpone("a", "2026-01-05");

      const [found] = await store.list();
      expect(found).toMatchObject({ date: "2026-01-06", seq: null });
    });

    it("preserves a timed date's own time-of-day on the new day", async () => {
      await store.upsert([task({ id: "a", date: "2025-06-01T09:00", seq: 5 })]);

      await store.postpone("a", "2026-01-05");

      const [found] = await store.list();
      expect(found).toMatchObject({ date: "2026-01-06T09:00" });
    });

    it("no-ops against a Task with no date at all — there's nothing to postpone", async () => {
      await store.upsert([task({ id: "a", date: null, seq: 5 })]);

      await store.postpone("a", "2026-01-05");

      const [found] = await store.list();
      expect(found).toMatchObject({ date: null, seq: 5 });
    });
  });

  describe("remove() — tombstone, not hard delete", () => {
    it("removes a Task from list(), listCompleted(), get() and search()", async () => {
      await store.upsert([task({ id: "a", content: "a recurring task", seq: 1 })]);

      await store.remove("a");

      expect(await store.list()).toEqual([]);
      expect(await store.get("a")).toBeUndefined();
      expect(await store.search("recur")).toEqual([]);
    });

    // The resurrection trap ADR 0028 names, applied to Tasks: `seq IS
    // NULL` means "no acknowledgement from the server yet," which also
    // covers "pushed, but the response was lost" — a store that
    // hard-deletes here instead of leaving a tombstone would let the next
    // sync bring the Task back permanently. This is the most important
    // new case in this ticket, mirroring entryStoreContract's own most
    // important case exactly.
    it("removing a Task whose seq is already null still leaves a tombstone pending(), not nothing", async () => {
      await store.upsert([task({ id: "a", content: "not yet synced", seq: null })]);

      await store.remove("a");

      const pending = await store.pending();
      expect(pending.map((t) => t.id)).toEqual(["a"]);
      expect(pending[0]?.deletedAt).not.toBeNull();
    });

    it("removing a Task blanks its content", async () => {
      await store.upsert([task({ id: "a", content: "something", seq: 1 })]);

      await store.remove("a");

      const [tombstone] = await store.pending();
      expect(tombstone).toMatchObject({ id: "a", content: "" });
    });

    // Every local mutation against a tombstone is a no-op — no
    // resurrection, no matter which door a caller tries.
    it("complete(), uncomplete(), rename(), reorder(), the four #169 setters, setLabelIds(), the three #171 setters, advanceRecurring(), completeForever() and postpone() are all no-ops against a tombstone", async () => {
      await store.upsert([task({ id: "a", content: "something", seq: 1, orderKey: "m" })]);
      await store.remove("a");

      await store.complete("a", "2026-01-05T00:00:00.000Z");
      await store.uncomplete("a");
      await store.rename("a", "trying to bring it back");
      await store.reorder("a", orderKeyBetween(null, "m"));
      await store.setDate("a", "2026-01-05");
      await store.setDeadline("a", "2026-01-10");
      // setDuration's own no-op check runs before its date-shape
      // validation (its doc comment explains why), so this doesn't throw
      // even though the live Task above was never given a timed date.
      await store.setDuration("a", 30);
      await store.setPriority("a", 4);
      await store.setLabelIds("a", ["work"]);
      await store.setProject("a", "some-project");
      await store.setSection("a", "some-section");
      // setParent's own no-op check runs before its parent-existence
      // check, so this doesn't throw even though "not-a-real-parent" was
      // never created.
      await store.setParent("a", "not-a-real-parent");
      // advanceRecurring's own no-op check runs before its "no
      // dateString" throw for the identical reason — the tombstoned Task
      // above was never given one either.
      await store.advanceRecurring("a", "2026-01-05T00:00:00.000Z");
      await store.completeForever("a", "2026-01-05T00:00:00.000Z");
      await store.postpone("a", "2026-01-05");

      expect(await store.list()).toEqual([]);
      expect(await store.listCompleted()).toEqual([]);
      const [tombstone] = await store.pending();
      expect(tombstone).toMatchObject({ id: "a", content: "" });
      expect(tombstone?.deletedAt).not.toBeNull();
    });

    it("upserting a tombstone arriving from sync removes the Task from list() and search()", async () => {
      await store.upsert([task({ id: "a", content: "a recurring task", seq: 1 })]);
      expect((await store.list()).map((t) => t.id)).toEqual(["a"]);

      const tombstone = task({
        id: "a",
        content: "",
        seq: 2,
        deletedAt: "2026-01-03T00:00:00.000Z",
      });
      await store.upsert([tombstone]);

      expect(await store.list()).toEqual([]);
      expect(await store.search("recur")).toEqual([]);
    });
  });

  describe("get()", () => {
    it("returns a live Task by id", async () => {
      await store.upsert([task({ id: "a" })]);

      expect(await store.get("a")).toEqual(task({ id: "a" }));
    });

    it("returns undefined for an unknown id", async () => {
      expect(await store.get("never-seen")).toBeUndefined();
    });
  });

  it("returns only Tasks with a null sequence from pending() — exactly seq IS NULL", async () => {
    const unsynced = task({ id: "unsynced", seq: null });
    const synced = task({ id: "synced", seq: 42 });

    await store.upsert([unsynced, synced]);

    expect((await store.pending()).map((t) => t.id)).toEqual(["unsynced"]);
  });

  it("starts the cursor at 0 and reflects whatever it's set to", async () => {
    expect(await store.getCursor()).toBe(0);

    await store.setCursor(7);

    expect(await store.getCursor()).toBe(7);
  });

  describe("search()", () => {
    it("matches by a word prefix", async () => {
      const shopping = task({ id: "a", content: "buy groceries", orderKey: "a" });
      const other = task({ id: "b", content: "call the dentist", orderKey: "b" });
      await store.upsert([shopping, other]);

      expect((await store.search("groc")).map((t) => t.id)).toEqual(["a"]);
    });

    it("does not match a word that merely contains the query, not as a prefix", async () => {
      await store.upsert([task({ id: "a", content: "a recurring task" })]);

      expect(await store.search("urring")).toEqual([]);
    });

    it("treats quotes, wildcards and boolean-looking words as literal text, never throwing", async () => {
      await store.upsert([task({ id: "a", content: 'AND OR NOT "quoted" * text' })]);

      expect((await store.search('AND OR NOT "quoted" *')).map((t) => t.id)).toEqual(["a"]);
      await expect(store.search('he said "hello')).resolves.toEqual([]);
      await expect(store.search("!!!")).resolves.toEqual([]);
    });

    it("treats an empty or whitespace-only query as matching nothing", async () => {
      await store.upsert([task({ id: "a", content: "anything at all" })]);

      expect(await store.search("")).toEqual([]);
      expect(await store.search("   ")).toEqual([]);
    });

    it("excludes a completed Task", async () => {
      await store.upsert([task({ id: "a", content: "a recurring task", seq: 1 })]);

      await store.complete("a", "2026-01-05T00:00:00.000Z");

      expect(await store.search("recur")).toEqual([]);
    });

    it("excludes a tombstoned Task", async () => {
      await store.upsert([task({ id: "a", content: "a recurring task", seq: 1 })]);

      await store.remove("a");

      expect(await store.search("recur")).toEqual([]);
    });
  });
}
