import type { Task } from "@meologue/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter, Outlet, Route, Routes, useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatTaskReference } from "@/lib/inline-markdown";
import { useSettingsStore } from "@/lib/settings";
import type { EntryStoreOutletContext } from "@/pages/entry-store-layout";
import { swipeLeft } from "@/test/swipe";
import { ComposerPage } from "./composer-page";

// Issue #355: the Composer's own completion toast now goes through the
// identical shared `use-completion-toast.tsx` machinery `todo-page.tsx`
// uses — `toast.custom()`, not the plain `toast(message, {...})` this page
// used before — so this file's own mock mirrors `todo-page.test.tsx`'s
// mock verbatim (that file's own header comment on it has the full
// reasoning: sonner 2.0.8 exposes no `role` option, `.custom`'s mock
// returns an incrementing id so a test can call the captured `jsx` factory
// itself to render the real `CompletionToastBody`, and `.dismiss` records
// the id closed either by the toast's own Undo button or by a later
// completion replacing it).
vi.mock("sonner", () => {
  const toast = vi.fn() as unknown as typeof import("sonner").toast;
  // biome-ignore lint/suspicious/noExplicitAny: attaching mock methods to a mock function, the same shape sonner's own `toast` carries in production (a callable object with `.error`/`.custom`/`.dismiss` etc as properties).
  (toast as any).error = vi.fn();
  let nextCustomToastId = 1;
  // biome-ignore lint/suspicious/noExplicitAny: see above.
  (toast as any).custom = vi.fn(() => `custom-toast-${nextCustomToastId++}`);
  // biome-ignore lint/suspicious/noExplicitAny: see above.
  (toast as any).dismiss = vi.fn();
  return { toast };
});

/**
 * Stands in for the real `TaskTitleEditor` — mirrors todo-page.test.tsx's
 * own identical stub, the same reason it exists there: task-title-
 * editor.tsx's own header comment explains why no test mounts that
 * component directly (a real ProseMirror `EditorView`, which jsdom cannot
 * usefully drive keystroke-by-keystroke). Every other test in this file
 * only reads the detail title's own display `<button>`, never edits it —
 * issue #247's own rename tests below are the first to need typed input,
 * so this mock is scoped to exactly what they need.
 */
function StubTaskTitleEditor({
  value,
  onCommit,
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
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          onCommit(text);
        }
      }}
    />
  );
}

vi.mock("@/components/todo/task-title-editor", () => ({
  TaskTitleEditor: StubTaskTitleEditor,
}));

// Stand-in for surfacing the current "?q=..." from MemoryRouter's own
// in-memory history.
function SearchParamProbe() {
  const [searchParams] = useSearchParams();
  return <p data-testid="url-query">{searchParams.toString()}</p>;
}

// Stands in for a hardware/browser Back press (issue #181, criterion 4's
// own design room: "a hardware/browser Back that dismisses the overlay
// instead of leaving the Composer is strongly preferred"). MemoryRouter
// has no `window.history` of its own for a real Back gesture to act on,
// so this drives the identical mechanism a real Back press triggers —
// `navigate(-1)` popping the router's own in-memory stack — the same way
// every other MemoryRouter-based suite in this codebase simulates Back.
function GoBackProbe() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(-1)}>
      Simulate Back
    </button>
  );
}

// EntryStoreLayout is what normally supplies this context (it owns the
// store and useHistory); stubbing it with a bare Outlet lets these tests
// exercise ComposerPage in isolation with a context of their choosing,
// without touching the real store-opening machinery. Wrapped in a
// QueryClientProvider because Search (ticket 39, extended to this page by
// ticket 55) reads through a TanStack Query query of its own.
function renderComposerPage(context: EntryStoreOutletContext, initialPath = "/") {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <SearchParamProbe />
        <GoBackProbe />
        <Routes>
          <Route element={<Outlet context={context} />}>
            <Route path="/" element={<ComposerPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const readyContext: EntryStoreOutletContext = {
  entries: [],
  sendEntry: vi.fn(),
  editEntry: vi.fn(),
  commitEntryEdit: vi.fn(),
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
  reorderTaskToday: vi.fn(),
  removeTask: vi.fn(),
  setTaskDate: vi.fn(),
  setTaskDeadline: vi.fn(),
  setTaskPriority: vi.fn(),
  setTaskDateString: vi.fn(),
  setTaskLabels: vi.fn(),
  setTaskDescription: vi.fn(),
  listTasksInProject: vi.fn(async () => []),
  listTaskChildren: vi.fn(async () => []),
  countTaskChildren: vi.fn(async () => ({ done: 0, total: 0 })),
  listTasksInSection: vi.fn(async () => []),
  listTaskDescendants: vi.fn(async () => []),
  advanceRecurringTask: vi.fn(),
  completeForeverTask: vi.fn(),
  postponeTask: vi.fn(),
  // Issue #171's three structural Task setters — these tests never
  // exercise Project/Section moves or reparenting, so a stub is enough
  // to satisfy EntryStoreOutletContext's shape.
  setTaskProject: vi.fn(),
  setTaskSection: vi.fn(),
  setTaskParent: vi.fn(async () => {}),
  labels: [],
  resolveLabelIds: vi.fn(async () => []),
  comments: [],
  addComment: vi.fn(),
  editComment: vi.fn(),
  removeComment: vi.fn(),
  // Issue #171's Projects and Sections — these tests never exercise
  // them either, same reasoning as the setTaskProject/etc. stubs above.
  projects: [],
  addProject: vi.fn(),
  renameProject: vi.fn(),
  setProjectColour: vi.fn(),
  setProjectDescription: vi.fn(),
  setProjectFavourite: vi.fn(),
  archiveProject: vi.fn(),
  unarchiveProject: vi.fn(),
  setProjectParent: vi.fn(async () => {}),
  reorderProject: vi.fn(),
  listSections: vi.fn(async () => []),
  addSection: vi.fn(async () => {}),
  renameSection: vi.fn(),
  setSectionDescription: vi.fn(),
  reorderSection: vi.fn(),
  deleteSection: vi.fn(),
  archiveSection: vi.fn(),
  unarchiveSection: vi.fn(),
  events: [],
  listEventsByTask: vi.fn(async () => []),
  listEventsByProject: vi.fn(async () => []),
  filters: [],
  addFilter: vi.fn(() => "filter-1"),
  renameFilter: vi.fn(),
  setFilterColour: vi.fn(),
  setFilterQuery: vi.fn(async () => {}),
  removeFilter: vi.fn(),
  addLabel: vi.fn(),
  renameLabel: vi.fn(),
  setLabelColour: vi.fn(),
  removeLabel: vi.fn(),
  removeProject: vi.fn(),
  disabled: false,
};

describe("ComposerPage", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    useSettingsStore.setState({ theme: "system", serverUrl: "" });
    vi.mocked(toast).mockReset();
    vi.mocked(toast.error).mockReset();
    vi.mocked(toast.custom).mockClear();
    vi.mocked(toast.dismiss).mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ADR 0036 retires the persistent nav: a destination is a pane pushed over
  // the root screen, so the way back out is a Back control rather than a nav
  // link that was always on screen. `nav.test.tsx`'s "exactly four
  // destinations" assertion moves with it, to `chat-list.test.tsx`.
  it("offers a Back control out to the root screen", () => {
    renderComposerPage(readyContext);

    expect(screen.getByRole("link", { name: "Back to chats" })).toHaveAttribute("href", "/");
  });

  it("disables the Composer while the store isn't ready", () => {
    renderComposerPage({
      entries: [],
      sendEntry: vi.fn(),
      editEntry: vi.fn(),
      commitEntryEdit: vi.fn(),
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
      reorderTaskToday: vi.fn(),
      removeTask: vi.fn(),
      setTaskDate: vi.fn(),
      setTaskDeadline: vi.fn(),
      setTaskPriority: vi.fn(),
      setTaskDateString: vi.fn(),
      setTaskLabels: vi.fn(),
      setTaskDescription: vi.fn(),
      listTasksInProject: vi.fn(async () => []),
      listTaskChildren: vi.fn(async () => []),
      countTaskChildren: vi.fn(async () => ({ done: 0, total: 0 })),
      listTasksInSection: vi.fn(async () => []),
      listTaskDescendants: vi.fn(async () => []),
      advanceRecurringTask: vi.fn(),
      completeForeverTask: vi.fn(),
      postponeTask: vi.fn(),
      // Issue #171's three structural Task setters — these tests never
      // exercise Project/Section moves or reparenting, so a stub is enough
      // to satisfy EntryStoreOutletContext's shape.
      setTaskProject: vi.fn(),
      setTaskSection: vi.fn(),
      setTaskParent: vi.fn(async () => {}),
      labels: [],
      resolveLabelIds: vi.fn(async () => []),
      comments: [],
      addComment: vi.fn(),
      editComment: vi.fn(),
      removeComment: vi.fn(),
      // Issue #171's Projects and Sections — these tests never exercise
      // them either, same reasoning as the setTaskProject/etc. stubs above.
      projects: [],
      addProject: vi.fn(),
      renameProject: vi.fn(),
      setProjectColour: vi.fn(),
      setProjectDescription: vi.fn(),
      setProjectFavourite: vi.fn(),
      archiveProject: vi.fn(),
      unarchiveProject: vi.fn(),
      setProjectParent: vi.fn(async () => {}),
      reorderProject: vi.fn(),
      listSections: vi.fn(async () => []),
      addSection: vi.fn(async () => {}),
      renameSection: vi.fn(),
      setSectionDescription: vi.fn(),
      reorderSection: vi.fn(),
      deleteSection: vi.fn(),
      archiveSection: vi.fn(),
      unarchiveSection: vi.fn(),
      events: [],
      listEventsByTask: vi.fn(async () => []),
      listEventsByProject: vi.fn(async () => []),
      filters: [],
      addFilter: vi.fn(() => "filter-1"),
      renameFilter: vi.fn(),
      setFilterColour: vi.fn(),
      setFilterQuery: vi.fn(async () => {}),
      removeFilter: vi.fn(),
      addLabel: vi.fn(),
      renameLabel: vi.fn(),
      setLabelColour: vi.fn(),
      removeLabel: vi.fn(),
      removeProject: vi.fn(),
      disabled: true,
    });

    // Issue #155: the Composer's field is a `contenteditable` `<div>` now,
    // not an `<input>`/`<textarea>` — it never matches `:disabled` (jest-dom's
    // `toBeDisabled()` only recognises real form controls), so "disabled"
    // shows up as `aria-disabled` instead (composer.tsx's own `attributes`
    // function on the mounted `EditorView`).
    expect(screen.getByPlaceholderText("What's on your mind?")).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("shows the store's error message", () => {
    renderComposerPage({
      entries: [],
      sendEntry: vi.fn(),
      editEntry: vi.fn(),
      commitEntryEdit: vi.fn(),
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
      reorderTaskToday: vi.fn(),
      removeTask: vi.fn(),
      setTaskDate: vi.fn(),
      setTaskDeadline: vi.fn(),
      setTaskPriority: vi.fn(),
      setTaskDateString: vi.fn(),
      setTaskLabels: vi.fn(),
      setTaskDescription: vi.fn(),
      listTasksInProject: vi.fn(async () => []),
      listTaskChildren: vi.fn(async () => []),
      countTaskChildren: vi.fn(async () => ({ done: 0, total: 0 })),
      listTasksInSection: vi.fn(async () => []),
      listTaskDescendants: vi.fn(async () => []),
      advanceRecurringTask: vi.fn(),
      completeForeverTask: vi.fn(),
      postponeTask: vi.fn(),
      // Issue #171's three structural Task setters — these tests never
      // exercise Project/Section moves or reparenting, so a stub is enough
      // to satisfy EntryStoreOutletContext's shape.
      setTaskProject: vi.fn(),
      setTaskSection: vi.fn(),
      setTaskParent: vi.fn(async () => {}),
      labels: [],
      resolveLabelIds: vi.fn(async () => []),
      comments: [],
      addComment: vi.fn(),
      editComment: vi.fn(),
      removeComment: vi.fn(),
      // Issue #171's Projects and Sections — these tests never exercise
      // them either, same reasoning as the setTaskProject/etc. stubs above.
      projects: [],
      addProject: vi.fn(),
      renameProject: vi.fn(),
      setProjectColour: vi.fn(),
      setProjectDescription: vi.fn(),
      setProjectFavourite: vi.fn(),
      archiveProject: vi.fn(),
      unarchiveProject: vi.fn(),
      setProjectParent: vi.fn(async () => {}),
      reorderProject: vi.fn(),
      listSections: vi.fn(async () => []),
      addSection: vi.fn(async () => {}),
      renameSection: vi.fn(),
      setSectionDescription: vi.fn(),
      reorderSection: vi.fn(),
      deleteSection: vi.fn(),
      archiveSection: vi.fn(),
      unarchiveSection: vi.fn(),
      events: [],
      listEventsByTask: vi.fn(async () => []),
      listEventsByProject: vi.fn(async () => []),
      filters: [],
      addFilter: vi.fn(() => "filter-1"),
      renameFilter: vi.fn(),
      setFilterColour: vi.fn(),
      setFilterQuery: vi.fn(async () => {}),
      removeFilter: vi.fn(),
      addLabel: vi.fn(),
      renameLabel: vi.fn(),
      setLabelColour: vi.fn(),
      removeLabel: vi.fn(),
      removeProject: vi.fn(),
      disabled: true,
      message: "meologue couldn't open its storage. Reloading may help.",
    });

    expect(
      screen.getByText("meologue couldn't open its storage. Reloading may help."),
    ).toBeInTheDocument();
  });

  it("renders History from the outlet context", () => {
    renderComposerPage({
      entries: [
        {
          id: "1",
          deviceId: "device-a",
          body: "hello",
          // Issue #196: updatedAt starts equal to createdAt
          createdAt: "now",
          updatedAt: "now",
          seq: 1,
          syncedAt: "now",
          deletedAt: null,
        },
      ],
      sendEntry: vi.fn(),
      editEntry: vi.fn(),
      commitEntryEdit: vi.fn(),
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
      reorderTaskToday: vi.fn(),
      removeTask: vi.fn(),
      setTaskDate: vi.fn(),
      setTaskDeadline: vi.fn(),
      setTaskPriority: vi.fn(),
      setTaskDateString: vi.fn(),
      setTaskLabels: vi.fn(),
      setTaskDescription: vi.fn(),
      listTasksInProject: vi.fn(async () => []),
      listTaskChildren: vi.fn(async () => []),
      countTaskChildren: vi.fn(async () => ({ done: 0, total: 0 })),
      listTasksInSection: vi.fn(async () => []),
      listTaskDescendants: vi.fn(async () => []),
      advanceRecurringTask: vi.fn(),
      completeForeverTask: vi.fn(),
      postponeTask: vi.fn(),
      // Issue #171's three structural Task setters — these tests never
      // exercise Project/Section moves or reparenting, so a stub is enough
      // to satisfy EntryStoreOutletContext's shape.
      setTaskProject: vi.fn(),
      setTaskSection: vi.fn(),
      setTaskParent: vi.fn(async () => {}),
      labels: [],
      resolveLabelIds: vi.fn(async () => []),
      comments: [],
      addComment: vi.fn(),
      editComment: vi.fn(),
      removeComment: vi.fn(),
      // Issue #171's Projects and Sections — these tests never exercise
      // them either, same reasoning as the setTaskProject/etc. stubs above.
      projects: [],
      addProject: vi.fn(),
      renameProject: vi.fn(),
      setProjectColour: vi.fn(),
      setProjectDescription: vi.fn(),
      setProjectFavourite: vi.fn(),
      archiveProject: vi.fn(),
      unarchiveProject: vi.fn(),
      setProjectParent: vi.fn(async () => {}),
      reorderProject: vi.fn(),
      listSections: vi.fn(async () => []),
      addSection: vi.fn(async () => {}),
      renameSection: vi.fn(),
      setSectionDescription: vi.fn(),
      reorderSection: vi.fn(),
      deleteSection: vi.fn(),
      archiveSection: vi.fn(),
      unarchiveSection: vi.fn(),
      events: [],
      listEventsByTask: vi.fn(async () => []),
      listEventsByProject: vi.fn(async () => []),
      filters: [],
      addFilter: vi.fn(() => "filter-1"),
      renameFilter: vi.fn(),
      setFilterColour: vi.fn(),
      setFilterQuery: vi.fn(async () => {}),
      removeFilter: vi.fn(),
      addLabel: vi.fn(),
      renameLabel: vi.fn(),
      setLabelColour: vi.fn(),
      removeLabel: vi.fn(),
      removeProject: vi.fn(),
      disabled: false,
    });

    expect(screen.getByText("hello")).toBeInTheDocument();
  });

  // Ticket 53: the thread next to the Composer reads oldest-to-newest, the
  // reverse of what the outlet context hands it (store order — see
  // history.tsx's groupByDay comment). Three same-day Entries so this only
  // exercises the reversal, not day-separator placement.
  it("reverses the store's newest-first order to oldest-to-newest reading order", () => {
    renderComposerPage({
      entries: [
        {
          id: "3",
          deviceId: "device-a",
          body: "third",
          createdAt: "2026-08-18T12:00:00.000Z",
          updatedAt: "2026-08-18T12:00:00.000Z",
          seq: 3,
          syncedAt: "now",
          deletedAt: null,
        },
        {
          id: "2",
          deviceId: "device-a",
          body: "second",
          createdAt: "2026-08-18T11:00:00.000Z",
          updatedAt: "2026-08-18T11:00:00.000Z",
          seq: 2,
          syncedAt: "now",
          deletedAt: null,
        },
        {
          id: "1",
          deviceId: "device-a",
          body: "first",
          createdAt: "2026-08-18T10:00:00.000Z",
          updatedAt: "2026-08-18T10:00:00.000Z",
          seq: 1,
          syncedAt: "now",
          deletedAt: null,
        },
      ],
      sendEntry: vi.fn(),
      editEntry: vi.fn(),
      commitEntryEdit: vi.fn(),
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
      reorderTaskToday: vi.fn(),
      removeTask: vi.fn(),
      setTaskDate: vi.fn(),
      setTaskDeadline: vi.fn(),
      setTaskPriority: vi.fn(),
      setTaskDateString: vi.fn(),
      setTaskLabels: vi.fn(),
      setTaskDescription: vi.fn(),
      listTasksInProject: vi.fn(async () => []),
      listTaskChildren: vi.fn(async () => []),
      countTaskChildren: vi.fn(async () => ({ done: 0, total: 0 })),
      listTasksInSection: vi.fn(async () => []),
      listTaskDescendants: vi.fn(async () => []),
      advanceRecurringTask: vi.fn(),
      completeForeverTask: vi.fn(),
      postponeTask: vi.fn(),
      // Issue #171's three structural Task setters — these tests never
      // exercise Project/Section moves or reparenting, so a stub is enough
      // to satisfy EntryStoreOutletContext's shape.
      setTaskProject: vi.fn(),
      setTaskSection: vi.fn(),
      setTaskParent: vi.fn(async () => {}),
      labels: [],
      resolveLabelIds: vi.fn(async () => []),
      comments: [],
      addComment: vi.fn(),
      editComment: vi.fn(),
      removeComment: vi.fn(),
      // Issue #171's Projects and Sections — these tests never exercise
      // them either, same reasoning as the setTaskProject/etc. stubs above.
      projects: [],
      addProject: vi.fn(),
      renameProject: vi.fn(),
      setProjectColour: vi.fn(),
      setProjectDescription: vi.fn(),
      setProjectFavourite: vi.fn(),
      archiveProject: vi.fn(),
      unarchiveProject: vi.fn(),
      setProjectParent: vi.fn(async () => {}),
      reorderProject: vi.fn(),
      listSections: vi.fn(async () => []),
      addSection: vi.fn(async () => {}),
      renameSection: vi.fn(),
      setSectionDescription: vi.fn(),
      reorderSection: vi.fn(),
      deleteSection: vi.fn(),
      archiveSection: vi.fn(),
      unarchiveSection: vi.fn(),
      events: [],
      listEventsByTask: vi.fn(async () => []),
      listEventsByProject: vi.fn(async () => []),
      filters: [],
      addFilter: vi.fn(() => "filter-1"),
      renameFilter: vi.fn(),
      setFilterColour: vi.fn(),
      setFilterQuery: vi.fn(async () => {}),
      removeFilter: vi.fn(),
      addLabel: vi.fn(),
      renameLabel: vi.fn(),
      setLabelColour: vi.fn(),
      removeLabel: vi.fn(),
      removeProject: vi.fn(),
      disabled: false,
    });

    const bodies = screen.getAllByText(/^(first|second|third)$/).map((el) => el.textContent);
    expect(bodies).toEqual(["first", "second", "third"]);
  });

  it("shows a hint that Sync is off when no Server URL is set", () => {
    renderComposerPage(readyContext);

    expect(screen.getByText(/sync is off/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /add a server url/i })).toHaveAttribute(
      "href",
      "/settings",
    );
  });

  it("hides the hint once a Server URL is set", () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");

    renderComposerPage(readyContext);

    expect(screen.queryByText(/sync is off/i)).not.toBeInTheDocument();
  });

  // Ticket 55: Search moves into the app bar as a mode rather than a
  // destination. Issue #75 deleted History's own page, so the Composer is
  // now the only page in EntryStoreLayout Search narrows this way (Sessions'
  // own search, sessions-page.tsx, is a separate collection with its own
  // tests) — this file proves the wiring works here, not every edge
  // use-history-search.ts already owns.
  describe("Search", () => {
    it("shows no search field until the magnifier is tapped", () => {
      renderComposerPage(readyContext);

      expect(screen.queryByRole("searchbox", { name: "Search History" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Search History" })).toBeInTheDocument();
    });

    it("tapping the magnifier expands the app bar into a search field", () => {
      renderComposerPage(readyContext);

      fireEvent.click(screen.getByRole("button", { name: "Search History" }));

      expect(screen.getByRole("searchbox", { name: "Search History" })).toBeInTheDocument();
      // The title/Sync-dot row is what the field replaces "in place" — it's
      // gone while searching, not merely covered.
      expect(screen.queryByText("Composer")).not.toBeInTheDocument();
    });

    it("narrows the Composer's thread to what the store's search returns", async () => {
      // A match not already in the unfiltered fallback list, so finding it
      // proves the real (async) search result landed, not the fallback
      // useEntrySearch shows while that search is still in flight.
      const searchOnlyMatch = {
        id: "3",
        deviceId: "device-a",
        body: "a match only search returns",
        createdAt: "now",
        updatedAt: "now",
        seq: 3,
        syncedAt: "now",
        deletedAt: null,
      };
      const search = vi.fn(async (query: string) => (query === "wor" ? [searchOnlyMatch] : []));

      renderComposerPage({
        entries: [
          {
            id: "1",
            deviceId: "device-a",
            body: "hello",
            createdAt: "now",
            updatedAt: "now",
            seq: 1,
            syncedAt: "now",
            deletedAt: null,
          },
          {
            id: "2",
            deviceId: "device-a",
            body: "world",
            createdAt: "now",
            updatedAt: "now",
            seq: 2,
            syncedAt: "now",
            deletedAt: null,
          },
        ],
        sendEntry: vi.fn(),
        editEntry: vi.fn(),
        commitEntryEdit: vi.fn(),
        removeEntry: vi.fn(),
        search,
        getEntries: vi.fn(async () => []),
        pagination: { hasMore: false, fetching: false, fetchMore: vi.fn() },
        tasks: [],
        completedTasks: [],
        addTask: vi.fn(),
        completeTask: vi.fn(),
        uncompleteTask: vi.fn(),
        renameTask: vi.fn(),
        reorderTask: vi.fn(),
        reorderTaskToday: vi.fn(),
        removeTask: vi.fn(),
        setTaskDate: vi.fn(),
        setTaskDeadline: vi.fn(),
        setTaskPriority: vi.fn(),
        setTaskDateString: vi.fn(),
        setTaskLabels: vi.fn(),
        setTaskDescription: vi.fn(),
        listTasksInProject: vi.fn(async () => []),
        listTaskChildren: vi.fn(async () => []),
        countTaskChildren: vi.fn(async () => ({ done: 0, total: 0 })),
        listTasksInSection: vi.fn(async () => []),
        listTaskDescendants: vi.fn(async () => []),
        advanceRecurringTask: vi.fn(),
        completeForeverTask: vi.fn(),
        postponeTask: vi.fn(),
        // Issue #171's three structural Task setters — these tests never
        // exercise Project/Section moves or reparenting, so a stub is enough
        // to satisfy EntryStoreOutletContext's shape.
        setTaskProject: vi.fn(),
        setTaskSection: vi.fn(),
        setTaskParent: vi.fn(async () => {}),
        labels: [],
        resolveLabelIds: vi.fn(async () => []),
        comments: [],
        addComment: vi.fn(),
        editComment: vi.fn(),
        removeComment: vi.fn(),
        // Issue #171's Projects and Sections — these tests never exercise
        // them either, same reasoning as the setTaskProject/etc. stubs above.
        projects: [],
        addProject: vi.fn(),
        renameProject: vi.fn(),
        setProjectColour: vi.fn(),
        setProjectDescription: vi.fn(),
        setProjectFavourite: vi.fn(),
        archiveProject: vi.fn(),
        unarchiveProject: vi.fn(),
        setProjectParent: vi.fn(async () => {}),
        reorderProject: vi.fn(),
        listSections: vi.fn(async () => []),
        addSection: vi.fn(async () => {}),
        renameSection: vi.fn(),
        setSectionDescription: vi.fn(),
        reorderSection: vi.fn(),
        deleteSection: vi.fn(),
        archiveSection: vi.fn(),
        unarchiveSection: vi.fn(),
        events: [],
        listEventsByTask: vi.fn(async () => []),
        listEventsByProject: vi.fn(async () => []),
        filters: [],
        addFilter: vi.fn(() => "filter-1"),
        renameFilter: vi.fn(),
        setFilterColour: vi.fn(),
        setFilterQuery: vi.fn(async () => {}),
        removeFilter: vi.fn(),
        addLabel: vi.fn(),
        renameLabel: vi.fn(),
        setLabelColour: vi.fn(),
        removeLabel: vi.fn(),
        removeProject: vi.fn(),
        disabled: false,
      });

      fireEvent.click(screen.getByRole("button", { name: "Search History" }));
      fireEvent.change(screen.getByRole("searchbox", { name: "Search History" }), {
        target: { value: "wor" },
      });

      expect(await screen.findByText("a match only search returns")).toBeInTheDocument();
      expect(screen.queryByText("hello")).not.toBeInTheDocument();
      expect(screen.queryByText("world")).not.toBeInTheDocument();
      expect(search).toHaveBeenLastCalledWith("wor");
    });

    // Ticket 53's hard constraint, extended to this page by ticket 55:
    // `search()` is contractually the same order as `list()` (ADR 0014,
    // newest-first) — narrowing to a search result must reverse to
    // oldest-to-newest exactly like the unfiltered thread does.
    it("reverses a search result's order the same way it reverses the unfiltered thread", async () => {
      const search = vi.fn(async () => [
        {
          id: "2",
          deviceId: "device-a",
          body: "search-newer",
          createdAt: "2026-08-18T12:00:00.000Z",
          updatedAt: "2026-08-18T12:00:00.000Z",
          seq: 2,
          syncedAt: "now",
          deletedAt: null,
        },
        {
          id: "1",
          deviceId: "device-a",
          body: "search-older",
          createdAt: "2026-08-18T10:00:00.000Z",
          updatedAt: "2026-08-18T10:00:00.000Z",
          seq: 1,
          syncedAt: "now",
          deletedAt: null,
        },
      ]);

      const { container } = renderComposerPage({
        entries: [],
        sendEntry: vi.fn(),
        editEntry: vi.fn(),
        commitEntryEdit: vi.fn(),
        removeEntry: vi.fn(),
        search,
        getEntries: vi.fn(async () => []),
        pagination: { hasMore: false, fetching: false, fetchMore: vi.fn() },
        tasks: [],
        completedTasks: [],
        addTask: vi.fn(),
        completeTask: vi.fn(),
        uncompleteTask: vi.fn(),
        renameTask: vi.fn(),
        reorderTask: vi.fn(),
        reorderTaskToday: vi.fn(),
        removeTask: vi.fn(),
        setTaskDate: vi.fn(),
        setTaskDeadline: vi.fn(),
        setTaskPriority: vi.fn(),
        setTaskDateString: vi.fn(),
        setTaskLabels: vi.fn(),
        setTaskDescription: vi.fn(),
        listTasksInProject: vi.fn(async () => []),
        listTaskChildren: vi.fn(async () => []),
        countTaskChildren: vi.fn(async () => ({ done: 0, total: 0 })),
        listTasksInSection: vi.fn(async () => []),
        listTaskDescendants: vi.fn(async () => []),
        advanceRecurringTask: vi.fn(),
        completeForeverTask: vi.fn(),
        postponeTask: vi.fn(),
        // Issue #171's three structural Task setters — these tests never
        // exercise Project/Section moves or reparenting, so a stub is enough
        // to satisfy EntryStoreOutletContext's shape.
        setTaskProject: vi.fn(),
        setTaskSection: vi.fn(),
        setTaskParent: vi.fn(async () => {}),
        labels: [],
        resolveLabelIds: vi.fn(async () => []),
        comments: [],
        addComment: vi.fn(),
        editComment: vi.fn(),
        removeComment: vi.fn(),
        // Issue #171's Projects and Sections — these tests never exercise
        // them either, same reasoning as the setTaskProject/etc. stubs above.
        projects: [],
        addProject: vi.fn(),
        renameProject: vi.fn(),
        setProjectColour: vi.fn(),
        setProjectDescription: vi.fn(),
        setProjectFavourite: vi.fn(),
        archiveProject: vi.fn(),
        unarchiveProject: vi.fn(),
        setProjectParent: vi.fn(async () => {}),
        reorderProject: vi.fn(),
        listSections: vi.fn(async () => []),
        addSection: vi.fn(async () => {}),
        renameSection: vi.fn(),
        setSectionDescription: vi.fn(),
        reorderSection: vi.fn(),
        deleteSection: vi.fn(),
        archiveSection: vi.fn(),
        unarchiveSection: vi.fn(),
        events: [],
        listEventsByTask: vi.fn(async () => []),
        listEventsByProject: vi.fn(async () => []),
        filters: [],
        addFilter: vi.fn(() => "filter-1"),
        renameFilter: vi.fn(),
        setFilterColour: vi.fn(),
        setFilterQuery: vi.fn(async () => {}),
        removeFilter: vi.fn(),
        addLabel: vi.fn(),
        renameLabel: vi.fn(),
        setLabelColour: vi.fn(),
        removeLabel: vi.fn(),
        removeProject: vi.fn(),
        disabled: false,
      });

      fireEvent.click(screen.getByRole("button", { name: "Search History" }));
      fireEvent.change(screen.getByRole("searchbox", { name: "Search History" }), {
        target: { value: "search" },
      });

      // The matched "search" prefix is highlighted (highlight-match.ts) into
      // its own <mark>, so each Entry's body is split across sibling text
      // nodes — waiting for "older" with exact:false is what tolerates
      // that.
      await screen.findByText("older", { exact: false });
      const bodies = Array.from(container.querySelectorAll('[data-slot="bubble-body"]')).map(
        (el) => el.textContent,
      );
      expect(bodies).toEqual(["search-older", "search-newer"]);
    });

    it("puts what the user types into the URL without pushing an entry per keystroke", () => {
      renderComposerPage(readyContext);

      fireEvent.click(screen.getByRole("button", { name: "Search History" }));
      fireEvent.change(screen.getByRole("searchbox", { name: "Search History" }), {
        target: { value: "wor" },
      });

      expect(screen.getByTestId("url-query")).toHaveTextContent("q=wor");
    });

    // Ticket 55's dismiss half of the acceptance criteria — shell.test.tsx
    // covers the rule itself; this proves ComposerPage wires Shell's
    // onDismiss the same way.
    it("dismissing search restores the app bar and clears the narrowing", () => {
      renderComposerPage({
        entries: [
          {
            id: "1",
            deviceId: "device-a",
            body: "hello",
            createdAt: "now",
            updatedAt: "now",
            seq: 1,
            syncedAt: "now",
            deletedAt: null,
          },
        ],
        sendEntry: vi.fn(),
        editEntry: vi.fn(),
        commitEntryEdit: vi.fn(),
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
        reorderTaskToday: vi.fn(),
        removeTask: vi.fn(),
        setTaskDate: vi.fn(),
        setTaskDeadline: vi.fn(),
        setTaskPriority: vi.fn(),
        setTaskDateString: vi.fn(),
        setTaskLabels: vi.fn(),
        setTaskDescription: vi.fn(),
        listTasksInProject: vi.fn(async () => []),
        listTaskChildren: vi.fn(async () => []),
        countTaskChildren: vi.fn(async () => ({ done: 0, total: 0 })),
        listTasksInSection: vi.fn(async () => []),
        listTaskDescendants: vi.fn(async () => []),
        advanceRecurringTask: vi.fn(),
        completeForeverTask: vi.fn(),
        postponeTask: vi.fn(),
        // Issue #171's three structural Task setters — these tests never
        // exercise Project/Section moves or reparenting, so a stub is enough
        // to satisfy EntryStoreOutletContext's shape.
        setTaskProject: vi.fn(),
        setTaskSection: vi.fn(),
        setTaskParent: vi.fn(async () => {}),
        labels: [],
        resolveLabelIds: vi.fn(async () => []),
        comments: [],
        addComment: vi.fn(),
        editComment: vi.fn(),
        removeComment: vi.fn(),
        // Issue #171's Projects and Sections — these tests never exercise
        // them either, same reasoning as the setTaskProject/etc. stubs above.
        projects: [],
        addProject: vi.fn(),
        renameProject: vi.fn(),
        setProjectColour: vi.fn(),
        setProjectDescription: vi.fn(),
        setProjectFavourite: vi.fn(),
        archiveProject: vi.fn(),
        unarchiveProject: vi.fn(),
        setProjectParent: vi.fn(async () => {}),
        reorderProject: vi.fn(),
        listSections: vi.fn(async () => []),
        addSection: vi.fn(async () => {}),
        renameSection: vi.fn(),
        setSectionDescription: vi.fn(),
        reorderSection: vi.fn(),
        deleteSection: vi.fn(),
        archiveSection: vi.fn(),
        unarchiveSection: vi.fn(),
        events: [],
        listEventsByTask: vi.fn(async () => []),
        listEventsByProject: vi.fn(async () => []),
        filters: [],
        addFilter: vi.fn(() => "filter-1"),
        renameFilter: vi.fn(),
        setFilterColour: vi.fn(),
        setFilterQuery: vi.fn(async () => {}),
        removeFilter: vi.fn(),
        addLabel: vi.fn(),
        renameLabel: vi.fn(),
        setLabelColour: vi.fn(),
        removeLabel: vi.fn(),
        removeProject: vi.fn(),
        disabled: false,
      });

      fireEvent.click(screen.getByRole("button", { name: "Search History" }));
      fireEvent.change(screen.getByRole("searchbox", { name: "Search History" }), {
        target: { value: "wor" },
      });
      expect(screen.getByTestId("url-query")).toHaveTextContent("q=wor");

      fireEvent.click(screen.getByRole("button", { name: "Close search" }));

      expect(screen.queryByRole("searchbox", { name: "Search History" })).not.toBeInTheDocument();
      expect(screen.getByTestId("url-query")).toHaveTextContent("");
      expect(screen.getByText("hello")).toBeInTheDocument();
    });

    it("seeds the search field open from a query already in the URL", async () => {
      const search = vi.fn(async () => [
        {
          id: "2",
          deviceId: "device-a",
          body: "world",
          createdAt: "now",
          updatedAt: "now",
          seq: 1,
          syncedAt: "now",
          deletedAt: null,
        },
      ]);

      renderComposerPage(
        {
          entries: [
            {
              id: "1",
              deviceId: "device-a",
              body: "hello",
              createdAt: "now",
              updatedAt: "now",
              seq: 1,
              syncedAt: "now",
              deletedAt: null,
            },
          ],
          sendEntry: vi.fn(),
          editEntry: vi.fn(),
          commitEntryEdit: vi.fn(),
          removeEntry: vi.fn(),
          search,
          getEntries: vi.fn(async () => []),
          pagination: { hasMore: false, fetching: false, fetchMore: vi.fn() },
          tasks: [],
          completedTasks: [],
          addTask: vi.fn(),
          completeTask: vi.fn(),
          uncompleteTask: vi.fn(),
          renameTask: vi.fn(),
          reorderTask: vi.fn(),
          reorderTaskToday: vi.fn(),
          removeTask: vi.fn(),
          setTaskDate: vi.fn(),
          setTaskDeadline: vi.fn(),
          setTaskPriority: vi.fn(),
          setTaskDateString: vi.fn(),
          setTaskLabels: vi.fn(),
          setTaskDescription: vi.fn(),
          listTasksInProject: vi.fn(async () => []),
          listTaskChildren: vi.fn(async () => []),
          countTaskChildren: vi.fn(async () => ({ done: 0, total: 0 })),
          listTasksInSection: vi.fn(async () => []),
          listTaskDescendants: vi.fn(async () => []),
          advanceRecurringTask: vi.fn(),
          completeForeverTask: vi.fn(),
          postponeTask: vi.fn(),
          // Issue #171's three structural Task setters — these tests never
          // exercise Project/Section moves or reparenting, so a stub is enough
          // to satisfy EntryStoreOutletContext's shape.
          setTaskProject: vi.fn(),
          setTaskSection: vi.fn(),
          setTaskParent: vi.fn(async () => {}),
          labels: [],
          resolveLabelIds: vi.fn(async () => []),
          comments: [],
          addComment: vi.fn(),
          editComment: vi.fn(),
          removeComment: vi.fn(),
          // Issue #171's Projects and Sections — these tests never exercise
          // them either, same reasoning as the setTaskProject/etc. stubs above.
          projects: [],
          addProject: vi.fn(),
          renameProject: vi.fn(),
          setProjectColour: vi.fn(),
          setProjectDescription: vi.fn(),
          setProjectFavourite: vi.fn(),
          archiveProject: vi.fn(),
          unarchiveProject: vi.fn(),
          setProjectParent: vi.fn(async () => {}),
          reorderProject: vi.fn(),
          listSections: vi.fn(async () => []),
          addSection: vi.fn(async () => {}),
          renameSection: vi.fn(),
          setSectionDescription: vi.fn(),
          reorderSection: vi.fn(),
          deleteSection: vi.fn(),
          archiveSection: vi.fn(),
          unarchiveSection: vi.fn(),
          events: [],
          listEventsByTask: vi.fn(async () => []),
          listEventsByProject: vi.fn(async () => []),
          filters: [],
          addFilter: vi.fn(() => "filter-1"),
          renameFilter: vi.fn(),
          setFilterColour: vi.fn(),
          setFilterQuery: vi.fn(async () => {}),
          removeFilter: vi.fn(),
          addLabel: vi.fn(),
          renameLabel: vi.fn(),
          setLabelColour: vi.fn(),
          removeLabel: vi.fn(),
          removeProject: vi.fn(),
          disabled: false,
        },
        "/?q=wor",
      );

      expect(screen.getByRole("searchbox", { name: "Search History" })).toHaveValue("wor");
      expect(await screen.findByText("world")).toBeInTheDocument();
    });
  });

  // ADR 0028 (issue #78): this is the real wiring — EntryRow's actions,
  // through History's shared EntryActionsSheet, into ComposerPage's own
  // editingEntry state and the docked Composer. Each layer already has its
  // own focused test (entry-row.test.tsx, entry-actions.test.tsx,
  // composer.test.tsx, use-history.test.tsx); this is the one place that
  // proves they're actually connected. jsdom has no `matchMedia`
  // (`hoverCapable()`, lib/pointer.ts, reads that as "no hover"), so a
  // plain tap on the row here opens the sheet exactly as it would on a
  // touch device — no explicit stub needed for that default.
  // #127: the sheet is reached by swiping a bubble left, not by tapping it.
  describe("Edit and Delete from a row's shared actions sheet", () => {
    const oneEntry: EntryStoreOutletContext["entries"] = [
      {
        id: "1",
        deviceId: "device-a",
        body: "hello",
        createdAt: "now",
        updatedAt: "now",
        seq: 1,
        syncedAt: "now",
        deletedAt: null,
      },
    ];

    it("choosing Edit puts the Composer into editing mode, seeded with the Entry's body", async () => {
      renderComposerPage({ ...readyContext, entries: oneEntry });

      swipeLeft(screen.getByText("hello"));
      fireEvent.click(await screen.findByText("Edit"));

      expect(screen.getByText("Editing Entry")).toBeInTheDocument();
      // Issue #155: `.toHaveValue()` only reads `<input>`/`<textarea>`; the
      // field is a `contenteditable` `<div>` now, so its rendered text is
      // read straight off `textContent` instead.
      expect(screen.getByPlaceholderText("What's on your mind?").textContent).toBe("hello");
    });

    // Issue #82: choosing Delete opens a confirm dialog rather than
    // calling removeEntry on the spot (the ConfirmDialog history.tsx
    // renders, one level above every row); removeEntry only fires once
    // that confirmation is accepted.
    it("choosing Delete, then confirming, calls removeEntry from the outlet context with the whole Entry", async () => {
      const removeEntry = vi.fn();
      renderComposerPage({ ...readyContext, entries: oneEntry, removeEntry });

      swipeLeft(screen.getByText("hello"));
      fireEvent.click(await screen.findByText("Delete"));

      expect(removeEntry).not.toHaveBeenCalled();

      fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

      expect(removeEntry).toHaveBeenCalledWith(oneEntry[0]);
    });
  });

  // Issue #153, retired by issue #231 (ADR 0074): a checkbox tap used to
  // wire straight through — History's rendered checkbox, into this page's
  // own `handleToggleTask`, into the same `editEntry` an ordinary Composer
  // edit commits through (ADR 0043's "a tick is an ordinary Entry edit")
  // — and `toggle-task.test.ts`/`entry-prose.test.tsx` covered the splice
  // and the rendering. A *bare* checkbox (no `[[task:id|label]]` mark
  // behind it) now has nothing to tick or open — see entry-prose.tsx's own
  // module comment — so this proves the end-to-end path from a real tap
  // through this page never reaches `editEntry` any more.
  describe("Tapping a checkbox", () => {
    const withTask: EntryStoreOutletContext["entries"] = [
      {
        id: "1",
        deviceId: "device-a",
        body: "- [ ] call mum\n- [ ] buy milk",
        createdAt: "2026-08-30T09:00:00.000Z",
        updatedAt: "2026-08-30T09:00:00.000Z",
        seq: 1,
        syncedAt: "now",
        deletedAt: null,
      },
    ];

    it("renders a bare checkbox disabled, and a tap never calls editEntry", () => {
      const editEntry = vi.fn();
      renderComposerPage({ ...readyContext, entries: withTask, editEntry });

      const checkbox = screen.getByRole("checkbox", { name: "call mum" });
      expect(checkbox).toBeDisabled();
      fireEvent.click(checkbox);

      expect(editEntry).not.toHaveBeenCalled();
      expect(checkbox).not.toBeChecked();
    });

    it("reading the page without tapping calls editEntry not at all", () => {
      const editEntry = vi.fn();
      renderComposerPage({ ...readyContext, entries: withTask, editEntry });

      expect(screen.getAllByRole("checkbox")).toHaveLength(2);
      expect(editEntry).not.toHaveBeenCalled();
    });
  });

  // Issue #144: the real, end-to-end wiring for "Refer" — History's shared
  // sheet, into this page's own `handleRefer`, into the docked Composer
  // via `composerRef`. Each layer already has its own focused test
  // (entry-row.test.tsx, entry-actions.test.tsx, history.test.tsx,
  // composer.test.tsx); this is the one place that proves they're actually
  // connected, the same role the Edit/Delete describe block just above
  // plays for those two actions.
  describe("Refer from a row's shared actions sheet", () => {
    const referredEntry: EntryStoreOutletContext["entries"][number] = {
      id: "referred-entry-id",
      deviceId: "device-a",
      body: "hello",
      createdAt: "now",
      updatedAt: "now",
      seq: 1,
      syncedAt: "now",
      deletedAt: null,
    };

    it("puts a Reference to the Entry into the Composer, with no raw id visible in the sheet itself", async () => {
      renderComposerPage({ ...readyContext, entries: [referredEntry] });

      swipeLeft(screen.getByText("hello"));
      // The sheet names the action, never the id it acts on.
      expect(screen.queryByText(referredEntry.id)).not.toBeInTheDocument();
      fireEvent.click(await screen.findByText("Refer to this Entry"));

      expect(screen.getByPlaceholderText("What's on your mind?").textContent).toBe(
        `[[e:${referredEntry.id}]]`,
      );
    });

    // The Composer's `editingEntry` mode (ADR 0028) has its own textarea
    // state, seeded from the Entry being edited rather than from whatever
    // was mid-composition before — Refer has to land in THAT text, not
    // start a fresh, separate Entry the reader never asked for.
    it("inserts into an Entry already being edited, rather than starting a new Entry", async () => {
      const editEntry = vi.fn();
      const entries: EntryStoreOutletContext["entries"] = [
        { ...referredEntry, id: "being-edited", body: "editing this one" },
        { ...referredEntry, id: "referred-entry-id-2" },
      ];
      renderComposerPage({ ...readyContext, entries, editEntry });

      // Enter edit mode on the first Entry.
      swipeLeft(screen.getByText("editing this one"));
      fireEvent.click(await screen.findByText("Edit"));
      expect(screen.getByPlaceholderText("What's on your mind?").textContent).toBe(
        "editing this one",
      );

      // Refer to the second Entry while still editing the first.
      swipeLeft(screen.getByText("hello"));
      fireEvent.click(await screen.findByText("Refer to this Entry"));

      expect(screen.getByText("Editing Entry")).toBeInTheDocument();
      expect(screen.getByPlaceholderText("What's on your mind?").textContent).toBe(
        "editing this one[[e:referred-entry-id-2]]",
      );
      expect(editEntry).not.toHaveBeenCalled();
    });
  });

  // Issue #173: `handleCommitEdit` routes a genuine edit-commit through
  // `commitEntryEdit` (use-history.ts), not plain `editEntry` — the door
  // that also runs Promotion (ADR 0048: a bare checkbox the reader just
  // added while editing becomes a Task too, not only one Sent fresh).
  // Driven through the same "Refer" insertion the describe block above
  // already proves dirties the document via a real dispatched transaction
  // (`insertAtCursor`), rather than simulated typing composer.tsx's own
  // module comment says jsdom cannot drive (ADR 0044) — Send is then an
  // ordinary button click on already-dirtied content.
  describe("committing an edit", () => {
    it("calls commitEntryEdit, not editEntry, once the edited document actually changed", async () => {
      const editEntry = vi.fn();
      const commitEntryEdit = vi.fn();
      const base: EntryStoreOutletContext["entries"][number] = {
        id: "referred-entry-id-2",
        deviceId: "device-a",
        body: "hello",
        createdAt: "now",
        updatedAt: "now",
        seq: 1,
        syncedAt: "now",
        deletedAt: null,
      };
      const entries: EntryStoreOutletContext["entries"] = [
        { ...base, id: "being-edited", body: "editing this one" },
        base,
      ];
      renderComposerPage({ ...readyContext, entries, editEntry, commitEntryEdit });

      swipeLeft(screen.getByText("editing this one"));
      fireEvent.click(await screen.findByText("Edit"));
      expect(screen.getByPlaceholderText("What's on your mind?").textContent).toBe(
        "editing this one",
      );

      // Dirties the document via a real transaction, the same mechanism
      // Refer's own test above already exercises.
      swipeLeft(screen.getByText("hello"));
      fireEvent.click(await screen.findByText("Refer to this Entry"));
      expect(screen.getByPlaceholderText("What's on your mind?").textContent).toBe(
        "editing this one[[e:referred-entry-id-2]]",
      );

      fireEvent.click(screen.getByLabelText("Send"));

      // `insertAtCursor` writes literal characters, not a live `reference`
      // node (only a hand-typed `[[…]]` or a picker choice ever creates
      // one — composer-editor.ts's own `referenceInputRule`) — so
      // `entryDocumentToMarkdown`'s own `escapeUserText` protects the
      // leading `[` of the pasted-looking `[[e:…]]` the same way it would
      // for any other reader-typed text that happens to start a mark. This
      // assertion is about which DOOR the commit went through, not about
      // Refer's own escaping, which the describe block above already
      // covers on its own terms.
      // The third argument (issue #173's own follow-up) is `composer.tsx`'s
      // own `ComposerPromotionContext` — built fresh off the live editor at
      // Send, so it's asserted on shape (`quickAddOptions` present, no
      // active checklist item here — this Entry has no checkbox line at
      // all) rather than pinned to a literal, since `now` is read from the
      // real clock this test doesn't control.
      expect(commitEntryEdit).toHaveBeenCalledWith(
        "being-edited",
        "editing this one\\[[e:referred-entry-id-2]]",
        {
          quickAddOptions: expect.objectContaining({ smartDates: expect.any(Boolean) }),
          active: null,
        },
      );
      expect(editEntry).not.toHaveBeenCalled();
    });
  });

  // Issue #142: following a date Reference lands here with `?d=YYYY-MM-DD`
  // (composer-page.tsx's own comment on why a query param, not a path
  // segment) — this page owns the seek: reading the param, deciding
  // whether to fetch another page or give up, and clearing the param once
  // there's nothing left to do.
  describe("a date-Reference seek (?d=)", () => {
    function seekEntry(id: string, createdAt: string): EntryStoreOutletContext["entries"][number] {
      return {
        id,
        deviceId: "device-a",
        body: `entry ${id}`,
        createdAt,
        updatedAt: createdAt,
        seq: 1,
        syncedAt: "now",
        deletedAt: null,
      };
    }

    // A dedicated render helper for this describe block, rather than
    // `renderComposerPage` above: a couple of these tests need to
    // `rerender` with a *changed* outlet context (simulating an older page
    // landing) against the exact same QueryClient and MemoryRouter
    // instance — swapping in a brand-new QueryClient on rerender would
    // reset every query's cached state, not just the one this test cares
    // about.
    function renderSeek(context: EntryStoreOutletContext, initialPath: string) {
      const queryClient = new QueryClient();
      const utils = render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={[initialPath]}>
            <SearchParamProbe />
            <Routes>
              <Route element={<Outlet context={context} />}>
                <Route path="/" element={<ComposerPage />} />
              </Route>
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );
      function rerenderWith(nextContext: EntryStoreOutletContext) {
        utils.rerender(
          <QueryClientProvider client={queryClient}>
            <MemoryRouter initialEntries={[initialPath]}>
              <SearchParamProbe />
              <Routes>
                <Route element={<Outlet context={nextContext} />}>
                  <Route path="/" element={<ComposerPage />} />
                </Route>
              </Routes>
            </MemoryRouter>
          </QueryClientProvider>,
        );
      }
      return { ...utils, rerenderWith };
    }

    it("clears ?d= once the target day is already loaded", async () => {
      renderComposerPage(
        {
          ...readyContext,
          entries: [seekEntry("1", "2020-01-01T10:00:00.000Z")],
        },
        "/?d=2020-01-01",
      );

      await waitFor(() => expect(screen.getByTestId("url-query")).not.toHaveTextContent("d="));
    });

    it("loads older pages until the target day appears, then clears ?d=", async () => {
      const fetchMore = vi.fn();
      const pagination = { hasMore: true, fetching: false, fetchMore };

      const { rerenderWith } = renderSeek(
        {
          ...readyContext,
          entries: [seekEntry("1", "2026-08-18T10:00:00.000Z")],
          pagination,
        },
        "/?d=2020-01-01",
      );

      await waitFor(() => expect(fetchMore).toHaveBeenCalledTimes(1));
      expect(screen.getByTestId("url-query")).toHaveTextContent("d=2020-01-01");

      // The page that request asked for lands, and it holds the target day.
      rerenderWith({
        ...readyContext,
        entries: [
          seekEntry("1", "2026-08-18T10:00:00.000Z"),
          seekEntry("2", "2020-01-01T10:00:00.000Z"),
        ],
        pagination,
      });

      await waitFor(() => expect(screen.getByTestId("url-query")).not.toHaveTextContent("d="));
    });

    it("clears ?d= once there are no more older pages to check, without ever fetching", async () => {
      const fetchMore = vi.fn();

      renderComposerPage(
        {
          ...readyContext,
          entries: [seekEntry("1", "2026-08-18T10:00:00.000Z")],
          pagination: { hasMore: false, fetching: false, fetchMore },
        },
        "/?d=2020-01-01",
      );

      await waitFor(() => expect(screen.getByTestId("url-query")).not.toHaveTextContent("d="));
      expect(fetchMore).not.toHaveBeenCalled();
    });

    it("does not call fetchMore while a page is already in flight", async () => {
      const fetchMore = vi.fn();

      renderComposerPage(
        {
          ...readyContext,
          entries: [seekEntry("1", "2026-08-18T10:00:00.000Z")],
          pagination: { hasMore: true, fetching: true, fetchMore },
        },
        "/?d=2020-01-01",
      );

      // Give History's own effect a chance to run before asserting the
      // negative — otherwise this would pass trivially before anything had
      // a chance to fire at all.
      await waitFor(() => expect(screen.getByTestId("url-query")).toHaveTextContent("d="));
      expect(fetchMore).not.toHaveBeenCalled();
    });

    it("ignores a malformed ?d=, the same as no seek at all", () => {
      renderComposerPage(readyContext, "/?d=not-a-day");

      expect(screen.getByTestId("url-query")).toHaveTextContent("d=not-a-day");
    });
  });

  // Issue #143: following an Entry Reference's chip lands here with
  // `?e=<uuid>`, extending the exact same seek mechanism the `?d=` suite
  // above already covers — mirrored test for test.
  describe("an Entry-Reference seek (?e=)", () => {
    const targetId = "0192abcd-1234-7890-abcd-0123456789ab";

    function seekEntry(id: string, createdAt: string): EntryStoreOutletContext["entries"][number] {
      return {
        id,
        deviceId: "device-a",
        body: `entry ${id}`,
        createdAt,
        updatedAt: createdAt,
        seq: 1,
        syncedAt: "now",
        deletedAt: null,
      };
    }

    // Same reasoning as the `?d=` suite's own `renderSeek`: a couple of
    // these tests need to `rerender` with a *changed* outlet context
    // (simulating an older page landing) against the exact same
    // QueryClient and MemoryRouter, so a fresh render per assertion isn't
    // an option.
    function renderSeek(context: EntryStoreOutletContext, initialPath: string) {
      const queryClient = new QueryClient();
      const utils = render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={[initialPath]}>
            <SearchParamProbe />
            <Routes>
              <Route element={<Outlet context={context} />}>
                <Route path="/" element={<ComposerPage />} />
              </Route>
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );
      function rerenderWith(nextContext: EntryStoreOutletContext) {
        utils.rerender(
          <QueryClientProvider client={queryClient}>
            <MemoryRouter initialEntries={[initialPath]}>
              <SearchParamProbe />
              <Routes>
                <Route element={<Outlet context={nextContext} />}>
                  <Route path="/" element={<ComposerPage />} />
                </Route>
              </Routes>
            </MemoryRouter>
          </QueryClientProvider>,
        );
      }
      return { ...utils, rerenderWith };
    }

    it("clears ?e= once the target Entry is already loaded", async () => {
      renderComposerPage(
        {
          ...readyContext,
          entries: [seekEntry(targetId, "2020-01-01T10:00:00.000Z")],
        },
        `/?e=${targetId}`,
      );

      await waitFor(() => expect(screen.getByTestId("url-query")).not.toHaveTextContent("e="));
    });

    it("loads older pages until the target Entry appears, then clears ?e=", async () => {
      const fetchMore = vi.fn();
      const pagination = { hasMore: true, fetching: false, fetchMore };

      const { rerenderWith } = renderSeek(
        {
          ...readyContext,
          entries: [seekEntry("1", "2026-08-18T10:00:00.000Z")],
          pagination,
        },
        `/?e=${targetId}`,
      );

      await waitFor(() => expect(fetchMore).toHaveBeenCalledTimes(1));
      expect(screen.getByTestId("url-query")).toHaveTextContent(`e=${targetId}`);

      // The page that request asked for lands, and it holds the target Entry.
      rerenderWith({
        ...readyContext,
        entries: [
          seekEntry("1", "2026-08-18T10:00:00.000Z"),
          seekEntry(targetId, "2020-01-01T10:00:00.000Z"),
        ],
        pagination,
      });

      await waitFor(() => expect(screen.getByTestId("url-query")).not.toHaveTextContent("e="));
    });

    it("clears ?e= once there are no more older pages to check, without ever fetching", async () => {
      const fetchMore = vi.fn();

      renderComposerPage(
        {
          ...readyContext,
          entries: [seekEntry("1", "2026-08-18T10:00:00.000Z")],
          pagination: { hasMore: false, fetching: false, fetchMore },
        },
        `/?e=${targetId}`,
      );

      await waitFor(() => expect(screen.getByTestId("url-query")).not.toHaveTextContent("e="));
      expect(fetchMore).not.toHaveBeenCalled();
    });

    it("does not call fetchMore while a page is already in flight", async () => {
      const fetchMore = vi.fn();

      renderComposerPage(
        {
          ...readyContext,
          entries: [seekEntry("1", "2026-08-18T10:00:00.000Z")],
          pagination: { hasMore: true, fetching: true, fetchMore },
        },
        `/?e=${targetId}`,
      );

      // Give History's own effect a chance to run before asserting the
      // negative — otherwise this would pass trivially before anything had
      // a chance to fire at all.
      await waitFor(() => expect(screen.getByTestId("url-query")).toHaveTextContent("e="));
      expect(fetchMore).not.toHaveBeenCalled();
    });

    it("ignores a malformed ?e=, the same as no seek at all", () => {
      renderComposerPage(readyContext, "/?e=not-a-uuid");

      expect(screen.getByTestId("url-query")).toHaveTextContent("e=not-a-uuid");
    });

    // The rule composer-page.tsx's own comment names: `?e=` wins
    // deterministically over `?d=` when both are present, rather than
    // either being silently dropped or the two racing each other.
    it("prefers ?e= over ?d= when both are present, ignoring ?d= entirely", async () => {
      const fetchMore = vi.fn();
      renderComposerPage(
        {
          ...readyContext,
          // This loaded Entry falls exactly on the day ?d= names — if
          // ?d= were the seek actually in flight, it would settle
          // immediately with no fetch, the same as "clears ?d= once the
          // target day is already loaded" above.
          entries: [seekEntry("1", "2020-01-01T10:00:00.000Z")],
          pagination: { hasMore: true, fetching: false, fetchMore },
        },
        `/?d=2020-01-01&e=${targetId}`,
      );

      // The target Entry (targetId) is not loaded, so a seek genuinely
      // keyed on ?e= has to ask for an older page instead of settling —
      // proof ?e=, not the trivially-satisfiable ?d=, is the seek in
      // flight.
      await waitFor(() => expect(fetchMore).toHaveBeenCalledTimes(1));
      expect(screen.getByTestId("url-query")).toHaveTextContent(`e=${targetId}`);
      expect(screen.getByTestId("url-query")).toHaveTextContent("d=2020-01-01");
    });
  });

  // Issue #181, criterion 4: "clicking its words opens the Task over the
  // Composer, without leaving the Composer." The overlay is `TaskDetailView`
  // (components/todo/task-detail-view.tsx) reused wholesale, addressed by
  // `?task=<id>` on this same `/` route rather than a navigation to
  // `/todo/task/<slug>-<id>` — see composer-page.tsx's own `TASK_PARAM`
  // comment for why.
  describe("the Task detail overlay (issue #181)", () => {
    const taskId = "0192abcd-1234-7890-abcd-0123456789ac";

    function taskFixture(overrides: Partial<Task> = {}): Task {
      return {
        id: taskId,
        deviceId: "device-a",
        content: "buy milk",
        completedAt: null,
        orderKey: "V",
        dayOrder: "V",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        seq: null,
        syncedAt: null,
        deletedAt: null,
        date: null,
        deadline: null,
        priority: 1,
        labelIds: [],
        dateString: null,
        projectId: null,
        sectionId: null,
        parentId: null,
        description: null,
        ...overrides,
      };
    }

    // History's own day block only ever renders alongside a day that
    // already has an Entry (the day separator it opens with comes from
    // `groupByDay(entries, ...)`, never from a Task on its own) — a Day
    // block test needs an Entry on the same day as its Task, the same
    // pairing every "day Tasks" test in history.test.tsx already makes.
    const entryOnTheSameDay = [
      {
        id: "1",
        deviceId: "device-a",
        body: "hello",
        createdAt: "2026-08-28T10:00:00.000Z",
        updatedAt: "2026-08-28T10:00:00.000Z",
        seq: 1,
        syncedAt: "now",
        deletedAt: null,
      },
    ];

    function stillOnComposer() {
      // The Composer's own Send button (composer.tsx) — present only on
      // this route, so its continued presence is proof the overlay opened
      // *over* the Composer rather than navigating away from it.
      // `hidden: true` because Radix's own Dialog marks the rest of the
      // page `aria-hidden` while it's open (the correct, standard modal
      // behaviour — trapping a screen reader inside the dialog) — this
      // assertion is about the DOM still holding the Composer, not about
      // whether it's reachable through the accessibility tree right now.
      expect(screen.getByRole("button", { name: "Send", hidden: true })).toBeInTheDocument();
    }

    it("opens over the Composer when a referenced checkbox's words are clicked", () => {
      renderComposerPage({
        ...readyContext,
        entries: [
          {
            id: "1",
            deviceId: "device-a",
            body: `- [ ] ${formatTaskReference(taskId, "buy milk")}`,
            createdAt: "2026-08-28T10:00:00.000Z",
            updatedAt: "2026-08-28T10:00:00.000Z",
            seq: 1,
            syncedAt: "now",
            deletedAt: null,
          },
        ],
        tasks: [taskFixture()],
      });

      fireEvent.click(screen.getByRole("button", { name: "buy milk" }));

      expect(screen.getByRole("dialog")).toBeInTheDocument();
      // Issue #225: the detail title is a non-editable display element at
      // rest (DET-02), not a form control with a `value` — a plain `<div>`,
      // as Todoist's is.
      expect(screen.getByTestId("task-detail-title")).toHaveTextContent("buy milk");
      stillOnComposer();
    });

    it("opens over the Composer from the day block", () => {
      renderComposerPage({
        ...readyContext,
        entries: [
          {
            id: "1",
            deviceId: "device-a",
            body: "hello",
            createdAt: "2026-08-28T10:00:00.000Z",
            updatedAt: "2026-08-28T10:00:00.000Z",
            seq: 1,
            syncedAt: "now",
            deletedAt: null,
          },
        ],
        tasks: [taskFixture({ date: "2026-08-28" })],
      });

      fireEvent.click(screen.getByRole("button", { name: "buy milk" }));

      expect(screen.getByRole("dialog")).toBeInTheDocument();
      stillOnComposer();
    });

    it("reflects ?task=<id> on a direct load — a bookmark or a reload opens straight to the Task", () => {
      renderComposerPage(
        {
          ...readyContext,
          tasks: [taskFixture()],
        },
        `/?task=${taskId}`,
      );

      expect(screen.getByRole("dialog")).toBeInTheDocument();
      // Issue #225: the detail title is a non-editable display element at
      // rest (DET-02), not a form control with a `value` — a plain `<div>`,
      // as Todoist's is.
      expect(screen.getByTestId("task-detail-title")).toHaveTextContent("buy milk");
    });

    it("shows nothing for a ?task= this Device cannot resolve", () => {
      renderComposerPage({ ...readyContext, tasks: [] }, `/?task=${taskId}`);

      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      stillOnComposer();
    });

    it("closing the overlay (Escape — task-detail-view.test.tsx's own established close gesture) removes ?task= and returns to the Composer", () => {
      renderComposerPage({
        ...readyContext,
        entries: entryOnTheSameDay,
        tasks: [taskFixture({ date: "2026-08-28" })],
      });

      fireEvent.click(screen.getByRole("button", { name: "buy milk" }));
      expect(screen.getByRole("dialog")).toBeInTheDocument();

      // The bottom-sheet layout (jsdom's default, narrow viewport) has no
      // "Close" button of its own — task-detail-view.tsx's own comment:
      // "Esc, the header's own back-to-list chevron behaviour and a tap
      // outside all already close this sheet" — so Escape is the one
      // close gesture available regardless of layout width.
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(screen.getByTestId("url-query")).not.toHaveTextContent("task=");
      stillOnComposer();
    });

    // Criterion 4's own design room: "a hardware/browser Back that dismisses
    // the overlay instead of leaving the Composer is strongly preferred."
    // Opening pushes a real history entry (composer-page.tsx's own
    // `openTaskOverlay` comment) specifically so this works.
    it("a Back press dismisses the overlay and lands back on the Composer, not one screen further back", () => {
      renderComposerPage({
        ...readyContext,
        entries: entryOnTheSameDay,
        tasks: [taskFixture({ date: "2026-08-28" })],
      });

      fireEvent.click(screen.getByRole("button", { name: "buy milk" }));
      expect(screen.getByRole("dialog")).toBeInTheDocument();

      // `hidden: true` — Radix's own Dialog marks this background button
      // `aria-hidden` while open (the same reason `stillOnComposer`'s own
      // query needs it); the click still fires on the real DOM node
      // regardless of what the accessibility tree currently exposes.
      fireEvent.click(screen.getByRole("button", { name: "Simulate Back", hidden: true }));

      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      stillOnComposer();
    });

    it("ticks a Task from inside the overlay through the same completeTask door Todo's own row uses", () => {
      const completeTask = vi.fn();
      renderComposerPage({
        ...readyContext,
        entries: entryOnTheSameDay,
        tasks: [taskFixture({ date: "2026-08-28" })],
        completeTask,
      });

      fireEvent.click(screen.getByRole("button", { name: "buy milk" }));
      fireEvent.click(screen.getByRole("checkbox", { name: 'Complete "buy milk"' }));

      expect(completeTask).toHaveBeenCalledWith(taskId);
    });

    // Issue #355: this page's own completion toast used to be a plain
    // `toast(message, { action: {...} })` — no `role`, sonner's
    // unconfigured ~4s duration, and no registration `Z`/`⌘Z` could reach.
    // It now goes through the identical shared `use-completion-toast.tsx`
    // machinery `todo-page.tsx` uses, asserted the same way
    // `todo-page.test.tsx`'s own "completes a Task and offers an Undo
    // toast wired to uncompleteTask" test asserts it there: against the
    // real `CompletionToastBody` element the `jsx` callback produces, not
    // against `toast`'s own call args.
    it("completing a Task from the overlay raises an announced Undo toast wired to uncompleteTask", () => {
      const completeTask = vi.fn();
      const uncompleteTask = vi.fn();
      renderComposerPage({
        ...readyContext,
        entries: entryOnTheSameDay,
        tasks: [taskFixture({ date: "2026-08-28" })],
        completeTask,
        uncompleteTask,
      });

      fireEvent.click(screen.getByRole("button", { name: "buy milk" }));
      fireEvent.click(screen.getByRole("checkbox", { name: 'Complete "buy milk"' }));

      expect(completeTask).toHaveBeenCalledWith(taskId);
      expect(toast.custom).toHaveBeenCalledWith(
        expect.any(Function),
        // CMT-05: the same measured 10s `todo-page.tsx`'s own completion
        // toast carries — not sonner's unconfigured default this page's
        // toast used before #355.
        expect.objectContaining({ duration: 10_000 }),
      );

      const customCall = vi.mocked(toast.custom).mock.calls[0];
      if (!customCall) throw new Error("toast.custom was not called");
      const [jsxFactory] = customCall;
      render(jsxFactory("toast-a"));

      const alertToast = screen.getByRole("alert");
      expect(alertToast).toHaveTextContent('Completed "buy milk"');

      fireEvent.click(within(alertToast).getByRole("button", { name: "Undo" }));
      expect(uncompleteTask).toHaveBeenCalledWith(taskId);
      expect(toast.dismiss).toHaveBeenCalledWith("toast-a");
    });

    // Issue #355 — the defect this ticket closes: completing a second Task
    // while the first toast is still showing used to leave two toasts on
    // screen (neither `toast.custom()` call site ever dismissed the
    // other), reachable by keyboard undo only for the newer one. This
    // asserts the fix directly, against the shared helper's own call
    // pattern: a second `raise` must dismiss whichever toast the first one
    // is still showing before raising its own.
    it("completing a second Task while the first toast is still showing replaces it, rather than stacking", () => {
      const completeTask = vi.fn();
      renderComposerPage({
        ...readyContext,
        entries: entryOnTheSameDay,
        tasks: [taskFixture({ date: "2026-08-28" })],
        completeTask,
      });

      fireEvent.click(screen.getByRole("button", { name: "buy milk" }));
      const checkbox = screen.getByRole("checkbox", { name: 'Complete "buy milk"' });
      fireEvent.click(checkbox);
      fireEvent.click(checkbox);

      expect(toast.custom).toHaveBeenCalledTimes(2);
      const firstToastId = vi.mocked(toast.custom).mock.results[0]?.value;
      expect(toast.dismiss).toHaveBeenCalledWith(firstToastId);
    });

    // Issue #355 — `Z`/`⌘Z` reach the Composer's own completion toast now
    // too, through the identical `pendingUndoRef` mechanism
    // `todo-page.test.tsx`'s own "keyboard undo of a completion (CMT-05)"
    // tests cover there. This page carries no `use-todo-keymap.ts`-style
    // table of its own (its own `useCompletionUndoShortcut` mount, above,
    // is the standalone chord match that exists because of that), so
    // these are the first tests of that reachability on this surface.
    describe("keyboard undo of the completion toast (issue #355)", () => {
      it("undoes the most recent completion on 'z'", () => {
        const completeTask = vi.fn();
        const uncompleteTask = vi.fn();
        renderComposerPage({
          ...readyContext,
          entries: entryOnTheSameDay,
          tasks: [taskFixture({ date: "2026-08-28" })],
          completeTask,
          uncompleteTask,
        });

        fireEvent.click(screen.getByRole("button", { name: "buy milk" }));
        fireEvent.click(screen.getByRole("checkbox", { name: 'Complete "buy milk"' }));

        fireEvent.keyDown(document, { key: "z" });

        expect(uncompleteTask).toHaveBeenCalledWith(taskId);
      });

      it("undoes the most recent completion on Cmd+Z", () => {
        const completeTask = vi.fn();
        const uncompleteTask = vi.fn();
        renderComposerPage({
          ...readyContext,
          entries: entryOnTheSameDay,
          tasks: [taskFixture({ date: "2026-08-28" })],
          completeTask,
          uncompleteTask,
        });

        fireEvent.click(screen.getByRole("button", { name: "buy milk" }));
        fireEvent.click(screen.getByRole("checkbox", { name: 'Complete "buy milk"' }));

        fireEvent.keyDown(document, { key: "z", metaKey: true });

        expect(uncompleteTask).toHaveBeenCalledWith(taskId);
      });

      it("does nothing on 'z' or Cmd+Z when nothing has been completed", () => {
        const uncompleteTask = vi.fn();
        renderComposerPage({
          ...readyContext,
          tasks: [taskFixture()],
          uncompleteTask,
        });

        fireEvent.keyDown(document, { key: "z" });
        fireEvent.keyDown(document, { key: "z", metaKey: true });

        expect(uncompleteTask).not.toHaveBeenCalled();
      });
    });
  });
});

// Issue #247: the Task detail overlay's own rename now resolves a
// recognised phrase through `commitTaskTitle` (task-title-commit.ts),
// reached by composer-page.tsx's own `commitRename` wrapper — the
// identical door todo-page.tsx's row and detail view both reach.
describe("ComposerPage — rename resolves recognised phrases (issue #247)", () => {
  const taskId = "0192abcd-1234-7890-abcd-0123456789ae";

  function taskFixture(overrides: Partial<Task> = {}): Task {
    return {
      id: taskId,
      deviceId: "device-a",
      content: "buy milk",
      completedAt: null,
      orderKey: "V",
      dayOrder: "V",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      seq: null,
      syncedAt: null,
      deletedAt: null,
      date: null,
      deadline: null,
      priority: 1,
      labelIds: [],
      dateString: null,
      projectId: null,
      sectionId: null,
      parentId: null,
      description: null,
      ...overrides,
    };
  }

  beforeEach(() => {
    // `toFake: ["Date"]` only — matching task-detail-view-recognition.
    // test.tsx's own reasoning: the title editor sits behind
    // `LazyTaskTitleEditor`'s `Suspense` boundary, whose resolution
    // `findByLabelText`'s internal polling needs a real `setTimeout` to
    // observe.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 8, 2, 12, 0)); // Sep 2, 2026 (Wed), local noon
    useSettingsStore.setState({ smartDatesEnabled: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves date and priority on Enter, stripping the phrase from the stored content", async () => {
    const renameTask = vi.fn();
    const setTaskDate = vi.fn();
    const setTaskPriority = vi.fn();
    renderComposerPage(
      {
        ...readyContext,
        tasks: [taskFixture({ content: "buy milk" })],
        renameTask,
        setTaskDate,
        setTaskPriority,
      },
      `/?task=${taskId}`,
    );

    const titleButton = await screen.findByTestId("task-detail-title");
    expect(titleButton).toHaveTextContent("buy milk");
    fireEvent.click(titleButton);
    const titleEditor = await screen.findByLabelText("Task name");
    fireEvent.change(titleEditor, { target: { value: "buy oat milk tomorrow p1" } });
    fireEvent.keyDown(titleEditor, { key: "Enter" });

    // Resolution is async (commitTaskTitle's own await) — renameTask's own
    // resolved value is what proves the phrase was actually stripped, not
    // merely recognised.
    await waitFor(() => expect(renameTask).toHaveBeenCalledWith(taskId, "buy oat milk"));
    expect(setTaskDate).toHaveBeenCalledWith(taskId, "2026-09-03");
    expect(setTaskPriority).toHaveBeenCalledWith(taskId, 4); // p1 UI == stored 4.
  });

  it("leaves an existing Date, Deadline, Priority and Labels untouched when a rename contains no recognised phrase", async () => {
    const renameTask = vi.fn();
    const setTaskDate = vi.fn();
    const setTaskDeadline = vi.fn();
    const setTaskPriority = vi.fn();
    const setTaskLabels = vi.fn();
    renderComposerPage(
      {
        ...readyContext,
        tasks: [
          taskFixture({
            content: "buy oat milk",
            date: "2026-09-10",
            deadline: "2026-09-15",
            priority: 3,
            labelIds: ["label-existing"],
          }),
        ],
        renameTask,
        setTaskDate,
        setTaskDeadline,
        setTaskPriority,
        setTaskLabels,
      },
      `/?task=${taskId}`,
    );

    const titleButton = await screen.findByTestId("task-detail-title");
    expect(titleButton).toHaveTextContent("buy oat milk");
    fireEvent.click(titleButton);
    const titleEditor = await screen.findByLabelText("Task name");
    fireEvent.change(titleEditor, { target: { value: "buy plain oat milk" } });
    fireEvent.keyDown(titleEditor, { key: "Enter" });

    await waitFor(() => expect(renameTask).toHaveBeenCalledWith(taskId, "buy plain oat milk"));
    expect(setTaskDate).not.toHaveBeenCalled();
    expect(setTaskDeadline).not.toHaveBeenCalled();
    expect(setTaskPriority).not.toHaveBeenCalled();
    expect(setTaskLabels).not.toHaveBeenCalled();
  });
});
