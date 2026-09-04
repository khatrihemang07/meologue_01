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

export interface TaskListProps {
  /** Top-level Tasks in this scope — TaskStore.listByProject's own result, Inbox's or one Project's. */
  tasks: Task[];
  /** This Project's own Sections, flat and already in manual order (ProjectStore.listSections) — empty for Inbox, which has none (Section.projectId is required, never Inbox). */
  sections: Section[];
  /** The Project this list belongs to, or `null` for Inbox — task-tree.tsx's own `TaskTree.projectId` doc comment on why keyboard outdent needs it. */
  projectId: Project["id"] | null;
  /** Shown in place of every row when `tasks` is empty — the caller's own words, since Inbox's and a Project's empty states read differently (todo-page.tsx). */
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
  listTasksInProject: (projectId: string | null) => Promise<Task[]>;
}

export function TaskList({
  tasks,
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
  listTasksInProject,
}: TaskListProps) {
  if (tasks.length === 0) {
    // A real state, not a blank panel — todo-page.tsx's own pre-#171
    // Inbox comment on this exact rule, extended here to cover a Project
    // with Sections but nothing filed in any of them yet.
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
    reorderTask,
    setTaskParent,
    listTaskChildren,
    listTasksInProject,
  } as const;

  if (sections.length === 0) {
    // Inbox, or a Project with no Sections yet — one flat TaskTree, no
    // headers, identical to issue #168's own original Inbox rendering.
    return <TaskTree tasks={tasks} depth={1} sectionOptions={sectionOptions} {...treeProps} />;
  }

  const unsectioned = tasks.filter((task) => task.sectionId === null);

  return (
    <div className="flex flex-col gap-4">
      {unsectioned.length > 0 && (
        <TaskTree tasks={unsectioned} depth={1} sectionOptions={sectionOptions} {...treeProps} />
      )}
      {sections.map((section) => {
        const sectionTasks = tasks.filter((task) => task.sectionId === section.id);
        return (
          <section key={section.id}>
            <h2 className="px-3 py-1 font-medium text-sm">{section.name}</h2>
            {sectionTasks.length === 0 ? (
              <p className="px-3 py-2 text-muted-foreground text-xs">
                Nothing in this Section yet.
              </p>
            ) : (
              <TaskTree
                tasks={sectionTasks}
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
