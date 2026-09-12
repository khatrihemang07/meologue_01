import type { Label, Project, Task } from "@meologue/core";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
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
  render(
    <ul>
      <TaskRow {...props} />
    </ul>,
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

describe("TaskRow", () => {
  it("renders the Task's content, with the checkbox unticked", () => {
    renderRow({ task: task({ content: "call mum" }) });

    expect(screen.getByText("call mum")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "call mum" })).not.toBeChecked();
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

    expect(screen.getByRole("checkbox").style.boxShadow).toContain("2px");
  });

  it("keeps the checkbox ring at 1px for P4 ('no priority'), the one default level", () => {
    renderRow({ task: task({ priority: 1 }) });

    expect(screen.getByRole("checkbox").style.boxShadow).toContain("1px");
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

  it("summarises an all-day date, a deadline and a non-default priority", () => {
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
    expect(screen.getByText("P1")).toBeInTheDocument();
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

    it("floors a row with a non-default priority (and no date) at 59px", () => {
      renderRow({ task: task({ content: "call mum", priority: 4 }) });

      expect(rowBox().style.minHeight).toBe("59px");
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
