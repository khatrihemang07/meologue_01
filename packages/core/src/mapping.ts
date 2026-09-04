import type { Comment } from "./comment-types";
import type { Event } from "./event-types";
import type { Label } from "./label-types";
import type { Project, Section } from "./project-types";
import type { Task } from "./task-types";
import type { Entry } from "./types";
import type {
  WireCommentInput,
  WireCommentOutput,
  WireEntryInput,
  WireEntryOutput,
  WireEventInput,
  WireEventOutput,
  WireLabelInput,
  WireLabelOutput,
  WireProjectInput,
  WireProjectOutput,
  WireSectionInput,
  WireSectionOutput,
  WireTaskInput,
  WireTaskOutput,
} from "./wire";

export function toWireEntryInput(entry: Entry): WireEntryInput {
  return {
    id: entry.id,
    device_id: entry.deviceId,
    body: entry.body,
    created_at: entry.createdAt,
    deleted_at: entry.deletedAt,
  };
}

export function fromWireEntryOutput(output: WireEntryOutput, syncedAt: string): Entry {
  return {
    id: output.id,
    deviceId: output.device_id,
    body: output.body,
    createdAt: output.created_at,
    seq: output.seq,
    syncedAt,
    // `deleted_at` is optional on the wire type (absent and null both mean
    // "not a tombstone") — normalise the absent case to null so Entry's
    // own deletedAt is never undefined (ADR 0028).
    deletedAt: output.deleted_at ?? null,
  };
}

/**
 * The Task-shaped sibling of toWireEntryInput/fromWireEntryOutput above
 * (issue #172 / ADR 0051 — the second entity stream). Every field is a
 * direct camelCase-to-snake_case rename with no reshaping: a Task's
 * `projectId`/`sectionId`/`parentId`/`labelIds` cross a Project, Section
 * or Label that this ticket does not sync (ADR 0051's own decision on an
 * unresolved reference), so this function has no business validating or
 * rewriting them — it carries whatever id the caller already has straight
 * onto the wire, honest and unresolved, the same way it already carries
 * `content` without checking whether the words make sense.
 */
export function toWireTaskInput(task: Task): WireTaskInput {
  return {
    id: task.id,
    device_id: task.deviceId,
    content: task.content,
    completed_at: task.completedAt,
    order_key: task.orderKey,
    // Today's own manual order (issue #182, task-types.ts's own
    // `dayOrder` doc comment) — a second, independent fractional index,
    // carried onto the wire exactly like `order_key` above it: opaque
    // text, no reshaping, no validation.
    day_order: task.dayOrder,
    created_at: task.createdAt,
    deleted_at: task.deletedAt,
    date: task.date,
    deadline: task.deadline,
    priority: task.priority,
    label_ids: task.labelIds,
    date_string: task.dateString,
    project_id: task.projectId,
    section_id: task.sectionId,
    parent_id: task.parentId,
    description: task.description,
  };
}

/**
 * See toWireTaskInput's own doc comment for the reshaping rule this
 * mirrors (none). `?? null` on every nullable field follows
 * fromWireEntryOutput's own convention above — a field absent on the wire
 * and a field explicitly `null` both mean the identical thing to this
 * Task's own fields, which are required-and-nullable, never `?`-optional
 * (../task-types.ts's own doc comment on why: an omitted key must never
 * silently default one way or the other without a caller saying so).
 * `withDefaultSchedulingFields`/`withDefaultLabelIds`/`withDefaultDateString`/
 * `withDefaultStructureFields`/`withDefaultDescription`/`withDefaultDayOrder`
 * (../task-fields.ts, ../label-fields.ts) are the *second* safety net a
 * Task arriving over Sync passes through, inside each TaskStore.upsert()
 * — this function is the first, and the two exist for different reasons:
 * this one turns "absent on the wire" into "null, a real value," and the
 * store-level defaulters turn "an even older client never sent this key
 * at all" into whichever default that ticket's own Task doc comment
 * names. Neither makes the other redundant.
 *
 * **`existing` exists for one reason only: a field on `Task` that
 * genuinely has no wire representation yet.** `description` (#180) and
 * `dayOrder` (issue #182) both needed it for a while, in turn, and both
 * are ordinary `output.field ?? null`/`output.field` lines above and
 * below like any other by the time this comment is being read — see this
 * file's own git history for the workaround each one was, and why it
 * could finally retire: `TaskStore.upsert()` (ADR 0047's own "there is
 * deliberately no `add()`" — Sync's pull applies an incoming Task by
 * overwriting the whole row) cannot tell "the wire confirms this Task has
 * no such value" apart from "the wire has nothing to say about this field
 * at all," so a field with no wire counterpart has to be read off a
 * Device's own existing copy instead of off `output`, or the *first*
 * upsert() of any ordinary, unrelated field change would silently
 * overwrite it with something invented.
 *
 * **No field uses `existing` right now, and that is the expected steady
 * state, not a sign the parameter is dead.** The day `Task` next grows a
 * field that ships ahead of its own wire support — #184's own activity
 * stream is a new stream, not this shape, but whatever comes after it
 * might not be — that field's line here reads `existing?.newField ?? <a
 * sensible bootstrap>` instead of `output.new_field`, and every other line
 * stays exactly as it is. **This is the one place that treatment belongs
 * — not in sync-engine.ts's own call site**, which has no way to know
 * which of a Task's many fields are wire-covered and which aren't, and
 * must not have to remember.
 */
export function fromWireTaskOutput(
  output: WireTaskOutput,
  syncedAt: string,
  existing: Task | undefined,
): Task {
  // `existing` is read by nothing below right now — see this function's
  // own doc comment for why the parameter stays anyway. The `void` is
  // this file's own acknowledgement of that, not a change of behaviour:
  // without it, apps/web's stricter `noUnusedParameters` build flags a
  // parameter this function deliberately keeps dormant as if it were a
  // mistake.
  void existing;
  return {
    id: output.id,
    deviceId: output.device_id,
    content: output.content,
    completedAt: output.completed_at ?? null,
    orderKey: output.order_key,
    dayOrder: output.day_order,
    createdAt: output.created_at,
    seq: output.seq,
    syncedAt,
    deletedAt: output.deleted_at ?? null,
    date: output.date ?? null,
    deadline: output.deadline ?? null,
    priority: output.priority,
    labelIds: output.label_ids,
    dateString: output.date_string ?? null,
    projectId: output.project_id ?? null,
    sectionId: output.section_id ?? null,
    parentId: output.parent_id ?? null,
    description: output.description ?? null,
  };
}

/**
 * The Project-shaped sibling of toWireTaskInput/fromWireTaskOutput above
 * (issue #182 / ADR 0051 — Sync's third entity stream). No reshaping,
 * mirroring toWireTaskInput's own doc comment: `parentId` names a Project
 * this ticket does not validate, carried straight through honest and
 * unresolved.
 */
export function toWireProjectInput(project: Project): WireProjectInput {
  return {
    id: project.id,
    device_id: project.deviceId,
    name: project.name,
    colour: project.colour,
    favourite: project.favourite,
    archived: project.archived,
    parent_id: project.parentId,
    description: project.description,
    order_key: project.orderKey,
    created_at: project.createdAt,
    deleted_at: project.deletedAt,
  };
}

export function fromWireProjectOutput(output: WireProjectOutput, syncedAt: string): Project {
  return {
    id: output.id,
    deviceId: output.device_id,
    name: output.name,
    colour: output.colour,
    favourite: output.favourite,
    archived: output.archived,
    parentId: output.parent_id ?? null,
    description: output.description ?? null,
    orderKey: output.order_key,
    createdAt: output.created_at,
    seq: output.seq,
    syncedAt,
    deletedAt: output.deleted_at ?? null,
  };
}

/** The Section-shaped sibling above — Sync's fourth entity stream. */
export function toWireSectionInput(section: Section): WireSectionInput {
  return {
    id: section.id,
    device_id: section.deviceId,
    project_id: section.projectId,
    name: section.name,
    description: section.description,
    order_key: section.orderKey,
    archived: section.archived,
    created_at: section.createdAt,
    deleted_at: section.deletedAt,
  };
}

export function fromWireSectionOutput(output: WireSectionOutput, syncedAt: string): Section {
  return {
    id: output.id,
    deviceId: output.device_id,
    projectId: output.project_id,
    name: output.name,
    description: output.description ?? null,
    orderKey: output.order_key,
    archived: output.archived,
    createdAt: output.created_at,
    seq: output.seq,
    syncedAt,
    deletedAt: output.deleted_at ?? null,
  };
}

/** The Label-shaped sibling above — Sync's fifth entity stream. */
export function toWireLabelInput(label: Label): WireLabelInput {
  return {
    id: label.id,
    device_id: label.deviceId,
    name: label.name,
    colour: label.colour,
    created_at: label.createdAt,
    deleted_at: label.deletedAt,
  };
}

export function fromWireLabelOutput(output: WireLabelOutput, syncedAt: string): Label {
  return {
    id: output.id,
    deviceId: output.device_id,
    name: output.name,
    colour: output.colour,
    createdAt: output.created_at,
    seq: output.seq,
    syncedAt,
    deletedAt: output.deleted_at ?? null,
  };
}

/** The Comment-shaped sibling above — Sync's sixth entity stream. */
export function toWireCommentInput(comment: Comment): WireCommentInput {
  return {
    id: comment.id,
    device_id: comment.deviceId,
    task_id: comment.taskId,
    text: comment.text,
    created_at: comment.createdAt,
    deleted_at: comment.deletedAt,
  };
}

export function fromWireCommentOutput(output: WireCommentOutput, syncedAt: string): Comment {
  return {
    id: output.id,
    deviceId: output.device_id,
    taskId: output.task_id,
    text: output.text,
    createdAt: output.created_at,
    seq: output.seq,
    syncedAt,
    deletedAt: output.deleted_at ?? null,
  };
}

/**
 * The Event-shaped sibling above — Sync's seventh entity stream (issue
 * #184). No `deleted_at` either direction, unlike every mapping above it
 * — an Event has no tombstone (../event-types.ts's own header comment).
 * No reshaping otherwise, mirroring toWireTaskInput's own doc comment:
 * `taskId`/`projectId` cross a Task/Project that may not have synced
 * here yet, carried straight through honest and unresolved, the identical
 * "an unresolved cross-reference is not this function's problem" rule
 * every other `toWire*Input` in this file already follows.
 */
export function toWireEventInput(event: Event): WireEventInput {
  return {
    id: event.id,
    device_id: event.deviceId,
    event_type: event.eventType,
    object_type: event.objectType,
    object_id: event.objectId,
    task_id: event.taskId,
    project_id: event.projectId,
    occurred_at: event.occurredAt,
    extra: event.extra,
  };
}

export function fromWireEventOutput(output: WireEventOutput, syncedAt: string): Event {
  return {
    id: output.id,
    deviceId: output.device_id,
    eventType: output.event_type as Event["eventType"],
    objectType: output.object_type as Event["objectType"],
    objectId: output.object_id,
    taskId: output.task_id ?? null,
    projectId: output.project_id ?? null,
    occurredAt: output.occurred_at,
    extra: (output.extra as Record<string, unknown> | null | undefined) ?? null,
    seq: output.seq,
    syncedAt,
  };
}
