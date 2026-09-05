import type { CommentStore } from "./comment-store";
import type { EventStore } from "./event-store";
import type { LabelStore } from "./label-store";
import {
  fromWireCommentOutput,
  fromWireEntryOutput,
  fromWireEventOutput,
  fromWireLabelOutput,
  fromWireProjectOutput,
  fromWireSectionOutput,
  fromWireTaskOutput,
  toWireCommentInput,
  toWireEntryInput,
  toWireEventInput,
  toWireLabelInput,
  toWireProjectInput,
  toWireSectionInput,
  toWireTaskInput,
} from "./mapping";
import type { ProjectStore } from "./project-store";
import { PROTOCOL_VERSION, ROW_SHAPE_EPOCH, SYNC_BATCH_SIZE } from "./protocol";
import type { EntryStore } from "./store";
import type { TaskStore } from "./task-store";
import type { WireSyncRequest, WireSyncResponse } from "./wire";

export type SyncTransport = (request: WireSyncRequest) => Promise<WireSyncResponse>;

export interface SyncEngineOptions {
  store: EntryStore;
  /**
   * Issue #172 / ADR 0051: Sync's second entity stream, alongside `store`
   * above. Required, not optional — every real caller already has one
   * (ADR 0047's Consequences: `TaskStore` sits over the identical shared
   * `SqliteDriver` an `EntryStore` does, opened once, in the same place),
   * and an optional field here would let a future caller quietly build a
   * Sync loop that pushes and pulls Entries while silently never touching
   * Tasks — the exact kind of drift ADR 0051's "one endpoint, one round
   * trip" decision exists to rule out structurally rather than by
   * convention.
   */
  taskStore: TaskStore;
  /**
   * Issue #182: Sync's third and fourth entity streams — Projects and
   * Sections, both folded into `ProjectStore` (../project-store.ts's own
   * header comment explains why Section has no store of its own). Required
   * for the identical reason `taskStore` above is.
   */
  projectStore: ProjectStore;
  /** Issue #182: Sync's fifth entity stream. Required, mirroring `taskStore`. */
  labelStore: LabelStore;
  /** Issue #182: Sync's sixth entity stream. Required, mirroring `taskStore`. */
  commentStore: CommentStore;
  /**
   * Issue #184: Sync's seventh entity stream, Todo's own activity log —
   * required, mirroring `taskStore`. Landed additively inside protocol 6
   * (no wire-protocol bump — server/src/sync.rs's own `PROTOCOL_VERSION`
   * doc comment), but this option is exactly as required as every stream
   * above it: the identical "no future caller can quietly build a loop
   * that pushes and pulls everything else while silently never touching
   * Events" reasoning `taskStore`'s own doc comment states.
   */
  eventStore: EventStore;
  transport: SyncTransport;
  deviceId: string;
  /** Injected so tests can control the timestamp recorded as syncedAt. */
  now?: () => string;
}

/**
 * Runs push and pull as a single loop: pending Entries, Tasks, Projects,
 * Sections, Labels, Comments and Events all go out in the same request,
 * everything that comes back (including this Device's own, now-confirmed
 * rows) is upserted into its own store, and every Cursor advances — one
 * endpoint, one round trip (ADR 0051), so a Task and the Entry referencing
 * it (or a Project and the Task naming it, or a Task and the Event
 * recording what happened to it) always arrive together rather than
 * leaving a window where one exists on this Device and the other doesn't
 * yet. Repeats immediately while *any* stream's response batch is full,
 * since a full batch on one means there's more of *that* stream waiting on
 * the server — the next request re-pushes nothing new for an
 * already-drained stream (its `pending()` is empty by then) and simply
 * keeps paging the others forward.
 *
 * Before any of that: issue #186 / ADR 0057's catch-up runs once, for
 * every stream, comparing `protocol.ts`'s `ROW_SHAPE_EPOCH` against what
 * each store itself last recorded catching up to
 * (`catchUpRowShapeEpoch`/`catchUpProjectRowShapeEpoch`/
 * `catchUpSectionRowShapeEpoch` — see `EntryStore.catchUpRowShapeEpoch`'s
 * own doc comment, `store.ts`, for the mechanism). This is a single local
 * comparison per stream, not a request, so it costs nothing on an
 * ordinary sync where no stream's row shape has changed; the one time it
 * does find a stream behind, it resets that stream's own Cursor to 0
 * before the `while` loop below ever reads it; from there, nothing below
 * has to know a catch-up happened at all — a Cursor of 0 and a full
 * backlog is the same shape this loop already handles for a Device that
 * has never synced.
 *
 * **Issue #194, two changes to the loop body itself:**
 *
 * - Each stream's own `pending()` result is sliced to at most
 *   `SYNC_BATCH_SIZE` rows before it goes into the request body — reads
 *   have always been paged this way (`SYNC_BATCH_SIZE`, "repeat while a
 *   batch comes back full"), but a push, until now, sent every pending row
 *   across all seven streams in one body with no limit, against the
 *   Server's own default body-size cap: a Device with a large-enough
 *   backlog (Merge, or simply a long stretch offline) would fail the
 *   *whole* round trip — pull included — with no partial progress. Any
 *   stream whose `pending()` came back longer than the slice sets
 *   `pushWasFull`, which folds into the loop's own continuation check
 *   exactly like a full response batch already does: there's more of that
 *   stream still waiting locally, so the loop doesn't stop just because
 *   this round trip's *response* batches all came back short.
 * - `server/src/sync.rs`'s `run_sync` now echoes back the current server
 *   row for every id each stream's request actually pushed —
 *   `response.acknowledged_*` — whether or not anything about that row
 *   changed (`SyncResponse::acknowledged_entries`'s own doc comment,
 *   server-side). Each stream upserts its own `acknowledged_*` rows before
 *   the ordinary Cursor-read rows below: this is what makes a push
 *   `pending()` forever after a byte-identical re-edit (the bug issue #194
 *   exists to fix) — a no-op replay reassigns no `seq` and so never
 *   surfaces in the Cursor-paged array, but it always surfaces here,
 *   because the acknowledgement is keyed by "what did this request push,"
 *   not by "what changed." `acknowledged_*` rows never advance any
 *   Cursor — see this function's own no-progress guard below for the one
 *   place that distinction actually matters.
 *
 * **The no-progress guard**, evaluated at the top of every iteration after
 * the first: if the previous iteration pushed at least one row, its
 * response's Cursor-paged batches were all short (so nothing forced
 * another round on *read* grounds), and the total pending count across
 * every stream hasn't gone down since, the loop breaks instead of running
 * another iteration. This is a backstop, not the mechanism this ticket's
 * correctness rests on — an honest server always acknowledges what it
 * received, and `pending()` always drops as a result — it exists purely
 * against a *future* server build that stops populating `acknowledged_*`
 * with real rows (a regression this ticket has no way to prevent at the
 * type level, since the array is always present on the wire — nothing
 * stops a future server from sending it back empty) turning what should
 * be a fixed bug back into the identical infinite-repush loop issue #194
 * was filed to close, just with an infinite tight loop of *requests*
 * standing in for the original bug's infinite loop of *ticks*.
 */
export async function sync(options: SyncEngineOptions): Promise<void> {
  const {
    store,
    taskStore,
    projectStore,
    labelStore,
    commentStore,
    eventStore,
    transport,
    deviceId,
  } = options;
  const now = options.now ?? (() => new Date().toISOString());

  await Promise.all([
    store.catchUpRowShapeEpoch(ROW_SHAPE_EPOCH.entries),
    taskStore.catchUpRowShapeEpoch(ROW_SHAPE_EPOCH.tasks),
    projectStore.catchUpProjectRowShapeEpoch(ROW_SHAPE_EPOCH.projects),
    projectStore.catchUpSectionRowShapeEpoch(ROW_SHAPE_EPOCH.sections),
    labelStore.catchUpRowShapeEpoch(ROW_SHAPE_EPOCH.labels),
    commentStore.catchUpRowShapeEpoch(ROW_SHAPE_EPOCH.comments),
    eventStore.catchUpRowShapeEpoch(ROW_SHAPE_EPOCH.events),
  ]);

  // Looked up per incoming Task, whether it arrives via `acknowledged_tasks`
  // or via the ordinary Cursor-paged `tasks` below, and not read off
  // `pendingTasks`/some other snapshot already in scope: an echoed Task's
  // own row may have been pending or may not (the Server can echo a Task
  // this Device never pushed, ADR 0051's whole "converge" point), and this
  // Device's current copy is the only thing that can answer "what does
  // this Device already hold for a field the wire doesn't carry" —
  // mapping.ts's fromWireTaskOutput own doc comment on why that question
  // still has to be askable even though no field on Task needs it answered
  // right now. `get()` returns `undefined` for a Task this Device has
  // never seen, or has since tombstoned — both cases correctly have
  // nothing local to carry through. Factored out once (issue #194) because
  // `acknowledged_tasks` and `tasks` both need it, in that order, every
  // iteration.
  async function applyIncomingTasks(wireTasks: WireSyncResponse["tasks"]): Promise<void> {
    if (wireTasks.length === 0) {
      return;
    }
    const syncedAt = now();
    const incomingTasks = await Promise.all(
      wireTasks.map(async (wireTask) => {
        const existing = await taskStore.get(wireTask.id);
        return fromWireTaskOutput(wireTask, syncedAt, existing);
      }),
    );
    await taskStore.upsert(incomingTasks);
  }

  let batchWasFull = true;
  // Issue #194's no-progress guard: state carried from the previous
  // iteration, read at the top of this one, before this iteration pushes
  // anything of its own. `null` on the very first iteration — there is no
  // previous iteration's push to have failed, so the guard can't fire yet.
  let previousIterationPushedSomething = false;
  let previousIterationResponseBatchWasFull = false;
  let previousTotalPending: number | null = null;

  while (batchWasFull) {
    const [
      pending,
      cursor,
      pendingTasks,
      taskCursor,
      pendingProjects,
      projectCursor,
      pendingSections,
      sectionCursor,
      pendingLabels,
      labelCursor,
      pendingComments,
      commentCursor,
      pendingEvents,
      eventCursor,
    ] = await Promise.all([
      store.pending(),
      store.getCursor(),
      taskStore.pending(),
      taskStore.getCursor(),
      projectStore.pendingProjects(),
      projectStore.getProjectCursor(),
      projectStore.pendingSections(),
      projectStore.getSectionCursor(),
      labelStore.pending(),
      labelStore.getCursor(),
      commentStore.pending(),
      commentStore.getCursor(),
      eventStore.pending(),
      eventStore.getCursor(),
    ]);

    const totalPending =
      pending.length +
      pendingTasks.length +
      pendingProjects.length +
      pendingSections.length +
      pendingLabels.length +
      pendingComments.length +
      pendingEvents.length;

    // See this function's own doc comment for the full reasoning — this
    // is the backstop against a future server that stops populating
    // `acknowledged_*`, not the mechanism this ticket's correctness rests
    // on. `previousTotalPending` is only ever set below, after an
    // iteration that pushed at least one row, so this can't fire on the
    // first iteration or after one that pushed nothing.
    if (
      previousIterationPushedSomething &&
      !previousIterationResponseBatchWasFull &&
      previousTotalPending !== null &&
      totalPending >= previousTotalPending
    ) {
      break;
    }

    // Issue #194: cap what this iteration actually pushes at
    // `SYNC_BATCH_SIZE` per stream, mirroring the cap reads have always
    // had (`SYNC_BATCH_SIZE`, the response side's own "repeat while a
    // batch comes back full"). `pending()` itself is unbounded — it
    // returns every locally-unsynced row a Device holds, which nothing
    // has ever policed at the client boundary until now — so a large
    // enough backlog on even one stream would otherwise build a request
    // body past the Server's own default size cap and fail the *whole*
    // round trip, pull included, with no partial progress.
    const entriesToPush = pending.slice(0, SYNC_BATCH_SIZE);
    const tasksToPush = pendingTasks.slice(0, SYNC_BATCH_SIZE);
    const projectsToPush = pendingProjects.slice(0, SYNC_BATCH_SIZE);
    const sectionsToPush = pendingSections.slice(0, SYNC_BATCH_SIZE);
    const labelsToPush = pendingLabels.slice(0, SYNC_BATCH_SIZE);
    const commentsToPush = pendingComments.slice(0, SYNC_BATCH_SIZE);
    const eventsToPush = pendingEvents.slice(0, SYNC_BATCH_SIZE);

    // True when at least one stream's own backlog didn't fit in this
    // iteration's push — there is more of *that* stream still waiting
    // locally, so the loop must not stop just because every response
    // batch this round trip happened to come back short (the pre-existing
    // `batchWasFull` check below only ever looked at what came *back*).
    const pushWasFull =
      pending.length > SYNC_BATCH_SIZE ||
      pendingTasks.length > SYNC_BATCH_SIZE ||
      pendingProjects.length > SYNC_BATCH_SIZE ||
      pendingSections.length > SYNC_BATCH_SIZE ||
      pendingLabels.length > SYNC_BATCH_SIZE ||
      pendingComments.length > SYNC_BATCH_SIZE ||
      pendingEvents.length > SYNC_BATCH_SIZE;

    const response = await transport({
      protocol_version: PROTOCOL_VERSION,
      device_id: deviceId,
      since_seq: cursor,
      entries: entriesToPush.map(toWireEntryInput),
      since_task_seq: taskCursor,
      tasks: tasksToPush.map(toWireTaskInput),
      since_project_seq: projectCursor,
      projects: projectsToPush.map(toWireProjectInput),
      since_section_seq: sectionCursor,
      sections: sectionsToPush.map(toWireSectionInput),
      since_label_seq: labelCursor,
      labels: labelsToPush.map(toWireLabelInput),
      since_comment_seq: commentCursor,
      comments: commentsToPush.map(toWireCommentInput),
      since_event_seq: eventCursor,
      events: eventsToPush.map(toWireEventInput),
    });

    // Issue #194: `acknowledged_*` applied first, then the ordinary
    // Cursor-read arrays below — both ultimately upsert the identical
    // shape of row through the identical `fromWire*Output` path, so
    // applying one before the other is never a correctness question, only
    // an ordering one, and applying the acknowledgement first is what
    // clears `pending()` even on an iteration whose Cursor-read arrays
    // don't happen to carry this Device's own rows back at all (this
    // module's own doc comment on why the Cursor-paged read alone can't be
    // relied on for that). Neither loop ever touches a Cursor — see this
    // function's own doc comment for why an acknowledgement must not
    // advance one.
    if (response.acknowledged_entries.length > 0) {
      const syncedAt = now();
      await store.upsert(
        response.acknowledged_entries.map((entry) => fromWireEntryOutput(entry, syncedAt)),
      );
    }
    if (response.entries.length > 0) {
      const syncedAt = now();
      await store.upsert(response.entries.map((entry) => fromWireEntryOutput(entry, syncedAt)));
    }
    if (response.cursor > cursor) {
      await store.setCursor(response.cursor);
    }

    await applyIncomingTasks(response.acknowledged_tasks);
    await applyIncomingTasks(response.tasks);
    if (response.task_cursor > taskCursor) {
      await taskStore.setCursor(response.task_cursor);
    }

    if (response.acknowledged_projects.length > 0) {
      const syncedAt = now();
      await projectStore.upsertProjects(
        response.acknowledged_projects.map((project) => fromWireProjectOutput(project, syncedAt)),
      );
    }
    if (response.projects.length > 0) {
      const syncedAt = now();
      await projectStore.upsertProjects(
        response.projects.map((project) => fromWireProjectOutput(project, syncedAt)),
      );
    }
    if (response.project_cursor > projectCursor) {
      await projectStore.setProjectCursor(response.project_cursor);
    }

    // `upsertProjects` and `upsertSections` are two calls against the one
    // `projectStore`, mirroring how `store`/`taskStore` are already two
    // calls against two different stores — Section is folded into
    // ProjectStore (../project-store.ts's own header comment), not into
    // Project's own upsert, so a Section's own bulk-merge write stays its
    // own method rather than smuggled into upsertProjects above.
    if (response.acknowledged_sections.length > 0) {
      const syncedAt = now();
      await projectStore.upsertSections(
        response.acknowledged_sections.map((section) => fromWireSectionOutput(section, syncedAt)),
      );
    }
    if (response.sections.length > 0) {
      const syncedAt = now();
      await projectStore.upsertSections(
        response.sections.map((section) => fromWireSectionOutput(section, syncedAt)),
      );
    }
    if (response.section_cursor > sectionCursor) {
      await projectStore.setSectionCursor(response.section_cursor);
    }

    if (response.acknowledged_labels.length > 0) {
      const syncedAt = now();
      await labelStore.upsert(
        response.acknowledged_labels.map((label) => fromWireLabelOutput(label, syncedAt)),
      );
    }
    if (response.labels.length > 0) {
      const syncedAt = now();
      await labelStore.upsert(response.labels.map((label) => fromWireLabelOutput(label, syncedAt)));
    }
    if (response.label_cursor > labelCursor) {
      await labelStore.setCursor(response.label_cursor);
    }

    if (response.acknowledged_comments.length > 0) {
      const syncedAt = now();
      await commentStore.upsert(
        response.acknowledged_comments.map((comment) => fromWireCommentOutput(comment, syncedAt)),
      );
    }
    if (response.comments.length > 0) {
      const syncedAt = now();
      await commentStore.upsert(
        response.comments.map((comment) => fromWireCommentOutput(comment, syncedAt)),
      );
    }
    if (response.comment_cursor > commentCursor) {
      await commentStore.setCursor(response.comment_cursor);
    }

    if (response.acknowledged_events.length > 0) {
      const syncedAt = now();
      await eventStore.upsert(
        response.acknowledged_events.map((event) => fromWireEventOutput(event, syncedAt)),
      );
    }
    if (response.events.length > 0) {
      const syncedAt = now();
      await eventStore.upsert(response.events.map((event) => fromWireEventOutput(event, syncedAt)));
    }
    if (response.event_cursor > eventCursor) {
      await eventStore.setCursor(response.event_cursor);
    }

    const responseBatchWasFull =
      response.entries.length >= SYNC_BATCH_SIZE ||
      response.tasks.length >= SYNC_BATCH_SIZE ||
      response.projects.length >= SYNC_BATCH_SIZE ||
      response.sections.length >= SYNC_BATCH_SIZE ||
      response.labels.length >= SYNC_BATCH_SIZE ||
      response.comments.length >= SYNC_BATCH_SIZE ||
      response.events.length >= SYNC_BATCH_SIZE;
    batchWasFull = responseBatchWasFull || pushWasFull;

    previousIterationPushedSomething =
      entriesToPush.length > 0 ||
      tasksToPush.length > 0 ||
      projectsToPush.length > 0 ||
      sectionsToPush.length > 0 ||
      labelsToPush.length > 0 ||
      commentsToPush.length > 0 ||
      eventsToPush.length > 0;
    previousIterationResponseBatchWasFull = responseBatchWasFull;
    previousTotalPending = totalPending;
  }
}
