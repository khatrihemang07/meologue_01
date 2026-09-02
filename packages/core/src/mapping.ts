import type { Task } from "./task-types";
import type { Entry } from "./types";
import type { WireEntryInput, WireEntryOutput, WireTaskInput, WireTaskOutput } from "./wire";

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
 * `withDefaultStructureFields` (../task-fields.ts, ../label-fields.ts) are
 * the *second* safety net a Task arriving over Sync passes through, inside
 * each TaskStore.upsert() — this function is the first, and the two exist
 * for different reasons: this one turns "absent on the wire" into "null,
 * a real value," and the store-level defaulters turn "an even older
 * client never sent this key at all" into whichever default that ticket's
 * own Task doc comment names. Neither makes the other redundant.
 */
export function fromWireTaskOutput(output: WireTaskOutput, syncedAt: string): Task {
  return {
    id: output.id,
    deviceId: output.device_id,
    content: output.content,
    completedAt: output.completed_at ?? null,
    orderKey: output.order_key,
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
  };
}
