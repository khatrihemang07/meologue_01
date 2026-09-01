import type { Task } from "@meologue/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { Link, MemoryRouter, Outlet, Route, Routes } from "react-router";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EntryStoreOutletContext } from "@/pages/entry-store-layout";
import { TodoPage } from "./todo-page";

vi.mock("sonner", () => ({ toast: vi.fn() }));

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "1",
    deviceId: "device-a",
    content: "buy milk",
    completedAt: null,
    orderKey: "V",
    createdAt: "2026-01-01T00:00:00.000Z",
    seq: 1,
    syncedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

// EntryStoreLayout normally supplies this context (it owns both stores and
// runs useHistory/useTasks) — stubbing it with a bare Outlet lets these
// tests exercise TodoPage in isolation with a context of their own
// choosing, the same technique composer-page.test.tsx already uses for the
// Entry half of this same context.
function renderTodoPage(context: EntryStoreOutletContext, initialPath = "/todo/inbox") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      {/* A real link to a non-`/todo/*` route (ADR 0049's own suggested
          test shape: "navigate to `/composer` ... through the router") —
          TodoPage itself has no reason to link to Composer, so this is the
          test's own way out, not a control this ticket adds to the page. */}
      <Link to="/composer">Leave Todo</Link>
      <Routes>
        <Route element={<Outlet context={context} />}>
          <Route path="/todo/inbox" element={<TodoPage />} />
          <Route path="/composer" element={<p>Composer</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

function readyContext(overrides: Partial<EntryStoreOutletContext> = {}): EntryStoreOutletContext {
  return {
    entries: [],
    sendEntry: vi.fn(),
    editEntry: vi.fn(),
    removeEntry: vi.fn(),
    search: vi.fn(async () => []),
    getEntries: vi.fn(async () => []),
    pagination: { hasMore: false, fetching: false, fetchMore: vi.fn() },
    tasks: [],
    completedTasks: [],
    addTask: vi.fn(),
    completeTask: vi.fn(),
    uncompleteTask: vi.fn(),
    renameTask: vi.fn(),
    reorderTask: vi.fn(),
    removeTask: vi.fn(),
    disabled: false,
    ...overrides,
  };
}

describe("TodoPage", () => {
  beforeEach(() => {
    vi.mocked(toast).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("offers a Back control out to the root screen", () => {
    renderTodoPage(readyContext());

    expect(screen.getByRole("link", { name: "Back to chats" })).toHaveAttribute("href", "/");
  });

  it("renders its own internal navigation, scoped to Todo (ADR 0049)", () => {
    renderTodoPage(readyContext());

    expect(screen.getByRole("navigation", { name: "Todo" })).toBeInTheDocument();
  });

  // ADR 0049's own suggested regression test: Todo's nav has to actually
  // leave the tree on navigating away, not merely become invisible —
  // otherwise "scoped to Todo" is a claim this ticket makes and nothing
  // checks.
  it("unmounts its internal navigation once the reader leaves Todo", () => {
    renderTodoPage(readyContext());
    expect(screen.getByRole("navigation", { name: "Todo" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("link", { name: "Leave Todo" }));

    expect(screen.getByText("Composer")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Todo" })).not.toBeInTheDocument();
  });

  it("reads an empty Inbox as a real state, not a blank panel", () => {
    renderTodoPage(readyContext({ tasks: [] }));

    expect(screen.getByText(/Nothing in your Inbox/)).toBeInTheDocument();
  });

  it("lists active Tasks", () => {
    renderTodoPage(readyContext({ tasks: [task({ id: "a", content: "call mum" })] }));

    expect(screen.getByText("call mum")).toBeInTheDocument();
    expect(screen.queryByText(/Nothing in your Inbox/)).not.toBeInTheDocument();
  });

  it("adds a Task through the form", () => {
    const addTask = vi.fn();
    renderTodoPage(readyContext({ addTask }));

    fireEvent.change(screen.getByLabelText("Add a Task"), { target: { value: "call mum" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(addTask).toHaveBeenCalledWith("call mum");
  });

  it("disables the Add form while the store isn't ready", () => {
    renderTodoPage(readyContext({ disabled: true }));

    expect(screen.getByLabelText("Add a Task")).toBeDisabled();
  });

  // The completion toast mirrors register-service-worker.web.ts's own
  // `toast(..., { action: { label, onClick } })` shape — this is the
  // Undo affordance the ticket's own brief points at.
  it("completes a Task and offers an Undo toast wired to uncompleteTask", () => {
    const completeTask = vi.fn();
    const uncompleteTask = vi.fn();
    renderTodoPage(
      readyContext({
        tasks: [task({ id: "a", content: "call mum" })],
        completeTask,
        uncompleteTask,
      }),
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "call mum" }));

    expect(completeTask).toHaveBeenCalledWith("a");
    expect(toast).toHaveBeenCalledWith(
      'Completed "call mum"',
      expect.objectContaining({
        action: expect.objectContaining({ label: "Undo", onClick: expect.any(Function) }),
      }),
    );

    const toastCall = vi.mocked(toast).mock.calls[0];
    const action = toastCall?.[1]?.action as { onClick: () => void } | undefined;
    action?.onClick();
    expect(uncompleteTask).toHaveBeenCalledWith("a");
  });

  it("restores a completed Task from the durable Completed section, independent of any toast", () => {
    const uncompleteTask = vi.fn();
    renderTodoPage(
      readyContext({
        completedTasks: [
          task({ id: "a", content: "call mum", completedAt: "2026-01-02T00:00:00.000Z" }),
        ],
        uncompleteTask,
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: 'Restore "call mum"' }));

    expect(uncompleteTask).toHaveBeenCalledWith("a");
  });

  it("deletes a Task only after confirming, mirroring sessions-page.tsx's ConfirmDialog", () => {
    const removeTask = vi.fn();
    renderTodoPage(readyContext({ tasks: [task({ id: "a", content: "call mum" })], removeTask }));

    fireEvent.click(screen.getByRole("button", { name: 'Delete "call mum"' }));
    expect(removeTask).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(removeTask).toHaveBeenCalledWith("a");
  });

  it("cancelling the delete confirmation leaves the Task untouched", () => {
    const removeTask = vi.fn();
    renderTodoPage(readyContext({ tasks: [task({ id: "a", content: "call mum" })], removeTask }));

    fireEvent.click(screen.getByRole("button", { name: 'Delete "call mum"' }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(removeTask).not.toHaveBeenCalled();
  });

  // ADR 0050's own criterion, exercised end to end through the page rather
  // than only against the pure `reorderedTaskOrderKey` helper
  // (task-reorder.test.ts already covers that in isolation): dragging one
  // row onto another calls reorderTask exactly once, with a key strictly
  // between the two Tasks it landed among.
  it("dragging a Task onto another calls reorderTask exactly once, with a key between its new neighbours", () => {
    const reorderTask = vi.fn();
    const a = task({ id: "a", content: "a", orderKey: "A" });
    const b = task({ id: "b", content: "b", orderKey: "B" });
    const c = task({ id: "c", content: "c", orderKey: "C" });
    renderTodoPage(readyContext({ tasks: [a, b, c], reorderTask }));

    // Dragging "a" onto "c"'s row: dropIndex resolves to "c"'s position in
    // [b, c] (index 1), so the computed key must land strictly between "b"
    // and "c".
    const source = screen.getByText("a").closest("li");
    const target = screen.getByText("c").closest("li");
    if (!source || !target) throw new Error("expected both rows to render");

    fireEvent.dragStart(source);
    fireEvent.dragOver(target);
    fireEvent.drop(target);

    expect(reorderTask).toHaveBeenCalledTimes(1);
    const [draggedId, newKey] = reorderTask.mock.calls[0] as [string, string];
    expect(draggedId).toBe("a");
    expect(newKey > "B").toBe(true);
    expect(newKey < "C").toBe(true);
  });
});
