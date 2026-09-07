import type {
  CommentStore,
  Entry,
  EntryStore,
  EventStore,
  LabelStore,
  ProjectStore,
  TaskStore,
} from "@meologue/core";
import { BODY_SOFT_BREAK_CUTOFF } from "@meologue/core";
import { describe, expect, it } from "vitest";
import { entryDocumentToMarkdown } from "./entry-document";
import { entrySchema } from "./entry-schema";
import {
  halveDocument,
  halveSoftBreakRuns,
  halveSoftBreaksInHistory,
  runSoftBreakMigrationOnce,
} from "./soft-break-migration";

function entry(overrides: Partial<Entry>): Entry {
  return {
    id: "1",
    deviceId: "device-a",
    body: "hello",
    createdAt: "2026-01-01T10:00:00.000Z",
    updatedAt: "2026-01-01T10:00:00.000Z",
    seq: 1,
    syncedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// halveSoftBreakRuns — the pure transform
// ---------------------------------------------------------------------------

describe("halveSoftBreakRuns", () => {
  it("halves a run of two newlines to one", () => {
    expect(halveSoftBreakRuns("a\n\nb")).toBe("a\nb");
  });

  it("halves a run of four newlines to two", () => {
    expect(halveSoftBreakRuns("a\n\n\n\nb")).toBe("a\n\nb");
  });

  it("halves a run of six newlines to three", () => {
    expect(halveSoftBreakRuns("a\n\n\n\n\n\nb")).toBe("a\n\n\nb");
  });

  it("leaves an odd run alone", () => {
    expect(halveSoftBreakRuns("a\n\n\nb")).toBe("a\n\n\nb");
  });

  it("leaves a leading odd run alone, at the very first top-level child", () => {
    expect(halveSoftBreakRuns("\n\n\nhello")).toBe("\n\n\nhello");
  });

  it("halves a leading run at the very first top-level child (index 0) — this is an Enter, not a separator", () => {
    expect(halveSoftBreakRuns("\n\nhello")).toBe("\nhello");
  });

  // Acceptance criterion, named directly: a blanket string replace would
  // fold "after" into the list item, because a lone `\n` is a lazy
  // continuation under CommonMark and only a genuine blank line keeps the
  // paragraph a sibling of the list rather than part of its last item.
  it("leaves `- item\\n\\nafter` unchanged — that blank line is the block separator, not an Enter", () => {
    expect(halveSoftBreakRuns("- item\n\nafter")).toBe("- item\n\nafter");
  });

  // Acceptance criterion, named directly: halving this blank line would
  // make `5. five` lose the separator CommonMark requires for a
  // non-1-starting ordered list to interrupt a preceding paragraph at all,
  // and it would stop being a list.
  it("leaves `a\\n\\n5. five` unchanged — that blank line is required for the list to parse as a list at all", () => {
    expect(halveSoftBreakRuns("a\n\n5. five")).toBe("a\n\n5. five");
  });

  it("leaves newlines inside a list item untouched — Enter has always been splitListItem there, never a block split", () => {
    const body = "- a\n  b\n\n  c";
    expect(halveSoftBreakRuns(body)).toBe(body);
  });

  it("leaves newlines inside a checklist item's own nested paragraph untouched, for the identical reason", () => {
    const body = "- [ ] t\n\n  tail";
    expect(halveSoftBreakRuns(body)).toBe(body);
  });

  it("preserves a block separator ahead of a paragraph while halving that same paragraph's own interior", () => {
    // "- item" is a list; "\n\nfirst\n\nsecond" is the paragraph sibling
    // that follows it — its OWN leading "\n\n" is the separator
    // `writeBlocks` inserts ahead of a paragraph sibling and must survive
    // verbatim, but the "\n\n" between "first" and "second", typed inside
    // that same merged prose run, is an old Enter and must halve.
    expect(halveSoftBreakRuns("- item\n\nfirst\n\nsecond")).toBe("- item\n\nfirst\nsecond");
  });

  it("is a no-op on a body with nothing to halve, beyond the plain round trip", () => {
    expect(halveSoftBreakRuns("hello world")).toBe("hello world");
  });

  // This function deliberately always parses and re-serializes (see its
  // own doc comment) rather than short-circuiting on "no \n\n at all" —
  // these two cases prove why: the plain round trip already changes
  // non-newline characters for reasons that have nothing to do with this
  // migration, and this function must agree with that round trip exactly
  // on such bodies, not merely leave them untouched.
  it("still applies the ordinary round trip's own normalisation to a body with nothing to halve", () => {
    expect(halveSoftBreakRuns("1) a\n2) b")).toBe("1. a\n2. b");
    expect(halveSoftBreakRuns("before ~ after")).toBe("before \\~ after");
  });
});

// ---------------------------------------------------------------------------
// halveDocument — the underlying primitive, exercised on hand-built
// documents `halveSoftBreakRuns` (a string-only function) has no way to
// construct: a `code`-marked leaf, or a `reference`/`task_reference` atom,
// can never actually hold an even-length `\n` run once real Markdown has
// passed through `entryMarkdownToDocument` (this module's own header
// comment explains why, for each) — mirrors entry-document.test.ts's own
// "documents built by editing, not by parsing" section, for the identical
// reason.
// ---------------------------------------------------------------------------

describe("halveDocument", () => {
  const nodeType = (name: string) => {
    const type = entrySchema.nodes[name];
    if (type === undefined) {
      throw new Error(`entrySchema has no ${name} node`);
    }
    return type;
  };
  const doc = (...blocks: import("prosemirror-model").Node[]) =>
    nodeType("doc").create(null, blocks);
  const para = (...content: import("prosemirror-model").Node[]) =>
    nodeType("paragraph").create(null, content);

  it("never touches a code-marked leaf's own text, even one holding an even-length newline run", () => {
    const codeMarkType = entrySchema.marks.code;
    if (codeMarkType === undefined) {
      throw new Error("entrySchema has no code mark");
    }
    const built = doc(para(entrySchema.text("a\n\nb", [codeMarkType.create()])));
    const halved = halveDocument(built);
    expect(halved.firstChild?.firstChild?.text).toBe("a\n\nb");
  });

  it("never rewrites a reference atom, and still halves ordinary text around it", () => {
    const reference = entrySchema.node("reference", {
      kind: "date",
      raw: "[[2026-08-28]]",
      date: "2026-08-28",
      entryId: null,
    });
    const built = doc(para(entrySchema.text("a\n\nb "), reference, entrySchema.text(" c\n\nd")));
    const halved = halveDocument(built);
    expect(entryDocumentToMarkdown(halved)).toBe("a\nb [[2026-08-28]] c\nd");
  });

  it("never rewrites a task_reference atom's own cached label", () => {
    const taskReference = entrySchema.node("task_reference", {
      taskId: "0192abcd-1234-7890-abcd-0123456789ac",
      label: "buy milk",
      checked: false,
    });
    const built = doc(para(taskReference));
    const halved = halveDocument(built);
    expect(halved.firstChild?.firstChild?.attrs).toMatchObject({ label: "buy milk" });
  });

  it("never descends into a bullet_list, even one holding an even-length newline run in a nested paragraph", () => {
    const list = nodeType("bullet_list").create(null, [
      nodeType("list_item").create({ checked: null }, [
        para(entrySchema.text("a")),
        para(entrySchema.text("\n\nb")),
      ]),
    ]);
    const built = doc(list);
    const halved = halveDocument(built);
    expect(entryDocumentToMarkdown(halved)).toBe(entryDocumentToMarkdown(built));
  });
});

// ---------------------------------------------------------------------------
// halveSoftBreaksInHistory — the scan, against a fake store. Modelled on
// backfill-tasks.test.ts's own `fakeEntryStore`, with one deliberate
// difference: `edit` here stamps `updatedAt` to a fixed post-cutoff
// instant, exactly like the real stores do (SqliteEntryStore.edit,
// InMemoryEntryStore.edit) — this migration's own "re-running is a no-op
// by construction" claim depends on that stamp, not merely on the
// halved-equals-normalized check, so a fake that skipped it would prove
// less than the real stores actually guarantee.
// ---------------------------------------------------------------------------

const POST_CUTOFF = "2027-01-01T00:00:00.000Z";

function fakeEntryStore(seed: Entry[]): Pick<EntryStore, "list" | "edit"> & { entries: Entry[] } {
  const entries = [...seed];
  return {
    entries,
    list: async () => [...entries],
    edit: async (id: string, body: string) => {
      const index = entries.findIndex((e) => e.id === id);
      if (index !== -1) {
        // biome-ignore lint/style/noNonNullAssertion: index checked above
        entries[index] = { ...entries[index]!, body, updatedAt: POST_CUTOFF };
      }
    },
  };
}

describe("halveSoftBreaksInHistory", () => {
  it("halves an eligible Entry's body and reports it as scanned and rewritten", async () => {
    const store = fakeEntryStore([entry({ id: "e1", body: "a\n\n\n\nb" })]);
    const report = await halveSoftBreaksInHistory({ store });
    expect(report).toEqual({ scanned: 1, rewritten: 1 });
    expect(store.entries[0]?.body).toBe("a\n\nb");
  });

  it("skips a tombstone entirely — it is never even counted as scanned", async () => {
    const store = fakeEntryStore([
      entry({ id: "e1", body: "", deletedAt: "2026-01-02T00:00:00.000Z" }),
    ]);
    const report = await halveSoftBreaksInHistory({ store });
    expect(report).toEqual({ scanned: 0, rewritten: 0 });
  });

  it("scans, but never writes, a row last changed at or after the cutoff", async () => {
    const store = fakeEntryStore([
      entry({ id: "e1", body: "a\n\n\n\nb", updatedAt: BODY_SOFT_BREAK_CUTOFF }),
    ]);
    const report = await halveSoftBreaksInHistory({ store });
    expect(report).toEqual({ scanned: 1, rewritten: 0 });
    expect(store.entries[0]?.body).toBe("a\n\n\n\nb");
  });

  it("scans, but never writes, a row whose only \\n\\n is a block separator with nothing left to halve — proving nothing here would Sync or stale a Digest", async () => {
    // Contains "\n\n" (so it passes the runner's own cheap pre-check), but
    // that "\n\n" is the separator ahead of the paragraph following the
    // list — preserved verbatim, never halved (this file's own
    // `halveSoftBreakRuns` tests cover why) — and there is nothing else in
    // "after" to halve either, so `halved` and `normalized` come out
    // identical and the write is skipped.
    const store = fakeEntryStore([entry({ id: "e1", body: "- item\n\nafter" })]);
    const report = await halveSoftBreaksInHistory({ store });
    expect(report).toEqual({ scanned: 1, rewritten: 0 });
    expect(store.entries[0]?.body).toBe("- item\n\nafter");
  });

  it("skips a body with no double newline at all, without even parsing it", async () => {
    const store = fakeEntryStore([entry({ id: "e1", body: "hello world" })]);
    const report = await halveSoftBreaksInHistory({ store });
    expect(report).toEqual({ scanned: 1, rewritten: 0 });
  });

  it("does not write an Entry whose only round-trip change is unrelated to newlines", async () => {
    // Has no "\n\n" at all, so the runner's own guard skips it before ever
    // comparing halved against normalized — this pins down that the
    // guard, not merely the comparison, is what keeps a merely-escaped
    // body from being rewritten and Synced for no reason.
    const store = fakeEntryStore([entry({ id: "e1", body: "before ~ after" })]);
    const report = await halveSoftBreaksInHistory({ store });
    expect(report).toEqual({ scanned: 1, rewritten: 0 });
    expect(store.entries[0]?.body).toBe("before ~ after");
  });

  it("running the pass twice performs exactly one write per affected Entry", async () => {
    const store = fakeEntryStore([entry({ id: "e1", body: "a\n\n\n\nb" })]);
    const first = await halveSoftBreaksInHistory({ store });
    expect(first).toEqual({ scanned: 1, rewritten: 1 });
    expect(store.entries[0]?.body).toBe("a\n\nb");

    // The fake store's own `edit` stamped `updatedAt` past the cutoff, the
    // same way the real stores do — this is what makes the second pass a
    // no-op by construction, not merely because the body already looks
    // halved.
    const second = await halveSoftBreaksInHistory({ store });
    expect(second).toEqual({ scanned: 1, rewritten: 0 });
    expect(store.entries[0]?.body).toBe("a\n\nb");
  });

  it("processes every eligible Entry, one at a time, independently of the others", async () => {
    const store = fakeEntryStore([
      entry({ id: "e1", body: "one\n\n\n\ntwo" }),
      entry({ id: "e2", body: "already fine" }),
      entry({ id: "e3", body: "three\n\n\n\n\n\nfour", updatedAt: BODY_SOFT_BREAK_CUTOFF }),
      entry({ id: "e4", body: "", deletedAt: "2026-01-02T00:00:00.000Z" }),
    ]);
    const report = await halveSoftBreaksInHistory({ store });
    expect(report).toEqual({ scanned: 3, rewritten: 1 });
    expect(store.entries[0]?.body).toBe("one\n\ntwo");
    expect(store.entries[1]?.body).toBe("already fine");
    expect(store.entries[2]?.body).toBe("three\n\n\n\n\n\nfour");
  });
});

// ---------------------------------------------------------------------------
// runSoftBreakMigrationOnce — the store-open trigger's own device-local
// marker. Kept light, mirroring backfill-tasks.test.ts's own choice not to
// exercise `runTasksBackfillOnce` directly (entry-store-layout.test.tsx
// already covers that wiring, with this function itself mocked out) — this
// only pins down the marker check/set this function alone is responsible
// for, not the Sync/query-invalidation side effects `entry-store-layout.
// test.tsx` never reaches either.
// ---------------------------------------------------------------------------

function fakeSyncStores(store: EntryStore) {
  return {
    store,
    taskStore: {} as TaskStore,
    projectStore: {} as ProjectStore,
    labelStore: {} as LabelStore,
    commentStore: {} as CommentStore,
    eventStore: {} as EventStore,
  };
}

function fakeFullEntryStore(seed: Entry[]): EntryStore {
  const inner = fakeEntryStore(seed);
  let migrated = false;
  return {
    ...inner,
    upsert: async () => {},
    applyPulled: async () => {},
    pending: async () => [],
    getCursor: async () => 0,
    setCursor: async () => {},
    catchUpRowShapeEpoch: async () => {},
    hasCompletedSoftBreakMigration: async () => migrated,
    markSoftBreakMigrationComplete: async () => {
      migrated = true;
    },
    search: async () => [],
    remove: async () => {},
    getMany: async () => [],
  } as EntryStore;
}

describe("runSoftBreakMigrationOnce", () => {
  it("skips the scan entirely once the marker says it already ran", async () => {
    const store = fakeFullEntryStore([entry({ id: "e1", body: "a\n\n\n\nb" })]);
    await store.markSoftBreakMigrationComplete();
    await runSoftBreakMigrationOnce(fakeSyncStores(store), "device-a");
    // The marker skip happens before `list()` is ever called at all — the
    // Entry's body is untouched.
    expect((await store.list())[0]?.body).toBe("a\n\n\n\nb");
  });

  it("runs the scan and records completion when the marker has not yet been set", async () => {
    const store = fakeFullEntryStore([entry({ id: "e1", body: "a\n\n\n\nb" })]);
    await runSoftBreakMigrationOnce(fakeSyncStores(store), "device-a");
    expect((await store.list())[0]?.body).toBe("a\n\nb");
    expect(await store.hasCompletedSoftBreakMigration()).toBe(true);
  });

  it("records completion even when nothing needed rewriting", async () => {
    const store = fakeFullEntryStore([entry({ id: "e1", body: "already fine" })]);
    await runSoftBreakMigrationOnce(fakeSyncStores(store), "device-a");
    expect(await store.hasCompletedSoftBreakMigration()).toBe(true);
  });
});
