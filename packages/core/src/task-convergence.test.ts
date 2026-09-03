import { describe, expect, it } from "vitest";
import { compareByOrder, orderKeyBetween } from "./order-key";
import type { SyncTransport } from "./sync-engine";
import { sync } from "./sync-engine";
import type { Task } from "./task-types";
import { comment } from "./test-support/comment-fixture";
import { InMemoryCommentStore } from "./test-support/in-memory-comment-store";
import { InMemoryEntryStore } from "./test-support/in-memory-entry-store";
import { InMemoryLabelStore } from "./test-support/in-memory-label-store";
import { InMemoryProjectStore } from "./test-support/in-memory-project-store";
import { InMemoryTaskStore } from "./test-support/in-memory-task-store";
import { label } from "./test-support/label-fixture";
import { project, section } from "./test-support/project-fixture";
import { task } from "./test-support/task-fixture";
import type {
  WireCommentOutput,
  WireLabelOutput,
  WireProjectOutput,
  WireSectionOutput,
  WireTaskOutput,
} from "./wire";

/**
 * The test ADR 0050 exists to justify: two Devices reordering a shared
 * Todo list *offline*, then syncing, must converge on one order — and it
 * has to be the order the drags actually asked for, not merely "some
 * order both Devices happen to agree on" (a fully-broken merge that
 * discarded both drags and fell back to createdAt order would "agree"
 * too, and would still be wrong).
 *
 * Why fractional indexing is what makes this provable, and integer
 * positions are not: an integer position names a Task by *where it sits*
 * (index 3), not by *what it's next to*. Moving one Task under that
 * scheme means recomputing the index of every sibling from the insertion
 * point onward — a write to N rows for one drag, not one. Two Devices
 * dragging *different* Tasks offline each recompute their own version of
 * that shared index space, and since neither transaction protection
 * (../sqlite/migrator.ts has none — see its own header comment) nor row
 * ordering across two Devices' pushes is guaranteed, sync resolves each
 * contested row independently under last-write-wins (ADR 0028). Which
 * Device's index value survives for a given row depends on which arrived
 * at the server last *for that row* — not on which Device's drag was
 * more recent, not on either Device's intended final order. The
 * "integer positions would have done" test below builds one concrete
 * interleaving to make that failure mode visible rather than asserting
 * it in the abstract.
 *
 * Fractional indexing sidesteps this by naming a Task's place *relative
 * to its neighbours' keys*, so a drag writes exactly the one row for the
 * Task that moved. Two Devices dragging different Tasks offline touch
 * disjoint rows, and sync has nothing to merge beyond applying both
 * writes — there's no shared index space for their edits to collide in.
 */

// A fake Server, in the spirit of sync-engine.test.ts's transport mock —
// a compacted change log keyed by Task id (ADR 0028's "Sync's compacted
// change log", applied to Tasks per ADR 0047): each push overwrites the
// current row for a given id and hands it a fresh, monotonically
// increasing seq, exactly the shape SqliteTaskStore.upsert's
// onConflictDoUpdate produces server-side. There's no real Task wire
// protocol yet (ADR 0047's Consequences name that as its own ADR, 0051,
// not this ticket's), so this models the same push/pull/cursor shape
// sync-engine.ts uses without inventing wire types this ticket doesn't
// own.
class FakeTaskServer {
  private readonly rows = new Map<string, { task: Task; seq: number }>();
  private counter = 0;

  push(pending: Task[]): void {
    for (const t of pending) {
      this.counter += 1;
      this.rows.set(t.id, { task: { ...t, seq: this.counter, syncedAt: null }, seq: this.counter });
    }
  }

  pull(sinceSeq: number): { tasks: Task[]; cursor: number } {
    const tasks = [...this.rows.values()]
      .filter((row) => row.seq > sinceSeq)
      .map((row) => row.task);
    return { tasks, cursor: this.counter };
  }
}

// One push-then-pull round against the fake Server — the same shape
// ../sync-engine.ts's sync() loop runs per iteration, simplified because
// this test never needs SYNC_BATCH_SIZE's paging (five Tasks, not
// thousands).
async function syncOnce(store: InMemoryTaskStore, server: FakeTaskServer): Promise<void> {
  const [pending, cursor] = await Promise.all([store.pending(), store.getCursor()]);
  server.push(pending);
  const { tasks: pulled, cursor: newCursor } = server.pull(cursor);
  if (pulled.length > 0) {
    await store.upsert(pulled);
  }
  if (newCursor > cursor) {
    await store.setCursor(newCursor);
  }
}

// Both stores start from this same five-Task, already-synced list — the
// common ancestor both Devices' offline drags diverge from.
async function seedConvergedList(
  storeA: InMemoryTaskStore,
  storeB: InMemoryTaskStore,
  server: FakeTaskServer,
): Promise<{ ids: string[]; keys: string[] }> {
  const k1 = orderKeyBetween(null, null);
  const k2 = orderKeyBetween(k1, null);
  const k3 = orderKeyBetween(k2, null);
  const k4 = orderKeyBetween(k3, null);
  const k5 = orderKeyBetween(k4, null);
  const keys = [k1, k2, k3, k4, k5];
  const ids = ["item-1", "item-2", "item-3", "item-4", "item-5"];
  const seeded = ids.map((id, i) =>
    task({ id, orderKey: keys[i] as string, seq: i + 1, content: id }),
  );

  await storeA.upsert(seeded);
  await storeB.upsert(seeded);
  server.push(seeded.map((t) => ({ ...t, seq: null })));
  await storeA.setCursor(seeded.length);
  await storeB.setCursor(seeded.length);

  return { ids, keys };
}

describe("Task order convergence (ADR 0050)", () => {
  it("two stores reordering different Tasks while both offline converge to the order both drags asked for", async () => {
    const storeA = new InMemoryTaskStore();
    const storeB = new InMemoryTaskStore();
    const server = new FakeTaskServer();
    const { keys } = await seedConvergedList(storeA, storeB, server);
    const [k1, , , k4, k5] = keys as [string, string, string, string, string];

    // Store A, offline, drags item-2 to between item-4 and item-5.
    const aTargetKey = orderKeyBetween(k4, k5);
    await storeA.reorder("item-2", aTargetKey);

    // Store B, offline, drags item-5 to the very front.
    const bTargetKey = orderKeyBetween(null, k1);
    await storeB.reorder("item-5", bTargetKey);

    // Only the dragged row is pending on each store — fractional
    // indexing's whole point: neither drag touched a sibling.
    expect((await storeA.pending()).map((t) => t.id)).toEqual(["item-2"]);
    expect((await storeB.pending()).map((t) => t.id)).toEqual(["item-5"]);

    // Both sync. Two rounds each: the first round pushes this Device's
    // own drag and pulls whatever the other Device had already pushed;
    // the second round is what actually observes the other Device's
    // drag if it hadn't landed on the server yet by the first round.
    await syncOnce(storeA, server);
    await syncOnce(storeB, server);
    await syncOnce(storeA, server);
    await syncOnce(storeB, server);

    const finalA = await storeA.list();
    const finalB = await storeB.list();

    // Converged: both Devices agree on one order.
    expect(finalA.map((t) => t.id)).toEqual(finalB.map((t) => t.id));

    // And it's the order both drags actually asked for, not merely
    // "something both agree on" — item-5 is first (Store B's drag),
    // item-2 sits between item-4 and item-3's original neighbours,
    // ending up last (Store A's drag), and item-1/item-3/item-4, which
    // neither Device touched, keep their original relative order.
    expect(finalA.map((t) => t.id)).toEqual(["item-5", "item-1", "item-3", "item-4", "item-2"]);

    // Checked structurally too, against the actual keys each drag
    // targeted — not just the id sequence, which a coincidentally
    // correct id order could satisfy without the underlying keys being
    // right.
    const byId = new Map(finalA.map((t) => [t.id, t]));
    expect(byId.get("item-5")?.orderKey).toBe(bTargetKey);
    expect(byId.get("item-2")?.orderKey).toBe(aTargetKey);
    expect(compareByOrder(byId.get("item-4") as Task, byId.get("item-2") as Task)).toBeLessThan(0);
    // Not a literal sibling comparison (item-5 moved away) — this just
    // confirms A's drag still sits below where the original k5 was,
    // i.e. at the tail, consistent with "between item-4 and item-5"
    // surviving even though item-5 itself relocated.
    expect(compareByOrder(byId.get("item-2") as Task, { orderKey: k5, id: "item-5" })).toBeLessThan(
      0,
    );
  });

  it("two stores dragging the SAME Task offline converge (both agree), but only one drag survives — last write wins", async () => {
    const storeA = new InMemoryTaskStore();
    const storeB = new InMemoryTaskStore();
    const server = new FakeTaskServer();
    const { keys } = await seedConvergedList(storeA, storeB, server);
    const [k1, , , k4, k5] = keys as [string, string, string, string, string];

    // Both Devices, independently and offline, drag the *same* Task
    // (item-3) to two different places.
    const aTargetKey = orderKeyBetween(k4, k5); // A: item-3 to the end
    const bTargetKey = orderKeyBetween(null, k1); // B: item-3 to the front
    await storeA.reorder("item-3", aTargetKey);
    await storeB.reorder("item-3", bTargetKey);

    // A syncs first, then B — B's push is the one that arrives on the
    // server last, so ADR 0028's last-write-wins-by-arrival makes B's
    // drag the one that survives.
    await syncOnce(storeA, server);
    await syncOnce(storeB, server);
    // A second round each so both Devices actually observe the other's
    // (or in A's case, its own overwritten) final state.
    await syncOnce(storeA, server);
    await syncOnce(storeB, server);

    const finalA = await storeA.list();
    const finalB = await storeB.list();

    // Converged: both Devices end up agreeing on the same order —
    expect(finalA.map((t) => t.id)).toEqual(finalB.map((t) => t.id));
    // — and it's specifically B's drag that won, not some third order
    // and not "both preserved" (which isn't a coherent outcome for one
    // Task with one orderKey). Asserting this honestly, rather than
    // only asserting "they agree," is the point: a merge that quietly
    // discarded A's edit is exactly last-write-wins working as designed
    // for a *single* contested Task, not a bug fractional indexing owes
    // a fix for — that guarantee is only about Tasks dragged
    // independently (the test above).
    const item3A = finalA.find((t) => t.id === "item-3");
    expect(item3A?.orderKey).toBe(bTargetKey);
    expect(item3A?.orderKey).not.toBe(aTargetKey);
  });
});

/**
 * The counterpart to the ordering-convergence test above, for a plain
 * content edit rather than a drag — issue #172 / ADR 0051's own
 * acceptance bar: "a Task edited on two stores while both are pending
 * converges to one value after both sync." Where the tests above exercise
 * `InMemoryTaskStore` directly against a hand-rolled `syncOnce` (there was
 * no real Task wire protocol yet when ADR 0050 landed — this file's own
 * header comment on `FakeTaskServer`), this exercises the real, now-wired
 * `sync()` (../sync-engine.ts) against a fake transport shaped exactly
 * like the real `/v1/sync` contract (`WireSyncResponse`) — proving the
 * actual mapping and upsert path this ticket built, not only the
 * store-level behaviour underneath it.
 */
// A tiny generic compacted change log — the identical shape every one of
// server/src/sync.rs's `insert_*`/`fetch_*_since` pairs implements (ADR
// 0028, reused unchanged for every stream added since): each push
// overwrites the current row for a given id wholesale and hands it a
// fresh, monotonically increasing seq. There is no per-field merge and no
// memory of the row it replaced, which is exactly what makes this
// last-write-wins-by-arrival rather than "cleverest edit wins."
class FakeStream<Row extends { id: string; seq: number }> {
  private readonly rows = new Map<string, { row: Row; seq: number }>();
  private seq = 0;

  // `pushed` is shaped like the wire's own *input* — every field `Row`
  // (the wire's *output* shape) has except `seq`, which this fake server
  // assigns itself, exactly as the real one does.
  push(pushed: Array<Omit<Row, "seq">>): void {
    for (const row of pushed) {
      this.seq += 1;
      this.rows.set(row.id, { row: { ...row, seq: this.seq } as Row, seq: this.seq });
    }
  }

  pull(sinceSeq: number): { rows: Row[]; cursor: number } {
    const rows = [...this.rows.values()].filter((r) => r.seq > sinceSeq).map((r) => r.row);
    const cursor = rows.reduce((max, r) => Math.max(max, r.seq), sinceSeq);
    return { rows, cursor };
  }
}

/**
 * A fake `/v1/sync` — every stream this ticket (issue #182) added, plus
 * the Task stream ADR 0051 already had, each its own `FakeStream` (its own
 * doc comment explains why that's a faithful model of `server/src/sync.rs`
 * rather than a simplification of it). Entries are never exercised here —
 * always empty, the Entry Cursor never advances — but a real
 * `WireSyncResponse` still has to answer every field regardless (ADR
 * 0051's "one endpoint, one round trip").
 */
class FakeSyncServer {
  private readonly tasks = new FakeStream<WireTaskOutput>();
  private readonly projects = new FakeStream<WireProjectOutput>();
  private readonly sections = new FakeStream<WireSectionOutput>();
  private readonly labels = new FakeStream<WireLabelOutput>();
  private readonly comments = new FakeStream<WireCommentOutput>();

  transport: SyncTransport = async (request) => {
    // Every one of these is optional on WireSyncRequest solely to tolerate
    // an older Device's request body, which genuinely has no such keys at
    // all (server/src/sync.rs's own SyncRequest doc comment) — this Device
    // always sends all of them, since it's this ticket's own real sync()
    // engine, but the wire type has to admit the older case regardless.
    // `day_order` is optional on WireTaskInput for the identical reason
    // (a Device on protocol 5 predates the field) — this Device's own
    // toWireTaskInput always sends a real one, so the `?? ""` below only
    // ever satisfies the type, never actually substitutes anything.
    this.tasks.push((request.tasks ?? []).map((t) => ({ ...t, day_order: t.day_order ?? "" })));
    this.projects.push(request.projects ?? []);
    this.sections.push(request.sections ?? []);
    this.labels.push(request.labels ?? []);
    this.comments.push(request.comments ?? []);

    const tasks = this.tasks.pull(request.since_task_seq ?? 0);
    const projects = this.projects.pull(request.since_project_seq ?? 0);
    const sections = this.sections.pull(request.since_section_seq ?? 0);
    const labels = this.labels.pull(request.since_label_seq ?? 0);
    const comments = this.comments.pull(request.since_comment_seq ?? 0);

    return {
      entries: [],
      cursor: request.since_seq,
      tasks: tasks.rows,
      task_cursor: tasks.cursor,
      projects: projects.rows,
      project_cursor: projects.cursor,
      sections: sections.rows,
      section_cursor: sections.cursor,
      labels: labels.rows,
      label_cursor: labels.cursor,
      comments: comments.rows,
      comment_cursor: comments.cursor,
    };
  };
}

// One Device's full set of stores plus a bound sync() call against a
// shared FakeSyncServer — every content-convergence test below (Task,
// Project, Section, Label, Comment) is the identical shape ("seed on A,
// pull on B, diverge offline, sync both, assert one value survives"), so
// this factory is what keeps the five tests from re-deriving that
// plumbing five times (issue #182: four more streams, the same proof
// repeated for each).
function createDevice(deviceId: string, server: FakeSyncServer) {
  const store = new InMemoryEntryStore();
  const taskStore = new InMemoryTaskStore();
  const projectStore = new InMemoryProjectStore(taskStore);
  const labelStore = new InMemoryLabelStore();
  const commentStore = new InMemoryCommentStore();
  return {
    store,
    taskStore,
    projectStore,
    labelStore,
    commentStore,
    sync: () =>
      sync({
        store,
        taskStore,
        projectStore,
        labelStore,
        commentStore,
        transport: server.transport,
        deviceId,
      }),
  };
}

describe("Task content convergence (issue #172 / ADR 0051)", () => {
  it("a Task renamed on two stores while both are pending converges to one value after both sync", async () => {
    const server = new FakeSyncServer();
    const deviceA = createDevice("device-a", server);
    const deviceB = createDevice("device-b", server);
    const taskId = "shared-task";

    // Seed: Device A creates the Task and syncs it up; Device B then pulls
    // that same, already-converged Task down — the common ancestor both
    // Devices' offline edits diverge from.
    await deviceA.taskStore.upsert([task({ id: taskId, content: "buy milk", seq: null })]);
    await deviceA.sync();
    await deviceB.sync();
    expect((await deviceB.taskStore.get(taskId))?.content).toBe("buy milk");

    // Both Devices, independently and offline, rename the *same* Task to
    // two different things.
    await deviceA.taskStore.rename(taskId, "buy milk and eggs");
    await deviceB.taskStore.rename(taskId, "buy oat milk");

    // Fractional-index reasoning doesn't apply to a content edit — there
    // is exactly one `content` column, so this is a genuine collision on
    // one field, not two independent writes the way reordering two
    // different Tasks is. Both renames are pending until synced.
    expect((await deviceA.taskStore.pending()).map((t) => t.id)).toEqual([taskId]);
    expect((await deviceB.taskStore.pending()).map((t) => t.id)).toEqual([taskId]);

    // A syncs first, then B — B's push is the one that arrives at the
    // server last, so ADR 0028's last-write-wins-by-arrival (reused for
    // Tasks by ADR 0047, not reinvented) makes B's rename the one that
    // survives. A second round each so both Devices actually observe the
    // final, converged state — mirrors this file's own ordering-
    // convergence tests above.
    await deviceA.sync();
    await deviceB.sync();
    await deviceA.sync();
    await deviceB.sync();

    const finalA = await deviceA.taskStore.get(taskId);
    const finalB = await deviceB.taskStore.get(taskId);

    // Converged: both Devices agree —
    expect(finalA?.content).toBe(finalB?.content);
    // — and it's specifically B's rename that won, not some third value
    // and not "both preserved" (which isn't coherent for one Task with one
    // `content` column). A merge that silently discarded A's edit is
    // exactly last-write-wins working as designed for a genuinely
    // contested field, not a bug this ticket owes a fix for.
    expect(finalA?.content).toBe("buy oat milk");
    expect(finalA?.content).not.toBe("buy milk and eggs");
  });
});

// Issue #182: `dayOrder` reached the wire in the same bump as the four new
// streams below — the identical last-write-wins-by-arrival proof the
// `content` test above gives for a Task's one-column-one-value field,
// applied to Today's own manual order instead. This is deliberately a
// content-convergence test, not another fractional-index-collision test
// like this file's own "Task order convergence" describe block above:
// two Devices dragging the *same* Task in Today, offline, both compute a
// real `dayOrder` value each, and there is exactly one column for the
// Server to arbitrate between them, the same shape a rename collision
// already has — not the "two different Tasks, two disjoint rows" shape
// the fractional-index tests exist to prove converges *without* a
// collision at all.
describe("Task dayOrder convergence (issue #182)", () => {
  it("a Task dragged in Today on two stores while both are pending converges to one dayOrder after both sync", async () => {
    const server = new FakeSyncServer();
    const deviceA = createDevice("device-a", server);
    const deviceB = createDevice("device-b", server);
    const taskId = "shared-task";

    await deviceA.taskStore.upsert([task({ id: taskId, content: "buy milk", seq: null })]);
    await deviceA.sync();
    await deviceB.sync();
    expect((await deviceB.taskStore.get(taskId))?.dayOrder).toBe(
      (await deviceA.taskStore.get(taskId))?.dayOrder,
    );

    // Both Devices, independently and offline, drag the *same* Task to
    // two different positions in their own Today.
    await deviceA.taskStore.reorderToday(taskId, "device-a-position");
    await deviceB.taskStore.reorderToday(taskId, "device-b-position");

    await deviceA.sync();
    await deviceB.sync();
    await deviceA.sync();
    await deviceB.sync();

    const finalA = await deviceA.taskStore.get(taskId);
    const finalB = await deviceB.taskStore.get(taskId);

    // Converged, and it's specifically B's drag that won — the same
    // last-write-wins-by-arrival outcome the `content` test above proves,
    // over `dayOrder` instead. `orderKey` is untouched throughout: neither
    // Device ever called reorder(), only reorderToday().
    expect(finalA?.dayOrder).toBe(finalB?.dayOrder);
    expect(finalA?.dayOrder).toBe("device-b-position");
    expect(finalA?.dayOrder).not.toBe("device-a-position");
    expect(finalA?.orderKey).toBe(finalB?.orderKey);
  });
});

// Issue #182: the identical proof, once per new stream — a Project, a
// Section, a Label and a Comment each converge under the same
// last-write-wins-by-arrival rule the Task test above already proves,
// because `insert_projects`/`insert_sections`/`insert_labels`/
// `insert_comments` (server/src/sync.rs) each reuse ADR 0028's rule
// unchanged rather than reinventing it (this file's own header comment on
// `FakeStream`).
describe("Project content convergence (issue #182)", () => {
  it("a Project renamed on two stores while both are pending converges to one value after both sync", async () => {
    const server = new FakeSyncServer();
    const deviceA = createDevice("device-a", server);
    const deviceB = createDevice("device-b", server);
    const projectId = "shared-project";

    await deviceA.projectStore.upsertProjects([
      project({ id: projectId, name: "Errands", seq: null }),
    ]);
    await deviceA.sync();
    await deviceB.sync();
    expect((await deviceB.projectStore.getProject(projectId))?.name).toBe("Errands");

    await deviceA.projectStore.renameProject(projectId, "Errands and chores");
    await deviceB.projectStore.renameProject(projectId, "Weekend errands");

    await deviceA.sync();
    await deviceB.sync();
    await deviceA.sync();
    await deviceB.sync();

    const finalA = await deviceA.projectStore.getProject(projectId);
    const finalB = await deviceB.projectStore.getProject(projectId);
    expect(finalA?.name).toBe(finalB?.name);
    expect(finalA?.name).toBe("Weekend errands");
  });
});

describe("Section content convergence (issue #182)", () => {
  it("a Section renamed on two stores while both are pending converges to one value after both sync", async () => {
    const server = new FakeSyncServer();
    const deviceA = createDevice("device-a", server);
    const deviceB = createDevice("device-b", server);
    const sectionId = "shared-section";

    // A Section needs a live Project on each Device to be reachable from
    // — addSection() itself refuses one that doesn't (ProjectStore's own
    // doc comment), but the direct upsertSections() Sync path this test
    // exercises does not, mirroring server/src/sync.rs's own unvalidated
    // `project_id` (SectionInput's own doc comment). Seeding the Project
    // on both Devices keeps this test about convergence, not about that
    // separate, already-covered dangling-reference behaviour.
    await deviceA.projectStore.upsertProjects([project({ id: "project-1", seq: null })]);
    await deviceB.projectStore.upsertProjects([project({ id: "project-1", seq: null })]);
    await deviceA.projectStore.upsertSections([
      section({ id: sectionId, projectId: "project-1", name: "Groceries", seq: null }),
    ]);
    await deviceA.sync();
    await deviceB.sync();
    expect((await deviceB.projectStore.getSection(sectionId))?.name).toBe("Groceries");

    await deviceA.projectStore.renameSection(sectionId, "Weekly groceries");
    await deviceB.projectStore.renameSection(sectionId, "Grocery list");

    await deviceA.sync();
    await deviceB.sync();
    await deviceA.sync();
    await deviceB.sync();

    const finalA = await deviceA.projectStore.getSection(sectionId);
    const finalB = await deviceB.projectStore.getSection(sectionId);
    expect(finalA?.name).toBe(finalB?.name);
    expect(finalA?.name).toBe("Grocery list");
  });
});

describe("Label content convergence (issue #182)", () => {
  it("a Label renamed on two stores while both are pending converges to one value after both sync", async () => {
    const server = new FakeSyncServer();
    const deviceA = createDevice("device-a", server);
    const deviceB = createDevice("device-b", server);
    const labelId = "shared-label";

    await deviceA.labelStore.upsert([label({ id: labelId, name: "errand", seq: null })]);
    await deviceA.sync();
    await deviceB.sync();
    expect((await deviceB.labelStore.get(labelId))?.name).toBe("errand");

    await deviceA.labelStore.rename(labelId, "chore");
    await deviceB.labelStore.rename(labelId, "weekend");

    await deviceA.sync();
    await deviceB.sync();
    await deviceA.sync();
    await deviceB.sync();

    const finalA = await deviceA.labelStore.get(labelId);
    const finalB = await deviceB.labelStore.get(labelId);
    expect(finalA?.name).toBe(finalB?.name);
    expect(finalA?.name).toBe("weekend");
  });
});

describe("Comment content convergence (issue #182)", () => {
  it("a Comment edited on two stores while both are pending converges to one value after both sync", async () => {
    const server = new FakeSyncServer();
    const deviceA = createDevice("device-a", server);
    const deviceB = createDevice("device-b", server);
    const commentId = "shared-comment";

    await deviceA.commentStore.upsert([comment({ id: commentId, text: "sounds good", seq: null })]);
    await deviceA.sync();
    await deviceB.sync();
    expect((await deviceB.commentStore.get(commentId))?.text).toBe("sounds good");

    await deviceA.commentStore.edit(commentId, "sounds good, I'll bring snacks");
    await deviceB.commentStore.edit(commentId, "sounds good, see you then");

    await deviceA.sync();
    await deviceB.sync();
    await deviceA.sync();
    await deviceB.sync();

    const finalA = await deviceA.commentStore.get(commentId);
    const finalB = await deviceB.commentStore.get(commentId);
    expect(finalA?.text).toBe(finalB?.text);
    expect(finalA?.text).toBe("sounds good, see you then");
  });
});

describe("what integer positions would have done (contrast, not this ticket's design)", () => {
  // Recomputes every Task's 0-based index after moving `movedId` to
  // `toIndex` — the naive, obvious integer-position scheme ADR 0050
  // rejected. Stands in for the "rewrite every sibling below the
  // insertion point" cost ../order-key.ts's header comment describes:
  // moving one Task here touches as many rows as shifted position.
  function positionsAfterMove(
    order: string[],
    movedId: string,
    toIndex: number,
  ): Map<string, number> {
    const withoutMoved = order.filter((id) => id !== movedId);
    const next = [...withoutMoved.slice(0, toIndex), movedId, ...withoutMoved.slice(toIndex)];
    return new Map(next.map((id, index) => [id, index]));
  }

  it("two Devices dragging different Tasks under integer positions can corrupt into a merge neither Device chose", () => {
    const original = ["item-1", "item-2", "item-3", "item-4", "item-5"];
    const originalPositions = new Map(original.map((id, index) => [id, index]));

    // Device A: drag item-2 to index 3 -> intends [1,3,4,2,5].
    const aPositions = positionsAfterMove(original, "item-2", 3);
    // Device B: drag item-5 to index 0 -> intends [5,1,2,3,4].
    const bPositions = positionsAfterMove(original, "item-5", 0);

    // Each Device only *writes* the rows whose position actually
    // changed from the original — a real diff-based sync wouldn't push
    // a no-op row.
    const aWrites = [...aPositions].filter(([id, pos]) => originalPositions.get(id) !== pos);
    const bWrites = [...bPositions].filter(([id, pos]) => originalPositions.get(id) !== pos);

    // Nothing here is transactional across rows (../sqlite/migrator.ts
    // has no transactions, and two Devices' pushes have no ordering
    // guarantee relative to each other at the row level) — so the
    // server can apply these writes in any interleaving, not
    // necessarily "every one of A's rows, then every one of B's." This
    // is one such interleaving: B's writes to item-4 and item-1 land,
    // then A's write to item-3 lands *after* B's write to item-1 — a
    // perfectly plausible arrival order once two Devices' pushes aren't
    // grouped atomically.
    const interleaving: Array<["A" | "B", string, number]> = [
      ["B", "item-5", bPositions.get("item-5") as number],
      ["B", "item-4", bPositions.get("item-4") as number],
      ["B", "item-1", bPositions.get("item-1") as number],
      ["A", "item-2", aPositions.get("item-2") as number],
      ["A", "item-3", aPositions.get("item-3") as number],
      ["B", "item-3", bPositions.get("item-3") as number],
    ].filter(([device, id]) =>
      (device === "A" ? aWrites : bWrites).some(([writtenId]) => writtenId === id),
    ) as Array<["A" | "B", string, number]>;

    const merged = new Map(originalPositions);
    for (const [, id, position] of interleaving) {
      merged.set(id, position);
    }

    // The interleaving above left two different Tasks (item-2 and
    // item-3) claiming the identical integer position — a merge that
    // ADR 0050's fractional scheme can't produce (two rows can share an
    // orderKey too, in principle, but nothing about a normal drag ever
    // asks for that; here it's the *direct, structural* result of two
    // Devices' index-based rewrites colliding).
    const positionCounts = new Map<number, number>();
    for (const position of merged.values()) {
      positionCounts.set(position, (positionCounts.get(position) ?? 0) + 1);
    }
    const hasCollision = [...positionCounts.values()].some((count) => count > 1);
    expect(hasCollision).toBe(true);

    // A position collision means "sort by position" has no single
    // answer — the tie-break is undefined, so two equally reasonable
    // ways of breaking it (id ascending vs id descending) can legally
    // disagree, and disagreeing means at most one of them can match
    // either Device's actual intent. That's the concrete shape of "an
    // order neither Device chose": not that the merge is random, but
    // that which order comes out depends on a tie-break rule nothing
    // about either Device's drag ever specified.
    const sortAscendingId = (a: [string, number], b: [string, number]) =>
      a[1] - b[1] || (a[0] < b[0] ? -1 : 1);
    const sortDescendingId = (a: [string, number], b: [string, number]) =>
      a[1] - b[1] || (a[0] > b[0] ? -1 : 1);
    const mergedAscTieBreak = [...merged.entries()].sort(sortAscendingId).map(([id]) => id);
    const mergedDescTieBreak = [...merged.entries()].sort(sortDescendingId).map(([id]) => id);
    expect(mergedAscTieBreak).not.toEqual(mergedDescTieBreak);

    // And concretely: the descending tie-break's answer matches neither
    // Device's actual intended order (the ascending tie-break happens,
    // in this particular interleaving, to coincide with Store B's order
    // on item-2/item-3 — which is exactly the trap: a merge that *looks*
    // fine under one arbitrary tie-break is still built on a genuine
    // collision, not on either Device's request).
    const aIntendedOrder = [...aPositions.entries()].sort((x, y) => x[1] - y[1]).map(([id]) => id);
    const bIntendedOrder = [...bPositions.entries()].sort((x, y) => x[1] - y[1]).map(([id]) => id);
    expect(mergedDescTieBreak).not.toEqual(aIntendedOrder);
    expect(mergedDescTieBreak).not.toEqual(bIntendedOrder);
  });
});
