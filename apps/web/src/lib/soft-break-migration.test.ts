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
import { entryDocumentToMarkdown, entryMarkdownToDocument } from "./entry-document";
import { entrySchema } from "./entry-schema";
import {
  halveDocument,
  halveSoftBreakRuns,
  halveSoftBreaksInHistory,
  runSoftBreakMigrationOnce,
} from "./soft-break-migration";

const roundTrip = (body: string) => entryDocumentToMarkdown(entryMarkdownToDocument(body));

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

// ADR 0069/issue #234 changed what these cases actually assert, not merely
// their expected strings. `halveSoftBreakRuns` still runs the identical
// code it always has (Status, above: "the pass still runs, still does
// exactly what it always did" — ADR 0069's own Consequences) — walk
// `entryMarkdownToDocument(body)`, halve an even-length `\n` run found
// inside a top-level paragraph LEAF's own text, skip lists/code/references,
// serialize back. What changed is what `entryMarkdownToDocument` itself now
// hands that walk: `collectBlocks` (inline-markdown.ts) no longer merges
// consecutive paragraph siblings into one run with the gap between them
// copied into its text — it SPLITS at every bare `\n`, of any run length,
// into separate top-level `paragraph` SIBLINGS, each starting with clean
// text of its own. A top-level paragraph leaf can therefore no longer hold
// an "old Enter" `\n` run at all by the time `halveDocument` ever sees it —
// that run was already consumed as a block boundary at PARSE time, before
// this function's own walk begins. `halveSoftBreakRuns` is consequently now
// equal to the plain round trip (`roundTrip`, below) for every body this
// suite could construct — proven directly, not merely asserted, by the
// last test in this describe block. The individual cases above that line
// are kept (not deleted) because they still pin down real, distinct
// behaviour: what a legacy body's bare-newline runs now mean once read
// through ADR 0069's reader, with `halveSoftBreakRuns` incidentally along
// for the ride.
describe("halveSoftBreakRuns", () => {
  it("collapses a run of two newlines to the one block boundary ADR 0069's reader already reads it as", () => {
    expect(halveSoftBreakRuns("a\n\nb")).toBe("a\n\nb");
  });

  it("collapses a run of four newlines the identical way — no more halving to a run-length-dependent count", () => {
    // Before this ticket, this run's own EVEN length meant "two old
    // Enters," and halved to "a\n\nb" for that reason. Now every non-empty
    // run of bare `\n`, whatever its length, is ONE block boundary
    // (ADR 0069) — `collectBlocks` never had a count to recover in the
    // first place, so the output here is the same "a\n\nb", but for an
    // entirely different reason: nothing was ever halved, because nothing
    // survived parsing as a `\n` run to halve.
    expect(halveSoftBreakRuns("a\n\n\n\nb")).toBe("a\n\nb");
  });

  it("collapses a run of six newlines the same way too, not to three", () => {
    // The clearest proof the two models disagree: the old, run-length-aware
    // halving would have produced "a\n\n\nb" (three newlines) here. The
    // block-boundary reader produces "a\n\nb" (ADR 0069's own single,
    // fixed-cost separator) regardless of how many bare newlines the
    // original run held.
    expect(halveSoftBreakRuns("a\n\n\n\n\n\nb")).toBe("a\n\nb");
  });

  it("collapses even an ODD run to the identical one block boundary — odd runs are no longer special-cased", () => {
    // The old model left an odd run alone, on the reasoning that no Enter
    // sequence could ever have produced one. ADR 0069's reader has no such
    // reasoning to make: an odd run of bare `\n` is still a non-empty run,
    // still exactly one block boundary, the same as an even one.
    expect(halveSoftBreakRuns("a\n\n\nb")).toBe("a\n\nb");
  });

  it("drops a leading run entirely, at the very first top-level child — there is no preceding block to separate from", () => {
    // Leading blank lines before a document's first real content carry no
    // meaning CommonMark's own block parser preserves — there is nothing
    // for them to be a separator FROM. "hello", not "\n\n\nhello".
    expect(halveSoftBreakRuns("\n\n\nhello")).toBe("hello");
  });

  it("drops a shorter leading run identically", () => {
    expect(halveSoftBreakRuns("\n\nhello")).toBe("hello");
  });

  it("leaves `- item\\n\\nafter` unchanged — that blank line is still the block separator, not an Enter", () => {
    // Still true under the new model, for the same underlying reason as
    // before: a lone `\n` is a CommonMark lazy continuation, so the
    // paragraph after the list needs a genuine blank line to survive as a
    // sibling rather than folding into the list's last item — and
    // `entryDocumentToMarkdown` writes exactly one blank line for that,
    // same as it always has.
    expect(halveSoftBreakRuns("- item\n\nafter")).toBe("- item\n\nafter");
  });

  it("leaves `a\\n\\n5. five` unchanged — that blank line is still required for the list to parse as a list at all", () => {
    expect(halveSoftBreakRuns("a\n\n5. five")).toBe("a\n\n5. five");
  });

  it("splits newlines inside a list item into separate blocks too, matching outside-list behaviour", () => {
    // ADR 0069's block-break splitting applies inside a list item exactly
    // as it does outside one now (`collectBlocks` uses one collector for
    // both) — "a", "b" and "c" become three separate `"prose"` blocks
    // inside the same item, each written back with its own `\n\n` and its
    // own recovered indentation.
    expect(halveSoftBreakRuns("- a\n  b\n\n  c")).toBe("- a\n\n  b\n\n  c");
  });

  it("splits newlines inside a checklist item's own nested paragraph identically", () => {
    expect(halveSoftBreakRuns("- [ ] t\n\n  tail")).toBe("- [ ] t\n\n  tail");
  });

  it("keeps a block separator ahead of a paragraph, and now also splits that paragraph's own interior into further blocks", () => {
    // "- item" is a list; "first" and "second" are two more block-broken
    // siblings that follow it, each written with its own `\n\n` ahead of
    // it — not one merged paragraph with an internal run halved, the way
    // the pre-0069 model would have produced.
    expect(halveSoftBreakRuns("- item\n\nfirst\n\nsecond")).toBe("- item\n\nfirst\n\nsecond");
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

  // The load-bearing finding of this ticket's own convergence (Part 2 of
  // issue #234's own brief): `halveSoftBreakRuns` is now, for every body
  // this suite constructs, IDENTICAL to the plain round trip. Not "usually
  // agrees" — every case above this one is individually a witness of the
  // same fact. This is why `halveSoftBreaksInHistory`, further below, now
  // reports `rewritten: 0` for every Entry it scans: `halveDocument`'s own
  // walk still runs, and its own invariant ("only ever removes `\n`
  // characters," ADR 0067's own safety argument) still holds — vacuously,
  // since ADR 0069's reader already consumed every "old Enter" `\n` run as
  // a block boundary before this function's own walk ever begins, leaving
  // nothing inside a top-level paragraph leaf for it to find.
  it("equals the plain round trip for every case in this file", () => {
    const bodies = [
      "a\n\nb",
      "a\n\n\n\nb",
      "a\n\n\n\n\n\nb",
      "a\n\n\nb",
      "\n\n\nhello",
      "\n\nhello",
      "- item\n\nafter",
      "a\n\n5. five",
      "- a\n  b\n\n  c",
      "- [ ] t\n\n  tail",
      "- item\n\nfirst\n\nsecond",
      "hello world",
      "1) a\n2) b",
      "before ~ after",
    ];
    for (const body of bodies) {
      expect(halveSoftBreakRuns(body)).toBe(roundTrip(body));
    }
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
    // `halveParagraph`'s own halving still runs unchanged on this
    // hand-built leaf text (never reachable through the real parser after
    // ADR 0069 — see this describe block's own header comment — but still
    // exercised directly here to prove the primitive itself): "a\n\nb "
    // halves to "a\nb ", " c\n\nd" halves to " c\nd". What changed is what
    // `entryDocumentToMarkdown` does with the ONE remaining `\n` each side
    // is left with — issue #234's writer now escapes every embedded `\n`
    // in a text leaf to `\` + `\n` unconditionally (`escapeUserText`'s own
    // comment, entry-document.ts), because an embedded `\n` in real text
    // is always a soft break now, never a bare block-separator character.
    expect(entryDocumentToMarkdown(halved)).toBe("a\\\nb [[2026-08-28]] c\\\nd");
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

// ADR 0069/issue #234: every case below that used to report `rewritten: 1`
// now reports `rewritten: 0`, for the reason the `halveSoftBreakRuns`
// describe block above proves directly — `halved === normalized` for every
// body this migration's own eligibility gate lets through, since ADR 0069's
// reader already consumed any "old Enter" newline run as a block boundary
// before `halveSoftBreaksInHistory`'s own comparison ever runs. The scan
// itself, the cutoff guard, and the cheap `"\n\n"` pre-check are all
// unchanged code, still exercised by every case here; only the write
// outcome differs.
describe("halveSoftBreaksInHistory", () => {
  it("scans an eligible Entry but no longer rewrites it — the plain round trip already normalises it", async () => {
    const store = fakeEntryStore([entry({ id: "e1", body: "a\n\n\n\nb" })]);
    const report = await halveSoftBreaksInHistory({ store });
    expect(report).toEqual({ scanned: 1, rewritten: 0 });
    expect(store.entries[0]?.body).toBe("a\n\n\n\nb");
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

  // Issue #217: the cutoff guard used to be a raw string comparison, and
  // `updated_at` does not have one shape — the Server writes six
  // fractional digits where this client writes three. `BODY_SOFT_BREAK_CUTOFF`
  // is client-shaped and lands on a whole second, so a Server-written row
  // inside that same millisecond compared as SMALLER and was rewritten
  // despite being at or after the cutoff.
  it("scans, but never writes, a Server-shaped row inside the cutoff's own millisecond", async () => {
    const serverShapedAtCutoff = `${BODY_SOFT_BREAK_CUTOFF.replace(/\.\d{3}Z$/, ".000400Z")}`;
    const store = fakeEntryStore([
      entry({ id: "e1", body: "a\n\n\n\nb", updatedAt: serverShapedAtCutoff }),
    ]);
    const report = await halveSoftBreaksInHistory({ store });
    expect(report).toEqual({ scanned: 1, rewritten: 0 });
    expect(store.entries[0]?.body).toBe("a\n\n\n\nb");
  });

  // A body rewrite is not recoverable from inside this pass, so a
  // timestamp neither comparison can read must skip rather than proceed.
  it("scans, but never writes, a row whose updatedAt cannot be read at all", async () => {
    const store = fakeEntryStore([
      entry({ id: "e1", body: "a\n\n\n\nb", updatedAt: "not a timestamp" }),
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

  it("running the pass twice stays a no-op both times, not merely stable after one write", async () => {
    const store = fakeEntryStore([entry({ id: "e1", body: "a\n\n\n\nb" })]);
    const first = await halveSoftBreaksInHistory({ store });
    expect(first).toEqual({ scanned: 1, rewritten: 0 });
    expect(store.entries[0]?.body).toBe("a\n\n\n\nb");

    const second = await halveSoftBreaksInHistory({ store });
    expect(second).toEqual({ scanned: 1, rewritten: 0 });
    expect(store.entries[0]?.body).toBe("a\n\n\n\nb");
  });

  it("processes every eligible Entry, one at a time, independently of the others — none of them get rewritten", async () => {
    const store = fakeEntryStore([
      entry({ id: "e1", body: "one\n\n\n\ntwo" }),
      entry({ id: "e2", body: "already fine" }),
      entry({ id: "e3", body: "three\n\n\n\n\n\nfour", updatedAt: BODY_SOFT_BREAK_CUTOFF }),
      entry({ id: "e4", body: "", deletedAt: "2026-01-02T00:00:00.000Z" }),
    ]);
    const report = await halveSoftBreaksInHistory({ store });
    expect(report).toEqual({ scanned: 3, rewritten: 0 });
    expect(store.entries[0]?.body).toBe("one\n\n\n\ntwo");
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
    applyAcknowledged: async () => {},
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

  it("runs the scan and records completion when the marker has not yet been set — the scan runs, but rewrites nothing (ADR 0069)", async () => {
    const store = fakeFullEntryStore([entry({ id: "e1", body: "a\n\n\n\nb" })]);
    await runSoftBreakMigrationOnce(fakeSyncStores(store), "device-a");
    expect((await store.list())[0]?.body).toBe("a\n\n\n\nb");
    expect(await store.hasCompletedSoftBreakMigration()).toBe(true);
  });

  it("records completion even when nothing needed rewriting", async () => {
    const store = fakeFullEntryStore([entry({ id: "e1", body: "already fine" })]);
    await runSoftBreakMigrationOnce(fakeSyncStores(store), "device-a");
    expect(await store.hasCompletedSoftBreakMigration()).toBe(true);
  });
});
