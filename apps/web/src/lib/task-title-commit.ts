/**
 * Turns a Task rename's raw typed text into whichever field setters it
 * actually resolved anything for — the seam between quick-add-task.ts's
 * own field resolution (this module calls straight through to
 * `taskFieldsForRename`, adding nothing of its own about what a phrase
 * means) and the two pages that own a Task's rename door (todo-page.tsx's
 * and composer-page.tsx's own `commitRename` wrappers, issue #247): each
 * hands this module a Task, the text a reader just committed, and its own
 * store setters, and this module decides which of them actually fire.
 * Kept as its own pure module, free of React, for the same reason
 * quick-add-task.ts is — the guards below (skip a setter whose field
 * resolved to nothing, merge rather than replace Labels, never re-fire a
 * rename whose resolved content already matches the Task's own) are each
 * worth testing directly against a plain object, not only through a
 * rendered row or detail view.
 */
import type { LocalDayKey, QuickAddOptions, Task } from "@meologue/core";
import { parseLocalDayKey, parseQuickAdd } from "@meologue/core";
import { taskFieldsForRename } from "@/lib/quick-add-task";

export interface TaskTitleCommitSetters {
  renameTask: (id: string, content: string) => void;
  setTaskDate: (id: string, date: string | null) => void;
  setTaskDeadline: (id: string, deadline: string | null) => void;
  setTaskPriority: (id: string, priority: number) => void;
  // `options.now` (itself `localDayKey(new Date())` in both real callers —
  // composer-page.tsx's and todo-page.tsx's own `commitRename` wrappers)
  // is passed straight through here for the identical parameter, already
  // a floating local day rather than an instant. Issue #296 renamed the
  // parameter this reaches to `today` for the same reason it fixed the
  // other two `setTaskDateString` call sites; this one needed no
  // behaviour change, only the rename, since it was never threading an
  // instant through in the first place. Issue #300: this setter's own
  // `today` is `LocalDayKey`, matching `TaskStore.setDateString`; see
  // `commitTaskTitle` below for how `options.now` (`QuickAddOptions`'s own
  // plain `string`, deliberately not branded — `local-day-key.ts`'s own
  // header comment explains why) bridges into it.
  setTaskDateString: (id: string, dateString: string | null, today: LocalDayKey) => void;
  setTaskLabels: (id: string, labelIds: string[]) => void;
  resolveLabelIds: (names: string[]) => Promise<string[]>;
  /** Issue #370 — the Project/Section-shaped siblings of `setTaskLabels`/`resolveLabelIds` above: renaming a Task with a typed `#project`/`/section` moves it, exactly as a typed date or priority already do. */
  setTaskProject: (id: string, projectId: string | null) => void;
  setTaskSection: (id: string, sectionId: string | null) => void;
  resolveProjectId: (name: string) => Promise<string>;
  resolveSectionId: (projectId: string, name: string) => Promise<string>;
}

export async function commitTaskTitle(
  task: Task,
  content: string,
  options: QuickAddOptions,
  setters: TaskTitleCommitSetters,
): Promise<void> {
  const result = parseQuickAdd(content, options);
  const fields = taskFieldsForRename(content, result, options);

  // REQUIRED CORRECTNESS GUARD, not a nicety: the callers' own "bail if
  // unchanged" checks compare the RAW typed text. Renaming "Buy milk" to
  // "Buy milk tomorrow" passes that check, but `fields.content` resolves
  // back to "Buy milk" — identical to `task.content` — once the date
  // phrase is stripped. Calling `renameTask` anyway would fire a spurious
  // "You changed the name" Activity line that buries the real story
  // ("you set the date").
  if (fields.content !== task.content) {
    setters.renameTask(task.id, fields.content);
  }

  // `null` unambiguously means "no date-family token matched" — there is
  // no "clear the date" phrase in the grammar, so `null` never means
  // clear.
  if (fields.date !== null && fields.date !== task.date) {
    setters.setTaskDate(task.id, fields.date);
  }

  if (fields.deadline !== null && fields.deadline !== task.deadline) {
    setters.setTaskDeadline(task.id, fields.deadline);
  }

  // `resolveRecurrence` (quick-add-task.ts) returns `null` both when no
  // recurrence token exists AND when one fails to resolve — both correctly
  // mean "don't touch" here too, since a failed parse must not clear an
  // existing repeat rule.
  //
  // `options.now` is `QuickAddOptions`'s own plain `string` (deliberately
  // not branded — see `packages/core/src/local-day-key.ts`'s own header
  // comment for why), but every real caller already builds it from
  // `localDayKey(new Date())`, so it is always well-formed here. This is
  // the "explicit parse" boundary issue #300 names as `LocalDayKey`'s
  // other legitimate producer, not an `as LocalDayKey` cast standing in
  // for validation that never happened: `parseLocalDayKey` actually checks
  // the shape, and the (never-expected-in-practice) `null` branch simply
  // skips the write rather than forwarding a value the brand can't vouch
  // for.
  if (fields.dateString !== null && fields.dateString !== task.dateString) {
    const today = parseLocalDayKey(options.now);
    if (today !== null) {
      setters.setTaskDateString(task.id, fields.dateString, today);
    }
  }

  // Already the STORED priority (taskFieldsForRename's own doc comment) —
  // passed straight through, never re-derived through `storedPriorityOf`.
  if (fields.priority !== null && fields.priority !== task.priority) {
    setters.setTaskPriority(task.id, fields.priority);
  }

  // `resolveLabelIds` is a find-or-create — only called when there's an
  // actual `@label` to resolve, so a rename with none never mints a Label
  // needlessly. `setTaskLabels` replaces its array wholesale, so typing
  // `@urgent` mid-rename must MERGE with whatever Labels the Task already
  // carries rather than silently dropping every other one.
  if (fields.labelNames.length > 0) {
    const resolvedIds = await setters.resolveLabelIds(fields.labelNames);
    const merged = Array.from(new Set([...task.labelIds, ...resolvedIds]));
    // `Set` preserves insertion order, and `task.labelIds` is inserted
    // first — so `merged` is exactly `task.labelIds`, same order and same
    // length, whenever `resolvedIds` added nothing new. A length check is
    // therefore enough to detect a real change without a second pass.
    if (merged.length !== task.labelIds.length) {
      setters.setTaskLabels(task.id, merged);
    }
  }

  // Issue #370: a typed `#project` moves the Task, exactly as a typed date
  // or priority above already do — this is not a divergence from those,
  // it's the same rule applied to structure. `/section` resolves *inside*
  // whichever Project wins: a typed `#project` in this same rename, or —
  // with none typed — the Task's own existing `projectId`, the rename's
  // own stand-in for handleAdd's "ambient Project" (a rename has no view
  // to inherit from, only the Task it's already filed under). A `/section`
  // with neither is silently ignored, the same "nothing to do" posture
  // handleAdd already gives that case.
  const projectId =
    fields.projectName !== null ? await setters.resolveProjectId(fields.projectName) : null;
  if (projectId !== null && projectId !== task.projectId) {
    setters.setTaskProject(task.id, projectId);
  }

  const sectionProjectId = projectId ?? task.projectId;
  if (fields.sectionName !== null && sectionProjectId !== null) {
    const sectionId = await setters.resolveSectionId(sectionProjectId, fields.sectionName);
    if (sectionId !== task.sectionId) {
      setters.setTaskSection(task.id, sectionId);
    }
  }
}
