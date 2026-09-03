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
 * mirrors (none) — with one deliberate exception, `description`
 * (issue #180), covered in its own paragraph below. `?? null` on every
 * other nullable field follows fromWireEntryOutput's own convention
 * above — a field absent on the wire and a field explicitly `null` both
 * mean the identical thing to this Task's own fields, which are
 * required-and-nullable, never `?`-optional (../task-types.ts's own doc
 * comment on why: an omitted key must never silently default one way or
 * the other without a caller saying so).
 * `withDefaultSchedulingFields`/`withDefaultLabelIds`/`withDefaultDateString`/
 * `withDefaultStructureFields` (../task-fields.ts, ../label-fields.ts) are
 * the *second* safety net a Task arriving over Sync passes through, inside
 * each TaskStore.upsert() — this function is the first, and the two exist
 * for different reasons: this one turns "absent on the wire" into "null,
 * a real value," and the store-level defaulters turn "an even older
 * client never sent this key at all" into whichever default that ticket's
 * own Task doc comment names. Neither makes the other redundant.
 *
 * **`description` cannot be read off `output` at all — the wire carries
 * no field for it yet (issue #182 is the protocol bump that adds one,
 * alongside Projects, Sections, Labels, Comments and Activity together).
 * `existing` is this Device's own current copy of the Task, if any, and
 * this function carries its `description` straight through rather than
 * manufacturing a `null`.** That distinction matters because
 * `TaskStore.upsert()` (ADR 0047's own "there is deliberately no `add()`"
 * — Sync's pull applies an incoming Task by overwriting the whole row,
 * exactly like a fresh local insert) cannot tell "the wire confirms this
 * Task has no description" apart from "the wire has nothing to say about
 * description at all" — both would arrive here as `null` if this function
 * invented one, and the *first* upsert() of any ordinary field change
 * (a rename, a reschedule — anything that reaches the wire and gets
 * echoed back) would silently overwrite a Device's own locally-set
 * `description` with that invented `null`, discarding words the wire
 * never even claimed to know about. Reading it off `existing` instead
 * means a Task this Device has never seen before (`existing` is
 * `undefined`) still gets `null` — there is nothing to carry through, and
 * that is the same "nothing chosen yet" state a brand-new Task starts in
 * either way — while a Task already on this Device keeps whatever it had.
 * This is the one field on `Task` today the wire cannot speak for; the
 * identical treatment — read it off `existing`, not off `output` — is
 * what any future locally-held-only field must get here too, which is
 * why the fix lives in this one function rather than in sync-engine.ts's
 * own call site: that call site has no way to know which of a Task's
 * many fields are wire-covered and which aren't, and it must not have to
 * remember.
 */
export function fromWireTaskOutput(
  output: WireTaskOutput,
  syncedAt: string,
  existing: Task | undefined,
): Task {
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
    // See this function's own doc comment above for why this reads off
    // `existing`, not off `output` — the wire has no field for it yet.
    description: existing?.description ?? null,
  };
}
