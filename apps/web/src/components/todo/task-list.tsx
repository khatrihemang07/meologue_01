/**
 * A Project or Inbox's own top-level Tasks — "opening a Project lists its
 * Tasks, reusing the list Inbox already uses" (issue #171's own
 * acceptance criterion), which this component *is*: `todo-page.tsx`
 * renders exactly one `TaskList` for Inbox (`sections={[]}`) and exactly
 * one for a Project (`sections` from that Project's own `listSections`),
 * never two different list implementations.
 *
 * Grouping by Section is the one thing this component adds beyond a flat
 * `TaskTree` (task-tree.tsx): a Task with no Section renders first, un-
 * headed, then every Section in its own manual order, each as its own
 * independent `TaskTree` — independent on purpose, since drag/keyboard
 * reorder inside one Section must never touch a sibling Section's own
 * rows (CONTEXT.md's Section entry: "flat, ordered manually"). Moving a
 * Task *between* Sections goes through `TaskRow`'s own `sectionOptions`
 * select, not a drag across this component's own group boundary — see
 * task-tree.tsx's own header comment for why that boundary isn't a drag
 * target.
 */
import type { Project, Section, Task } from "@meologue/core";
import type { TaskDetailActions } from "@/components/todo/task-row";
import { TaskTree } from "@/components/todo/task-tree";
import { useSettingsStore } from "@/lib/settings";

export interface TaskListProps {
  /** Top-level Tasks in this scope — TaskStore.listByProject's own result, Inbox's or one Project's. */
  tasks: Task[];
  /**
   * Every completed Task anywhere (the flat `completedTasks`
   * `useEntryStore()` already returns, `todo-page.tsx`) — this component
   * narrows it to top-level, this-scope rows itself
   * (`topLevelCompletedTasks` below), the identical "the caller hands
   * over the flat list, this component does its own filtering" split
   * `tasks`/`sections`/`projectId` already establish for the active half.
   * Defaults to empty so a caller with nothing completed anywhere (or one
   * that hasn't been updated yet) needs no change.
   *
   * Issue #358: whether any of this ever reaches `TaskTree` at all is
   * gated on `completedTasksVisible` below, not decided by this prop —
   * a caller still hands over the same whole-account list regardless of
   * the setting, exactly as `#310`'s `suppressProjectBadge` split already
   * keeps "what this scope's own rows are" separate from "how they're
   * currently drawn."
   */
  completedTasks?: Task[];
  /** Un-completes a Task from `completedTasks` above — forwarded straight through to every `TaskTree` this list renders (see that component's own doc comment). */
  onUncomplete?: (task: Task) => void;
  /** This Project's own Sections, flat and already in manual order (ProjectStore.listSections) — empty for Inbox, which has none (Section.projectId is required, never Inbox). */
  sections: Section[];
  /** The Project this list belongs to, or `null` for Inbox — task-tree.tsx's own `TaskTree.projectId` doc comment on why keyboard outdent needs it. */
  projectId: Project["id"] | null;
  emptyMessage: string;
  /** Passed straight through to every `TaskTree`/`TaskRow` this list renders — see `TaskDetailActions`'s own doc comment (task-row.tsx). */
  detailActions: TaskDetailActions;
  onComplete: (task: Task) => void;
  onCompleteForever: (task: Task) => void;
  onRequestDelete: (task: Task) => void;
  onOpenSchedule: (task: Task) => void;
  /** Wired to every row's own "move to Section" select when `sections` is non-empty — undefined when it is, since TaskRow already hides the control for an empty `sectionOptions` array on its own, but there is no Section to name here regardless. */
  onMoveToSection?: (taskId: string, sectionId: string | null) => void;
  reorderTask: (id: string, orderKey: string) => void;
  setTaskParent: (id: string, parentId: string | null) => Promise<void>;
  listTaskChildren: (parentId: string) => Promise<Task[]>;
  /** Issue #298 — see TaskTree's own prop doc. */
  countTaskChildren: (parentId: string) => Promise<{ done: number; total: number }>;
  listTasksInProject: (projectId: string | null) => Promise<Task[]>;
}

export function TaskList({
  tasks,
  completedTasks = [],
  onUncomplete,
  sections,
  projectId,
  emptyMessage,
  detailActions,
  onComplete,
  onCompleteForever,
  onRequestDelete,
  onOpenSchedule,
  onMoveToSection,
  reorderTask,
  setTaskParent,
  listTaskChildren,
  countTaskChildren,
  listTasksInProject,
}: TaskListProps) {
  const completedTasksVisible = useSettingsStore((state) => state.completedTasksVisible);

  // Narrowed to THIS scope's own top-level rows — `completedTasks` itself
  // is the flat, whole-account list every other caller of it already
  // filters client-side (`todo-page.tsx`'s `openTaskSubtasks`, its own doc
  // comment on the identical narrowing). `parentId === null` is what
  // "top-level" means here; a completed sub-task is deliberately left out
  // of this narrowing — see `TaskTree`'s own `completedTasks` doc comment
  // for why interleaving one level deeper is this ticket's own named,
  // deferred gap rather than built ahead of being asked for.
  const topLevelCompletedTasks = completedTasksVisible
    ? completedTasks.filter((task) => task.projectId === projectId && task.parentId === null)
    : [];

  if (tasks.length === 0 && topLevelCompletedTasks.length === 0) {
    return <p className="px-3 py-6 text-center text-muted-foreground text-sm">{emptyMessage}</p>;
  }

  const sectionOptions = sections.map((section) => ({ id: section.id, name: section.name }));

  // TaskTree's own generic, `(task: Task) => void`-shaped callbacks — one
  // set, reused for every bucket below, since completing/deleting/
  // scheduling a Task means the same thing regardless of which Section
  // bucket its own row happens to render from.
  const treeProps = {
    projectId,
    detailActions,
    onComplete,
    onCompleteForever,
    onRequestDelete,
    onOpenSchedule,
    onMoveToSection,
    onUncomplete,
    reorderTask,
    setTaskParent,
    listTaskChildren,
    countTaskChildren,
    listTasksInProject,
  } as const;

  if (sections.length === 0) {
    // Inbox, or a Project with no Sections yet — one flat TaskTree, no
    // headers, identical to issue #168's own original Inbox rendering.
    return (
      <TaskTree
        tasks={tasks}
        completedTasks={topLevelCompletedTasks}
        depth={1}
        sectionOptions={sectionOptions}
        {...treeProps}
      />
    );
  }

  const unsectioned = tasks.filter((task) => task.sectionId === null);
  const unsectionedCompleted = topLevelCompletedTasks.filter((task) => task.sectionId === null);

  return (
    <div className="flex flex-col gap-4">
      {(unsectioned.length > 0 || unsectionedCompleted.length > 0) && (
        <TaskTree
          tasks={unsectioned}
          completedTasks={unsectionedCompleted}
          depth={1}
          sectionOptions={sectionOptions}
          {...treeProps}
        />
      )}
      {sections.map((section) => {
        const sectionTasks = tasks.filter((task) => task.sectionId === section.id);
        const sectionCompleted = topLevelCompletedTasks.filter(
          (task) => task.sectionId === section.id,
        );
        return (
          <section key={section.id}>
            <h2 className="px-3 py-1 font-medium text-sm">{section.name}</h2>
            {sectionTasks.length === 0 && sectionCompleted.length === 0 ? (
              <p className="px-3 py-2 text-muted-foreground text-xs">
                Nothing in this Section yet.
              </p>
            ) : (
              <TaskTree
                tasks={sectionTasks}
                completedTasks={sectionCompleted}
                depth={1}
                sectionOptions={sectionOptions}
                {...treeProps}
              />
            )}
          </section>
        );
      })}
    </div>
  );
}
