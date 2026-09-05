import type { Entry, EntryStore } from "@meologue/core";
import { describe, expect, it, vi } from "vitest";
import { formatTaskReference } from "./inline-markdown";
import {
  findEntriesReferencingTask,
  syncTaskReferenceChecked,
  syncTaskReferenceLabel,
} from "./task-reference-sync";

const TASK_ID = "0192abcd-1234-7890-abcd-0123456789ac";
const OTHER_TASK_ID = "0192abcd-1234-7890-abcd-0123456789ad";

function entry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: "e1",
    deviceId: "device-a",
    body: "hello",
    // Issue #196: updatedAt starts equal to createdAt
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    seq: 1,
    syncedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

/**
 * A minimal fake, matching `day-referrers.test.ts`'s own shape for
 * `search`: a plain substring match, which over-matches exactly the way
 * the real FTS5 index does (`day-referrers.ts`'s own module comment) — the
 * confirm-by-parse step is what these tests actually prove, not the search
 * step, since the real tokenizer's behaviour is covered by
 * `sqlite-entry-store.test.ts` in packages/core.
 */
function createFakeStore(initial: readonly Entry[]): Pick<EntryStore, "search" | "edit"> & {
  entries: () => Entry[];
} {
  let entries = [...initial];
  return {
    search: vi.fn(async (query: string) => entries.filter((e) => e.body.includes(query))),
    edit: vi.fn(async (id: string, body: string) => {
      entries = entries.map((e) => (e.id === id ? { ...e, body } : e));
    }),
    entries: () => entries,
  };
}

describe("findEntriesReferencingTask", () => {
  it("finds an Entry carrying a real Reference to the Task", async () => {
    const referencing = entry({
      id: "e1",
      body: `- [ ] ${formatTaskReference(TASK_ID, "buy milk")}`,
    });
    const store = createFakeStore([referencing]);

    const found = await findEntriesReferencingTask(store, TASK_ID);

    expect(found.map((e) => e.id)).toEqual(["e1"]);
  });

  it("does not confuse a Reference to a DIFFERENT Task for one to this Task", async () => {
    const other = entry({
      id: "e1",
      body: `- [ ] ${formatTaskReference(OTHER_TASK_ID, "buy milk")}`,
    });
    const store = createFakeStore([other]);

    const found = await findEntriesReferencingTask(store, TASK_ID);

    expect(found).toEqual([]);
  });

  // The real FTS5 index's own over-matching (day-referrers.ts's own
  // module comment: "step 1 over-matches ... step 2 confirms by parsing")
  // — an Entry that merely mentions the Task's own id as incidental text,
  // with no real `[[task:...]]` mark at all, must not be reported as a
  // referrer.
  it("excludes an Entry that merely contains the Task's id as incidental text, not a real Reference", async () => {
    const incidental = entry({
      id: "e1",
      body: `mentioned the id ${TASK_ID} in passing, no brackets`,
    });
    const store = createFakeStore([incidental]);

    const found = await findEntriesReferencingTask(store, TASK_ID);

    expect(found).toEqual([]);
  });

  it("finds a Reference nested several lists deep", async () => {
    const nested = entry({
      id: "e1",
      body: `- outer\n  - [ ] ${formatTaskReference(TASK_ID, "buy milk")}`,
    });
    const store = createFakeStore([nested]);

    const found = await findEntriesReferencingTask(store, TASK_ID);

    expect(found.map((e) => e.id)).toEqual(["e1"]);
  });
});

describe("syncTaskReferenceLabel", () => {
  it("rewrites the cached label in every Entry referencing the Task", async () => {
    const referencing = entry({
      id: "e1",
      body: `- [ ] ${formatTaskReference(TASK_ID, "old label")}`,
    });
    const store = createFakeStore([referencing]);

    await syncTaskReferenceLabel(store, TASK_ID, "new label");

    expect(store.edit).toHaveBeenCalledWith(
      "e1",
      `- [ ] ${formatTaskReference(TASK_ID, "new label")}`,
    );
  });

  it("touches only the Entries that actually reference the Task", async () => {
    const referencing = entry({ id: "e1", body: `- [ ] ${formatTaskReference(TASK_ID, "old")}` });
    const unrelated = entry({ id: "e2", body: "an ordinary Entry about something else" });
    const store = createFakeStore([referencing, unrelated]);

    await syncTaskReferenceLabel(store, TASK_ID, "new");

    expect(store.edit).toHaveBeenCalledTimes(1);
    expect(store.edit).toHaveBeenCalledWith("e1", expect.any(String));
  });

  it("is a no-op — no store.edit call at all — when nothing references the Task", async () => {
    const store = createFakeStore([entry({ id: "e1", body: "nothing to see here" })]);

    await syncTaskReferenceLabel(store, TASK_ID, "new label");

    expect(store.edit).not.toHaveBeenCalled();
  });

  it("refreshes every Reference to the Task in one Entry, if there is more than one", async () => {
    const referencing = entry({
      id: "e1",
      body: `- [ ] ${formatTaskReference(TASK_ID, "old")}\n- [ ] a second mention: ${formatTaskReference(TASK_ID, "old")}`,
    });
    const store = createFakeStore([referencing]);

    await syncTaskReferenceLabel(store, TASK_ID, "new");

    expect(store.edit).toHaveBeenCalledWith(
      "e1",
      `- [ ] ${formatTaskReference(TASK_ID, "new")}\n- [ ] a second mention: ${formatTaskReference(TASK_ID, "new")}`,
    );
  });
});

describe("syncTaskReferenceChecked", () => {
  it("ticks the cached marker in every Entry referencing the Task", async () => {
    const referencing = entry({
      id: "e1",
      body: `- [ ] ${formatTaskReference(TASK_ID, "buy milk")}`,
    });
    const store = createFakeStore([referencing]);

    await syncTaskReferenceChecked(store, TASK_ID, true);

    expect(store.edit).toHaveBeenCalledWith(
      "e1",
      `- [x] ${formatTaskReference(TASK_ID, "buy milk")}`,
    );
  });

  it("unticks the cached marker in every Entry referencing the Task", async () => {
    const referencing = entry({
      id: "e1",
      body: `- [x] ${formatTaskReference(TASK_ID, "buy milk")}`,
    });
    const store = createFakeStore([referencing]);

    await syncTaskReferenceChecked(store, TASK_ID, false);

    expect(store.edit).toHaveBeenCalledWith(
      "e1",
      `- [ ] ${formatTaskReference(TASK_ID, "buy milk")}`,
    );
  });

  it("is a no-op when the marker already matches the requested state", async () => {
    const referencing = entry({
      id: "e1",
      body: `- [x] ${formatTaskReference(TASK_ID, "buy milk")}`,
    });
    const store = createFakeStore([referencing]);

    await syncTaskReferenceChecked(store, TASK_ID, true);

    expect(store.edit).not.toHaveBeenCalled();
  });

  it("does not touch a DIFFERENT Task's own marker in the same Entry", async () => {
    const referencing = entry({
      id: "e1",
      body: `- [ ] ${formatTaskReference(TASK_ID, "buy milk")}\n- [ ] ${formatTaskReference(OTHER_TASK_ID, "walk dog")}`,
    });
    const store = createFakeStore([referencing]);

    await syncTaskReferenceChecked(store, TASK_ID, true);

    expect(store.edit).toHaveBeenCalledWith(
      "e1",
      `- [x] ${formatTaskReference(TASK_ID, "buy milk")}\n- [ ] ${formatTaskReference(OTHER_TASK_ID, "walk dog")}`,
    );
  });
});
