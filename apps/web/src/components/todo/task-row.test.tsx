import type { Label, Project, Task } from "@meologue/core";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OPEN_COMMAND_MENU_EVENT, OPEN_SCHEDULE_EVENT } from "@/lib/todo-keymap";
import { TaskRow } from "./task-row";

/**
 * Stands in for the real `TaskTitleEditor` — `task-title-editor.tsx`'s own
 * header comment records why no test mounts that component directly: it
 * wraps a real ProseMirror `EditorView`, and jsdom "cannot usefully mount
 * [one], let alone type into it" (`composer.tsx`'s own identical finding
 * for the Composer). Mocking exactly this module, not `TaskRow` or
 * `TaskRowContent` themselves, is the same split `todo-sidebar.test.tsx`
 * and `chat-shell-layout.test.tsx` already use for `entry-store-layout.tsx`
 * (mocked there because it needs a real SqliteDriver) — everything this
 * suite actually wants to prove (double-click activates it, Enter commits
 * through `detailActions.onRename`, Escape cancels) lives in the wiring
 * around the editor, not inside the editor itself.
 */
function StubTaskTitleEditor({
  value,
  onCommit,
  onCancel,
  ariaLabel,
}: {
  value: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
  ariaLabel?: string;
}) {
  const [text, setText] = useState(value);
  return (
    <input
      aria-label={ariaLabel ?? "Task name"}
      value={text}
      onChange={(event) => setText(event.target.value)}
      onBlur={() => onCommit(text)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          onCommit(text);
        }
        if (event.key === "Escape") {
          onCancel();
        }
      }}
    />
  );
}

vi.mock("@/components/todo/task-title-editor", () => ({
  TaskTitleEditor: StubTaskTitleEditor,
}));

function label(overrides: Partial<Label> = {}): Label {
  return {
    id: "label-1",
    deviceId: "device-a",
    name: "urgent",
    colour: "#ff8d85",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    seq: null,
    syncedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "project-1",
    deviceId: "device-a",
    name: "Errands",
    colour: "#ff8d85",
    favourite: false,
    archived: false,
    parentId: null,
    description: null,
    orderKey: "V",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    seq: null,
    syncedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "1",
    deviceId: "device-a",
    content: "buy milk",
    completedAt: null,
    orderKey: "V",
    dayOrder: "V",
    // Issue #196: updatedAt starts equal to createdAt
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    seq: 1,
    syncedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    // Undated, no deadline, priority 1 ("no priority") — the
    // same default packages/core/src/test-support/task-fixture.ts uses,
    // so a test that wants a scheduled Task says so explicitly via
    // `overrides` rather than this fixture guessing at one.
    date: null,
    deadline: null,
    priority: 1,
    // No Labels, doesn't repeat — the same "concrete value, not a gap"
    // default packages/core/src/test-support/task-fixture.ts's own
    // fixture uses for these two issue #170 fields.
    labelIds: [],
    dateString: null,
    // In Inbox, no Section, top-level — the same "nothing chosen yet"
    // state every other #171 field above defaults to, and what a Task
    // created directly in Todo starts with (@meologue/core's task-types.ts).
    projectId: null,
    sectionId: null,
    parentId: null,
    description: null,
    ...overrides,
  };
}

function renderRow(overrides: Partial<Parameters<typeof TaskRow>[0]> = {}) {
  const props = {
    task: task(),
    detailActions: {
      projects: [],
      labels: [],
      onOpenDetail: vi.fn(),
      onSetPriority: vi.fn(),
      onSetDate: vi.fn(),
      onSetDateString: vi.fn(),
      datesWithTasks: new Map(),
      onSetProject: vi.fn(),
      onSetLabels: vi.fn(),
      onCopyLink: vi.fn(),
      onRename: vi.fn(),
      commentCountFor: vi.fn(() => 0),
    },
    onComplete: vi.fn(),
    onCompleteForever: vi.fn(),
    onRequestDelete: vi.fn(),
    onOpenSchedule: vi.fn(),
    isDropTarget: false,
    onHandlePointerDown: vi.fn(),
    onHandlePointerMove: vi.fn(),
    onHandlePointerUp: vi.fn(),
    onHandlePointerCancel: vi.fn(),
    onMoveUp: vi.fn(),
    onMoveDown: vi.fn(),
    onIndent: vi.fn(),
    onOutdent: vi.fn(),
    ...overrides,
  };
  // ROW-08 (parity-ledger.md): the comment-count badge is a real
  // react-router `<Link>` now, not a plain `<span>` — it needs a Router
  // context to render at all, which this suite had no reason to supply
  // before.
  render(
    <ul>
      <TaskRow {...props} />
    </ul>,
    { wrapper: MemoryRouter },
  );
  return props;
}

/**
 * The `[data-task-row-box]` `<div>` inside the rendered row — issue #192
 * moved every visual class, the depth padding, and (since exactly one
 * `TaskRow` ever renders per `renderRow` call here) every one of those
 * onto this element rather than the `<li>` around it, so a test asserting
 * on any of them has to look here now — task-row.tsx's own header comment
 * carries the fuller reasoning for the split.
 */
function rowBox(): HTMLElement {
  const box = document.querySelector<HTMLElement>("[data-task-row-box]");
  if (!box) throw new Error("expected a row box");
  return box;
}

/**
 * The checkbox's own aria-hidden inner `<span>` (ROW-03) — the 18×18
 * visible ring, carrying the priority `box-shadow` — now that the
 * checkbox itself is a `<button role="checkbox">` supplying only the
 * 24×24 hit box around it.
 */
function ringSpan(): HTMLElement {
  const span = screen.getByRole("checkbox").querySelector<HTMLElement>("span");
  if (!span) throw new Error("expected the checkbox's own ring span");
  return span;
}

describe("TaskRow", () => {
  it("renders the Task's content, with the checkbox unticked", () => {
    renderRow({ task: task({ content: "call mum" }) });

    expect(screen.getByText("call mum")).toBeInTheDocument();
    // ROW-03 (parity-ledger.md), the user's 2026-09-13 decision: the
    // checkbox's accessible name is now Todoist's own fixed wording
    // ("Mark task as complete"/"Mark task as incomplete", `lifecycle.md:70`),
    // not the Task's content — a row no longer names the checkbox after
    // itself. This file renders exactly one row per test (`renderRow`
    // above), so the name alone is still unambiguous here; a caller
    // rendering more than one row has to find the row first and the
    // checkbox within it instead (see todo-page.test.tsx/today-view.test.tsx).
    expect(screen.getByRole("checkbox", { name: "Mark task as complete" })).not.toBeChecked();
  });

  // ROW-06 (parity-ledger.md): driven live, both apps, flow 10 — Todoist
  // parses markdown in a task title at render time
  // (`live-audit-dom/flow10-ROW-06-both.json`), verified with a title
  // confirmed to hold only literal delimiters, never composer-converted
  // marks. This row used to interpolate `task.content` as plain text
  // everywhere.
  it("renders markdown in the title as real formatting, not literal characters — ROW-06", () => {
    renderRow({ task: task({ content: "ZZ probe **bold** _em_ `code`" }) });

    // The title button's own accessible name is computed from its
    // rendered content, so a browser (and RTL) reads it as the plain
    // words — this also proves the button still opens the detail view
    // via `data-row-nav-target`, unaffected by the markup swap inside it.
    const titleButton = screen.getByRole("button", { name: "ZZ probe bold em code" });
    expect(titleButton).toHaveAttribute("data-row-nav-target");
    expect(titleButton.querySelector("strong")?.textContent).toBe("bold");
    expect(titleButton.querySelector("em")?.textContent).toBe("em");
    expect(titleButton.querySelector("code")?.textContent).toBe("code");
  });

  // The artifact's own row aria-labels were never re-driven live against
  // Todoist for this construct (only the tab-title/dialog-accessible-name
  // strings were), so this row's hover-action aria-labels keep
  // interpolating the raw, un-rendered title — unchanged by ROW-06.
  it("keeps aria-labels as the raw, unrendered title — ROW-06 aria-labels are unrecorded", () => {
    renderRow({ task: task({ content: "ZZ probe **bold** _em_ `code`" }) });

    expect(
      screen.getByRole("button", { name: 'Edit "ZZ probe **bold** _em_ `code`"' }),
    ).toBeInTheDocument();
  });

  it("ticking the checkbox calls onComplete", () => {
    const onComplete = vi.fn();
    renderRow({ onComplete });

    fireEvent.click(screen.getByRole("checkbox"));

    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("ticking a recurring Task's checkbox still calls onComplete, not onCompleteForever", () => {
    // A recurring Task's own checkbox is still an ordinary tap most of the
    // time — Shift+Click is the one exception (the next test) — advancing
    // to the next occurrence, not ending the series (TaskStore.
    // advanceRecurring's own doc comment, and todo-page.tsx's own
    // handleComplete, which is what actually decides between complete()
    // and advanceRecurring() based on `dateString`; this row only ever
    // decides between onComplete and onCompleteForever).
    const onComplete = vi.fn();
    const onCompleteForever = vi.fn();
    renderRow({ task: task({ dateString: "every month" }), onComplete, onCompleteForever });

    fireEvent.click(screen.getByRole("checkbox"));

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onCompleteForever).not.toHaveBeenCalled();
  });

  it("Shift+Click on a recurring Task's checkbox calls onCompleteForever, not onComplete", () => {
    // Todoist's own documented gesture for "Complete and archive recurring
    // task" — the end of the series, never "complete this occurrence"
    // (BRIEF.md's own "Domain decisions you must not re-derive").
    const onComplete = vi.fn();
    const onCompleteForever = vi.fn();
    renderRow({ task: task({ dateString: "every month" }), onComplete, onCompleteForever });

    fireEvent.click(screen.getByRole("checkbox"), { shiftKey: true });

    expect(onCompleteForever).toHaveBeenCalledTimes(1);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("Shift+Click on a non-recurring Task's checkbox is an ordinary complete", () => {
    // The modifier is meaningless without a series to end — ignored rather
    // than doing nothing, so an accidental Shift held down never silently
    // eats the tap.
    const onComplete = vi.fn();
    const onCompleteForever = vi.fn();
    renderRow({ task: task({ dateString: null }), onComplete, onCompleteForever });

    fireEvent.click(screen.getByRole("checkbox"), { shiftKey: true });

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onCompleteForever).not.toHaveBeenCalled();
  });

  it("shows a touch-reachable 'Complete and archive' button only for a recurring Task", () => {
    const onCompleteForever = vi.fn();
    renderRow({
      task: task({ content: "pay rent", dateString: "every month" }),
      onCompleteForever,
    });

    fireEvent.click(
      screen.getByRole("button", { name: 'Complete and archive recurring task "pay rent"' }),
    );

    expect(onCompleteForever).toHaveBeenCalledTimes(1);
  });

  it("renders no 'Complete and archive' button for a non-recurring Task", () => {
    renderRow({ task: task({ content: "pay rent", dateString: null }) });

    expect(screen.queryByRole("button", { name: /Complete and archive/ })).not.toBeInTheDocument();
  });

  // ROW-14 (parity-ledger.md): a completed Task now renders through this
  // same row rather than a separate, reduced component — this file's own
  // fix for the gap the ROW-14 change first shipped with, per
  // `task-row-content.tsx`'s own doc comment on the checkbox and title.
  describe("ROW-14: a completed Task renders through this same row", () => {
    it("carries aria-checked=true and 'Mark task as incomplete'", () => {
      renderRow({ task: task({ completedAt: "2026-01-01T00:00:00.000Z" }) });

      const checkbox = screen.getByRole("checkbox", { name: "Mark task as incomplete" });
      expect(checkbox).toHaveAttribute("aria-checked", "true");
    });

    it("clicking the checkbox calls onUncomplete, not onComplete", () => {
      const onComplete = vi.fn();
      const onUncomplete = vi.fn();
      renderRow({
        task: task({ completedAt: "2026-01-01T00:00:00.000Z" }),
        onComplete,
        onUncomplete,
      });

      fireEvent.click(screen.getByRole("checkbox", { name: "Mark task as incomplete" }));

      expect(onUncomplete).toHaveBeenCalledTimes(1);
      expect(onComplete).not.toHaveBeenCalled();
    });

    it("gives the title the shared completed-style class", () => {
      renderRow({ task: task({ content: "done", completedAt: "2026-01-01T00:00:00.000Z" }) });

      expect(screen.getByRole("button", { name: "done" })).toHaveClass("completed-task-text");
    });

    it("does not give an active Task's title the completed-style class", () => {
      renderRow({ task: task({ content: "not done", completedAt: null }) });

      expect(screen.getByRole("button", { name: "not done" })).not.toHaveClass(
        "completed-task-text",
      );
    });

    it("keeps its date badge, Labels, Project name and comment count — the same metadata line an active row shows", () => {
      renderRow({
        task: task({
          content: "done",
          completedAt: "2026-01-01T00:00:00.000Z",
          date: "2026-01-01",
          labelIds: ["label-1"],
          projectId: "project-1",
        }),
        commentCount: 2,
        detailActions: {
          projects: [project()],
          labels: [label()],
          onOpenDetail: vi.fn(),
          onSetPriority: vi.fn(),
          onSetDate: vi.fn(),
          onSetDateString: vi.fn(),
          datesWithTasks: new Map(),
          onSetProject: vi.fn(),
          onSetLabels: vi.fn(),
          onCopyLink: vi.fn(),
          onRename: vi.fn(),
          commentCountFor: vi.fn(() => 2),
        },
      });

      expect(screen.getByText("urgent")).toBeInTheDocument();
      expect(screen.getByText("Errands")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "2 comments" })).toBeInTheDocument();
      // The date badge itself is asserted by text elsewhere in this suite
      // (ROW-01's own `describe` above) rather than by its exact,
      // day-relative wording here — `hasMetadata` (and so the 59px floor)
      // being true is what proves a date badge rendered at all alongside
      // the fields above.
      expect(rowBox().style.minHeight).toBe("59px");
      // ROW-03: the priority ring is still drawn on a completed row's
      // checkbox, filled with a check mark once ticked — the fill this
      // component's own predecessor (`completed-tasks.tsx`'s now-removed
      // `CompletedTaskRow`) added, carried over rather than dropped.
      expect(ringSpan().querySelector("svg")).toBeInTheDocument();
    });

    it("hides the 'Complete and archive recurring task' button once the Task is completed", () => {
      // ROW-14 decision, recorded in task-row-content.tsx's own comment:
      // "end the series" has nothing left to do to a Task that's already
      // done — not measured against either artifact, a judgment call.
      renderRow({
        task: task({
          content: "pay rent",
          dateString: "every month",
          completedAt: "2026-01-01T00:00:00.000Z",
        }),
      });

      expect(
        screen.queryByRole("button", { name: /Complete and archive/ }),
      ).not.toBeInTheDocument();
    });

    it("carries data-completed-task, excluding it from drag/reorder geometry", () => {
      renderRow({ task: task({ completedAt: "2026-01-01T00:00:00.000Z" }) });

      expect(screen.getByRole("listitem")).toHaveAttribute("data-completed-task", "true");
    });

    it("keeps its hover controls (Edit, Date, Comment, More) working — neither artifact says otherwise", () => {
      // Neither app's own ROW-14 artifact drove a completed row's hover
      // controls specifically — this is the fallback this ticket's own
      // brief asks for ("if the artifact doesn't settle it, keep them
      // working"), not a read fact.
      renderRow({ task: task({ content: "done", completedAt: "2026-01-01T00:00:00.000Z" }) });

      expect(screen.getByRole("button", { name: 'Edit "done"' })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: 'Date "done"' })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: 'Comment on "done"' })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: 'More actions for "done"' })).toBeInTheDocument();
    });

    it("renders no drag handle when the caller omits the drag/reorder props (as task-tree.tsx does for a completed row)", () => {
      renderRow({
        task: task({ completedAt: "2026-01-01T00:00:00.000Z" }),
        onHandlePointerDown: undefined,
        onHandlePointerMove: undefined,
        onHandlePointerUp: undefined,
        onHandlePointerCancel: undefined,
        onMoveUp: undefined,
        onMoveDown: undefined,
        onIndent: undefined,
        onOutdent: undefined,
      });

      expect(screen.queryByTestId("task-drag-handle")).not.toBeInTheDocument();
    });
  });

  // ROW-03/PRI-06 (parity-ledger.md), issue #250 then a later fix pass:
  // pass2-2026-09-11.md §2 first measured the checkbox ring at 2px for P1,
  // 1px everywhere else — flow 2's live P1-P4 fixtures (PRI-06) then showed
  // that "everywhere else" was wrong for P2/P3 too: the ring is 2px for
  // EVERY non-default priority (P1, P2, P3) and 1px only at P4 ("no
  // priority"). `priority` below is the STORED value; UI P1/P2/P3/P4 are
  // stored 4/3/2/1 (task-types.ts's own `uiPriorityOf`'s `5 - x`
  // inversion) — this suite always states the UI level in the test name
  // and the stored number in the fixture, never the reverse.
  it.each([
    ["P1", 4],
    ["P2", 3],
    ["P3", 2],
  ])("thickens the checkbox ring to 2px at %s", (_uiLabel, storedPriority) => {
    renderRow({ task: task({ priority: storedPriority }) });

    // ROW-03: the ring itself now lives on the checkbox `<button>`'s own
    // aria-hidden inner `<span>` (the 18×18 visible ring), not on the
    // accessible checkbox element directly — the button supplies the
    // 24×24 hit box, which carries no box-shadow of its own.
    expect(ringSpan().style.boxShadow).toContain("2px");
  });

  it("keeps the checkbox ring at 1px for P4 ('no priority'), the one default level", () => {
    renderRow({ task: task({ priority: 1 }) });

    expect(ringSpan().style.boxShadow).toContain("1px");
  });

  it("shows the recurrence exactly as typed, not a paraphrase", () => {
    renderRow({ task: task({ dateString: "every other monday" }) });

    expect(screen.getByText("every other monday")).toBeInTheDocument();
  });

  // Issue #178 moved Delete off the row's own hover actions entirely — it
  // lives behind the "More actions" (⋯) menu now, alongside the rest of
  // the full command set, per this ticket's own reference behaviour.
  it("Delete, in the More actions menu, calls onRequestDelete, not the store directly", () => {
    const onRequestDelete = vi.fn();
    renderRow({ task: task({ content: "call mum" }), onRequestDelete });

    fireEvent.pointerDown(screen.getByRole("button", { name: 'More actions for "call mum"' }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Delete/ }));

    expect(onRequestDelete).toHaveBeenCalledTimes(1);
  });

  // Pointer Events, not native HTML5 drag-and-drop — issue #168's own
  // follow-up: Android WebView never synthesises `dragstart` from touch
  // input, so the drag has to work through the same mechanism on every
  // device rather than one that only a mouse can trigger.
  it("the grip handle forwards pointer events to the handlers it's given, and the row itself is not draggable", () => {
    const onHandlePointerDown = vi.fn();
    const onHandlePointerMove = vi.fn();
    const onHandlePointerUp = vi.fn();
    const onHandlePointerCancel = vi.fn();
    renderRow({
      onHandlePointerDown,
      onHandlePointerMove,
      onHandlePointerUp,
      onHandlePointerCancel,
    });

    const row = screen.getByRole("listitem");
    expect(row).not.toHaveAttribute("draggable");

    const handle = screen.getByTestId("task-drag-handle");
    fireEvent.pointerDown(handle, { pointerId: 1 });
    fireEvent.pointerMove(handle, { pointerId: 1 });
    fireEvent.pointerUp(handle, { pointerId: 1 });
    fireEvent.pointerCancel(handle, { pointerId: 1 });

    expect(onHandlePointerDown).toHaveBeenCalledTimes(1);
    expect(onHandlePointerMove).toHaveBeenCalledTimes(1);
    expect(onHandlePointerUp).toHaveBeenCalledTimes(1);
    expect(onHandlePointerCancel).toHaveBeenCalledTimes(1);
  });

  // Issue #171's keyboard reorder — the handle is a real, focusable
  // `<button>` for exactly this reason (its own doc comment).
  it("ArrowUp/ArrowDown on the handle call onMoveUp/onMoveDown", () => {
    const onMoveUp = vi.fn();
    const onMoveDown = vi.fn();
    renderRow({ onMoveUp, onMoveDown });

    const handle = screen.getByTestId("task-drag-handle");
    fireEvent.keyDown(handle, { key: "ArrowUp" });
    fireEvent.keyDown(handle, { key: "ArrowDown" });

    expect(onMoveUp).toHaveBeenCalledTimes(1);
    expect(onMoveDown).toHaveBeenCalledTimes(1);
  });

  // Issue #171's keyboard reparent — `Alt`+arrow, not a plain arrow (which
  // this file's own test above already claims for reorder) and not `Tab`
  // (onOutdent's own doc comment, TaskRowProps, on why).
  it("Alt+ArrowRight/Alt+ArrowLeft on the handle call onIndent/onOutdent", () => {
    const onIndent = vi.fn();
    const onOutdent = vi.fn();
    const onMoveUp = vi.fn();
    renderRow({ onIndent, onOutdent, onMoveUp });

    const handle = screen.getByTestId("task-drag-handle");
    fireEvent.keyDown(handle, { key: "ArrowRight", altKey: true });
    fireEvent.keyDown(handle, { key: "ArrowLeft", altKey: true });
    // A plain, unmodified ArrowRight/ArrowLeft is not reorder or reparent
    // — only ArrowUp/ArrowDown (unmodified) and Alt+ArrowRight/ArrowLeft
    // are ever recognised, so a stray ArrowLeft with no modifier must do
    // nothing at all.
    fireEvent.keyDown(handle, { key: "ArrowRight" });

    expect(onIndent).toHaveBeenCalledTimes(1);
    expect(onOutdent).toHaveBeenCalledTimes(1);
    expect(onMoveUp).not.toHaveBeenCalled();
  });

  // The handle only — a pointerdown anywhere else on the row must still let
  // the browser scroll the list normally on touch, which is the entire
  // reason the handle exists as a separate element rather than the row
  // being draggable outright.
  it("does not put pointer listeners on the row itself, only on the handle", () => {
    const onHandlePointerDown = vi.fn();
    renderRow({ onHandlePointerDown });

    fireEvent.pointerDown(screen.getByText("buy milk"), { pointerId: 1 });

    expect(onHandlePointerDown).not.toHaveBeenCalled();
  });

  it("draws the drop indicator only while it is the drop target", () => {
    renderRow({ isDropTarget: true });

    expect(rowBox()).toHaveClass("border-t-primary");
  });

  // Issue #171's drag-to-reparent: nesting draws a genuinely different
  // indicator from ordinary reordering, not the same top border reused —
  // a reader mid-drag has to be able to tell "lands between rows" from
  // "lands inside this row" without waiting to see what happens on
  // release (this ticket's own brief names conflating the two as a real
  // risk).
  it("draws a distinct row-highlight indicator, not the reorder line, while it is the nest target", () => {
    renderRow({ isNestTarget: true });

    const box = rowBox();
    expect(box).toHaveClass("ring-primary");
    expect(box).not.toHaveClass("border-t-primary");
  });

  it("draws neither indicator when the row is neither the reorder nor the nest target", () => {
    renderRow({ isDropTarget: false, isNestTarget: false });

    const box = rowBox();
    expect(box).not.toHaveClass("border-t-primary");
    expect(box).not.toHaveClass("ring-primary");
  });

  // Issue #253: the Date button now anchors its own `TaskSchedulePopover`
  // instance directly — it no longer opens the shared bottom sheet
  // (`onOpenSchedule`), which now only opens from the More-actions
  // "Deadline…" item. `scheduler-view` is the popover's own `data-testid`
  // (task-schedule-popover.tsx) — jsdom lays nothing out, so this proves
  // the popover opens, not that it anchors under the button; see this
  // ticket's own report for why anchoring itself needs a real browser.
  // "Schedule" was renamed "Date" (issue #178's own reference behaviour —
  // the row's four hover actions read Edit, Date, Comment, More).
  it("the Date button opens this row's own anchored scheduler popover, not the shared sheet", () => {
    const onOpenSchedule = vi.fn();
    renderRow({ task: task({ content: "call mum" }), onOpenSchedule });

    expect(screen.queryByTestId("scheduler-view")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: 'Date "call mum"' }));

    expect(screen.getByTestId("scheduler-view")).toBeInTheDocument();
    expect(onOpenSchedule).not.toHaveBeenCalled();
  });

  // Issue #253: the More-actions "Date…" item is a second entry point onto
  // the identical per-row popover instance the hover button above opens —
  // both flip the same `scheduleOpen` flag `task-row.tsx` owns.
  //
  // Issue #255: opening the popover now waits for the More-actions menu's
  // own `onCloseAutoFocus` (fired once Radix's `Presence` actually finishes
  // closing the menu's Content) rather than happening synchronously inside
  // `onSelect` — see task-command-menu.tsx's own doc comment on the "Date…"
  // item for why. jsdom runs no real CSS animation, so this still resolves
  // quickly, but asynchronously — hence `waitFor` rather than an immediate
  // assertion.
  it("the More-actions 'Date…' item opens the identical scheduler popover", async () => {
    renderRow({ task: task({ content: "call mum" }) });

    fireEvent.pointerDown(screen.getByRole("button", { name: 'More actions for "call mum"' }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Date/ }));

    await waitFor(() => expect(screen.getByTestId("scheduler-view")).toBeInTheDocument());
  });

  // Issue #253: the `T` shortcut's own fan-in — `use-todo-keymap.ts`
  // dispatches `OPEN_SCHEDULE_EVENT` (todo-keymap.ts) rather than calling
  // this row directly, the identical document-level mechanism
  // `OPEN_COMMAND_MENU_EVENT` already uses for `.` below.
  it("opens the scheduler popover when todo-keymap.ts's own OPEN_SCHEDULE_EVENT names this Task", () => {
    renderRow({ task: task({ id: "1", content: "call mum" }) });

    expect(screen.queryByTestId("scheduler-view")).not.toBeInTheDocument();

    act(() => {
      document.dispatchEvent(new CustomEvent(OPEN_SCHEDULE_EVENT, { detail: { taskId: "1" } }));
    });

    expect(screen.getByTestId("scheduler-view")).toBeInTheDocument();
  });

  it("ignores OPEN_SCHEDULE_EVENT when it names a different Task", () => {
    renderRow({ task: task({ id: "1", content: "call mum" }) });

    act(() => {
      document.dispatchEvent(
        new CustomEvent(OPEN_SCHEDULE_EVENT, { detail: { taskId: "other-task" } }),
      );
    });

    expect(screen.queryByTestId("scheduler-view")).not.toBeInTheDocument();
  });

  // Issue #296: this row's own `TaskSchedulePopover` wiring (the "No Date"
  // clear and the Repeat menu's "Every day" pick, both inside
  // `task-row-content.tsx`) used to thread `new Date().toISOString()`
  // through `onSetDateString`'s third argument — `TaskStore.setDateString`'s
  // own doc comment (packages/core) says that parameter (`today`) has
  // always meant a floating local calendar day, never an instant. Slicing
  // an instant's first ten characters names the UTC day, not the Device's
  // own, for a window each night as wide as the Device's own UTC offset —
  // the identical shape of bug issue #290 fixed for
  // `advanceRecurringTask`/`postponeTask` in use-tasks.ts, and
  // `task-detail-view.test.tsx`'s own identical suite covers the sibling
  // call site. These tests pin both directions the same way: a Device
  // east of UTC before its own midnight has reached UTC, and one west of
  // UTC after local time has already rolled into UTC's next day.
  describe("issue #296 — onSetDateString receives the local day, not UTC's", () => {
    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllEnvs();
    });

    function renderRowWithOnSetDateString(
      taskOverrides: Partial<Task>,
      onSetDateString: (id: string, dateString: string | null, today: string) => void,
    ) {
      renderRow({
        task: task({ id: "1", content: "call mum", ...taskOverrides }),
        detailActions: {
          projects: [],
          labels: [],
          onOpenDetail: vi.fn(),
          onSetPriority: vi.fn(),
          onSetDate: vi.fn(),
          onSetDateString,
          datesWithTasks: new Map(),
          onSetProject: vi.fn(),
          onSetLabels: vi.fn(),
          onCopyLink: vi.fn(),
          onRename: vi.fn(),
          commentCountFor: vi.fn(() => 0),
        },
      });
    }

    it("clearing the date with No Date reports the local day for a Device east of UTC, before its own midnight has reached UTC", () => {
      vi.stubEnv("TZ", "Asia/Kolkata");
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(2026, 8, 15, 0, 16, 18));

      const onSetDateString = vi.fn();
      renderRowWithOnSetDateString(
        { date: "2026-09-14", dateString: "every day" },
        onSetDateString,
      );

      fireEvent.click(screen.getByRole("button", { name: 'Date "call mum"' }));
      fireEvent.click(screen.getByRole("button", { name: "No Date" }));

      expect(onSetDateString).toHaveBeenCalledWith("1", null, "2026-09-15");
    });

    it("clearing the date with No Date reports the local day for a Device west of UTC, once local time has already rolled into UTC's next day", () => {
      vi.stubEnv("TZ", "America/Los_Angeles");
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(2026, 8, 14, 23, 45, 0));

      const onSetDateString = vi.fn();
      renderRowWithOnSetDateString(
        { date: "2026-09-13", dateString: "every day" },
        onSetDateString,
      );

      fireEvent.click(screen.getByRole("button", { name: 'Date "call mum"' }));
      fireEvent.click(screen.getByRole("button", { name: "No Date" }));

      expect(onSetDateString).toHaveBeenCalledWith("1", null, "2026-09-14");
    });

    it("picking 'Every day' from the Repeat menu reports the local day for a Device east of UTC, before its own midnight has reached UTC", () => {
      vi.stubEnv("TZ", "Asia/Kolkata");
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(2026, 8, 15, 0, 16, 18));

      const onSetDateString = vi.fn();
      renderRowWithOnSetDateString({ date: null, dateString: null }, onSetDateString);

      fireEvent.click(screen.getByRole("button", { name: 'Date "call mum"' }));
      // Radix's `DropdownMenu.Trigger` opens on `pointerdown`, not `click`
      // — task-schedule-popover.test.tsx's own `openRepeatMenu` helper
      // establishes this identically for the same "Repeat" button.
      fireEvent.pointerDown(screen.getByRole("button", { name: "Repeat" }));
      const menu = screen.getByTestId("repeat-menu");
      fireEvent.click(within(menu).getByRole("menuitem", { name: "Every day" }));

      expect(onSetDateString).toHaveBeenCalledWith("1", "every day", "2026-09-15");
    });

    it("picking 'Every day' from the Repeat menu reports the local day for a Device west of UTC, once local time has already rolled into UTC's next day", () => {
      vi.stubEnv("TZ", "America/Los_Angeles");
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(2026, 8, 14, 23, 45, 0));

      const onSetDateString = vi.fn();
      renderRowWithOnSetDateString({ date: null, dateString: null }, onSetDateString);

      fireEvent.click(screen.getByRole("button", { name: 'Date "call mum"' }));
      fireEvent.pointerDown(screen.getByRole("button", { name: "Repeat" }));
      const menu = screen.getByTestId("repeat-menu");
      fireEvent.click(within(menu).getByRole("menuitem", { name: "Every day" }));

      expect(onSetDateString).toHaveBeenCalledWith("1", "every day", "2026-09-14");
    });
  });

  // Issue #253: "Deadline…" is unchanged by this ticket — it still opens
  // the shared `TaskScheduleSheet`, not the Date popover.
  it("the More-actions 'Deadline…' item still calls onOpenSchedule, not the scheduler popover", () => {
    const onOpenSchedule = vi.fn();
    renderRow({ task: task({ content: "call mum" }), onOpenSchedule });

    fireEvent.pointerDown(screen.getByRole("button", { name: 'More actions for "call mum"' }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Deadline/ }));

    expect(onOpenSchedule).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("scheduler-view")).not.toBeInTheDocument();
  });

  it("on a hover-capable pointer, a row's actions render in the fixed order Edit, Date, Comment, More", () => {
    renderRow({ task: task({ content: "call mum" }) });

    const buttons = screen
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label"))
      .filter((label): label is string => label !== null);

    // Only the four hover actions, checked by their relative order — the
    // drag handle and the checkbox carry their own, differently-shaped
    // labels and aren't part of this claim.
    const hoverActionLabels = buttons.filter((label) =>
      /^(Edit|Date|Comment on|More actions for)/.test(label),
    );
    expect(hoverActionLabels).toEqual([
      'Edit "call mum"',
      'Date "call mum"',
      'Comment on "call mum"',
      'More actions for "call mum"',
    ]);
  });

  // A real device (1080x2400) found this the hard way: with all four
  // hover actions following the pre-existing `(hover: hover)` convention
  // — visible unless a hover-capable pointer says otherwise — a touch
  // reader with no hover at all got all four, permanently, on a 349px
  // row. Four 44px buttons plus the grip handle and checkbox left "call
  // the dentist" as little as 37px to render in, and it came out "call …".
  //
  // jsdom (this project's test environment, `vite.config.ts`'s own `test.
  // environment: "jsdom"`, with no `css: true`) never loads Tailwind's
  // actual generated stylesheet, so nothing here can assert real
  // `display`/visibility the way a browser would — `toBeVisible()` would
  // pass or fail independent of any class on the element. What's actually
  // load-bearing, and what this asserts instead, is the exact utility
  // classes Tailwind mechanically turns into that CSS: `hidden` (the base,
  // no-hover state) overridden only by a hover-capable media query, on
  // Edit/Date/Comment specifically. More carries no `hidden` at all: it
  // has to stay the one thing a touch reader can always tap, since it's
  // now the only door onto the other three's own actions at rest.
  //
  // Issue #224 widened that media query from plain `(hover: hover)` to
  // `(hover: hover),(pointer: fine)` — `task-row-content.tsx`'s own comment
  // explains why: a Tauri desktop window can misreport `(hover: none)` for
  // a real mouse, and OR-ing in `(pointer: fine)` is what stops that
  // misreport from also taking these three buttons away on a build the real
  // device fix above was never about. It now rides the `pointer-fine`
  // variant declared in index.css rather than an inline arbitrary one.
  //
  // **Read the limit of this assertion honestly.** `toHaveClass` proves a
  // string is on the element and nothing more — it cannot see whether any
  // CSS was ever generated for that name. This very test passed while the
  // classes were assembled by template interpolation, which Tailwind's
  // text scanner never sees, so no rule existed and every one of these
  // buttons was fully visible on every row. The class name and the applied
  // style are two different claims; only rendering the real stylesheet
  // settles the second, which is what the side-by-side rig is for.
  it("only More actions renders unconditionally — Edit, Date and Comment are hidden outside a hover-or-fine-pointer device", () => {
    renderRow({ task: task({ content: "call mum" }) });

    for (const label of ['Edit "call mum"', 'Date "call mum"', 'Comment on "call mum"']) {
      const button = screen.getByRole("button", { name: label });
      expect(button).toHaveClass("hidden");
      expect(button).toHaveClass("pointer-fine:flex");
    }

    const more = screen.getByRole("button", { name: 'More actions for "call mum"' });
    expect(more).not.toHaveClass("hidden");
    expect(more).toHaveClass("flex");
  });

  it("opens the full command menu on right-click", () => {
    renderRow({ task: task({ content: "call mum" }) });

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    fireEvent.contextMenu(screen.getByRole("listitem"));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /^Edit/ })).toBeInTheDocument();

    // Escaped on the menu itself, not the row — Radix hides the rest of
    // the page from the accessibility tree while an open menu's focus
    // scope is active, so the `<li>` isn't a `listitem` to query against
    // until the menu closes again.
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  // Issue #228: the `.` key itself moved off this row entirely, onto
  // `use-todo-keymap.ts`'s one document-level listener — this row's own
  // remaining job is reacting to *that* hook's event, which is what this
  // test drives directly rather than a raw "." keydown (there's no keydown
  // handler left on this row to receive one).
  it("opens the full command menu when use-todo-keymap.ts's own event names this Task", () => {
    renderRow({ task: task({ id: "1", content: "call mum" }) });

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    act(() => {
      document.dispatchEvent(new CustomEvent(OPEN_COMMAND_MENU_EVENT, { detail: { taskId: "1" } }));
    });
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("ignores use-todo-keymap.ts's own event when it names a different Task", () => {
    renderRow({ task: task({ id: "1", content: "call mum" }) });

    act(() => {
      document.dispatchEvent(
        new CustomEvent(OPEN_COMMAND_MENU_EVENT, { detail: { taskId: "other-task" } }),
      );
    });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("shows no schedule summary for a Task with no date, deadline or priority set", () => {
    renderRow({ task: task({ content: "call mum" }) });

    expect(screen.queryByText(/Due/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^P[1-4]$/)).not.toBeInTheDocument();
  });

  it("summarises an all-day date and a deadline — a non-default priority renders no text badge (ROW-10)", () => {
    renderRow({
      task: task({
        content: "call mum",
        date: "2026-09-03",
        deadline: "2026-09-10",
        priority: 4, // stored 4 is UI P1 — uiPriorityOf's own inversion.
      }),
    });

    expect(screen.getByText("3 Sep")).toBeInTheDocument();
    expect(screen.getByText("Due 10 Sep")).toBeInTheDocument();
    // ROW-10(a): Todoist's own `task-info-tags` is empty for a P1 Task —
    // priority shows only through the checkbox ring (ROW-03/PRI-05/06),
    // never a `P1`/`P2`/`P3` text badge on the row itself.
    expect(screen.queryByText("P1")).not.toBeInTheDocument();
  });

  it("summarises a timed date with its time of day", () => {
    renderRow({ task: task({ content: "call mum", date: "2026-09-03T09:30" }) });

    expect(screen.getByText("3 Sep 9:30 AM")).toBeInTheDocument();
  });

  // DATE-01 (parity-ledger.md): Todoist's own date control carries an
  // inline 12×12 calendar `<svg>` beside the date text
  // (`live-audit-dom/flow8-DATE-01-todoist.json`), which meologue rendered
  // no icon for at all before this fix. That artifact only ever sampled
  // an OVERDUE row ("Yesterday", four captures in flow8-DATE-01-debug.json)
  // — whether Todoist's non-overdue dates also carry the icon was never
  // settled either way, so this is on every dated row, not gated to
  // overdue, per this fix's own instruction for an unsettled artifact.
  // jsdom paints no pixels, so this only proves the icon element is in the
  // DOM next to the date text, not that it renders at 12×12 on screen.
  it("shows a calendar icon beside the date text — DATE-01", () => {
    renderRow({ task: task({ content: "call mum", date: "2026-09-03" }) });

    const dateText = screen.getByText("3 Sep");
    expect(dateText.querySelector("svg.lucide-calendar")).not.toBeNull();
  });

  // DATE-04 (parity-ledger.md): driven live on Today (flow 2) — a
  // recurring Task whose date badge is suppressed (today-view.tsx's own
  // `suppressDateBadge`, ROW-13) is NOT fully suppressed the way a plain
  // due-today row is: Todoist keeps the `due-date-control` button but
  // empties its text, leaving an icon-only badge tinted the Today green
  // (`live-audit-dom/flow2-ROW-13-todoist.json`'s own
  // `recurringDueTodayRow`, "the recurrence glyph" — a single icon, not
  // the calendar (DATE-01) beside it). A plain, non-recurring suppressed
  // row still renders nothing at all, unchanged from before this fix.
  it("DATE-04: a suppressed date badge on a recurring Task still shows an icon-only recurrence glyph", () => {
    renderRow({
      task: task({ content: "water plants", date: "2026-09-02", dateString: "every day" }),
      suppressDateBadge: true,
    });

    expect(screen.queryByText("Today")).not.toBeInTheDocument();
    expect(screen.queryByText(/↻/)).not.toBeInTheDocument();
    expect(rowBox().querySelector("svg.lucide-repeat")).not.toBeNull();
    expect(rowBox().querySelector("svg.lucide-calendar")).toBeNull();
  });

  it("DATE-04: a suppressed date badge on a non-recurring Task still renders nothing", () => {
    renderRow({
      task: task({ content: "call mum", date: "2026-09-02" }),
      suppressDateBadge: true,
    });

    expect(rowBox().querySelector("svg.lucide-repeat")).toBeNull();
    expect(rowBox().querySelector("svg.lucide-calendar")).toBeNull();
  });

  // ROW-01 (parity-ledger.md): a title-only row (no date, deadline,
  // priority, recurrence, Label, Project, sub-task or comment count) is
  // 43px in Todoist; a row carrying one metadata line is 59px, +16px. This
  // used to be a single `minHeight: "59px"` floor that held every
  // title-only row at 59 regardless. jsdom computes no layout, so this
  // only proves the inline `minHeight` style switches with `hasMetadata`
  // — it cannot measure the row's actual painted height. Flow 11 R2 did:
  // the 44px action buttons held a title-only row at 47px, so they now lay
  // out at 36px through `-my-1`, which the last test here pins.
  describe("ROW-01: row height follows whether the row has a metadata line", () => {
    it("lays the 44px row actions out at 36px so they cannot hold a title-only row above 43px", () => {
      renderRow({ task: task({ content: "call mum" }) });

      const more = screen.getByRole("button", { name: 'More actions for "call mum"' });
      expect(more).toHaveClass("size-11", "-my-1");
    });

    it("floors a title-only row at 43px", () => {
      renderRow({ task: task({ content: "call mum" }) });

      expect(rowBox().style.minHeight).toBe("43px");
    });

    it("floors a row with a date badge at 59px", () => {
      renderRow({ task: task({ content: "call mum", date: "2026-09-03" }) });

      expect(rowBox().style.minHeight).toBe("59px");
    });

    // ROW-10(a): priority no longer counts toward `hasMetadata` — Todoist
    // shows it only via the checkbox ring, never a row-level badge — so a
    // Task whose only attribute is a non-default priority is now a
    // title-only row, exactly Todoist's own P1 fixture
    // (`flow2-ROW-01-02-todoist.json`, 43px). This test used to expect
    // 59px, back when `task.priority !== 1` was one of the checks
    // `hasMetadata` OR'd together.
    it("floors a row with a non-default priority (and no date) at 43px — priority is not metadata (ROW-10)", () => {
      renderRow({ task: task({ content: "call mum", priority: 4 }) });

      expect(rowBox().style.minHeight).toBe("43px");
    });

    it("floors a row whose only metadata is a sub-task count at 59px", () => {
      renderRow({ task: task({ content: "call mum" }), subtaskCount: 2 });

      expect(rowBox().style.minHeight).toBe("59px");
    });

    it("floors a row at 43px when its date badge is suppressed and nothing else qualifies as metadata", () => {
      renderRow({
        task: task({ content: "call mum", date: "2026-09-03" }),
        suppressDateBadge: true,
      });

      expect(rowBox().style.minHeight).toBe("43px");
    });
  });

  // Issue #224's own "must gain" list: Labels, the Project a Task lives
  // in, a Description preview and a sub-task count, none of which this
  // row rendered before.
  describe("issue #224's new metadata — Labels, Project, Description, sub-tasks", () => {
    it("shows every resolved Label as a dot-plus-name badge, skipping a dangling id it can't resolve", () => {
      renderRow({
        task: task({ content: "call mum", labelIds: ["label-1", "gone"] }),
        detailActions: {
          projects: [],
          labels: [label({ id: "label-1", name: "urgent" })],
          onOpenDetail: vi.fn(),
          onSetPriority: vi.fn(),
          onSetDate: vi.fn(),
          onSetDateString: vi.fn(),
          datesWithTasks: new Map(),
          onSetProject: vi.fn(),
          onSetLabels: vi.fn(),
          onCopyLink: vi.fn(),
          onRename: vi.fn(),
          commentCountFor: vi.fn(() => 0),
        },
      });

      expect(screen.getByText("urgent")).toBeInTheDocument();
    });

    it("shows the Task's own Project name when it has one, resolved live off detailActions.projects", () => {
      renderRow({
        task: task({ content: "call mum", projectId: "project-1" }),
        detailActions: {
          projects: [project({ id: "project-1", name: "Errands" })],
          labels: [],
          onOpenDetail: vi.fn(),
          onSetPriority: vi.fn(),
          onSetDate: vi.fn(),
          onSetDateString: vi.fn(),
          datesWithTasks: new Map(),
          onSetProject: vi.fn(),
          onSetLabels: vi.fn(),
          onCopyLink: vi.fn(),
          onRename: vi.fn(),
          commentCountFor: vi.fn(() => 0),
        },
      });

      expect(screen.getByText("Errands")).toBeInTheDocument();
    });

    it("shows no Project name for an Inbox Task (projectId null)", () => {
      renderRow({ task: task({ content: "call mum", projectId: null }) });

      // "Inbox" is never named on the row itself — only a Task actually
      // filed under a Project gets the badge (task-schedule-chips.tsx's
      // own `projectNameFor` precedent for the identical omission).
      expect(screen.queryByText("Inbox")).not.toBeInTheDocument();
    });

    // Issue #310 (ROW-10/AROW-14): Todoist suppresses a Task row's own
    // Project badge inside that Project's own view — the page's own
    // heading already names it — and shows it everywhere else
    // (Today/Upcoming/Search/a Filter). `suppressProjectBadge` is the
    // caller-supplied flag `task-tree.tsx` derives from `projectId !==
    // null`; this row itself only has to obey it.
    it("hides the Project badge when suppressProjectBadge is set, even though the Task has a Project", () => {
      renderRow({
        task: task({ content: "call mum", projectId: "project-1" }),
        suppressProjectBadge: true,
        detailActions: {
          projects: [project({ id: "project-1", name: "Errands" })],
          labels: [],
          onOpenDetail: vi.fn(),
          onSetPriority: vi.fn(),
          onSetDate: vi.fn(),
          onSetDateString: vi.fn(),
          datesWithTasks: new Map(),
          onSetProject: vi.fn(),
          onSetLabels: vi.fn(),
          onCopyLink: vi.fn(),
          onRename: vi.fn(),
          commentCountFor: vi.fn(() => 0),
        },
      });

      expect(screen.queryByText("Errands")).not.toBeInTheDocument();
    });

    it("still shows the Project badge when suppressProjectBadge is omitted (Today/Upcoming's own default)", () => {
      renderRow({
        task: task({ content: "call mum", projectId: "project-1" }),
        detailActions: {
          projects: [project({ id: "project-1", name: "Errands" })],
          labels: [],
          onOpenDetail: vi.fn(),
          onSetPriority: vi.fn(),
          onSetDate: vi.fn(),
          onSetDateString: vi.fn(),
          datesWithTasks: new Map(),
          onSetProject: vi.fn(),
          onSetLabels: vi.fn(),
          onCopyLink: vi.fn(),
          onRename: vi.fn(),
          commentCountFor: vi.fn(() => 0),
        },
      });

      expect(screen.getByText("Errands")).toBeInTheDocument();
    });

    it("shows no sub-task count when there are none", () => {
      renderRow({ task: task({ content: "call mum" }), subtaskCount: 0 });

      expect(screen.queryByText("3")).not.toBeInTheDocument();
    });

    it("shows the sub-task count, icon plus number, once there are sub-tasks", () => {
      renderRow({ task: task({ content: "call mum" }), subtaskCount: 3 });

      expect(screen.getByText("3")).toBeInTheDocument();
    });

    it("previews a Description's first line as rendered markdown beneath the title — ROW-07", () => {
      renderRow({
        task: task({ content: "call mum", description: "**call** first\nthen leave a voicemail" }),
      });

      // Only the first line — the rest of a multi-line Description is one
      // tap away in the detail view, not repeated here (this row's own
      // header comment on `descriptionFirstLine`).
      expect(screen.queryByText(/voicemail/)).not.toBeInTheDocument();
      // Real HTML from markdown, not the literal `**call**` characters —
      // ROW-07's own "real HTML from markdown" requirement.
      const strong = screen.getByText("call", { selector: "strong" });
      expect(strong).toBeInTheDocument();
    });

    it("renders no Description preview at all when the Task has none", () => {
      renderRow({ task: task({ content: "call mum", description: null }) });

      expect(document.querySelector(".truncate.text-muted-foreground")).not.toBeInTheDocument();
    });
  });

  describe("comment count — issue #180", () => {
    it("shows no comment count when there are none", () => {
      renderRow({ task: task({ content: "call mum" }), commentCount: 0 });

      expect(screen.queryByText("0")).not.toBeInTheDocument();
    });

    it("shows the count next to the date chip when non-zero", () => {
      renderRow({
        task: task({ content: "call mum", date: "2026-09-03" }),
        commentCount: 3,
      });

      expect(screen.getByText("3 Sep")).toBeInTheDocument();
      expect(screen.getByText("3")).toBeInTheDocument();
    });

    it("shows the count even on a Task with no date, deadline or priority", () => {
      renderRow({ task: task({ content: "call mum" }), commentCount: 1 });

      expect(screen.getByText("1")).toBeInTheDocument();
    });

    // ROW-08 (parity-ledger.md): Todoist's own badge is a real
    // `<a aria-label="N comment(s)" href="…?intent=reply">`
    // (`row-and-detail.md:120`; singular confirmed live,
    // `flow10-ROW-09-both.json`'s `"1 comment"` reading) — this used to be
    // a plain, non-interactive `<span>`.
    // Issue #306: `?intent=reply` closes ROW-08's one remaining
    // divergence — Todoist's own badge carries it too
    // (`taskDetailPath`'s own doc comment, task-detail-route.ts, has the
    // full reasoning for why it rides the SAME address as a query
    // parameter rather than a second route).
    it("renders the comment badge as a link to the Task's own detail route, carrying the reply intent, singular wording at 1", () => {
      renderRow({ task: task({ id: "1", content: "call mum" }), commentCount: 1 });

      const link = screen.getByRole("link", { name: "1 comment" });
      expect(link).toHaveAttribute("href", "/todo/task/call-mum-1?intent=reply");
    });

    it("pluralises the comment badge's wording above 1", () => {
      renderRow({ task: task({ id: "1", content: "call mum" }), commentCount: 2 });

      expect(screen.getByRole("link", { name: "2 comments" })).toBeInTheDocument();
    });

    it("clicking the comment badge never completes the Task", () => {
      // This row carries no click handler of its own today (only the
      // checkbox and the title button call `onComplete`/`onOpenDetail`),
      // so there is nothing live for a bubbled click to accidentally
      // trigger yet — this pins that a click on the link stays a plain
      // navigation, not a second door onto completing the row, should one
      // ever get added. The link's own `stopPropagation` (task-row-content.tsx)
      // is the guard; a real ambient row handler is a browser-only proof
      // (jsdom's root-delegated event model can't stand in for one, see
      // this file's own report).
      const onComplete = vi.fn();
      renderRow({ task: task({ id: "1", content: "call mum" }), commentCount: 1, onComplete });

      fireEvent.click(screen.getByRole("link", { name: "1 comment" }));

      expect(onComplete).not.toHaveBeenCalled();
    });
  });

  // Issue #169's Today view is the first caller with no drag handlers at
  // all — TaskRow's own doc comment on onHandlePointerDown explains why an
  // inert handle would be worse than none.
  // Issue #171: moving a Task between Sections without needing the
  // pointer recogniser's own drag geometry (task-row.tsx's own doc
  // comment on `sectionOptions` names why that gap exists).
  it("offers a Section select only when sectionOptions is given, and calls onMoveToSection", () => {
    const onMoveToSection = vi.fn();
    renderRow({
      task: task({ content: "call mum", sectionId: "s1" }),
      sectionOptions: [
        { id: "s1", name: "Errands" },
        { id: "s2", name: "Later" },
      ],
      onMoveToSection,
    });

    const select = screen.getByRole("combobox", { name: 'Move "call mum" to a Section' });
    expect(select).toHaveValue("s1");

    fireEvent.change(select, { target: { value: "s2" } });
    expect(onMoveToSection).toHaveBeenCalledWith("s2");

    fireEvent.change(select, { target: { value: "" } });
    expect(onMoveToSection).toHaveBeenCalledWith(null);
  });

  it("renders no Section select when sectionOptions is not given", () => {
    renderRow({ task: task({ content: "call mum" }) });

    expect(
      screen.queryByRole("combobox", { name: 'Move "call mum" to a Section' }),
    ).not.toBeInTheDocument();
  });

  it("renders no drag handle when no drag handlers are given", () => {
    renderRow({
      onHandlePointerDown: undefined,
      onHandlePointerMove: undefined,
      onHandlePointerUp: undefined,
      onHandlePointerCancel: undefined,
    });

    expect(screen.queryByTestId("task-drag-handle")).not.toBeInTheDocument();
  });

  // Issue #192's own acceptance criterion, pinned at the level that
  // actually owns the `<li>`: whatever `children` this row is given (a
  // sub-task's own nested `TaskTree`, in practice — task-tree.tsx's own
  // `TaskTreeRow`) has to land *inside* this row's own `<li>`, not beside
  // it, or the markup is invalid HTML again (a `ul` may hold only `li`).
  // A plain `<ul>` stands in for the real `TaskTree` here — this test
  // only needs to know where `TaskRow` puts whatever it's handed, not
  // whether a real sub-task list renders correctly, which task-tree.test.tsx's
  // own structural test already covers end to end.
  it("renders children inside its own <li>, not as a sibling of it", () => {
    renderRow({
      task: task({ content: "plan trip" }),
      children: (
        <ul data-testid="fake-subtasks">
          <li>book flights</li>
        </ul>
      ),
    });

    // `rowBox()`'s own `<li>` — not `screen.getByRole("listitem")`, which
    // would now also match the fake sub-task `<li>` this test hands in as
    // `children`, and fail on being asked for exactly one of two.
    const li = rowBox().closest("li");
    const subtasks = screen.getByTestId("fake-subtasks");
    expect(li).not.toBeNull();
    expect(li?.contains(subtasks)).toBe(true);
    expect(subtasks.parentElement).toBe(li);
  });

  // Issue #225: inline row editing, which did not exist before this
  // ticket. The activation gesture is Todoist's own measured "Edit"
  // hover pencil (`task-row-content.tsx`'s own header comment records
  // driving it directly) — a single click on the title keeps its
  // pre-existing, unambiguous meaning, "open the detail view."
  describe("inline rename (issue #225)", () => {
    it("clicking Edit swaps the title for the shared editor, seeded with the current content", async () => {
      renderRow({ task: task({ content: "buy milk" }) });

      fireEvent.click(screen.getByRole("button", { name: 'Edit "buy milk"' }));

      expect(await screen.findByLabelText("Task name")).toHaveValue("buy milk");
      expect(screen.queryByRole("button", { name: "buy milk" })).not.toBeInTheDocument();
    });

    it("a plain click on the title still opens the detail view, unambiguously and with no delay", () => {
      const onOpenDetail = vi.fn();
      renderRow({
        task: task({ content: "buy milk" }),
        detailActions: {
          projects: [],
          labels: [],
          onOpenDetail,
          onSetPriority: vi.fn(),
          onSetDate: vi.fn(),
          onSetDateString: vi.fn(),
          datesWithTasks: new Map(),
          onSetProject: vi.fn(),
          onSetLabels: vi.fn(),
          onCopyLink: vi.fn(),
          onRename: vi.fn(),
          commentCountFor: vi.fn(() => 0),
        },
      });

      fireEvent.click(screen.getByRole("button", { name: "buy milk" }));

      expect(onOpenDetail).toHaveBeenCalledWith(expect.objectContaining({ content: "buy milk" }));
    });

    it("Enter commits a changed title through detailActions.onRename, and returns to the display button", async () => {
      const onRename = vi.fn();
      renderRow({
        task: task({ content: "buy milk" }),
        detailActions: {
          projects: [],
          labels: [],
          onOpenDetail: vi.fn(),
          onSetPriority: vi.fn(),
          onSetDate: vi.fn(),
          onSetDateString: vi.fn(),
          datesWithTasks: new Map(),
          onSetProject: vi.fn(),
          onSetLabels: vi.fn(),
          onCopyLink: vi.fn(),
          onRename,
          commentCountFor: vi.fn(() => 0),
        },
      });

      fireEvent.click(screen.getByRole("button", { name: 'Edit "buy milk"' }));
      const editor = await screen.findByLabelText("Task name");
      fireEvent.change(editor, { target: { value: "buy oat milk" } });
      fireEvent.keyDown(editor, { key: "Enter" });

      expect(onRename).toHaveBeenCalledWith("1", "buy oat milk");
      // `onRename` here is a bare mock, not a store mutation — this row's
      // own `task` prop never actually changes, so what returns at rest
      // is the display button showing that same, still-current prop
      // (`todo-page.tsx`'s real `renameTask` is what a reader would see
      // reflect the new text, once the store round-trips it back down).
      // What this test can prove at this isolation level is that editing
      // ends and the shared editor unmounts.
      expect(await screen.findByRole("button", { name: "buy milk" })).toBeInTheDocument();
      expect(screen.queryByLabelText("Task name")).not.toBeInTheDocument();
    });

    it("does not rename when the committed text is unchanged or blank", async () => {
      const onRename = vi.fn();
      renderRow({
        task: task({ content: "buy milk" }),
        detailActions: {
          projects: [],
          labels: [],
          onOpenDetail: vi.fn(),
          onSetPriority: vi.fn(),
          onSetDate: vi.fn(),
          onSetDateString: vi.fn(),
          datesWithTasks: new Map(),
          onSetProject: vi.fn(),
          onSetLabels: vi.fn(),
          onCopyLink: vi.fn(),
          onRename,
          commentCountFor: vi.fn(() => 0),
        },
      });

      fireEvent.click(screen.getByRole("button", { name: 'Edit "buy milk"' }));
      let editor = await screen.findByLabelText("Task name");
      fireEvent.keyDown(editor, { key: "Enter" });
      expect(onRename).not.toHaveBeenCalled();

      fireEvent.click(await screen.findByRole("button", { name: 'Edit "buy milk"' }));
      editor = await screen.findByLabelText("Task name");
      fireEvent.change(editor, { target: { value: "   " } });
      fireEvent.keyDown(editor, { key: "Enter" });
      expect(onRename).not.toHaveBeenCalled();
    });

    it("Escape cancels without renaming, discarding the in-progress edit", async () => {
      const onRename = vi.fn();
      renderRow({
        task: task({ content: "buy milk" }),
        detailActions: {
          projects: [],
          labels: [],
          onOpenDetail: vi.fn(),
          onSetPriority: vi.fn(),
          onSetDate: vi.fn(),
          onSetDateString: vi.fn(),
          datesWithTasks: new Map(),
          onSetProject: vi.fn(),
          onSetLabels: vi.fn(),
          onCopyLink: vi.fn(),
          onRename,
          commentCountFor: vi.fn(() => 0),
        },
      });

      fireEvent.click(screen.getByRole("button", { name: 'Edit "buy milk"' }));
      const editor = await screen.findByLabelText("Task name");
      fireEvent.change(editor, { target: { value: "discard me" } });
      fireEvent.keyDown(editor, { key: "Escape" });

      expect(onRename).not.toHaveBeenCalled();
      expect(await screen.findByRole("button", { name: "buy milk" })).toBeInTheDocument();
    });
  });
});
