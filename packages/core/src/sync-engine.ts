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
import { PROTOCOL_VERSION, SYNC_BATCH_SIZE } from "./protocol";
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

  let batchWasFull = true;
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

    const response = await transport({
      protocol_version: PROTOCOL_VERSION,
      device_id: deviceId,
      since_seq: cursor,
      entries: pending.map(toWireEntryInput),
      since_task_seq: taskCursor,
      tasks: pendingTasks.map(toWireTaskInput),
      since_project_seq: projectCursor,
      projects: pendingProjects.map(toWireProjectInput),
      since_section_seq: sectionCursor,
      sections: pendingSections.map(toWireSectionInput),
      since_label_seq: labelCursor,
      labels: pendingLabels.map(toWireLabelInput),
      since_comment_seq: commentCursor,
      comments: pendingComments.map(toWireCommentInput),
      since_event_seq: eventCursor,
      events: pendingEvents.map(toWireEventInput),
    });

    if (response.entries.length > 0) {
      const syncedAt = now();
      await store.upsert(response.entries.map((entry) => fromWireEntryOutput(entry, syncedAt)));
    }
    if (response.cursor > cursor) {
      await store.setCursor(response.cursor);
    }

    if (response.tasks.length > 0) {
      const syncedAt = now();
      // Looked up per incoming Task, not read off `pendingTasks`/some
      // other snapshot already in scope: an echoed Task's own row may
      // have been pending or may not (the Server can echo a Task this
      // Device never pushed, ADR 0051's whole "converge" point), and
      // this Device's current copy is the only thing that can answer
      // "what does this Device already hold for a field the wire doesn't
      // carry" — mapping.ts's fromWireTaskOutput own doc comment on why
      // that question still has to be askable even though no field on
      // Task needs it answered right now. `get()` returns `undefined`
      // for a Task this Device has never seen, or has since tombstoned —
      // both cases correctly have nothing local to carry through.
      const incomingTasks = await Promise.all(
        response.tasks.map(async (wireTask) => {
          const existing = await taskStore.get(wireTask.id);
          return fromWireTaskOutput(wireTask, syncedAt, existing);
        }),
      );
      await taskStore.upsert(incomingTasks);
    }
    if (response.task_cursor > taskCursor) {
      await taskStore.setCursor(response.task_cursor);
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

    if (response.sections.length > 0) {
      const syncedAt = now();
      // `upsertProjects` and `upsertSections` are two calls against the one
      // `projectStore`, mirroring how `store`/`taskStore` are already two
      // calls against two different stores — Section is folded into
      // ProjectStore (../project-store.ts's own header comment), not into
      // Project's own upsert, so a Section's own bulk-merge write stays
      // its own method rather than smuggled into upsertProjects above.
      await projectStore.upsertSections(
        response.sections.map((section) => fromWireSectionOutput(section, syncedAt)),
      );
    }
    if (response.section_cursor > sectionCursor) {
      await projectStore.setSectionCursor(response.section_cursor);
    }

    if (response.labels.length > 0) {
      const syncedAt = now();
      await labelStore.upsert(response.labels.map((label) => fromWireLabelOutput(label, syncedAt)));
    }
    if (response.label_cursor > labelCursor) {
      await labelStore.setCursor(response.label_cursor);
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

    if (response.events.length > 0) {
      const syncedAt = now();
      await eventStore.upsert(response.events.map((event) => fromWireEventOutput(event, syncedAt)));
    }
    if (response.event_cursor > eventCursor) {
      await eventStore.setCursor(response.event_cursor);
    }

    batchWasFull =
      response.entries.length >= SYNC_BATCH_SIZE ||
      response.tasks.length >= SYNC_BATCH_SIZE ||
      response.projects.length >= SYNC_BATCH_SIZE ||
      response.sections.length >= SYNC_BATCH_SIZE ||
      response.labels.length >= SYNC_BATCH_SIZE ||
      response.comments.length >= SYNC_BATCH_SIZE ||
      response.events.length >= SYNC_BATCH_SIZE;
  }
}
