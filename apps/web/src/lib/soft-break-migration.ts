/**
 * The one-time newline-halving migration (issue #214, ADR 0067): every
 * Entry body written before the build that made Enter insert a single
 * `\n` (issue #212, ADR 0066) shipped still carries the old shape — one
 * Enter stored `\n\n` (a blank line), and a deliberate blank line stored
 * `\n\n\n\n`. Since #212, one Enter stores `\n`. Reading an un-migrated
 * body under the new reader shows a blank line everywhere the writer only
 * ever pressed Enter once. This pass halves every run of `\n` of even
 * length in old writing, once, so it reads the way it was meant to.
 *
 * **This is Promotion's own backfill, reused, not reimplemented** — see
 * `backfill-tasks.ts`'s module comment, which this file is modelled on
 * closely enough to read as its sibling: the same `Pick<EntryStore, "list"
 * | "edit">` scan shape, the same one-Entry-at-a-time write ordering, and
 * the same device-local "already ran" flag that is an optimisation and
 * never the source of correctness.
 *
 * **Why halving is deterministic, and why a blanket string replace is
 * not.** A run of `\n` of even length `2k` came from exactly `k` old
 * Enters typed back to back with nothing between them (each contributing
 * two), so halving it to `k` newlines recovers exactly what `k` Enters
 * mean today. An odd run cannot have come from Enter alone — the parser
 * only ever inserts a literal `\n\n`/`\n\n\n\n` block separator (even, by
 * construction — see `writeBlocks`'s own comment, entry-document.ts) or a
 * writer's own even number of soft breaks, so an odd run is left alone
 * rather than guessed at. But not every `\n\n` in a stored body is an old
 * Enter at all: `writeBlocks` also writes a blank line ahead of a sibling
 * paragraph (a lone `\n` is a lazy continuation under CommonMark, so two
 * paragraph siblings can only round-trip with a real blank line between
 * them) and ahead of an ordered list whose numbering does not start at 1
 * (a marker cannot otherwise interrupt an open paragraph). Halving either
 * of those blindly would corrupt structure, not merely reformat it —
 * `- item\n\nafter` would fold "after" into the list item, and
 * `a\n\n5. five` would stop being a list at all. `halveSoftBreakRuns`
 * therefore never touches a raw string: it runs over the parsed document
 * (`entryMarkdownToDocument`/`entryDocumentToMarkdown`, the blessed
 * round-trip pair, ADR 0044) and only ever rewrites text inside a
 * top-level `paragraph` child — never inside a `bullet_list`/
 * `ordered_list` (Enter has always been `splitListItem` there, never a
 * block split, so no `\n\n` inside a list item ever came from an Enter),
 * never inside a `code` mark (an Enter typed while a code span was open
 * would have produced two separate spans, never one `\n\n`-holding span),
 * and never inside a `reference`/`task_reference` atom (a Reference's own
 * `raw` cannot contain a newline at all, and a task reference's `label`
 * is a cache whose characters this migration has no business rewriting).
 */

import type { EntryStore } from "@meologue/core";
import { BODY_SOFT_BREAK_CUTOFF, isStrictlyNewerThan } from "@meologue/core";
import { Fragment, type Node as PMNode } from "prosemirror-model";
import { entryDocumentToMarkdown, entryMarkdownToDocument } from "@/lib/entry-document";
import { queryClient } from "@/lib/query-client";
import { ENTRIES_QUERY_KEY } from "@/lib/query-keys";
import { requestSync, type SyncStores } from "@/lib/sync-runner";

/** Halves one run of `\n` — even length `2k` becomes `k` newlines, odd length is returned unchanged (see this file's own header comment for why an odd run is never an old Enter). */
function halveNewlineRun(run: string): string {
  return run.length % 2 === 0 ? "\n".repeat(run.length / 2) : run;
}

function halveNewlineRuns(text: string): string {
  return text.replace(/\n+/g, halveNewlineRun);
}

/**
 * One text leaf's own text. `preserveLeadingRun` protects exactly the
 * block-separator case this file's header comment calls out: when this
 * leaf is the very first leaf of a top-level paragraph that is *not*
 * itself the document's first top-level child, any `\n` run at the very
 * start of its text is the gap `writeBlocks` inserted ahead of it as a
 * sibling separator (`parseEntryMarkdown` always captures that gap as the
 * paragraph's own leading text, verbatim, never trimmed — see
 * `entry-document.ts`'s own `writeBlocks` comment) — not a keystroke, and
 * is left exactly as written. Everything after that leading run, in this
 * same leaf, is halved normally: a separator can precede real typing in
 * the same paragraph (`- item\n\nafter one\n\nafter two`, where "after
 * one"/"after two" are two Enter-separated lines inside the same merged
 * prose run that follows the list).
 */
function halveLeafText(text: string, preserveLeadingRun: boolean): string {
  if (!preserveLeadingRun) {
    return halveNewlineRuns(text);
  }
  const leadingMatch = /^\n+/.exec(text);
  if (leadingMatch === null) {
    return halveNewlineRuns(text);
  }
  const leading = leadingMatch[0];
  return leading + halveNewlineRuns(text.slice(leading.length));
}

/**
 * One top-level `paragraph` node. `isFirstTopLevelChild` decides whether
 * this paragraph's own leading `\n` run (if it has one) is a block
 * separator to preserve or an Enter press to halve — see
 * `halveLeafText`'s own comment. Every other leaf, and every leaf beyond
 * the first, is halved uniformly regardless of position: only the very
 * first leaf of a non-first paragraph carries a separator at all.
 */
function halveParagraph(paragraph: PMNode, isFirstTopLevelChild: boolean): PMNode {
  const children: PMNode[] = [];
  paragraph.forEach((leaf, _offset, index) => {
    const hasCodeMark = leaf.marks.some((mark) => mark.type.name === "code");
    if (hasCodeMark || !leaf.isText || leaf.text === undefined) {
      // Untouched: a code span's own text (an Enter inside one could never
      // have produced a `\n\n` in a single span — see this file's header
      // comment), or a non-text atom (`reference`/`task_reference`), which
      // carries no newline this migration is allowed to rewrite anyway.
      children.push(leaf);
      return;
    }
    const preserveLeadingRun = index === 0 && !isFirstTopLevelChild;
    const text = halveLeafText(leaf.text, preserveLeadingRun);
    children.push(text === leaf.text ? leaf : leaf.type.schema.text(text, leaf.marks));
  });
  return paragraph.copy(Fragment.fromArray(children));
}

/**
 * The whole document. Only a top-level `paragraph` child is ever rewritten
 * — a `bullet_list`/`ordered_list` top-level child is pushed through
 * unchanged, never descended into (this file's header comment on why
 * nothing inside a list item is ever an old Enter's doing).
 *
 * Exported alongside `halveSoftBreakRuns` (below) — not merely an
 * internal step of it — for the same reason `entry-document.test.ts`'s own
 * "documents built by editing, not by parsing" section hand-builds
 * documents through `entrySchema` directly: a `code`-marked leaf, or a
 * `reference`/`task_reference` atom, can never actually hold an
 * even-length `\n` run once it has passed through
 * `entryMarkdownToDocument`'s own parse (this file's header comment
 * explains why, for each). Proving this function still leaves such a leaf
 * completely untouched needs a document built by hand, the only way to
 * construct the shape at all — `halveSoftBreakRuns` itself, taking only a
 * `string`, has no way to hand one in.
 */
export function halveDocument(doc: PMNode): PMNode {
  const children: PMNode[] = [];
  doc.forEach((child, _offset, index) => {
    children.push(child.type.name === "paragraph" ? halveParagraph(child, index === 0) : child);
  });
  return doc.copy(Fragment.fromArray(children));
}

/**
 * The pure transform (issue #214's own brief). Parses `body`, halves every
 * even-length run of `\n` inside top-level prose text, and serializes back
 * — see this file's header comment for the full reasoning on what is and
 * is not touched.
 *
 * Deliberately always parses, even when `body` holds no `"\n\n"` at all
 * (nothing for this function to halve): an earlier version of this
 * function short-circuited that case by returning `body` verbatim, on the
 * reasoning that a body with no `"\n\n"` has nothing to halve — true, but
 * not the same claim as "nothing about this function's own output would
 * differ from the ordinary round trip." `entryDocumentToMarkdown` can
 * still normalise a body that has no double newline at all — an ordered
 * list's `)` delimiter becomes `.` (`roundTrip("1) a\n2) b")` ===
 * `"1. a\n2. b"`), and a lone `~` in prose gains an escaping backslash
 * (`roundTrip("before ~ after")` === `"before \\~ after"`) — both found
 * directly in `entry-document.test.ts`'s own corpus, neither involving a
 * newline at all. Short-circuiting there would make `halveSoftBreakRuns`
 * disagree with the plain round trip on characters that have nothing to
 * do with newlines, which is exactly what this module's own invariant
 * test (`entry-document.test.ts`) exists to catch, and what would make a
 * caller unable to trust "only newlines changed" as a property of this
 * function's output in general. The runner below (`halveSoftBreaksInHistory`)
 * is where the real performance win from "most Entries have nothing to
 * halve" actually belongs — it skips calling this function at all for a
 * body with no `"\n\n"`, exactly the way `backfill-tasks.ts`'s own
 * `mightHoldACheckbox` guards its caller's loop rather than
 * `promoteBareCheckboxes` itself.
 */
export function halveSoftBreakRuns(body: string): string {
  return entryDocumentToMarkdown(halveDocument(entryMarkdownToDocument(body)));
}

/** How many Entries the migration looked at, and how many it actually rewrote (issue #214's own acceptance criterion: "counts of scanned and rewritten Entries are reported"). */
export interface SoftBreakMigrationReport {
  scanned: number;
  rewritten: number;
}

export interface HalveSoftBreaksOptions {
  store: Pick<EntryStore, "list" | "edit">;
  /** Defaults to `@meologue/core`'s real `BODY_SOFT_BREAK_CUTOFF` — overridable so a test can exercise the cutoff boundary without depending on the real build's own fixed instant. */
  cutoff?: string;
}

/**
 * Runs the migration over every Entry `store.list()` returns — no page
 * argument, the identical "a migration that quietly omits things is worse
 * than none" posture `backfillTasksFromHistory` already takes (that
 * file's own header comment, ADR 0016's original framing). Order does not
 * matter here the way it does for the Tasks backfill (which wants Day
 * one's Tasks at the front of Inbox) — every Entry is independent, so
 * this simply walks whatever order `list()` returns.
 *
 * Per Entry, in order:
 *
 * - a tombstone is skipped — a removed Entry's `body` is already blanked
 *   (ADR 0028), nothing to migrate;
 * - an Entry last changed at or after `cutoff` is skipped — its body was
 *   already written by a build where one Enter is one `\n`, so there is
 *   nothing old-shaped left in it to halve, and rewriting it anyway could
 *   only ever remove a blank line the writer placed on purpose;
 * - a body with no `"\n\n"` at all is skipped — nothing for
 *   `halveSoftBreakRuns` to halve, and skipping here (rather than inside
 *   that function — see its own doc comment) is what avoids paying for
 *   `entryMarkdownToDocument`'s ProseMirror parse, twice over, for the
 *   majority of Entries this migration will ever see;
 * - otherwise, `halved` is compared against `normalized` — the plain
 *   round trip of the same body, with no halving applied — and the Entry
 *   is written only when they differ. This is what keeps an Entry whose
 *   round trip is already stable (nothing this migration would change)
 *   from Syncing and from marking its day's Digest stale for no reason;
 *   comparing against the *round trip*, not against `body` itself, is
 *   what makes this comparison exact even for a body the round trip
 *   would already normalise for unrelated reasons (an escaped `~`, an
 *   ordered-list delimiter) — those show up in both sides of the
 *   comparison identically, so they never make an untouched Entry look
 *   changed.
 *
 * **One Entry at a time, written immediately, never batched** — the
 * identical reasoning `backfillTasksFromHistory` gives for its own
 * identical choice: an interruption after Entry N leaves Entries 1..N
 * fully committed (their own `updatedAt` already past `cutoff`), so a
 * re-run's own cutoff guard has nothing left to do for any of them.
 */
export async function halveSoftBreaksInHistory(
  options: HalveSoftBreaksOptions,
): Promise<SoftBreakMigrationReport> {
  const { store, cutoff = BODY_SOFT_BREAK_CUTOFF } = options;

  let scanned = 0;
  let rewritten = 0;

  const entries = await store.list();
  for (const entry of entries) {
    if (entry.deletedAt !== null) {
      continue;
    }
    scanned += 1;
    // Issue #217: compared by INSTANT, and only rewrite a row this can
    // positively establish is older than the cutoff. This was
    // `entry.updatedAt >= cutoff`, a raw string comparison, and
    // `updated_at` does not have one shape — the Server emits six
    // fractional digits where this client emits three, so a Server-written
    // `…:27.000400Z` compared as SMALLER than this cutoff's own
    // `…:27.000Z` and the row was rewritten despite being after it.
    // Narrow (it needs the row to land in the cutoff's own millisecond)
    // but the same defect as #217's, and this guard is the only thing
    // standing between a post-cutoff body and an unwanted rewrite.
    //
    // Phrased as "not provably older" rather than "newer or equal" so an
    // unreadable timestamp skips the row instead of rewriting it. Refusing
    // to touch a body is always the recoverable direction; rewriting one on
    // a comparison nobody can trust is not.
    if (!isStrictlyNewerThan(cutoff, entry.updatedAt)) {
      continue;
    }
    if (!entry.body.includes("\n\n")) {
      continue;
    }
    const normalized = entryDocumentToMarkdown(entryMarkdownToDocument(entry.body));
    const halved = halveSoftBreakRuns(entry.body);
    if (halved === normalized) {
      continue;
    }
    await store.edit(entry.id, halved);
    rewritten += 1;
  }

  return { scanned, rewritten };
}

// Device-local, exactly like `backfill-tasks.ts`'s own `BACKFILLED_KEY` —
// an optimisation, never the source of correctness (this file's own
// header comment, and `EntryStore.hasCompletedSoftBreakMigration`'s own
// doc comment, packages/core/src/store.ts). Kept in `kv` via the Store
// itself, not `localStorage`, precisely so a Restore — which restores
// `kv` — carries this marker along with it (ADR 0067's own "the invariant
// that replaces a safety Backup" is about the transform's own safety; the
// marker's placement is a separate, narrower guard against a Restored,
// pre-migration History being silently skipped forever).

/**
 * The store-open trigger (issue #214), mirroring `runTasksBackfillOnce`'s
 * own shape (`backfill-tasks.ts`) closely enough to read as its sibling.
 * `entry-store-layout.tsx` calls this once the real store is open, after
 * the Tasks backfill has itself finished — that backfill also rewrites
 * bodies (`promoteBareCheckboxes`'s own text changes), and letting it run
 * first means this migration sees the final text rather than racing it.
 *
 * Skips the scan entirely once `hasCompletedSoftBreakMigration()` says it
 * already ran; otherwise runs `halveSoftBreaksInHistory` and records
 * completion. Logs what it did via `console.info` — the identical
 * reporting posture `runTasksBackfillOnce` takes, for the identical
 * reason (this app has no admin surface a background migration could
 * report through instead) — but only when it actually rewrote something;
 * a fully-migrated Device's console stays quiet on every later boot.
 *
 * **Makes its own writes visible**, the same way `runTasksBackfillOnce`
 * does: `halveSoftBreaksInHistory` writes straight through `store`,
 * bypassing `useHistory`'s own mutation plumbing, so nothing else would
 * tell TanStack Query a rewritten body exists or tell Sync there is new
 * work pending. When at least one Entry was rewritten, this invalidates
 * `ENTRIES_QUERY_KEY` (every loaded page — a rewrite can land on an Entry
 * anywhere in History, not only the newest one) and nudges Sync
 * (`requestSync`) exactly as any other local write does (ADR 0013).
 *
 * **Rewritten bodies deliberately do Sync and do stale a Digest** — see
 * ADR 0067's own "Consequences" for why suppressing that would be worse
 * (a Device that migrates locally without pushing diverges permanently).
 */
export async function runSoftBreakMigrationOnce(
  stores: SyncStores,
  deviceId: string,
): Promise<void> {
  const { store } = stores;
  if (await store.hasCompletedSoftBreakMigration()) {
    return;
  }
  const report = await halveSoftBreaksInHistory({ store });
  await store.markSoftBreakMigrationComplete();
  if (report.rewritten > 0) {
    console.info(
      `[soft-break migration] halved newline runs in ${report.rewritten} of ${report.scanned} scanned Entr${
        report.rewritten === 1 ? "y" : "ies"
      }.`,
    );
    await queryClient.invalidateQueries({ queryKey: ENTRIES_QUERY_KEY });
    void requestSync(stores, deviceId);
  }
}
