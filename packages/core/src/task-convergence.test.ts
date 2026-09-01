import { describe, expect, it } from "vitest";
import { compareByOrder, orderKeyBetween } from "./order-key";
import type { Task } from "./task-types";
import { InMemoryTaskStore } from "./test-support/in-memory-task-store";
import { task } from "./test-support/task-fixture";

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
