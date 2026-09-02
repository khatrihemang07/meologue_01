/**
 * A Task's full command set (issue #178) — "the full command set lives
 * behind right-click and the `.` key, not on the row: four common actions
 * on hover, everything else one menu away" (this ticket's own reference
 * behaviour, observed live in a real Todoist). One `DropdownMenu.Root`,
 * not a second `ContextMenu.Root` layered beside it: right-click and the
 * `.` key both just set the identical `open` state a caller already owns
 * (task-row.tsx's own `onContextMenu`/`.`-key handlers) and let it render
 * anchored at the row's own "More" button — a real Radix `ContextMenu`
 * would anchor at the cursor instead, which is closer to Todoist's own
 * placement but costs a second Radix primitive family and a second,
 * near-duplicate item list to keep in sync with this one; anchoring at a
 * fixed, always-visible trigger is the trade this ticket takes instead,
 * named here rather than left silent.
 *
 * Every item here reuses an existing door onto TaskStore — `onOpenDetail`/
 * `onOpenSchedule` open views this app already built (the Task's own
 * route, `TaskScheduleSheet`), `onSetPriority`/`onSetProject`/
 * `onSetLabels` are use-tasks.ts's own setters. **Reminders, Duplicate and
 * Open in new window are deliberately absent** — none names a capability
 * this codebase has: there is no Reminder store, no Duplicate mutation on
 * TaskStore, and "open in new window" has no meaning on a single-window
 * mobile/Tauri target the way it does in a desktop browser tab. Building
 * inert menu items for capabilities that don't exist is exactly the "no
 * affordance for a gesture that can't happen here" trap task-row.tsx's
 * own header comment already refuses elsewhere in this file's neighbours
 * — this ticket's own report names the trim explicitly rather than
 * leaving it to look like an oversight.
 */
import type { Label, Project, Task } from "@meologue/core";
import { storedPriorityOf, uiPriorityOf } from "@meologue/core";
import { CalendarClock, CalendarX2, Copy, FolderInput, Pencil, Tag, Trash2 } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import type * as React from "react";
import { priorityColour } from "@/lib/task-priority-colors";
import { cn } from "@/lib/utils";

export interface TaskCommandMenuProps {
  task: Task;
  projects: Project[];
  labels: Label[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The trigger this menu anchors to — task-row.tsx's own "More actions" (⋯) button. */
  trigger: React.ReactNode;
  onOpenDetail: () => void;
  onOpenSchedule: () => void;
  onSetPriority: (priority: number) => void;
  onSetProject: (projectId: string | null) => void;
  onSetLabels: (labelIds: string[]) => void;
  onCopyLink: () => void;
  onRequestDelete: () => void;
}

const itemClassName =
  "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none data-highlighted:bg-muted data-highlighted:text-foreground";

/** Renders after every command's own words — the reference layout's own hint characters (Edit ⌘E, Date (T), etc.). Purely a legend: none of these is bound as a real keyboard shortcut (this file's own header comment on what this ticket trims), so it never claims a binding that doesn't exist beyond the `.` key that opens this menu at all. */
function Hint({ children }: { children: React.ReactNode }) {
  return <span className="ml-auto text-muted-foreground text-xs">{children}</span>;
}

export function TaskCommandMenu({
  task,
  projects,
  labels,
  open,
  onOpenChange,
  trigger,
  onOpenDetail,
  onOpenSchedule,
  onSetPriority,
  onSetProject,
  onSetLabels,
  onCopyLink,
  onRequestDelete,
}: TaskCommandMenuProps) {
  const uiPriority = uiPriorityOf(task.priority);

  function toggleLabel(labelId: string) {
    const has = task.labelIds.includes(labelId);
    onSetLabels(has ? task.labelIds.filter((id) => id !== labelId) : [...task.labelIds, labelId]);
  }

  return (
    <DropdownMenu.Root open={open} onOpenChange={onOpenChange}>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          className="z-50 flex w-56 flex-col gap-0.5 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0"
        >
          <DropdownMenu.Item className={itemClassName} onSelect={onOpenDetail}>
            <Pencil aria-hidden="true" className="size-3.5" />
            Edit
            <Hint>⌘E</Hint>
          </DropdownMenu.Item>

          <DropdownMenu.Item className={itemClassName} onSelect={onOpenSchedule}>
            <CalendarClock aria-hidden="true" className="size-3.5" />
            Date…
            <Hint>T</Hint>
          </DropdownMenu.Item>

          <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger className={itemClassName}>
              <span
                aria-hidden="true"
                className="size-3.5 shrink-0 rounded-full border"
                style={{ borderColor: priorityColour(uiPriority) }}
              />
              Priority
              <Hint>Y</Hint>
            </DropdownMenu.SubTrigger>
            <DropdownMenu.Portal>
              <DropdownMenu.SubContent className="z-50 flex w-40 flex-col gap-0.5 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg">
                {[1, 2, 3, 4].map((ui) => (
                  <DropdownMenu.Item
                    key={ui}
                    className={itemClassName}
                    aria-pressed={ui === uiPriority}
                    onSelect={() => onSetPriority(storedPriorityOf(ui))}
                  >
                    <span
                      aria-hidden="true"
                      className="size-3.5 shrink-0 rounded-full"
                      style={{ backgroundColor: priorityColour(ui) }}
                    />
                    {`P${ui}`}
                  </DropdownMenu.Item>
                ))}
              </DropdownMenu.SubContent>
            </DropdownMenu.Portal>
          </DropdownMenu.Sub>

          <DropdownMenu.Item className={itemClassName} onSelect={onOpenSchedule}>
            <CalendarX2 aria-hidden="true" className="size-3.5" />
            Deadline…
            <Hint>D</Hint>
          </DropdownMenu.Item>

          {labels.length > 0 && (
            <DropdownMenu.Sub>
              <DropdownMenu.SubTrigger className={itemClassName}>
                <Tag aria-hidden="true" className="size-3.5" />
                Labels
              </DropdownMenu.SubTrigger>
              <DropdownMenu.Portal>
                <DropdownMenu.SubContent className="z-50 flex max-h-64 w-48 flex-col gap-0.5 overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg">
                  {labels.map((label) => {
                    const checked = task.labelIds.includes(label.id);
                    return (
                      <DropdownMenu.Item
                        key={label.id}
                        className={cn(itemClassName, "justify-between")}
                        // Keep the menu open across a toggle — a reader
                        // ticking three Labels in a row shouldn't have to
                        // reopen this submenu after each one, the same
                        // "commits immediately, no separate Save" rule
                        // TaskScheduleSheet's own header comment states
                        // for its four fields.
                        onSelect={(event) => {
                          event.preventDefault();
                          toggleLabel(label.id);
                        }}
                      >
                        <span className="flex items-center gap-2">
                          <span
                            aria-hidden="true"
                            className="size-2.5 shrink-0 rounded-full"
                            style={{ backgroundColor: label.colour }}
                          />
                          {label.name}
                        </span>
                        {checked && <span aria-hidden="true">✓</span>}
                      </DropdownMenu.Item>
                    );
                  })}
                </DropdownMenu.SubContent>
              </DropdownMenu.Portal>
            </DropdownMenu.Sub>
          )}

          <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger className={itemClassName}>
              <FolderInput aria-hidden="true" className="size-3.5" />
              Move to…
              <Hint>V</Hint>
            </DropdownMenu.SubTrigger>
            <DropdownMenu.Portal>
              <DropdownMenu.SubContent className="z-50 flex max-h-64 w-48 flex-col gap-0.5 overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg">
                <DropdownMenu.Item
                  className={itemClassName}
                  aria-pressed={task.projectId === null}
                  onSelect={() => onSetProject(null)}
                >
                  Inbox
                </DropdownMenu.Item>
                {projects.map((project) => (
                  <DropdownMenu.Item
                    key={project.id}
                    className={itemClassName}
                    aria-pressed={task.projectId === project.id}
                    onSelect={() => onSetProject(project.id)}
                  >
                    <span
                      aria-hidden="true"
                      className="size-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: project.colour }}
                    />
                    {project.name}
                  </DropdownMenu.Item>
                ))}
              </DropdownMenu.SubContent>
            </DropdownMenu.Portal>
          </DropdownMenu.Sub>

          <DropdownMenu.Separator className="my-1 h-px bg-border" />

          <DropdownMenu.Item className={itemClassName} onSelect={onCopyLink}>
            <Copy aria-hidden="true" className="size-3.5" />
            Copy link to task
          </DropdownMenu.Item>

          <DropdownMenu.Item
            className={cn(itemClassName, "text-destructive data-highlighted:bg-destructive/10")}
            onSelect={onRequestDelete}
          >
            <Trash2 aria-hidden="true" className="size-3.5" />
            Delete
            <Hint>⌘⌫</Hint>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
