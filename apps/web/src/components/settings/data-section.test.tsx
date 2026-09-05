import type {
  Entry,
  EntryStore,
  Project,
  ProjectStore,
  RestoreOutcome,
  SqliteDriver,
  Task,
  TaskStore,
  UnzipBackupResult,
} from "@meologue/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "@/lib/settings";
import type { LoadFileResult } from "@/platform/load-file";
import type { SaveFileOutcome } from "@/platform/save-file";
import { DataSection } from "./data-section";

const {
  saveFileMock,
  loadFileMock,
  createBackupMock,
  unzipBackupMock,
  restoreFromBackupMock,
  fetchServerBackupMock,
  restoreServerBackupMock,
  rebuildMismatchedEmbeddingsMock,
} = vi.hoisted(() => ({
  // Resolves "saved" by default (ticket 47's defect fix — see
  // save-file.web.ts's SaveFileOutcome doc comment and docs/adr/0016); the
  // "cancellation" and "failure" tests below override this per test.
  saveFileMock: vi.fn(
    async (_fileName: string, _bytes: Uint8Array): Promise<SaveFileOutcome> => "saved",
  ),
  // Issue #197's file-picking seam — resolves "cancelled" by default, the
  // same "quiet unless a test says otherwise" posture saveFileMock takes.
  loadFileMock: vi.fn(async (): Promise<LoadFileResult> => ({ outcome: "cancelled" })),
  // Stand-ins for @meologue/core's own createBackup/unzipBackup/
  // restoreFromBackup — data-section.tsx reaches all three through a
  // dynamic `import("@meologue/core")` inside its click handlers (the
  // bundle-budget fix this file's own doc comment explains), which
  // `vi.mock` below intercepts identically to a static import. Standing
  // these in means these tests exercise exactly this page's own wiring —
  // which arguments it passes, what it does with the outcome — not
  // dump.ts/parse.ts/restore.ts's own logic, which each already has its
  // own test file against a real driver.
  createBackupMock: vi.fn(async () => ({
    fileName: "meologue-backup-20260816-114500.zip",
    bytes: new Uint8Array([1, 2, 3]),
  })),
  unzipBackupMock: vi.fn(
    (_bytes: Uint8Array): UnzipBackupResult => ({
      ok: true,
      backup: {
        databaseSql: "",
        settingsJson: "{}",
        metaJson: JSON.stringify({ taken_at: "2026-08-16T11:45:00.000Z" }),
      },
    }),
  ),
  restoreFromBackupMock: vi.fn(
    async (): Promise<RestoreOutcome> => ({
      ok: true,
      result: { inserted: 0, updated: 0, unchanged: 0, skippedTables: [], skippedColumns: [] },
    }),
  ),
  // Server Backup/Restore (issue #198) go through server-backup-transport.ts
  // directly rather than through @meologue/core at all (that module's own
  // doc comment: a Server Backup is an opaque pg_dump archive this Device
  // only relays), so it's mocked as its own module rather than folded into
  // the @meologue/core mock above.
  fetchServerBackupMock: vi.fn(async () => ({ ok: true, bytes: new Uint8Array([9, 9, 9]) })),
  restoreServerBackupMock: vi.fn(async () => ({
    ok: true,
    report: { mismatched_embedding_count: 0 },
  })),
  rebuildMismatchedEmbeddingsMock: vi.fn(async () => ({ ok: true, report: { rebuilt_count: 0 } })),
}));

vi.mock("@/platform/save-file", () => ({ saveFile: saveFileMock }));
vi.mock("@/platform/load-file", () => ({ loadFile: loadFileMock }));
vi.mock("@/lib/server-backup-transport", () => ({
  fetchServerBackup: fetchServerBackupMock,
  restoreServerBackup: restoreServerBackupMock,
  rebuildMismatchedEmbeddings: rebuildMismatchedEmbeddingsMock,
}));

// `createBackup`, `unzipBackup` and `restoreFromBackup` are stood in for —
// every other @meologue/core export this file touches (the Entry/Task/
// Project types) stays the real thing, via `importOriginal`.
vi.mock("@meologue/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@meologue/core")>();
  return {
    ...actual,
    createBackup: createBackupMock,
    unzipBackup: unzipBackupMock,
    restoreFromBackup: restoreFromBackupMock,
  };
});

function createFakeStore(entries: Entry[] = []): EntryStore {
  return {
    list: vi.fn(async () => entries),
    upsert: vi.fn(async () => {}),
    pending: vi.fn(async () => []),
    getCursor: vi.fn(async () => 0),
    setCursor: vi.fn(async () => {}),
    // Issue #186 / ADR 0057.
    catchUpRowShapeEpoch: vi.fn(async () => {}),
    search: vi.fn(async () => []),
    edit: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    getMany: vi.fn(async () => []),
  };
}

// A minimal TaskStore double — issue #175's Export now reads Tasks
// alongside Entries. Every method beyond list()/listCompleted() is a
// trivial stub: no test in this file exercises Todo's own mutation paths
// (those live in use-tasks.test.tsx and todo-page.test.tsx), so each just
// has to satisfy the interface, the same reasoning use-tasks.test.tsx's
// own createFakeStore gives for its untouched methods.
function createFakeTaskStore(active: Task[] = [], completed: Task[] = []): TaskStore {
  return {
    list: vi.fn(async () => active),
    listByProject: vi.fn(async () => []),
    listChildren: vi.fn(async () => []),
    listInSection: vi.fn(async () => []),
    listDescendants: vi.fn(async () => []),
    listCompleted: vi.fn(async () => completed),
    get: vi.fn(async () => undefined),
    upsert: vi.fn(async () => {}),
    complete: vi.fn(async () => {}),
    uncomplete: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    reorder: vi.fn(async () => {}),
    reorderToday: vi.fn(async () => {}),
    setDate: vi.fn(async () => {}),
    setDeadline: vi.fn(async () => {}),
    setPriority: vi.fn(async () => {}),
    setLabelIds: vi.fn(async () => {}),
    setProject: vi.fn(async () => {}),
    setSection: vi.fn(async () => {}),
    setParent: vi.fn(async () => {}),
    setDescription: vi.fn(async () => {}),
    advanceRecurring: vi.fn(async () => {}),
    completeForever: vi.fn(async () => {}),
    postpone: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    pending: vi.fn(async () => []),
    getCursor: vi.fn(async () => 0),
    setCursor: vi.fn(async () => {}),
    // Issue #186 / ADR 0057.
    catchUpRowShapeEpoch: vi.fn(async () => {}),
    search: vi.fn(async () => []),
  };
}

// A minimal ProjectStore double, mirroring createFakeTaskStore's own
// reasoning above — only listProjects() is ever read by handleExport.
function createFakeProjectStore(projects: Project[] = []): ProjectStore {
  return {
    listProjects: vi.fn(async () => projects),
    getProject: vi.fn(async () => undefined),
    upsertProjects: vi.fn(async () => {}),
    renameProject: vi.fn(async () => {}),
    setProjectColour: vi.fn(async () => {}),
    setProjectDescription: vi.fn(async () => {}),
    setProjectFavourite: vi.fn(async () => {}),
    archiveProject: vi.fn(async () => {}),
    unarchiveProject: vi.fn(async () => {}),
    setProjectParent: vi.fn(async () => {}),
    reorderProject: vi.fn(async () => {}),
    removeProject: vi.fn(async () => {}),
    pendingProjects: vi.fn(async () => []),
    getProjectCursor: vi.fn(async () => 0),
    setProjectCursor: vi.fn(async () => {}),
    // Issue #186 / ADR 0057.
    catchUpProjectRowShapeEpoch: vi.fn(async () => {}),
    listSections: vi.fn(async () => []),
    getSection: vi.fn(async () => undefined),
    addSection: vi.fn(async () => {}),
    upsertSections: vi.fn(async () => {}),
    renameSection: vi.fn(async () => {}),
    setSectionDescription: vi.fn(async () => {}),
    reorderSection: vi.fn(async () => {}),
    deleteSection: vi.fn(async () => {}),
    archiveSection: vi.fn(async () => {}),
    unarchiveSection: vi.fn(async () => {}),
    pendingSections: vi.fn(async () => []),
    getSectionCursor: vi.fn(async () => 0),
    setSectionCursor: vi.fn(async () => {}),
    // Issue #186 / ADR 0057.
    catchUpSectionRowShapeEpoch: vi.fn(async () => {}),
  };
}

// A minimal double satisfying SqliteDriver's own one-method shape
// (../../../packages/core/src/sqlite/driver.ts) — createBackup/
// restoreFromBackup are both mocked in this file, so nothing here ever
// calls `execute`; this only has to be an object the Backup/Restore tests
// below can compare by identity against ("calls createBackup with this
// Device's own driver").
const fakeDriver: SqliteDriver = { execute: vi.fn() };

/** The full `ExportStoreHandle` shape, with per-store overrides — every test below that needs an opened store builds it from here rather than repeating all five fields, so `driver` (issue #195) has exactly one place to default from. */
function openedStore(
  overrides: Partial<{ store: EntryStore; taskStore: TaskStore; projectStore: ProjectStore }> = {},
) {
  return {
    store: overrides.store ?? createFakeStore(),
    taskStore: overrides.taskStore ?? createFakeTaskStore(),
    projectStore: overrides.projectStore ?? createFakeProjectStore(),
    deviceId: "device-a",
    driver: fakeDriver,
  };
}

// Issue #202: DataSection takes the opened store handle as a prop rather
// than reading `entryStoreQueryOptions` itself (settings-page.tsx is the
// one place that does, and passes the result down) — so, unlike before this
// ticket's split, none of this file needs react-query or a mock of
// `@/pages/entry-store-layout` at all. Moved from settings-page.test.tsx's
// own "Export" describe block, assertions unchanged.
describe("DataSection", () => {
  beforeEach(() => {
    saveFileMock.mockReset();
    saveFileMock.mockResolvedValue("saved");
    loadFileMock.mockReset();
    loadFileMock.mockResolvedValue({ outcome: "cancelled" });
    createBackupMock.mockReset();
    createBackupMock.mockResolvedValue({
      fileName: "meologue-backup-20260816-114500.zip",
      bytes: new Uint8Array([1, 2, 3]),
    });
    unzipBackupMock.mockReset();
    unzipBackupMock.mockReturnValue({
      ok: true,
      backup: {
        databaseSql: "",
        settingsJson: "{}",
        metaJson: JSON.stringify({ taken_at: "2026-08-16T11:45:00.000Z" }),
      },
    });
    restoreFromBackupMock.mockReset();
    restoreFromBackupMock.mockResolvedValue({
      ok: true,
      result: { inserted: 0, updated: 0, unchanged: 0, skippedTables: [], skippedColumns: [] },
    });
    fetchServerBackupMock.mockReset();
    fetchServerBackupMock.mockResolvedValue({ ok: true, bytes: new Uint8Array([9, 9, 9]) });
    restoreServerBackupMock.mockReset();
    restoreServerBackupMock.mockResolvedValue({
      ok: true,
      report: { mismatched_embedding_count: 0 },
    });
    rebuildMismatchedEmbeddingsMock.mockReset();
    rebuildMismatchedEmbeddingsMock.mockResolvedValue({ ok: true, report: { rebuilt_count: 0 } });
    useSettingsStore.setState({ serverUrl: "" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useSettingsStore.setState({ serverUrl: "" });
  });

  it("is disabled while the store has not resolved", () => {
    render(<DataSection opened={undefined} />);

    expect(screen.getByRole("button", { name: "Export as zip" })).toBeDisabled();
  });

  it("is enabled once the store resolves", () => {
    render(<DataSection opened={openedStore()} />);

    expect(screen.getByRole("button", { name: "Export as zip" })).toBeEnabled();
  });

  it("reads every Entry, Task and Project, saves a zip, and shows a success toast", async () => {
    const entries: Entry[] = [
      {
        id: "e1",
        deviceId: "device-a",
        body: "went for a walk",
        createdAt: "2026-08-16T06:00:00.000Z",
        // Issue #196: equal to createdAt, which is what an Entry that has
        // never been edited carries — the migration backfills every
        // pre-existing row exactly this way.
        updatedAt: "2026-08-16T06:00:00.000Z",
        seq: 1,
        syncedAt: "2026-08-16T06:00:01.000Z",
        deletedAt: null,
      },
    ];
    const store = createFakeStore(entries);
    const taskStore = createFakeTaskStore();
    const projectStore = createFakeProjectStore();
    const successToast = vi.spyOn(toast, "success");

    render(<DataSection opened={openedStore({ store, taskStore, projectStore })} />);
    fireEvent.click(screen.getByRole("button", { name: "Export as zip" }));

    await waitFor(() => expect(saveFileMock).toHaveBeenCalledTimes(1));
    expect(store.list).toHaveBeenCalledTimes(1);
    // Issue #175: Export now reads every Task and Project alongside
    // every Entry — a backup that silently omitted Tasks would fail ADR
    // 0016's own "quietly omits things is worse than none" rule.
    expect(taskStore.list).toHaveBeenCalledTimes(1);
    expect(taskStore.listCompleted).toHaveBeenCalledTimes(1);
    expect(projectStore.listProjects).toHaveBeenCalledTimes(1);
    const call = saveFileMock.mock.calls[0];
    expect(call).toBeDefined();
    const [fileName, bytes] = call ?? ["", new Uint8Array()];
    expect(fileName).toMatch(/^meologue-export-\d{8}-\d{6}\.zip$/);
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(successToast).toHaveBeenCalledWith(expect.stringContaining(fileName));
  });

  // This is the case that actually pins ticket 47's defect shut: before
  // the fix, saveFile resolved without throwing on cancellation just like
  // it does on success, and handleExport had no way to tell the two
  // apart — so a cancelled save panel / share sheet raised the same
  // "Exported N Entries" success toast a real save would, claiming a
  // backup existed when nothing had been written anywhere.
  it("raises no toast at all — neither success nor error — when the user cancels the save", async () => {
    const store = createFakeStore([]);
    saveFileMock.mockResolvedValue("cancelled");
    const successToast = vi.spyOn(toast, "success");
    const errorToast = vi.spyOn(toast, "error");

    render(<DataSection opened={openedStore({ store })} />);
    fireEvent.click(screen.getByRole("button", { name: "Export as zip" }));

    await waitFor(() => expect(saveFileMock).toHaveBeenCalledTimes(1));
    expect(successToast).not.toHaveBeenCalled();
    expect(errorToast).not.toHaveBeenCalled();
  });

  it("shows an error toast carrying the real error when saving fails", async () => {
    const store = createFakeStore([]);
    saveFileMock.mockRejectedValue(new Error("Export isn't supported on Android yet."));
    const errorToast = vi.spyOn(toast, "error");

    render(<DataSection opened={openedStore({ store })} />);
    fireEvent.click(screen.getByRole("button", { name: "Export as zip" }));

    await waitFor(() =>
      expect(errorToast).toHaveBeenCalledWith("Export isn't supported on Android yet."),
    );
  });
});
