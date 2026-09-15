import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useWideLayout } from "@/hooks/use-wide-layout";
import { OPEN_QUICK_ADD_EVENT } from "@/lib/todo-keymap";

/**
 * Issue #304 (ANAV-02, AQA-01, parity ledger): a persistent create
 * affordance over Todo's list, reachable at any scroll position on a
 * phone. Todoist's own counterpart is a `FloatingActionButton`
 * (`content-desc="Quick add"`, measured 56 CSS px) that floats over the
 * list and never moves; meologue's only door before this ticket was
 * `AddTaskForm`'s end-of-list "Add task" trigger, which sits in the list
 * flow and scrolls away as the list grows — the single largest
 * interaction divergence in the Android ledger (this ticket's own brief).
 *
 * **Reuses the existing door, rather than opening a second one.** Clicking
 * dispatches the identical `OPEN_QUICK_ADD_EVENT` `todo-sidebar.tsx`'s own
 * "Add task" button already dispatches (that file's own doc comment on
 * the fan-in) — `todo-page.tsx`'s existing listener is the only place
 * `QuickAddDialog`'s `open` state is set, unchanged by this ticket. That
 * dialog's own `autoFocus` on its title field (quick-add-dialog.tsx) is
 * what satisfies "opens the existing composer, focused and ready to
 * type"; nothing here duplicates that.
 *
 * **Hides itself at the wide breakpoint**, the identical mechanism
 * `TodoNav` already uses (`useWideLayout()`, use-wide-layout.ts's
 * `WIDE_LAYOUT_QUERY`, 900px) — `TodoSidebar`'s own "Add task" link is
 * always on screen there, so a floating control duplicating it has no
 * purpose past that width, matching this ticket's own acceptance
 * criterion ("does not appear at the wide breakpoint").
 *
 * **Named "Quick add", not "Add task".** `todo-page.test.tsx` records
 * "exactly one Add task-named button in the tree" as a load-bearing
 * invariant (`AddTaskForm`'s own trigger) — a second button sharing that
 * name would make every `getByRole("button", { name: "Add task" })` in
 * this repo ambiguous the moment both are mounted on the same page.
 * "Quick add" is also Todoist's own name for this exact control (this
 * ticket's own measurement, `content-desc="Quick add"`), so this is the
 * closer parity match, not only the collision-avoiding one.
 *
 * **56 CSS px (`size-14`)**, matching Todoist's own measured FAB rather
 * than only clearing the acceptance criterion's 48px floor.
 *
 * **Positioning and the safe area are Shell's job, not this component's.**
 * Rendered through Shell's `floatingAction` slot (shell.tsx), inside the
 * same `relative` wrapper that already anchors the jump-to-newest
 * control — a sibling of `composerSlot` (`TodoNav`) in the flex column,
 * never overlaid on top of it. `bottom-4`/`right-4` below are relative to
 * that wrapper's own edges, which end exactly where `TodoNav` begins:
 * there is no gap this button could cover TodoNav's own controls through,
 * and TodoNav's `[padding-bottom:env(safe-area-inset-bottom)]`
 * (todo-nav.tsx) is what clears the system gesture bar underneath both —
 * this button never recomputes that inset itself. Shell's own
 * `floatingAction` doc comment has the rest, including the scroll
 * column's matching bottom spacer so the list's own last row doesn't land
 * underneath this.
 */
export function TodoCreateFab() {
  const wide = useWideLayout();
  if (wide) {
    return null;
  }

  return (
    <Button
      type="button"
      variant="default"
      size="icon"
      aria-label="Quick add"
      onClick={() => document.dispatchEvent(new CustomEvent(OPEN_QUICK_ADD_EVENT))}
      className="absolute right-4 bottom-4 z-10 size-14 rounded-full shadow-lg"
    >
      <Plus aria-hidden="true" className="size-6" />
    </Button>
  );
}
