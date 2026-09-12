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
 * route, `TaskScheduleSheet`). Issue #253 split "Date…" off from
 * `onOpenSchedule` onto its own `onOpenDate` — the row's own anchored
 * `TaskSchedulePopover` instance, not the sheet — while "Deadline…" keeps
 * the original callback unchanged. `onSetPriority`/`onSetProject`/
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
 *
 * **Issue #228:** the hint characters this file used to hand-write next to
 * each command (`⌘E`, `T`, `Y`, `D`, `V`, `⌘⌫`) were "purely a legend" —
 * wired to nothing at all, this file's own former comment admitted. They
 * now come from `hintForId()` (`@/lib/todo-keymap`), the same table
 * `use-todo-keymap.ts` actually matches keydowns against, so a hint can no
 * longer exist unless its binding does. `hintForId` returns `null` for
 * "Move to…" (`V`) on purpose — that binding was deliberately left
 * unimplemented (todo-keymap.ts's own header comment has the reason: no
 * controlled way to open this exact submenu pre-expanded), so this menu
 * renders no hint there at all rather than a false one.
 */
import type { Label, Project, Task } from "@meologue/core";
import { storedPriorityOf, uiPriorityOf } from "@meologue/core";
import { CalendarClock, CalendarX2, Copy, FolderInput, Pencil, Tag, Trash2 } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import type * as React from "react";
import { useRef } from "react";
import { priorityPickerColour } from "@/lib/task-priority-colors";
import { hintForId } from "@/lib/todo-keymap";
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
  /**
   * Opens the row's own anchored `TaskSchedulePopover` instance (issue
   * #253) — this menu's own "Date…" item, sitting alongside "Deadline…"
   * below (`onOpenSchedule`, still the shared bottom sheet) rather than
   * sharing its callback: the two now open genuinely different surfaces,
   * where before this ticket both opened the identical sheet.
   */
  onOpenDate: () => void;
  onOpenSchedule: () => void;
  onSetPriority: (priority: number) => void;
  onSetProject: (projectId: string | null) => void;
  onSetLabels: (labelIds: string[]) => void;
  onCopyLink: () => void;
  onRequestDelete: () => void;
}

const itemClassName =
  "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none data-highlighted:bg-muted data-highlighted:text-foreground";

/** Renders after every command's own words — issue #228's own table-derived hint (`hintForId`, `@/lib/todo-keymap`), `null` when nothing is wired for that id (this file's own header comment on why "Move to…" renders none). */
function Hint({ id }: { id: string }) {
  const hint = hintForId(id);
  if (hint === null) {
    return null;
  }
  return <span className="ml-auto text-muted-foreground text-xs">{hint}</span>;
}

export function TaskCommandMenu({
  task,
  projects,
  labels,
  open,
  onOpenChange,
  trigger,
  onOpenDetail,
  onOpenDate,
  onOpenSchedule,
  onSetPriority,
  onSetProject,
  onSetLabels,
  onCopyLink,
  onRequestDelete,
}: TaskCommandMenuProps) {
  const uiPriority = uiPriorityOf(task.priority);
  // Set by the "Date…" item's own `onSelect` below, consumed by this
  // Content's own `onCloseAutoFocus` — see that item's doc comment for why
  // opening the popover has to wait for this menu's own close to actually
  // finish, not just be requested.
  const pendingDateOpenRef = useRef(false);

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
          // See the "Date…" item's own doc comment (issue #255) — this
          // only ever acts when that item set `pendingDateOpenRef`, and it
          // is the one moment this menu's own `FocusScope` has actually
          // torn down rather than merely being told to close.
          onCloseAutoFocus={(event) => {
            if (!pendingDateOpenRef.current) {
              return;
            }
            pendingDateOpenRef.current = false;
            // Skip the default "return focus to the trigger" — the
            // popover's own autofocus takes it from here, and bouncing
            // through the trigger first buys nothing.
            event.preventDefault();
            onOpenDate();
          }}
        >
          <DropdownMenu.Item className={itemClassName} onSelect={onOpenDetail}>
            <Pencil aria-hidden="true" className="size-3.5" />
            Edit
            <Hint id="edit-task" />
          </DropdownMenu.Item>

          {/*
            **Issue #255.** "Date…" used to fail to open its anchored
            popover when clicked with a mouse (2 of 10 attempts,
            deterministic by row position), while the identical keyboard
            path (Arrow keys, Enter) worked every time. Two earlier fixes
            were tried and reverted — `preventDefault()` in this item's own
            `onSelect` (which also suppressed the menu's auto-close, so it
            needed two Escapes), and a ref-scoped `onCloseAutoFocus` that
            only ever redirected *where* focus went back to. Neither moved
            the mouse tally — the second result is what points away from
            "the menu returns focus to its trigger," which both assumed.

            **Root cause, proved with a `dispatchEvent`/`focusin`
            instrumentation trace in a real browser (jsdom lays out no
            popover and reproduces neither `FocusScope` nor pointer
            dismissal, so this is invisible there):** `onSelect` fires
            inside the *same* `flushSync` Radix uses to dispatch
            `menu.itemSelect`. The old code opened
            `TaskSchedulePopover` — and mounted its `FocusScope`, which
            autofocuses the "Type a date" input — synchronously in that
            same tick, *before* this menu's own `Content` had actually
            unmounted (`Presence` keeps a closing `Content` — and its
            `FocusScope` — alive through the exit animation, well after
            `onOpenChange(false)` is called). With two `FocusScope`s
            simultaneously mounted, this menu's own focus-management effect
            (`@radix-ui/react-focus-scope`'s unconditional
            mount/unmount-autofocus effect, present whether or not the menu
            is `modal`) sees focus sitting outside its own container on
            every render it takes while closing — and Radix recomposes its
            `onMountAutoFocus`/`onUnmountAutoFocus` handlers on every
            render, so it reliably takes at least one more — and forcibly
            refocuses back into itself. The popover's own `DismissableLayer`
            reads that forced refocus as focus leaving it, and dismisses
            itself. A same-tick open-then-close never paints, which is why
            the failure mode was "no DOM node" rather than a misplaced one.

            **The fix:** don't open the popover until this menu's `Content`
            has genuinely finished closing. The item's own `onSelect` below
            no longer calls `onOpenDate` directly — it only arms
            `pendingDateOpenRef` (declared above, alongside this Content's
            own `onCloseAutoFocus`). `onCloseAutoFocus` fires exactly once,
            exactly when `Presence` finally tears the menu's `FocusScope`
            down — the one moment nothing is left to steal focus back — and
            that is where `onOpenDate` now runs. This is the deferral this
            issue's own report suggested trying ("whether deferring the
            popover's open past the menu's unmount changes the tally") and
            explicitly distinguished from attempt #1's `preventDefault()`:
            that suppressed the menu's *own* close; this instead lets the
            close finish and rides its own completion signal.

            Verified in a real browser across upper AND bottom rows with a
            mouse tally, plus that Escape still closes this menu in one
            press and the keyboard path (Arrow keys, Enter) is unaffected.
          */}
          <DropdownMenu.Item
            className={itemClassName}
            onSelect={() => {
              pendingDateOpenRef.current = true;
            }}
          >
            <CalendarClock aria-hidden="true" className="size-3.5" />
            Date…
            <Hint id="set-date" />
          </DropdownMenu.Item>

          <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger className={itemClassName}>
              <span
                aria-hidden="true"
                className="size-3.5 shrink-0 rounded-full border"
                // The picker's own swatch colour, not the row ring's — this
                // preview sits inside the Priority picker itself, and
                // PRI-05 (parity-ledger.md) is explicit that the two are
                // genuinely different values for P1.
                style={{ borderColor: priorityPickerColour(uiPriority) }}
              />
              Priority
              <Hint id="set-priority" />
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
                      style={{ backgroundColor: priorityPickerColour(ui) }}
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
            <Hint id="set-deadline" />
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
              <Hint id="move-to" />
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
            <Hint id="delete-task" />
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
