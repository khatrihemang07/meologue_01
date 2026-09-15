import type {
  CommentStore,
  Entry,
  EntryStore,
  EventStore,
  LabelStore,
  ProjectStore,
  Task,
  TaskStore,
} from "@meologue/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearLastDestination, writeLastDestination } from "@/lib/last-destination";
import { localDayKey } from "@/lib/local-day-key";
import { ENTRY_STORE_QUERY_KEY } from "@/lib/query-keys";
import { useSettingsStore } from "@/lib/settings";
import { ChatListPage } from "./chat-list-page";

// Mirrors back-to-chats.test.tsx's own stand-in ("jsdom implements no
// matchMedia at all") — every test that renders the wide column installs
// this first.
function installWideMatchMedia() {
  Object.defineProperty(window, "matchMedia", {
    value: vi.fn(() => ({
      matches: true,
      media: "",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
    configurable: true,
    writable: true,
  });
}

function removeMatchMedia() {
  Object.defineProperty(window, "matchMedia", {
    value: undefined,
    configurable: true,
    writable: true,
  });
}

// Built off the real, running clock rather than a fixed fake date — fake
// timers block `findBy`/`waitFor`'s own polling (they hung this suite for a
// full 5s per test the first time this file was written with
// `vi.useFakeTimers()`), so "today" here is whatever day the suite actually
// runs on, expressed the same local-fields way `localDayKey`/`entryDayKey`
// themselves read it.
const now = new Date();
const TODAY_KEY = localDayKey(now);

/** An ISO instant `daysAgo` days before now, at `hour` in *local* time — so it lands on the same local day `TODAY_KEY` names, regardless of this Device's own UTC offset. */
function localIso(daysAgo: number, hour: number): string {
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - daysAgo,
    hour,
    0,
    0,
  ).toISOString();
}

function entry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: "entry-1",
    deviceId: "device-a",
    body: "wrote something",
    createdAt: localIso(0, 9),
    updatedAt: localIso(0, 9),
    seq: 1,
    syncedAt: localIso(0, 9),
    deletedAt: null,
    ...overrides,
  };
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    deviceId: "device-a",
    content: "buy milk",
    completedAt: null,
    orderKey: "V",
    dayOrder: "V",
    createdAt: localIso(1, 0),
    updatedAt: localIso(1, 0),
    seq: 1,
    syncedAt: localIso(1, 0),
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

/**
 * A minimal, in-memory `EntryStore` stand-in, mirroring
 * `use-tasks.test.tsx`'s own `createFakeEntryStore` — only `list`/`getMany`
 * are ever actually called by this page's read-only Today summary, but the
 * full interface has to be satisfied to type as an `EntryStore`.
 */
function fakeEntryStore(entries: Entry[] = []): EntryStore {
  return {
    list: vi.fn(async () => entries),
    upsert: vi.fn(async () => {}),
    applyPulled: vi.fn(async () => {}),
    applyAcknowledged: vi.fn(async () => {}),
    pending: vi.fn(async () => []),
    getCursor: vi.fn(async () => 0),
    setCursor: vi.fn(async () => {}),
    catchUpRowShapeEpoch: vi.fn(async () => {}),
    hasCompletedSoftBreakMigration: vi.fn(async () => true),
    markSoftBreakMigrationComplete: vi.fn(async () => {}),
    search: vi.fn(async () => []),
    edit: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    getMany: vi.fn(async (ids: string[]) => entries.filter((e) => ids.includes(e.id))),
  };
}

/** Mirrors `use-tasks.test.tsx`'s own `createFakeStore`, narrowed to what this page's read-only Today summary actually calls (`list`). */
function fakeTaskStore(tasks: Task[] = []): TaskStore {
  return {
    list: vi.fn(async () => tasks),
    listByProject: vi.fn(async () => []),
    listChildren: vi.fn(async () => []),
    countChildren: vi.fn(async () => ({ done: 0, total: 0 })),
    listInSection: vi.fn(async () => []),
    listDescendants: vi.fn(async () => []),
    listCompleted: vi.fn(async () => []),
    get: vi.fn(async () => undefined),
    upsert: vi.fn(async () => {}),
    applyPulled: vi.fn(async () => {}),
    complete: vi.fn(async () => {}),
    uncomplete: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    reorder: vi.fn(async () => {}),
    reorderToday: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    pending: vi.fn(async () => []),
    getCursor: vi.fn(async () => 0),
    setCursor: vi.fn(async () => {}),
    catchUpRowShapeEpoch: vi.fn(async () => {}),
    search: vi.fn(async () => []),
    setDate: vi.fn(async () => {}),
    setDeadline: vi.fn(async () => {}),
    setPriority: vi.fn(async () => {}),
    setDateString: vi.fn(async () => {}),
    setLabelIds: vi.fn(async () => {}),
    advanceRecurring: vi.fn(async () => {}),
    completeForever: vi.fn(async () => {}),
    postpone: vi.fn(async () => {}),
    setProject: vi.fn(async () => {}),
    setSection: vi.fn(async () => {}),
    setParent: vi.fn(async () => {}),
    setDescription: vi.fn(async () => {}),
  };
}

/**
 * Pre-seeds `entryStoreQueryOptions`'s own cache entry so `ChatListPage`'s
 * `useQuery(entryStoreQueryOptions)` (chat-list-page.tsx) resolves
 * synchronously to a fake, already-"open" store bag rather than racing a
 * real `openEntryStore()` call — the identical trick `entry-store-layout.tsx`
 * itself uses `staleTime: Infinity` to make safe: data set here is never
 * considered stale, so nothing ever refetches over it.
 */
function seedOpenedStore(queryClient: QueryClient, entries: Entry[] = [], tasks: Task[] = []) {
  queryClient.setQueryData(ENTRY_STORE_QUERY_KEY, {
    store: fakeEntryStore(entries),
    taskStore: fakeTaskStore(tasks),
    labelStore: {} as LabelStore,
    projectStore: {} as ProjectStore,
    commentStore: {} as CommentStore,
    eventStore: {} as EventStore,
    filterStore: {},
    deviceId: "device-a",
  });
}

function renderChatListPage(queryClient: QueryClient) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/"]}>
        <ChatListPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ChatListPage", () => {
  afterEach(() => {
    removeMatchMedia();
    clearLastDestination();
    useSettingsStore.setState({
      serverUrl: "",
      capabilities: null,
      hiddenDestinations: new Set(),
    });
    vi.unstubAllGlobals();
  });

  it("renders ChatListPane, unchanged, below the wide breakpoint", () => {
    const queryClient = new QueryClient();

    renderChatListPage(queryClient);

    expect(screen.getByRole("navigation", { name: "Chats" })).toBeInTheDocument();
    expect(screen.getAllByRole("link")).toHaveLength(5);
    expect(screen.queryByText("Today")).not.toBeInTheDocument();
    expect(screen.queryByText("Continue")).not.toBeInTheDocument();
  });

  it("renders a new content column at the wide breakpoint, not the chat list a second time", () => {
    installWideMatchMedia();
    const queryClient = new QueryClient();
    seedOpenedStore(queryClient);

    renderChatListPage(queryClient);

    // The pane's own list lives in chat-shell-layout.tsx, not here — this
    // column carries no second "Chats" navigation landmark.
    expect(screen.queryByRole("navigation", { name: "Chats" })).not.toBeInTheDocument();
    expect(screen.getByText("Today")).toBeInTheDocument();
  });

  it("shows no Continue card when nothing has been recorded yet", () => {
    installWideMatchMedia();
    const queryClient = new QueryClient();
    seedOpenedStore(queryClient);

    renderChatListPage(queryClient);

    expect(screen.queryByText("Continue")).not.toBeInTheDocument();
  });

  it("offers a Continue card back into the last recorded Destination", async () => {
    installWideMatchMedia();
    writeLastDestination("/composer");
    const queryClient = new QueryClient();
    seedOpenedStore(queryClient);

    renderChatListPage(queryClient);

    expect(screen.getByText("Continue")).toBeInTheDocument();
    const links = await screen.findAllByRole("link", { name: /Composer/ });
    expect(links.some((link) => link.getAttribute("href") === "/composer")).toBe(true);
  });

  it("does not offer a Continue card for a Destination the reader has since hidden", () => {
    installWideMatchMedia();
    writeLastDestination("/digest");
    useSettingsStore.setState({ hiddenDestinations: new Set(["digest"]) });
    const queryClient = new QueryClient();
    seedOpenedStore(queryClient);

    renderChatListPage(queryClient);

    expect(screen.queryByText("Continue")).not.toBeInTheDocument();
    // The Today summary must not offer the hidden Destination either.
    expect(screen.queryByText("Most recent Digest")).not.toBeInTheDocument();
  });

  it("counts Entries written today, against a Device-local day boundary", async () => {
    installWideMatchMedia();
    const queryClient = new QueryClient();
    seedOpenedStore(
      queryClient,
      [
        entry({ id: "today-1", createdAt: localIso(0, 9) }),
        entry({ id: "today-2", createdAt: localIso(0, 20) }),
        entry({ id: "yesterday", createdAt: localIso(1, 9) }),
      ],
      [],
    );

    renderChatListPage(queryClient);

    expect(screen.getByText("Entries written today")).toBeInTheDocument();
    // Waited for, not asserted synchronously: the value starts as "Nothing
    // yet" (the not-yet-open placeholder — EntryAndTaskToday's own comment)
    // and only becomes the real count once useHistory's own query resolves.
    expect(await screen.findByText("2")).toBeInTheDocument();
  });

  it("shows a calm empty state when nothing was written today", async () => {
    installWideMatchMedia();
    const queryClient = new QueryClient();
    seedOpenedStore(queryClient, [], []);

    renderChatListPage(queryClient);

    expect(await screen.findByText("Entries written today")).toBeInTheDocument();
    expect(screen.getAllByText("Nothing yet").length).toBeGreaterThan(0);
  });

  it("says the counts are unavailable, rather than zero, when the Entry store cannot open", async () => {
    installWideMatchMedia();
    const queryClient = new QueryClient();
    // `entryStoreQueryOptions` sets `retry: false` because
    // `StorageUnavailableError`/`SecondTabError` are permanent
    // (entry-store-layout.tsx), so a failed open leaves `data === undefined`
    // forever — indistinguishable from "still opening" unless the error is
    // read. Reporting "Nothing yet" here would tell a reader they wrote
    // nothing today when the app simply cannot read what they wrote.
    queryClient
      .getQueryCache()
      .build(queryClient, {
        queryKey: ENTRY_STORE_QUERY_KEY,
        queryFn: async () => {
          throw new Error("storage unavailable");
        },
      })
      .setState({
        status: "error",
        error: new Error("storage unavailable"),
        fetchStatus: "idle",
      });

    renderChatListPage(queryClient);

    expect(await screen.findByText("Entries written today")).toBeInTheDocument();
    expect(screen.getAllByText("Unavailable").length).toBeGreaterThan(0);
    expect(screen.queryByText("Nothing yet")).not.toBeInTheDocument();
    expect(screen.queryByText("Nothing due")).not.toBeInTheDocument();
  });

  it("counts Tasks due today", async () => {
    installWideMatchMedia();
    const queryClient = new QueryClient();
    seedOpenedStore(queryClient, [], [task({ id: "due-today", date: TODAY_KEY })]);

    renderChatListPage(queryClient);

    expect(screen.getByText("Tasks due today")).toBeInTheDocument();
    expect(await screen.findByText("1")).toBeInTheDocument();
  });

  it("shows a calm empty state when nothing is due today", async () => {
    installWideMatchMedia();
    const queryClient = new QueryClient();
    seedOpenedStore(queryClient, [], []);

    renderChatListPage(queryClient);

    expect(await screen.findByText("Tasks due today")).toBeInTheDocument();
    expect(screen.getAllByText("Nothing due").length).toBeGreaterThan(0);
  });

  it("does not offer Tasks due today once Todo is hidden", () => {
    installWideMatchMedia();
    useSettingsStore.setState({ hiddenDestinations: new Set(["todo"]) });
    const queryClient = new QueryClient();
    seedOpenedStore(queryClient);

    renderChatListPage(queryClient);

    expect(screen.queryByText("Tasks due today")).not.toBeInTheDocument();
  });

  it("degrades the Digest line to Locked when Sync is off, without fetching", () => {
    installWideMatchMedia();
    useSettingsStore.setState({ serverUrl: "" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const queryClient = new QueryClient();
    seedOpenedStore(queryClient);

    renderChatListPage(queryClient);

    expect(screen.getByText("Most recent Digest")).toBeInTheDocument();
    expect(screen.getByText("Locked")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("degrades the Digest line when the Server is unreachable", async () => {
    installWideMatchMedia();
    useSettingsStore.setState({ serverUrl: "https://server.example" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const queryClient = new QueryClient();
    seedOpenedStore(queryClient);

    renderChatListPage(queryClient);

    expect(await screen.findByText("Server unreachable")).toBeInTheDocument();
  });

  it("shows the latest Digest once one is fetched", async () => {
    installWideMatchMedia();
    useSettingsStore.setState({ serverUrl: "https://server.example" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          digest: {
            period: "day",
            period_start: "2026-09-01",
            period_end: "2026-09-01",
            body: "You wrote about your knee again today.",
            grounding_entry_ids: [],
            prev_date: null,
            next_date: null,
            stale: false,
            revision: 1,
            written_at: "2026-09-02T06:00:00Z",
          },
        }),
      })),
    );
    const queryClient = new QueryClient();
    seedOpenedStore(queryClient);

    renderChatListPage(queryClient);

    expect(await screen.findByText(/Sep 1, 2026/)).toBeInTheDocument();
  });

  it("shows a calm placeholder when every hideable Destination is hidden and nothing is recorded to continue", () => {
    installWideMatchMedia();
    useSettingsStore.setState({
      hiddenDestinations: new Set(["composer", "reflect", "digest", "todo"]),
    });
    const queryClient = new QueryClient();
    seedOpenedStore(queryClient);

    renderChatListPage(queryClient);

    expect(
      screen.getByText("Nothing to continue yet — pick a Destination from the list."),
    ).toBeInTheDocument();
  });
});
