/**
 * The one-time History backfill (issue #174, ADR 0053): every checkbox
 * ever written, in every Entry that already existed before Promotion
 * (issue #173) shipped, becomes a Task — ticked ones included, as
 * *completed* Tasks, so the record stays honest and only genuinely
 * unfinished lines surface in Inbox. Day one's Inbox becomes exactly the
 * set of things the reader wrote down and never finished.
 *
 * **This is Promotion, reused, not reimplemented.** `promoteBareCheckboxes`
 * (promote-tasks.ts) already does everything a checkbox line needs done
 * to it — the ProseMirror round trip, the loop guard that skips a line
 * already carrying a Reference, the quick-add parse, the Task fields it
 * resolves to — and this module calls it once per Entry, exactly the way
 * `use-history.ts`'s `sendEntry`/`commitEntryEdit` already do. The one
 * thing this module adds on top is `confidenceGate` below: the parser is
 * "deliberately over-eager" (promote-tasks.ts's own words), and the thing
 * that makes that safe in the add field — seeing a token light up and
 * clicking it back to plain text — has no equivalent in a migration that
 * runs once, over everything, silently, with nobody watching.
 *
 * **Idempotence comes from the loop guard, not a transaction.**
 * `packages/core/src/sqlite/migrator.ts`'s own comment is explicit that
 * this database has none — Tauri pools connections, so a `BEGIN` and the
 * statement after it may not even reach the same connection. This module
 * never asks for one. Safety instead comes from the same property that
 * already makes Promotion itself safe to run twice: a checklist line that
 * already carries a `[[task:id|label]]` Reference is left alone
 * (`promoteBareCheckboxes`'s own loop guard). Interrupt this backfill
 * halfway — the process dies, the tab closes — and re-running it from the
 * very first Entry again does no harm: every line it already rewrote is
 * now a Reference, so it's skipped exactly as an ordinary Send with
 * nothing new to promote would be, and only the genuinely-unprocessed
 * remainder does any work. `runTasksBackfillOnce` below still keeps a
 * cheap local flag so a fully-backfilled Device doesn't re-scan its whole
 * History on every open, but that flag is a performance optimisation,
 * never the source of correctness — losing it costs one redundant, still
 * perfectly safe pass.
 */
import type {
  CommentStore,
  Entry,
  EntryStore,
  LabelStore,
  ProjectStore,
  QuickAddLanguage,
  QuickAddOptions,
  QuickAddToken,
  Task,
  TaskStore,
} from "@meologue/core";
import { englishQuickAddLanguage, mintId as mintTaskId, orderKeyBetween } from "@meologue/core";
import { promotedTaskToTask } from "@/hooks/use-history";
import { deviceUtcOffsetMinutes, entryDayKey } from "@/lib/entry-day";
import { type ChecklistConfidenceGate, promoteBareCheckboxes } from "@/lib/promote-tasks";
import { queryClient } from "@/lib/query-client";
import { ENTRIES_QUERY_KEY } from "@/lib/query-keys";
import { requestSync } from "@/lib/sync-runner";
import { refreshTasks } from "@/lib/tasks-refresh";

/**
 * The confidence gate itself (issue #174's own brief): a token the
 * backfill refuses to trust, on top of whatever `promoteBareCheckboxes`
 * would otherwise recognise. Every kind not named here — an explicit
 * calendar date (`matchAbsoluteDate`), `today`/`tomorrow`
 * (`matchRelativeDate`), a *modified* weekday like `next monday`/
 * `this friday` (`matchWeekday`, when it matched more than the bare word),
 * an explicit offset like `in 3 days` (`matchArithmeticDate`), an
 * explicit clock time (`matchExplicitTime`) — stays high-confidence and
 * is promoted exactly as Promotion would promote it today.
 *
 * **A bare weekday, used as a noun.** `token.raw` for a *modified* match
 * is always more than one word (`"next monday"`, `"this fri"`); a bare
 * one is exactly one of `QuickAddLanguage.weekdays`'s own keys and
 * nothing else. That textual difference is what distinguishes "call mum
 * on **Monday**" (a date, safe to infer even without a click-to-demote
 * moment) from "**Monday**'s meeting notes are still in my head" (a
 * weekday used as an ordinary noun, exactly the shape of false positive
 * the brief calls out by name) without this module needing to know which
 * of `date-rules.ts`'s several rules actually produced the match.
 *
 * **A bare fuzzy time word.** `morning`/`noon`/`afternoon`/`evening`/
 * `night`/`midnight` are at least as common in ordinary prose as a
 * weekday noun — "had a lovely **evening**" is not a due time — and the
 * ticket's own brief only names weekday-as-noun and interval words by
 * example, not exhaustively; refusing this family too is the same
 * principle applied consistently, not a narrower reading of it. An
 * *explicit* clock time (`5pm`, `17:00`) carries none of that ambiguity —
 * nobody writes "5pm" to mean anything but a time — so it stays trusted.
 *
 * **A bare recurrence word.** `matchRecurrenceWord` recognises but never
 * resolves one (../../packages/core/src/quick-add/date-rules.ts's own
 * `matchRecurrenceWord` doc comment: "flagged, not resolved") — this is
 * Todoist's own documented false positive, named in the ticket by its own
 * example ("Create **monthly** report"), and this module never even
 * calls the recurrence resolver a live add field would: refusing every
 * recurrence token here means `taskFieldsFromQuickAdd` never sees one to
 * resolve in the first place.
 */
export function isLowConfidenceBackfillToken(
  token: QuickAddToken,
  language: QuickAddLanguage,
): boolean {
  if (token.kind === "recurrence") {
    return true;
  }
  const raw = token.raw.trim().toLowerCase();
  if (token.kind === "date") {
    return Object.hasOwn(language.weekdays, raw);
  }
  if (token.kind === "time") {
    return Object.hasOwn(language.fuzzyTimes, raw);
  }
  return false;
}

function confidenceGateFor(language: QuickAddLanguage): ChecklistConfidenceGate {
  return (token) => isLowConfidenceBackfillToken(token, language);
}

/** A cheap, deliberately imprecise pre-check — issue #174's own guard against paying `entryMarkdownToDocument`'s ProseMirror parse for the majority of Entries, which never held a checkbox at all. Never the source of correctness: `promoteBareCheckboxes`'s own loop guard is what actually decides whether a line qualifies, so a false positive here (a body that merely mentions "[ ]" in prose) costs one wasted parse, never a wrong promotion. */
function mightHoldACheckbox(body: string): boolean {
  return body.includes("[ ]") || body.includes("[x]") || body.includes("[X]");
}

/** How many Tasks the backfill minted, and how many of those carried a date the parser actually recognised (issue #174's own acceptance criterion: "the migration reports what it did — how many Tasks, how many dated"). `tasksDated` is a strict subset of `tasksCreated`: the remainder took their Entry's own capture date (`promotedTaskToTask`'s own capture-date rule) rather than nothing at all. */
export interface TasksBackfillReport {
  tasksCreated: number;
  tasksDated: number;
}

export interface BackfillTasksOptions {
  store: Pick<EntryStore, "list" | "edit">;
  taskStore: Pick<TaskStore, "list" | "upsert">;
  deviceId: string;
  /** Defaults to `@meologue/core`'s real `mintId` — overridable so a test can supply a deterministic sequence, the same reason `promoteBareCheckboxes` itself takes one as a parameter rather than calling it directly. */
  mintId?: () => string;
  /**
   * `%label` name resolution (promote-tasks.ts's own `PromotedTask.labelNames`)
   * — defaults to "nothing resolves," the identical fallback
   * `useHistory`'s own default takes, on the same reasoning: old checkbox
   * text overwhelmingly carries no `%label` at all (the sigil postdates
   * every Entry this backfill is reaching for), and a caller with a real
   * LabelStore to resolve against passes the real thing.
   */
  resolveLabelIds?: (names: string[]) => Promise<string[]>;
  /** Minutes east of UTC — defaults to this Device's own, live `deviceUtcOffsetMinutes()`, matching every other place History computes a capture day (entry-day.ts, day-referrers.ts, Export's own ADR 0016). */
  offsetMinutes?: number;
  /** Defaults to `@meologue/core`'s `englishQuickAddLanguage` — the one language pack this app ships. */
  language?: QuickAddLanguage;
}

/**
 * Runs the backfill over every Entry `store.list()` returns — called with
 * no page argument, exactly as Export already does (ADR 0016's own
 * "a backup that quietly omits things is worse than none," the identical
 * reasoning applied here to a migration instead of a zip). Processes
 * Entries **oldest first** — the reverse of `list()`'s own newest-first
 * order — so the Tasks day one's writing produces land at the *front* of
 * Inbox, in the order the reader actually wrote them, rather than newest
 * History first: "Day one's Inbox is exactly the set of things the reader
 * wrote down and never finished" only reads as the most useful thing this
 * feature can show if it's also the first thing a reader scrolling Inbox
 * sees.
 *
 * **One Entry at a time, written immediately, not batched to the end.**
 * Each Entry's own promoted Tasks are upserted and its body rewritten
 * before the next Entry is even parsed. This is what makes "safe to
 * re-run" cheap as well as correct: an interruption after Entry N leaves
 * Entries 1..N fully committed — Task rows written, References in place —
 * so a re-run's own loop guard has nothing left to do for any of them,
 * and only resumes real work from N+1. Holding every Entry's promoted
 * Tasks in memory and writing them in one giant batch at the very end
 * would make an interruption one line before the finish lose the whole
 * run's progress instead of losing nothing.
 *
 * **Per-Entry `now`, not wall-clock `now`.** `tomorrow`/`next monday`
 * inside old, historical text was written relative to the day it was
 * *captured*, not relative to whenever this backfill happens to run —
 * resolving it against today's real date would silently jump a phrase
 * written in, say, March 2024 to a Monday years away, which is exactly
 * the kind of silent, unwatched mistake the confidence gate exists to
 * prevent one level up. Each Entry gets its own `QuickAddOptions.now`,
 * its own local capture day (`entryDayKey`), before its checkbox lines
 * are parsed at all.
 */
export async function backfillTasksFromHistory(
  options: BackfillTasksOptions,
): Promise<TasksBackfillReport> {
  const {
    store,
    taskStore,
    deviceId,
    mintId = mintTaskId,
    resolveLabelIds = async () => [],
    offsetMinutes = deviceUtcOffsetMinutes(),
    language = englishQuickAddLanguage,
  } = options;

  const confidenceGate = confidenceGateFor(language);
  const active = await taskStore.list();
  let lastKey = active.at(-1)?.orderKey ?? null;
  let tasksCreated = 0;
  let tasksDated = 0;

  // `list()` returns newest first; walking it in reverse visits Entries
  // oldest first — see this function's own header comment for why that
  // order matters, not just that some order is picked.
  const entries: Entry[] = await store.list();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry === undefined || !mightHoldACheckbox(entry.body)) {
      continue;
    }

    const capturedDay = entryDayKey(entry.createdAt, offsetMinutes) ?? entry.createdAt.slice(0, 10);
    const quickAddOptions: QuickAddOptions = { now: capturedDay, smartDates: true, language };
    const { body, tasks: promoted } = promoteBareCheckboxes(
      entry.body,
      mintId,
      quickAddOptions,
      null,
      confidenceGate,
    );
    if (promoted.length === 0) {
      continue;
    }

    const newTasks: Task[] = [];
    for (const task of promoted) {
      lastKey = orderKeyBetween(lastKey, null);
      const labelIds = await resolveLabelIds(task.labelNames);
      newTasks.push(promotedTaskToTask(task, deviceId, entry.createdAt, lastKey, labelIds));
      tasksCreated += 1;
      if (task.date !== null) {
        tasksDated += 1;
      }
    }
    // Tasks land before the Entry that now References them, so nothing
    // ever observes a Reference whose Task hasn't been written yet.
    await taskStore.upsert(newTasks);
    await store.edit(entry.id, body);
  }

  return { tasksCreated, tasksDated };
}

// Device-local (ADR 0008's own "configuration outside the entry store"
// reasoning, applied to a migration flag rather than a UI setting) —
// never synced, and not the source of correctness (this module's own
// header comment). Losing it — a cleared browser profile, a fresh
// `localStorage` — costs one redundant, still-safe re-scan of History, on
// whichever Device it happens to.
const BACKFILLED_KEY = "meologue.tasks-backfilled-v1";

function hasAlreadyBackfilled(): boolean {
  try {
    return localStorage.getItem(BACKFILLED_KEY) === "true";
  } catch {
    // Every localStorage access in this app degrades to "assume the
    // less-trusting answer" on failure (settings.ts's own header comment)
    // — here, that means "assume not yet backfilled" and pay for a
    // redundant scan rather than silently skip Entries this Device might
    // never actually have processed.
    return false;
  }
}

function markBackfilled(): void {
  try {
    localStorage.setItem(BACKFILLED_KEY, "true");
  } catch {
    // A failed write here just means the next open scans History again —
    // wasted work, never a correctness problem (this module's own header
    // comment on why the loop guard, not this flag, is what makes
    // re-running safe).
  }
}

/**
 * The store-open trigger (issue #174) — `entry-store-layout.tsx` calls
 * this once `open()` resolves. Skips the scan entirely once
 * `BACKFILLED_KEY` says it already ran; otherwise runs
 * `backfillTasksFromHistory` and logs what it did, satisfying the
 * ticket's own "the migration reports what it did — how many Tasks, how
 * many dated" with a plain `console.info`: this app has no admin surface
 * or notification centre a background migration could report through
 * instead, and a reader who wants to confirm it ran can already do so on
 * screen — Inbox filling with whatever History left unfinished is the
 * report that actually matters to them. Silent when there was nothing to
 * promote at all (a fresh Device, or one that finished on an earlier
 * open), so a fully up-to-date Device's console stays quiet on every
 * later boot.
 *
 * **Makes its own writes visible.** `backfillTasksFromHistory` writes
 * straight through `store`/`taskStore`, bypassing `useHistory`/`use-tasks.ts`'s
 * own mutation plumbing entirely (there is no live Send or tick this is
 * standing in for) — so nothing else would tell TanStack Query a
 * newly-backfilled Task or a rewritten Entry body exists. When real work
 * happened, this invalidates `TASKS_QUERY_KEY` (`refreshTasks`,
 * tasks-refresh.ts — Inbox's own query) and `ENTRIES_QUERY_KEY` (History's
 * own, every loaded page — a bounded "just the newest page" refresh, the
 * kind `refreshNewestEntriesPage` does for an ordinary edit, isn't enough
 * here: the backfill can rewrite an Entry anywhere in History, not only
 * the newest one) so a reader who already has the app open sees the
 * result without a reload. Also nudges Sync (`requestSync`,
 * sync-runner.ts) exactly as any other local write does (ADR 0013,
 * ticket 38) — a backfilled Task/Entry pair starts pending like any
 * other, and there is no reason to make it wait for the next scheduled
 * tick just because a migration wrote it instead of a reader.
 *
 * Takes the *full* `EntryStore`/`TaskStore` (unlike
 * `backfillTasksFromHistory`'s own narrower `Pick<...>`), because
 * `requestSync` needs both in full — this is the one caller
 * (`entry-store-layout.tsx`) that always has the real, fully-opened
 * stores in hand anyway, so there is nothing to narrow for.
 */
export async function runTasksBackfillOnce(
  store: EntryStore,
  taskStore: TaskStore,
  // Issue #182: needed only to pass through to requestSync's own
  // SyncStores bag below — see this function's own header comment on why
  // it takes the full stores rather than backfillTasksFromHistory's own
  // narrower `Pick<...>`.
  projectStore: ProjectStore,
  labelStore: LabelStore,
  commentStore: CommentStore,
  deviceId: string,
  resolveLabelIds?: (names: string[]) => Promise<string[]>,
): Promise<void> {
  if (hasAlreadyBackfilled()) {
    return;
  }
  const report = await backfillTasksFromHistory({ store, taskStore, deviceId, resolveLabelIds });
  markBackfilled();
  if (report.tasksCreated > 0) {
    console.info(
      `[tasks backfill] promoted ${report.tasksCreated} checkbox${
        report.tasksCreated === 1 ? "" : "es"
      } from History into Tasks (${report.tasksDated} dated from recognised text, ${
        report.tasksCreated - report.tasksDated
      } took their Entry's own capture date).`,
    );
    await Promise.all([
      refreshTasks(),
      queryClient.invalidateQueries({ queryKey: ENTRIES_QUERY_KEY }),
    ]);
    void requestSync({ store, taskStore, projectStore, labelStore, commentStore }, deviceId);
  }
}
