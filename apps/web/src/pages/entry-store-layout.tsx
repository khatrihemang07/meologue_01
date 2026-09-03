import type {
  Comment,
  CommentStore,
  Entry,
  EntryStore,
  Label,
  LabelStore,
  Project,
  ProjectStore,
  Section,
  Task,
  TaskStore,
} from "@meologue/core";
import { open } from "@meologue/core";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Outlet, useOutletContext } from "react-router";
import { useComments } from "@/hooks/use-comments";
import { type UseHistoryPagination, useHistory } from "@/hooks/use-history";
import { useLabels } from "@/hooks/use-labels";
import { type AddProjectOverrides, useProjects } from "@/hooks/use-projects";
import { type AddTaskOverrides, useTasks } from "@/hooks/use-tasks";
import { runTasksBackfillOnce } from "@/lib/backfill-tasks";
import { dayHasEntries } from "@/lib/day-has-entries";
import { dayReferrers } from "@/lib/day-referrers";
import { deferStore, type StoreMethodNames } from "@/lib/defer-store";
import { deviceUtcOffsetMinutes } from "@/lib/entry-day";
import {
  OpenTimeoutError,
  SecondTabError,
  StorageUnavailableError,
} from "@/lib/entry-store-errors";
import type { ComposerPromotionContext } from "@/lib/promote-tasks";
import { ENTRY_STORE_QUERY_KEY } from "@/lib/query-keys";
import { createDriver } from "@/platform/sqlite-driver";

export interface EntryStoreOutletContext {
  entries: Entry[];
  /** Issue #79 — see UseHistoryPagination's own doc comment (use-history.ts). */
  pagination: UseHistoryPagination;
  sendEntry: (raw: string, promotion?: ComposerPromotionContext) => void;
  /** Search (ticket 39) — narrows History to Entries whose body matches `query`, per EntryStore.search. */
  search: (query: string) => Promise<Entry[]>;
  /**
   * A direct by-id lookup, per EntryStore.getMany — added to fix issue
   * #79's regression: `entries` above is only whatever pages of History
   * `useHistory`'s infinite query has loaded so far, so a page that needs
   * to resolve a specific, known set of ids (reflection-page.tsx's
   * Grounding ids) can't rely on scanning `entries` for them the way it
   * could before paging existed. Named to match `search`'s shape — a
   * function a page calls, not a second array to keep in sync with the
   * first.
   */
  getEntries: (ids: string[]) => Promise<Entry[]>;
  /**
   * Whether a local day (YYYY-MM-DD) holds at least one live Entry (issue
   * #142) — day-has-entries.ts's own `dayHasEntries`, exposed as a context
   * function the same way `search`/`getEntries` above are, rather than the
   * raw store: entry-row.tsx's date-Reference link (via
   * use-day-has-entries.ts) is this field's one caller, and it needs
   * exactly this answer, not `EntryStore.list` itself.
   *
   * Optional, unlike `search`/`getEntries`: every other page that builds
   * this context — reflection-page.tsx's and digest-reader-page.tsx's own
   * tests among them, none of which know a date Reference exists — has no
   * reason to supply it, and `use-day-has-entries.ts`'s own hook already
   * treats "no probe available" the same as "still resolving": the
   * Reference simply stays its literal text, the same "unresolved is plain
   * text" rule inline-prose.tsx already applies to a removed Entry or a
   * malformed mark.
   */
  dayHasEntries?: (dayKey: string) => Promise<boolean>;
  /**
   * The later Entries that Refer to a local day (YYYY-MM-DD) (issue #147,
   * ADR 0042's own "a day can also be asked what Refers to it") —
   * day-referrers.ts's own `dayReferrers`, exposed as a context function the
   * same way `dayHasEntries` above is, rather than the raw store:
   * history.tsx's own day-adjacent row (via use-day-referrers.ts) is this
   * field's one caller, and it needs exactly this answer, not
   * `EntryStore.search` itself (ADR 0042's "day shows what Refers to it" is
   * two steps — narrowing with search, then confirming by parsing — and
   * `dayReferrers` is where both live, not here).
   *
   * Optional, unlike `search`/`getEntries`, for the same reason
   * `dayHasEntries` is: every other page that builds this context has no
   * reason to supply it, and `use-day-referrers.ts`'s own hook already
   * treats "no probe available" the same as "still resolving" — a day
   * renders as having nothing Referring to it either way.
   */
  dayReferrers?: (dayKey: string) => Promise<Entry[]>;
  /**
   * Resolves one Entry Reference's target by id (issue #143) — the chip's
   * own probe, `entry-row.tsx`'s `EntryReferenceLink` (via
   * `use-entry-reference.ts`) is its one caller. Returns `undefined` for an
   * id `getMany` doesn't hand back — a tombstoned Entry, or one that hasn't
   * Synced to this Device yet — which is exactly the "unresolvable" case
   * the chip renders as plain text (ADR 0042's "one rule, four causes").
   *
   * Built on `EntryStore.getMany`, the same primitive `getEntries` above
   * already wraps, rather than widening `EntryStore` with a singular
   * lookup of its own. Kept as its own field instead of reusing `getEntries`
   * directly: `getEntries` is keyed by reflection-page.tsx's own
   * `groundingEntriesQueryKey` — the *set* of ids one Grounding disclosure
   * needs at once, refetched together whenever that set changes — while a
   * chip needs its own target cached per id alone
   * (`entryReferenceQueryKey`), so two chips pointing at the same Entry
   * anywhere in the app share one lookup regardless of what else either of
   * them also happens to reference. A second field is what keeps those two
   * cache shapes independent without teaching `getEntries`'s callers about
   * per-id caching they have no use for.
   *
   * Optional, unlike `getEntries`: the same reasoning as `dayHasEntries`
   * just above — every outlet-context builder that predates this ticket
   * (reflection-page.test.tsx and digest-reader-page.test.tsx among them)
   * has no reason to know an Entry Reference exists, and
   * `use-entry-reference.ts`'s own hook already treats "no probe supplied"
   * the same as "still resolving."
   */
  getEntry?: (entryId: string) => Promise<Entry | undefined>;
  /** ADR 0028 — see use-history.ts's own doc comment for what these do and why removeEntry takes the whole Entry. */
  editEntry: (id: string, body: string) => void;
  /** The Composer's own edit-commit door (issue #173) — use-history.ts's own `commitEntryEdit` doc comment for why this is `editEntry`'s promoting sibling rather than the same function. */
  commitEntryEdit: (id: string, body: string, promotion?: ComposerPromotionContext) => void;
  removeEntry: (entry: Entry) => void;
  /**
   * Todo's Tasks (issue #168, ADR 0047) — the Task-shaped sibling of
   * `entries`/`pagination`/`sendEntry`/`editEntry`/`removeEntry` above,
   * built the same way for the same reason: `useTasks` (use-tasks.ts) runs
   * once, here, above every route this layout wraps, rather than each Todo
   * view opening its own subscription to the same TaskStore. `/todo` and
   * `/todo/inbox` are routed under this layout (App.tsx) precisely so this
   * field exists for them, the same way `entries` exists for `/`.
   *
   * Not optional, unlike `dayHasEntries`/`dayReferrers`/`getEntry` further
   * up: those are optional because most of this context's builders
   * (reflection-page.test.tsx and friends) predate the Reference features
   * that need them and have nothing to supply. Every builder of this
   * context is this file's own two `satisfies` literals below, and both
   * supply a real value (the not-ready stand-ins just beneath this
   * interface), so there is no caller this field could be missing for.
   */
  tasks: Task[];
  /** Completed Tasks, newest first — TaskStore.listCompleted(), the other half of `tasks` above. */
  completedTasks: Task[];
  /**
   * Captures a new Task, inheriting `date` from the view the reader is
   * standing in (`todo-page.tsx`'s `captureDate`) — the plan's "default
   * date is inherited from origin" rule. Omitting `date` means undated,
   * which is Inbox's own behaviour.
   */
  addTask: (content: string, overrides?: AddTaskOverrides) => void;
  completeTask: (id: string) => void;
  uncompleteTask: (id: string) => void;
  renameTask: (id: string, content: string) => void;
  reorderTask: (id: string, orderKey: string) => void;
  /** Writes the one `dayOrder` a Today drag computed (issue #182) — use-tasks.ts's own `reorderTaskToday` doc comment. */
  reorderTaskToday: (id: string, dayOrder: string) => void;
  removeTask: (id: string) => void;
  /**
   * The three scheduling setters issue #169 adds (use-tasks.ts's own doc
   * comments carry the reasoning each individually needs). Grouped under
   * `tasks`/`addTask`/etc. above rather than a nested object: every other
   * Task mutation on this context is a flat, top-level field, and a
   * `scheduling: {...}` bag here would be the one field on this interface
   * that reads differently from its neighbours for no reason a caller
   * benefits from.
   */
  setTaskDate: (id: string, date: string | null) => void;
  setTaskDeadline: (id: string, deadline: string | null) => void;
  setTaskPriority: (id: string, priority: number) => void;
  /** Replaces a Task's Labels wholesale — use-tasks.ts's own `setTaskLabels` doc comment. */
  setTaskLabels: (id: string, labelIds: string[]) => void;
  /** Sets a Task's Description (issue #180) — use-tasks.ts's own `setTaskDescription` doc comment. */
  setTaskDescription: (id: string, description: string | null) => void;
  /** A Project's own top-level Tasks (`null` for Inbox) — use-tasks.ts's own `listTasksInProject` doc comment. */
  listTasksInProject: (projectId: string | null) => Promise<Task[]>;
  /** A Task's own direct sub-tasks — use-tasks.ts's own `listTaskChildren` doc comment. */
  listTaskChildren: (parentId: string) => Promise<Task[]>;
  /** A Section's own direct members — use-tasks.ts's own `listTasksInSection` doc comment. */
  listTasksInSection: (sectionId: string) => Promise<Task[]>;
  /** Every descendant of a Task — use-tasks.ts's own `listTaskDescendants` doc comment. */
  listTaskDescendants: (id: string) => Promise<Task[]>;
  /** Issue #170's three recurrence methods — use-tasks.ts's own UseTasksResult doc comments carry the full reasoning for each. */
  advanceRecurringTask: (id: string) => void;
  completeForeverTask: (id: string) => void;
  postponeTask: (id: string) => void;
  /**
   * Todo's Labels (issue #170) — the Label-shaped sibling of `tasks`
   * above, built the same way for the same reason: `useLabels`
   * (use-labels.ts) runs once, here, above every route this layout wraps.
   * `resolveLabelIds` is what add-task-form.tsx's own caller
   * (todo-page.tsx) awaits before it can build a Task literal carrying
   * real `labelIds` at all — see that hook's own doc comment.
   */
  labels: Label[];
  resolveLabelIds: (names: string[]) => Promise<string[]>;
  /**
   * Todo's Comments (issue #180) — the Comment-shaped sibling of `labels`
   * above, built the same way for the same reason: `useComments`
   * (use-comments.ts) runs once, here, above every route this layout
   * wraps. `comments` is the whole, flat, cross-Task list — task-row.tsx's
   * own comment-count badge and the Task detail view's own thread both
   * narrow it client-side (comment-counts.ts) rather than this context
   * growing a second, per-Task field.
   */
  comments: Comment[];
  addComment: (taskId: string, text: string) => void;
  editComment: (id: string, text: string) => void;
  removeComment: (id: string) => void;
  /**
   * Todo's Projects and Sections (issue #171) — the Project-shaped sibling
   * of `labels`/`tasks` above, built the same way for the same reason:
   * `useProjects` (use-projects.ts) runs once, here, above every route
   * this layout wraps. See use-projects.ts's own `UseProjectsResult` doc
   * comments for what each field does — this context simply forwards all
   * of them, exactly as it already does for Tasks and Labels.
   */
  projects: Project[];
  addProject: (name: string, overrides?: AddProjectOverrides) => void;
  renameProject: (id: string, name: string) => void;
  setProjectColour: (id: string, colour: string) => void;
  setProjectDescription: (id: string, description: string | null) => void;
  setProjectFavourite: (id: string, favourite: boolean) => void;
  archiveProject: (id: string) => void;
  unarchiveProject: (id: string) => void;
  setProjectParent: (id: string, parentId: string | null) => Promise<void>;
  reorderProject: (id: string, orderKey: string) => void;
  listSections: (projectId: string) => Promise<Section[]>;
  addSection: (projectId: string, name: string) => Promise<void>;
  renameSection: (id: string, name: string) => void;
  setSectionDescription: (id: string, description: string | null) => void;
  reorderSection: (id: string, orderKey: string) => void;
  deleteSection: (id: string) => void;
  archiveSection: (id: string) => void;
  unarchiveSection: (id: string) => void;
  /** Moves a Task into `projectId` (or back to Inbox for `null`) — TaskStore.setProject's own doc comment, via use-tasks.ts's `setTaskProject`. */
  setTaskProject: (id: string, projectId: string | null) => void;
  /** Files a Task into `sectionId`, or clears it for `null` — TaskStore.setSection's own doc comment, via use-tasks.ts's `setTaskSection`. */
  setTaskSection: (id: string, sectionId: string | null) => void;
  /** Reparents a Task under `parentId`, or to top-level for `null` — use-tasks.ts's own `setTaskParent` doc comment on why this returns a Promise unlike every other Task mutator on this context. */
  setTaskParent: (id: string, parentId: string | null) => Promise<void>;
  disabled: boolean;
  message?: string;
}

// This is the composition root for the sqlite-driver seam (ticket 24): each
// platform file supplies only a driver, and the store is opened here, once,
// rather than duplicated per platform.
async function openEntryStore() {
  const driver = await createDriver();
  return open(driver);
}

// Exported so `SyncLoop` (`use-sync-loop.ts`, ticket 38) can subscribe to
// the exact same query — same key, same queryFn, same options — so the
// cache still opens the store at most once per page load, whichever of the
// two mounts first. `retry` and `retryOnMount` both matter together (see
// the comment below); keeping them in one `queryOptions()` object rather
// than duplicated in two `useQuery` calls means a future change to either
// can't drift between the two call sites.
export const entryStoreQueryOptions = queryOptions({
  queryKey: ENTRY_STORE_QUERY_KEY,
  queryFn: openEntryStore,
  // A Device has exactly one store for the life of a page load (ADR 0001):
  // never stale, never garbage-collected, never retried — a SecondTabError
  // or StorageUnavailableError is not transient, and retrying would mean a
  // second openEntryStore() call spinning up a second Worker competing with
  // the first for the same OPFS pool lock.
  staleTime: Number.POSITIVE_INFINITY,
  gcTime: Number.POSITIVE_INFINITY,
  retry: false,
  // `retry: false` only governs retries within one fetch attempt — it does
  // nothing about `retryOnMount` (default `true`), which re-runs queryFn
  // for a *new* observer of an already-errored query. Without this, a
  // Settings round trip after a failed open remounts EntryStoreLayout,
  // which mounts a fresh observer, which re-fetches — reopening a second
  // Worker against the same OPFS pool lock, exactly what the settings
  // above exist to prevent. Only the error path is affected: a
  // successfully-resolved query is never stale (staleTime: Infinity), so
  // it's already skipped on remount regardless of this setting.
  retryOnMount: false,
});

function describeOpenError(error: unknown): string {
  if (error instanceof SecondTabError) {
    // OPFS allows a single writer per origin (ticket 45). Before installing
    // the PWA was possible, hitting this meant two browser tabs — an edge
    // case a user could just close one of. An installed window plus a
    // browser tab is now the normal steady state, and the second one to
    // open lands here — "tab" would be actively wrong for the installed
    // window, and the old wording ("can't store Entries") read like data
    // loss rather than the ordinary, expected lockout this actually is.
    // Detection is unchanged; only the words.
    return "meologue is already open in another window. Only one window can hold the Entries at a time — close this one, or go back to the other.";
  }
  if (error instanceof StorageUnavailableError) {
    return "meologue can't store Entries here — try a non-private window over HTTPS or localhost.";
  }
  if (error instanceof OpenTimeoutError) {
    // Issue #159: deliberately not the same sentence as the fallback below.
    // A timeout is not a known failure — the store may still be opening
    // (see SqliteWorkerDriver's own comment on why the timeout is generous)
    // or may be stuck forever, and there is no way to tell those apart from
    // here. Saying "couldn't open" would claim more than is actually known;
    // this is the one branch of this function whose whole job is to make a
    // *hung* open look different on screen from a *failed* one, so the
    // reader isn't shown an indefinitely disabled Composer with no
    // explanation at all.
    console.error("meologue: opening the entry store timed out", error);
    return "meologue is taking longer than expected to open its storage. If this doesn't resolve, try reloading.";
  }
  // Reached by WorkerLoadError (the worker script itself failed to load or
  // threw at top level — issue #159) as well as anything else this
  // function doesn't specifically recognize: `error` here is guaranteed to
  // carry more detail than the sentence below does, so it's logged in full
  // rather than only the generic fallback message reaching a developer.
  console.error("meologue: failed to open the entry store", error);
  return "meologue couldn't open its storage. Reloading may help.";
}

function noop() {}

async function noopSearch(): Promise<Entry[]> {
  return [];
}

async function noopGetEntries(): Promise<Entry[]> {
  return [];
}

// Before the store opens there are no Entries to find on any day (`entries:
// []` above already says as much); this is the `dayHasEntries` field's own
// stand-in for that same not-ready state.
async function noopDayHasEntries(): Promise<boolean> {
  return false;
}

// `getEntry`'s own not-ready stand-in, mirroring `noopDayHasEntries` just
// above: nothing can be resolved before the store opens, and `undefined` is
// already this field's own "unresolvable" answer, not a special case for it.
async function noopGetEntry(): Promise<Entry | undefined> {
  return undefined;
}

// `dayReferrers`'s own not-ready stand-in, mirroring `noopDayHasEntries`:
// nothing has Referred to any day before the store opens, and an empty
// array is already this field's own "nothing found" answer.
async function noopDayReferrers(): Promise<Entry[]> {
  return [];
}

// ADR 0028's edit/delete affordances need the store to exist just as much
// as sendEntry does — the not-ready outlet context below stands in with
// these too, for the identical reason: the History rendered while
// `disabled` is true has no Entries to act on anyway (`entries: []`), but
// the context's shape must still satisfy `EntryStoreOutletContext` so a
// page never has to null-check which branch of EntryStoreLayout it's
// under.
function noopEdit(_id: string, _body: string) {}

function noopCommitEntryEdit(_id: string, _body: string) {}

function noopRemove(_entry: Entry) {}

// Todo's own not-ready stand-ins (issue #168), same reasoning as
// `noopEdit`/`noopRemove` just above: the Inbox rendered while `disabled`
// is true has no Tasks to act on (`tasks: []` below), but every field
// `EntryStoreOutletContext` declares still has to exist so `useEntryStore`
// never returns a shape a page has to null-check.
function noopAddTask(_content: string, _overrides?: AddTaskOverrides) {}

function noopCompleteTask(_id: string) {}

function noopUncompleteTask(_id: string) {}

function noopRenameTask(_id: string, _content: string) {}

function noopReorderTask(_id: string, _orderKey: string) {}

function noopReorderTaskToday(_id: string, _dayOrder: string) {}

function noopRemoveTask(_id: string) {}

// Issue #169's three setters — the not-ready stand-ins for a Today view or a
// picker mounted before the store opens, same reasoning as
// noopAddTask/noopReorderTask above.
function noopSetTaskDate(_id: string, _date: string | null) {}

function noopSetTaskDeadline(_id: string, _deadline: string | null) {}

function noopSetTaskPriority(_id: string, _priority: number) {}

// Issue #178's Task detail view — the not-ready stand-in for `setTaskLabels`,
// same reasoning as the four setters just above.
function noopSetTaskLabels(_id: string, _labelIds: string[]) {}

// Issue #180's Task detail view — the not-ready stand-in for
// `setTaskDescription`, same reasoning as the setters just above.
function noopSetTaskDescription(_id: string, _description: string | null) {}

// `listTasksInProject`/`listTaskChildren`'s own not-ready stand-ins,
// mirroring `noopGetEntries`: nothing can be resolved before the store
// opens, and an empty array is already each field's own "nothing found"
// answer.
async function noopListTasksInProject(_projectId: string | null): Promise<Task[]> {
  return [];
}

async function noopListTaskChildren(_parentId: string): Promise<Task[]> {
  return [];
}

async function noopListTasksInSection(_sectionId: string): Promise<Task[]> {
  return [];
}

async function noopListTaskDescendants(_id: string): Promise<Task[]> {
  return [];
}

// Issue #170's three recurrence methods — same not-ready reasoning.
function noopAdvanceRecurringTask(_id: string) {}

function noopCompleteForeverTask(_id: string) {}

function noopPostponeTask(_id: string) {}

// Issue #171's three structural Task setters — same not-ready reasoning.
function noopSetTaskProject(_id: string, _projectId: string | null) {}

function noopSetTaskSection(_id: string, _sectionId: string | null) {}

async function noopSetTaskParent(_id: string, _parentId: string | null): Promise<void> {}

// `labels`'s own not-ready stand-in, mirroring `noopGetEntries`: nothing
// can be resolved before the store opens, and an empty array is already
// this field's own "nothing found" answer.
async function noopResolveLabelIds(_names: string[]): Promise<string[]> {
  return [];
}

// `comments`'s own not-ready stand-ins (issue #180), mirroring
// `noopAddTask`/`noopRemoveTask`: `comments: []` below has nothing to
// act on regardless, but every field `EntryStoreOutletContext` declares
// still has to exist.
function noopAddComment(_taskId: string, _text: string) {}

function noopEditComment(_id: string, _text: string) {}

function noopRemoveComment(_id: string) {}

// Todo's Projects and Sections (issue #171) — same not-ready reasoning as
// `noopAddTask`/`noopRemoveTask` above: `projects: []` below has nothing
// to act on regardless, but every field `EntryStoreOutletContext` declares
// still has to exist.
function noopAddProject(_name: string, _overrides?: AddProjectOverrides) {}

function noopRenameProject(_id: string, _name: string) {}

function noopSetProjectColour(_id: string, _colour: string) {}

function noopSetProjectDescription(_id: string, _description: string | null) {}

function noopSetProjectFavourite(_id: string, _favourite: boolean) {}

function noopArchiveProject(_id: string) {}

function noopUnarchiveProject(_id: string) {}

async function noopSetProjectParent(_id: string, _parentId: string | null): Promise<void> {}

function noopReorderProject(_id: string, _orderKey: string) {}

// `listSections`'s own not-ready stand-in, mirroring `noopGetEntries`:
// nothing can be resolved before the store opens, and an empty array is
// already this field's own "nothing found" answer.
async function noopListSections(_projectId: string): Promise<Section[]> {
  return [];
}

async function noopAddSection(_projectId: string, _name: string): Promise<void> {}

function noopRenameSection(_id: string, _name: string) {}

function noopSetSectionDescription(_id: string, _description: string | null) {}

function noopReorderSection(_id: string, _orderKey: string) {}

function noopDeleteSection(_id: string) {}

function noopArchiveSection(_id: string) {}

function noopUnarchiveSection(_id: string) {}

function noopFetchMore() {}

// Mirrors `entries: []` just above: nothing to page through before the
// store is open, and `hasMore: false` keeps Shell's scroll listener from
// ever calling `noopFetchMore` in the first place (see
// use-pinned-scroll.ts's own `hasMore` guard).
const notReadyPagination: UseHistoryPagination = {
  hasMore: false,
  fetching: false,
  fetchMore: noopFetchMore,
};

// Issue #110's fix, now built on `deferStore` (`@/lib/defer-store.ts`,
// issue #167) rather than nine hand-written forwarding methods: forwards
// every `EntryStore` call to whatever `openEntryStore()` eventually
// resolves to, so `useHistory` (below) has a real `EntryStore` to call from
// this layout's very first render — not just once `data` exists. Nothing
// here ever opens a second store: `promise` is always the same cached
// open, deduplicated by TanStack Query (see this file's own doc comment on
// `entryStoreQueryOptions`), so this reaches the store exclusively through
// the query cache, the same single door that comment already guarantees.
//
// `ENTRY_STORE_METHODS` below is the part `deferStore` type-checks against
// `EntryStore` itself (see `StoreMethodNames`'s own doc comment) — a method
// added to `EntryStore` and not listed here fails to compile, rather than
// silently returning `undefined` the one time a caller races the store's
// own open.
const ENTRY_STORE_METHODS: StoreMethodNames<EntryStore> = {
  list: true,
  upsert: true,
  pending: true,
  getCursor: true,
  setCursor: true,
  search: true,
  edit: true,
  remove: true,
  getMany: true,
};

function deferUntilOpen(promise: Promise<{ store: EntryStore; deviceId: string }>): EntryStore {
  return deferStore(promise, ({ store }) => store, ENTRY_STORE_METHODS);
}

// Issue #168's own reason #167 pulled `deferStore` out of `deferUntilOpen`
// in the first place: a second deferred facade, over the identical open
// promise, needs nothing but a second `select` and a second method list —
// see `defer-store.ts`'s own doc comment.
const TASK_STORE_METHODS: StoreMethodNames<TaskStore> = {
  list: true,
  // Issue #171's four structural queries, added to TaskStore alongside
  // `projectId`/`sectionId`/`parentId` themselves — the identical
  // compile-time checkpoint this registry exists for (see this registry's
  // own comment below on setDate/etc.) applies to these four exactly as
  // it does to every setter.
  listByProject: true,
  listChildren: true,
  listInSection: true,
  listDescendants: true,
  listCompleted: true,
  get: true,
  upsert: true,
  complete: true,
  uncomplete: true,
  rename: true,
  reorder: true,
  // Issue #182's Today-shaped sibling of reorder — the identical
  // compile-time checkpoint as every setter here.
  reorderToday: true,
  remove: true,
  pending: true,
  getCursor: true,
  setCursor: true,
  search: true,
  // Issue #169's three setters, added to TaskStore alongside the scheduling
  // fields themselves — this is the compile-time checkpoint this registry
  // exists for (StoreMethodNames's own doc comment): a method added to
  // TaskStore and not listed here fails `tsc -b` right at this line,
  // rather than silently resolving to `undefined` through `deferStore` the
  // one time a picker calls it before the store finishes opening.
  setDate: true,
  setDeadline: true,
  setPriority: true,
  // Issue #170 adds setLabelIds alongside the Labels feature itself, and
  // its recurrence engine adds three more (../../packages/core/
  // src/task-store.ts's own doc comments have the full reasoning for
  // each): the identical compile-time checkpoint applies to all four.
  setLabelIds: true,
  advanceRecurring: true,
  completeForever: true,
  postpone: true,
  // Issue #171's three structural setters — the identical compile-time
  // checkpoint as every setter above.
  setProject: true,
  setSection: true,
  setParent: true,
  // Issue #180's Description setter — the identical compile-time
  // checkpoint as every setter above.
  setDescription: true,
};

function deferTaskStoreUntilOpen(
  promise: Promise<{ taskStore: TaskStore; deviceId: string }>,
): TaskStore {
  return deferStore(promise, ({ taskStore }) => taskStore, TASK_STORE_METHODS);
}

// Labels (issue #170) — a third deferred facade over the same open
// promise, same reasoning as TASK_STORE_METHODS's own comment: this is
// the compile-time checkpoint that fails `tsc -b` the moment LabelStore
// grows a method this registry doesn't also list.
const LABEL_STORE_METHODS: StoreMethodNames<LabelStore> = {
  list: true,
  get: true,
  upsert: true,
  rename: true,
  setColour: true,
  remove: true,
  pending: true,
  getCursor: true,
  setCursor: true,
};

function deferLabelStoreUntilOpen(
  promise: Promise<{ labelStore: LabelStore; deviceId: string }>,
): LabelStore {
  return deferStore(promise, ({ labelStore }) => labelStore, LABEL_STORE_METHODS);
}

// Projects and Sections (issue #171) — a fourth deferred facade over the
// same open promise, same reasoning as TASK_STORE_METHODS's own comment:
// this is the compile-time checkpoint that fails `tsc -b` the moment
// ProjectStore grows a method this registry doesn't also list.
const PROJECT_STORE_METHODS: StoreMethodNames<ProjectStore> = {
  listProjects: true,
  getProject: true,
  upsertProjects: true,
  renameProject: true,
  setProjectColour: true,
  setProjectDescription: true,
  setProjectFavourite: true,
  archiveProject: true,
  unarchiveProject: true,
  setProjectParent: true,
  reorderProject: true,
  removeProject: true,
  pendingProjects: true,
  getProjectCursor: true,
  setProjectCursor: true,
  listSections: true,
  getSection: true,
  addSection: true,
  // Issue #182's Sync write path for Sections — the identical
  // compile-time checkpoint as every method here.
  upsertSections: true,
  renameSection: true,
  setSectionDescription: true,
  reorderSection: true,
  deleteSection: true,
  archiveSection: true,
  unarchiveSection: true,
  pendingSections: true,
  getSectionCursor: true,
  setSectionCursor: true,
};

function deferProjectStoreUntilOpen(
  promise: Promise<{ projectStore: ProjectStore; deviceId: string }>,
): ProjectStore {
  return deferStore(promise, ({ projectStore }) => projectStore, PROJECT_STORE_METHODS);
}

// Comments (issue #180) — a fifth deferred facade over the same open
// promise, same reasoning as TASK_STORE_METHODS's own comment: this is
// the compile-time checkpoint that fails `tsc -b` the moment CommentStore
// grows a method this registry doesn't also list.
const COMMENT_STORE_METHODS: StoreMethodNames<CommentStore> = {
  list: true,
  listByTask: true,
  get: true,
  upsert: true,
  edit: true,
  remove: true,
  pending: true,
  getCursor: true,
  setCursor: true,
};

function deferCommentStoreUntilOpen(
  promise: Promise<{ commentStore: CommentStore; deviceId: string }>,
): CommentStore {
  return deferStore(promise, ({ commentStore }) => commentStore, COMMENT_STORE_METHODS);
}

/**
 * The composition root for ADR 0001, ADR 0013 and ADR 0047: opens the Entry
 * store and the Task store together (one `open()` call, one shared
 * `SqliteDriver` — ADR 0047's own "no second OPFS lock" decision), and runs
 * `useHistory` and `useTasks` exactly once each, above the routes that read
 * from them — `/`, `/reflect`, `/digest`, `/todo` and `/todo/inbox` (ticket
 * 27, extended by ADR 0020, issue #71 and issue #168; issue #75 deleted
 * `/history`, once a fourth), which all render whatever this layout puts on
 * the outlet context rather than each owning their own store. Settings is a
 * sibling route outside this layout, not a child of it (ADR 0008): it must
 * stay usable even when the store below never reaches "ready", and the only
 * way to guarantee that structurally is to keep it off this component's
 * subtree entirely — unchanged by issue #75 moving Settings into the
 * persistent Nav, since that only changed how a reader reaches `/settings`,
 * not where the route sits in this tree.
 *
 * Opening happens through a TanStack Query query rather than a hand-rolled
 * module-scope promise: its cache gives the same single-open guarantee —
 * `openEntryStore` runs at most once per page load for `ENTRY_STORE_QUERY_KEY`,
 * including across React 19 StrictMode's double-mount and a round trip to
 * Settings and back — without this layout having to memoize anything itself.
 * `SyncLoop` (`use-sync-loop.ts`, ticket 38) subscribes to the exact same
 * `entryStoreQueryOptions` independently, mounted above the router rather
 * than inside this layout, which is what keeps the sync loop running while
 * this layout is unmounted (the user is on Settings).
 *
 * Issue #110: this used to branch on `data` to decide *what to render* — a
 * bare `<Outlet>` while the store was opening, or an inner `<Ready>`
 * component (which called `useHistory` itself) once it was open. That put
 * two different element types in the exact same position in the tree across
 * those two renders, and React only preserves a subtree's state when the
 * type at a given position stays the same — a change unmounts the old one
 * and mounts a fresh one. So every route under here (`/`, `/reflect`,
 * `/digest`) was silently torn down and rebuilt the moment the store
 * finished opening, ~50-100ms after first paint: confirmed directly by a
 * test that renders a probe here, resolves the store open, and watches the
 * probe unmount and remount (entry-store-layout.test.tsx). For most routes
 * that remount is invisible — there's nothing in flight yet to lose. For
 * `/reflect`, landing inside that window aborts a `/v1/reflect` stream that
 * happened to start during it (`activeAbortRef`'s cleanup,
 * reflection-page.tsx runs on *any* unmount, not only a real navigation
 * away).
 *
 * The fix keeps this component's *own* type constant across every render —
 * `<Outlet>` is always the direct, only thing it returns — by calling
 * `useHistory` and `useTasks` unconditionally instead of only once `data`
 * exists. Each needs its own store synchronously, so before `data` resolves
 * they're handed `deferUntilOpen`'s and `deferTaskStoreUntilOpen`'s facades
 * instead of the real ones; once `data` resolves, each is handed its real
 * store directly. Either way, both hooks' own calls run in the same order
 * on every render, so nothing about *this* component's position or type
 * ever changes — its child routes never lose their state to an internal
 * remount again.
 */
export function EntryStoreLayout() {
  const { data, error } = useQuery(entryStoreQueryOptions);

  const message = useMemo(() => (error ? describeOpenError(error) : undefined), [error]);

  // A promise this component settles itself, from `data`/`error` above,
  // rather than one obtained by independently asking TanStack Query to
  // fetch (`fetchQuery`/`ensureQueryData`) — either of those triggers a
  // fresh fetch attempt of their own whenever the query is sitting in an
  // error state, bypassing `retryOnMount: false` (that option only governs
  // `useQuery`'s own observer) and reopening a second Worker against the
  // same OPFS pool lock on exactly the Settings-round-trip-after-a-failed-open
  // path `retryOnMount: false` exists to prevent (see
  // `entryStoreQueryOptions`'s own comment, and the regression test this
  // mistake first failed). Settling this from `data`/`error` instead means
  // it only ever reflects whatever `useQuery` itself already decided to do.
  // `useState`'s lazy initializer runs exactly once per mount, so `deferred`
  // is a stable object for this component's whole lifetime.
  const [deferred] = useState(() => {
    let resolve!: (value: {
      store: EntryStore;
      taskStore: TaskStore;
      labelStore: LabelStore;
      projectStore: ProjectStore;
      commentStore: CommentStore;
      deviceId: string;
    }) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<{
      store: EntryStore;
      taskStore: TaskStore;
      labelStore: LabelStore;
      projectStore: ProjectStore;
      commentStore: CommentStore;
      deviceId: string;
    }>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // A rejection here (the store failed to open) is already surfaced via
    // `message` above — this only stops it from also logging as an
    // unhandled rejection for the common case where nothing ever calls the
    // facade while `disabled: true` keeps every real caller away from it.
    promise.catch(() => {});
    return { promise, resolve, reject };
  });

  // Calling `resolve`/`reject` here, during render, rather than from a
  // `useEffect`: a Promise can only ever settle once, so calling either
  // more than once (a StrictMode double-render in dev, or a render React
  // ends up throwing away) is a harmless no-op — and settling eagerly, on
  // the very render that first sees `data`/`error`, is what lets
  // `useHistory`'s already-in-flight first fetch (started against
  // `pendingStore` below) resolve against the real store the moment it's
  // available, instead of waiting an extra effect tick.
  if (data) {
    deferred.resolve(data);
  } else if (error) {
    deferred.reject(error);
  }

  // `useHistory`'s own fetch, kicked off the moment this facade is first
  // used, captures `deferred.promise` in its closure — that's what lets an
  // attempt that starts before the store opens complete against the real
  // store once it does, with no manual retry.
  const pendingStore = useMemo(() => deferUntilOpen(deferred.promise), [deferred]);
  // `useTasks`'s own equivalent, over the exact same `deferred.promise` —
  // one open, three facades reaching into it (`deferStore`'s own doc
  // comment on `select`).
  const pendingTaskStore = useMemo(() => deferTaskStoreUntilOpen(deferred.promise), [deferred]);
  // `useLabels`'s own equivalent (issue #170) — a third facade over the
  // same one open.
  const pendingLabelStore = useMemo(() => deferLabelStoreUntilOpen(deferred.promise), [deferred]);
  // `useProjects`'s own equivalent (issue #171) — a fourth facade over the
  // same one open.
  const pendingProjectStore = useMemo(
    () => deferProjectStoreUntilOpen(deferred.promise),
    [deferred],
  );
  // `useComments`'s own equivalent (issue #180) — a fifth facade over the
  // same one open.
  const pendingCommentStore = useMemo(
    () => deferCommentStoreUntilOpen(deferred.promise),
    [deferred],
  );

  const store = data?.store ?? pendingStore;
  const taskStore = data?.taskStore ?? pendingTaskStore;
  const labelStore = data?.labelStore ?? pendingLabelStore;
  const projectStore = data?.projectStore ?? pendingProjectStore;
  const commentStore = data?.commentStore ?? pendingCommentStore;
  const deviceId = data?.deviceId ?? "";

  // `useLabels` is called before `useHistory` on purpose: Promotion's own
  // `#Shopping` resolution (`upsertPromotedTasks`, use-history.ts) needs
  // `resolveLabelIds` handed in as `useHistory`'s own fourth argument
  // below, the identical LabelStore round trip `handleAdd` (further down
  // this file) already awaits for the add field's own `%label` tokens.
  const { labels, resolveLabelIds } = useLabels(labelStore, deviceId);

  // Issue #174, ADR 0053: the one-time History backfill, kicked off the
  // moment the real store is open — `backfillTasksFromHistory` itself is
  // what makes running it more than once harmless (its own header
  // comment), but `backfillStarted` still guards against firing it
  // *concurrently* with itself: two overlapping runs would both read the
  // same not-yet-rewritten Entry bodies before either had a chance to
  // write one back, and both would mint a Task for the same checkbox line
  // — the loop guard only protects a line already rewritten by an
  // EARLIER, finished run, not two runs racing each other. A plain ref
  // (not `runTasksBackfillOnce`'s own localStorage flag, which only
  // updates once the whole scan finishes) is what closes that window: it
  // flips the instant this effect decides to start, before the first
  // `await` inside `runTasksBackfillOnce` ever runs, so React's dev-mode
  // double-invoke of a fresh mount's effects can never launch two scans
  // side by side.
  const backfillStarted = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `resolveLabelIds` is read for its current value only, deliberately not a reactive trigger — `backfillStarted` already limits this to one call for the lifetime of this component, so re-running it because a *different* function identity was handed over on a later render would be wrong, not merely redundant.
  useEffect(() => {
    if (data === undefined || backfillStarted.current) {
      return;
    }
    backfillStarted.current = true;
    void runTasksBackfillOnce(
      data.store,
      data.taskStore,
      data.projectStore,
      data.labelStore,
      data.commentStore,
      data.deviceId,
      resolveLabelIds,
    );
  }, [data]);

  const { entries, pagination, sendEntry, editEntry, commitEntryEdit, removeEntry } = useHistory(
    store,
    taskStore,
    projectStore,
    labelStore,
    commentStore,
    deviceId,
    resolveLabelIds,
  );
  const {
    tasks,
    completedTasks,
    addTask,
    completeTask,
    uncompleteTask,
    renameTask,
    reorderTask,
    reorderTaskToday,
    removeTask,
    setTaskDate,
    setTaskDeadline,
    setTaskPriority,
    setTaskLabels,
    setTaskDescription,
    listTasksInProject,
    listTaskChildren,
    listTasksInSection,
    listTaskDescendants,
    advanceRecurringTask,
    completeForeverTask,
    postponeTask,
    setTaskProject,
    setTaskSection,
    setTaskParent,
  } = useTasks(store, taskStore, projectStore, labelStore, commentStore, deviceId);
  const { comments, addComment, editComment, removeComment } = useComments(commentStore, deviceId);
  const {
    projects,
    addProject,
    renameProject,
    setProjectColour,
    setProjectDescription,
    setProjectFavourite,
    archiveProject,
    unarchiveProject,
    setProjectParent,
    reorderProject,
    listSections,
    addSection,
    renameSection,
    setSectionDescription,
    reorderSection,
    deleteSection,
    archiveSection,
    unarchiveSection,
  } = useProjects(projectStore, deviceId);

  return (
    <Outlet
      context={
        data
          ? ({
              entries,
              pagination,
              sendEntry,
              search: (query: string) => store.search(query),
              getEntries: (ids: string[]) => store.getMany(ids),
              dayHasEntries: (dayKey: string) =>
                dayHasEntries(store, dayKey, deviceUtcOffsetMinutes()),
              dayReferrers: (dayKey: string) =>
                dayReferrers(store, dayKey, deviceUtcOffsetMinutes()),
              getEntry: (entryId: string) => store.getMany([entryId]).then((found) => found.at(0)),
              editEntry,
              commitEntryEdit,
              removeEntry,
              tasks,
              completedTasks,
              addTask,
              completeTask,
              uncompleteTask,
              renameTask,
              reorderTask,
              reorderTaskToday,
              removeTask,
              setTaskDate,
              setTaskDeadline,
              setTaskPriority,
              setTaskLabels,
              setTaskDescription,
              listTasksInProject,
              listTaskChildren,
              listTasksInSection,
              listTaskDescendants,
              advanceRecurringTask,
              completeForeverTask,
              postponeTask,
              setTaskProject,
              setTaskSection,
              setTaskParent,
              labels,
              resolveLabelIds,
              comments,
              addComment,
              editComment,
              removeComment,
              projects,
              addProject,
              renameProject,
              setProjectColour,
              setProjectDescription,
              setProjectFavourite,
              archiveProject,
              unarchiveProject,
              setProjectParent,
              reorderProject,
              listSections,
              addSection,
              renameSection,
              setSectionDescription,
              reorderSection,
              deleteSection,
              archiveSection,
              unarchiveSection,
              disabled: false,
            } satisfies EntryStoreOutletContext)
          : ({
              entries: [],
              pagination: notReadyPagination,
              sendEntry: noop,
              search: noopSearch,
              getEntries: noopGetEntries,
              dayHasEntries: noopDayHasEntries,
              dayReferrers: noopDayReferrers,
              getEntry: noopGetEntry,
              editEntry: noopEdit,
              commitEntryEdit: noopCommitEntryEdit,
              removeEntry: noopRemove,
              tasks: [],
              completedTasks: [],
              addTask: noopAddTask,
              completeTask: noopCompleteTask,
              uncompleteTask: noopUncompleteTask,
              renameTask: noopRenameTask,
              reorderTask: noopReorderTask,
              reorderTaskToday: noopReorderTaskToday,
              removeTask: noopRemoveTask,
              setTaskDate: noopSetTaskDate,
              setTaskDeadline: noopSetTaskDeadline,
              setTaskPriority: noopSetTaskPriority,
              setTaskLabels: noopSetTaskLabels,
              setTaskDescription: noopSetTaskDescription,
              listTasksInProject: noopListTasksInProject,
              listTaskChildren: noopListTaskChildren,
              listTasksInSection: noopListTasksInSection,
              listTaskDescendants: noopListTaskDescendants,
              advanceRecurringTask: noopAdvanceRecurringTask,
              completeForeverTask: noopCompleteForeverTask,
              postponeTask: noopPostponeTask,
              setTaskProject: noopSetTaskProject,
              setTaskSection: noopSetTaskSection,
              setTaskParent: noopSetTaskParent,
              labels: [],
              resolveLabelIds: noopResolveLabelIds,
              comments: [],
              addComment: noopAddComment,
              editComment: noopEditComment,
              removeComment: noopRemoveComment,
              projects: [],
              addProject: noopAddProject,
              renameProject: noopRenameProject,
              setProjectColour: noopSetProjectColour,
              setProjectDescription: noopSetProjectDescription,
              setProjectFavourite: noopSetProjectFavourite,
              archiveProject: noopArchiveProject,
              unarchiveProject: noopUnarchiveProject,
              setProjectParent: noopSetProjectParent,
              reorderProject: noopReorderProject,
              listSections: noopListSections,
              addSection: noopAddSection,
              renameSection: noopRenameSection,
              setSectionDescription: noopSetSectionDescription,
              reorderSection: noopReorderSection,
              deleteSection: noopDeleteSection,
              archiveSection: noopArchiveSection,
              unarchiveSection: noopUnarchiveSection,
              disabled: true,
              message,
            } satisfies EntryStoreOutletContext)
      }
    />
  );
}

/** Read by `/`, `/reflect`, `/todo` and `/todo/inbox` (`/digest` reads nothing from the store — see this file's own comment above) — anything rendered outside EntryStoreLayout's Outlet must not call this. */
export function useEntryStore(): EntryStoreOutletContext {
  return useOutletContext<EntryStoreOutletContext>();
}
