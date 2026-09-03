import type { Entry, EntryStore, Task, TaskStore } from "@meologue/core";
import { englishQuickAddLanguage } from "@meologue/core";
import { describe, expect, it } from "vitest";
import { backfillTasksFromHistory, isLowConfidenceBackfillToken } from "./backfill-tasks";
import { formatTaskReference } from "./inline-markdown";

/**
 * A deterministic `mintId`, uuid-shaped rather than promote-tasks.test.ts's
 * own plain "task-1" — unlike that suite, which only ever calls
 * `promoteBareCheckboxes` once per test, this one re-parses a rewritten
 * body on a second backfill pass to prove idempotence, and `TASK_SHAPE`
 * (inline-markdown.ts) only recognises a fixed-length hex uuid as a task
 * Reference at all; a plain string like "task-1" would degrade to
 * unresolved plain text on the very re-parse this suite means to exercise,
 * defeating the loop guard for a reason that has nothing to do with
 * whether the guard actually works.
 */
function sequentialMintId() {
  let count = 0;
  return () => {
    count += 1;
    return `00000000-0000-4000-8000-${String(count).padStart(12, "0")}`;
  };
}

/** The id `sequentialMintId()` hands out on its first call, spelled out for assertions. */
const FIRST_ID = "00000000-0000-4000-8000-000000000001";

function entry(overrides: Partial<Entry>): Entry {
  return {
    id: "1",
    deviceId: "device-a",
    body: "hello",
    createdAt: "2026-01-01T10:00:00.000Z",
    seq: 1,
    syncedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

/**
 * `list()` returns whatever order the test hands it (this suite always
 * builds fixtures already newest-first, matching `EntryStore.list()`'s own
 * real contract) — a fake, not `InMemoryEntryStore`, because
 * `backfillTasksFromHistory` only ever calls `list`/`edit`
 * (`BackfillTasksOptions.store`'s own `Pick<...>` type), and use-history.
 * test.tsx's own `createFakeStore` establishes this is the convention
 * apps/web tests already use for a store double rather than reaching for
 * a real implementation.
 */
function fakeEntryStore(seed: Entry[]): Pick<EntryStore, "list" | "edit"> & { entries: Entry[] } {
  const entries = [...seed];
  return {
    entries,
    list: async () => [...entries],
    edit: async (id: string, body: string) => {
      const index = entries.findIndex((e) => e.id === id);
      if (index !== -1) {
        // biome-ignore lint/style/noNonNullAssertion: index checked above
        entries[index] = { ...entries[index]!, body };
      }
    },
  };
}

function fakeTaskStore(): Pick<TaskStore, "list" | "upsert"> & { active: Task[] } {
  const active: Task[] = [];
  return {
    active,
    list: async () => [...active],
    upsert: async (incoming: Task[]) => {
      active.push(...incoming);
    },
  };
}

describe("isLowConfidenceBackfillToken", () => {
  it("refuses a bare recurrence word", () => {
    expect(
      isLowConfidenceBackfillToken(
        { kind: "recurrence", start: 0, end: 7, raw: "monthly" },
        englishQuickAddLanguage,
      ),
    ).toBe(true);
  });

  it("refuses a bare weekday used as a noun, but not a modified one", () => {
    expect(
      isLowConfidenceBackfillToken(
        { kind: "date", start: 0, end: 6, raw: "monday", date: "2026-01-05" },
        englishQuickAddLanguage,
      ),
    ).toBe(true);
    expect(
      isLowConfidenceBackfillToken(
        { kind: "date", start: 0, end: 11, raw: "next monday", date: "2026-01-05" },
        englishQuickAddLanguage,
      ),
    ).toBe(false);
  });

  it("refuses a bare fuzzy time word, but not an explicit clock time", () => {
    expect(
      isLowConfidenceBackfillToken(
        { kind: "time", start: 0, end: 7, raw: "evening", time: "18:00" },
        englishQuickAddLanguage,
      ),
    ).toBe(true);
    expect(
      isLowConfidenceBackfillToken(
        { kind: "time", start: 0, end: 3, raw: "5pm", time: "17:00" },
        englishQuickAddLanguage,
      ),
    ).toBe(false);
  });

  it("trusts an explicit date and an unambiguous relative one", () => {
    expect(
      isLowConfidenceBackfillToken(
        { kind: "date", start: 0, end: 6, raw: "27 Jan", date: "2026-01-27" },
        englishQuickAddLanguage,
      ),
    ).toBe(false);
    expect(
      isLowConfidenceBackfillToken(
        { kind: "date", start: 0, end: 8, raw: "tomorrow", date: "2026-01-02" },
        englishQuickAddLanguage,
      ),
    ).toBe(false);
  });
});

describe("backfillTasksFromHistory", () => {
  it("promotes a bare checkbox and rewrites the Entry's body to carry a Reference", async () => {
    const store = fakeEntryStore([entry({ id: "1", body: "- [ ] buy milk" })]);
    const taskStore = fakeTaskStore();

    const report = await backfillTasksFromHistory({
      store,
      taskStore,
      deviceId: "device-a",
      mintId: sequentialMintId(),
      offsetMinutes: 0,
    });

    expect(report).toEqual({ tasksCreated: 1, tasksDated: 0 });
    expect(taskStore.active).toHaveLength(1);
    expect(taskStore.active[0]).toMatchObject({ id: FIRST_ID, content: "buy milk" });
    expect(store.entries[0]?.body).toBe(`- [ ] ${formatTaskReference(FIRST_ID, "buy milk")}`);
  });

  it("promotes a ticked checkbox into a completed Task, dated the Entry's own capture instant", async () => {
    const store = fakeEntryStore([
      entry({ id: "1", body: "- [x] already done", createdAt: "2026-03-04T09:30:00.000Z" }),
    ]);
    const taskStore = fakeTaskStore();

    await backfillTasksFromHistory({
      store,
      taskStore,
      deviceId: "device-a",
      mintId: sequentialMintId(),
      offsetMinutes: 0,
    });

    expect(taskStore.active[0]?.completedAt).toBe("2026-03-04T09:30:00.000Z");
  });

  it("takes the Entry's own capture date when nothing in the line parses", async () => {
    const store = fakeEntryStore([
      entry({
        id: "1",
        body: "- [ ] think about this later",
        createdAt: "2024-05-06T12:00:00.000Z",
      }),
    ]);
    const taskStore = fakeTaskStore();

    const report = await backfillTasksFromHistory({
      store,
      taskStore,
      deviceId: "device-a",
      mintId: sequentialMintId(),
      offsetMinutes: 0,
    });

    expect(report.tasksDated).toBe(0);
    expect(taskStore.active[0]?.date).toBe("2024-05-06");
  });

  it("resolves a relative date against the Entry's own capture day, never against wall-clock now", async () => {
    const store = fakeEntryStore([
      entry({ id: "1", body: "- [ ] call mom tomorrow", createdAt: "2020-06-15T08:00:00.000Z" }),
    ]);
    const taskStore = fakeTaskStore();

    const report = await backfillTasksFromHistory({
      store,
      taskStore,
      deviceId: "device-a",
      mintId: sequentialMintId(),
      offsetMinutes: 0,
    });

    expect(report.tasksDated).toBe(1);
    expect(taskStore.active[0]?.date).toBe("2020-06-16");
    expect(taskStore.active[0]?.content).toBe("call mom");
  });

  it("refuses a bare weekday used as a noun — the Task takes the capture date, and the word survives as plain text", async () => {
    const store = fakeEntryStore([
      entry({
        id: "1",
        body: "- [ ] Monday's meeting notes are still in my head",
        createdAt: "2024-05-06T12:00:00.000Z",
      }),
    ]);
    const taskStore = fakeTaskStore();

    const report = await backfillTasksFromHistory({
      store,
      taskStore,
      deviceId: "device-a",
      mintId: sequentialMintId(),
      offsetMinutes: 0,
    });

    expect(report.tasksDated).toBe(0);
    expect(taskStore.active[0]?.date).toBe("2024-05-06");
    expect(taskStore.active[0]?.content).toBe("Monday's meeting notes are still in my head");
  });

  it("refuses a bare recurrence word — Todoist's own documented false positive, refused here identically", async () => {
    const store = fakeEntryStore([
      entry({
        id: "1",
        body: "- [ ] Create monthly report",
        createdAt: "2024-05-06T12:00:00.000Z",
      }),
    ]);
    const taskStore = fakeTaskStore();

    const report = await backfillTasksFromHistory({
      store,
      taskStore,
      deviceId: "device-a",
      mintId: sequentialMintId(),
      offsetMinutes: 0,
    });

    expect(report.tasksDated).toBe(0);
    expect(taskStore.active[0]?.dateString).toBeNull();
    expect(taskStore.active[0]?.content).toBe("Create monthly report");
  });

  it("trusts a modified weekday — 'next monday' is not the noun the bare-weekday refusal exists for", async () => {
    const store = fakeEntryStore([
      // 2024-05-06 is itself a Monday; "next monday" should land a week later.
      entry({
        id: "1",
        body: "- [ ] renew the gym pass next monday",
        createdAt: "2024-05-06T12:00:00.000Z",
      }),
    ]);
    const taskStore = fakeTaskStore();

    const report = await backfillTasksFromHistory({
      store,
      taskStore,
      deviceId: "device-a",
      mintId: sequentialMintId(),
      offsetMinutes: 0,
    });

    expect(report.tasksDated).toBe(1);
    expect(taskStore.active[0]?.date).toBe("2024-05-13");
  });

  it("trusts an explicit calendar date", async () => {
    const store = fakeEntryStore([
      entry({
        id: "1",
        body: "- [ ] renew passport 27 Jan 2025",
        createdAt: "2024-05-06T12:00:00.000Z",
      }),
    ]);
    const taskStore = fakeTaskStore();

    const report = await backfillTasksFromHistory({
      store,
      taskStore,
      deviceId: "device-a",
      mintId: sequentialMintId(),
      offsetMinutes: 0,
    });

    expect(report.tasksDated).toBe(1);
    expect(taskStore.active[0]?.date).toBe("2025-01-27");
  });

  it("skips a line that already carries a Reference — the loop guard promote-tasks.ts already relies on", async () => {
    // A real uuid shape, not a plain string like "existing-task" — TASK_SHAPE
    // (inline-markdown.ts) only recognises a fixed-length hex uuid as a
    // task Reference at all; anything else degrades to plain text under
    // ADR 0042's own "unresolvable is plain text" rule, which is a
    // different (and, for this test, wrong) thing to be pinning down.
    const existingTaskId = "11111111-1111-4111-8111-111111111111";
    const store = fakeEntryStore([
      entry({ id: "1", body: `- [ ] ${formatTaskReference(existingTaskId, "already promoted")}` }),
    ]);
    const taskStore = fakeTaskStore();

    const report = await backfillTasksFromHistory({
      store,
      taskStore,
      deviceId: "device-a",
      mintId: sequentialMintId(),
      offsetMinutes: 0,
    });

    expect(report).toEqual({ tasksCreated: 0, tasksDated: 0 });
    expect(taskStore.active).toHaveLength(0);
  });

  it("is idempotent — re-running over already-promoted Entries does no further work", async () => {
    const store = fakeEntryStore([
      entry({ id: "1", body: "- [ ] buy milk" }),
      entry({ id: "2", body: "- [x] done already" }),
    ]);
    const taskStore = fakeTaskStore();

    const first = await backfillTasksFromHistory({
      store,
      taskStore,
      deviceId: "device-a",
      mintId: sequentialMintId(),
      offsetMinutes: 0,
    });
    expect(first.tasksCreated).toBe(2);

    const second = await backfillTasksFromHistory({
      store,
      taskStore,
      deviceId: "device-a",
      mintId: sequentialMintId(),
      offsetMinutes: 0,
    });

    expect(second).toEqual({ tasksCreated: 0, tasksDated: 0 });
    expect(taskStore.active).toHaveLength(2);
  });

  it("promotes multiple checkboxes across multiple Entries in oldest-first order, so the oldest writing lands first in Inbox", async () => {
    const store = fakeEntryStore([
      // list() returns newest-first, as the real store does.
      entry({ id: "newer", body: "- [ ] second thing", createdAt: "2026-02-01T00:00:00.000Z" }),
      entry({ id: "older", body: "- [ ] first thing", createdAt: "2026-01-01T00:00:00.000Z" }),
    ]);
    const taskStore = fakeTaskStore();

    await backfillTasksFromHistory({
      store,
      taskStore,
      deviceId: "device-a",
      mintId: sequentialMintId(),
      offsetMinutes: 0,
    });

    expect(taskStore.active.map((t) => t.content)).toEqual(["first thing", "second thing"]);
    // biome-ignore lint/style/noNonNullAssertion: both rows exist, asserted above
    expect(taskStore.active[0]!.orderKey < taskStore.active[1]!.orderKey).toBe(true);
  });

  it("mints Tasks continuing after whatever order Tasks already exist, rather than colliding with them", async () => {
    const store = fakeEntryStore([entry({ id: "1", body: "- [ ] buy milk" })]);
    const taskStore = fakeTaskStore();
    taskStore.active.push({
      id: "existing",
      deviceId: "device-a",
      content: "already in Todo",
      completedAt: null,
      orderKey: "V",
      createdAt: "2026-01-01T00:00:00.000Z",
      seq: null,
      syncedAt: null,
      deletedAt: null,
      date: null,
      deadline: null,
      priority: 1,
      labelIds: [],
      dateString: null,
      projectId: null,
      sectionId: null,
      parentId: null,
      description: null,
    });

    await backfillTasksFromHistory({
      store,
      taskStore,
      deviceId: "device-a",
      mintId: sequentialMintId(),
      offsetMinutes: 0,
    });

    const minted = taskStore.active.find((t) => t.id === FIRST_ID);
    expect(minted).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: presence asserted above
    expect("V" < minted!.orderKey).toBe(true);
  });

  it("leaves an Entry with no checkbox at all completely untouched", async () => {
    const store = fakeEntryStore([entry({ id: "1", body: "just a plain thought, no list here" })]);
    const taskStore = fakeTaskStore();

    const report = await backfillTasksFromHistory({
      store,
      taskStore,
      deviceId: "device-a",
      mintId: sequentialMintId(),
      offsetMinutes: 0,
    });

    expect(report).toEqual({ tasksCreated: 0, tasksDated: 0 });
    expect(store.entries[0]?.body).toBe("just a plain thought, no list here");
  });
});
