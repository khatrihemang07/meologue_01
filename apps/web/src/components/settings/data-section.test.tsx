import type {
  Entry,
  EntryStore,
  MergeOutcome,
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
import type {
  FetchServerBackupResult,
  RebuildMismatchedEmbeddingsResult,
  RestoreServerBackupResult,
} from "@/lib/server-backup-transport";
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
  mergeBackupIntoDeviceMock,
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
  // Issue #199's own dynamic import, mirroring the other three above.
  mergeBackupIntoDeviceMock: vi.fn(
    async (): Promise<MergeOutcome> => ({
      ok: true,
      result: { inserted: 0, updated: 0, unchanged: 0, skippedTables: [], skippedColumns: [] },
    }),
  ),
  // Server Backup/Restore (issue #198) go through server-backup-transport.ts
  // directly rather than through @meologue/core at all (that module's own
  // doc comment: a Server Backup is an opaque pg_dump archive this Device
  // only relays), so it's mocked as its own module rather than folded into
  // the @meologue/core mock above.
  fetchServerBackupMock: vi.fn(
    async (): Promise<FetchServerBackupResult> => ({ ok: true, bytes: new Uint8Array([9, 9, 9]) }),
  ),
  restoreServerBackupMock: vi.fn(
    async (): Promise<RestoreServerBackupResult> => ({
      ok: true,
      report: { mismatched_embedding_count: 0 },
    }),
  ),
  rebuildMismatchedEmbeddingsMock: vi.fn(
    async (): Promise<RebuildMismatchedEmbeddingsResult> => ({
      ok: true,
      report: { rebuilt_count: 0 },
    }),
  ),
}));

vi.mock("@/platform/save-file", () => ({ saveFile: saveFileMock }));
vi.mock("@/platform/load-file", () => ({ loadFile: loadFileMock }));
vi.mock("@/lib/server-backup-transport", () => ({
  fetchServerBackup: fetchServerBackupMock,
  restoreServerBackup: restoreServerBackupMock,
  rebuildMismatchedEmbeddings: rebuildMismatchedEmbeddingsMock,
}));

// `createBackup`, `unzipBackup`, `restoreFromBackup` and
// `mergeBackupIntoDevice` are stood in for — every other @meologue/core
// export this file touches (the Entry/Task/Project types) stays the real
// thing, via `importOriginal`.
vi.mock("@meologue/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@meologue/core")>();
  return {
    ...actual,
    createBackup: createBackupMock,
    unzipBackup: unzipBackupMock,
    restoreFromBackup: restoreFromBackupMock,
    mergeBackupIntoDevice: mergeBackupIntoDeviceMock,
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
    // Backup/Restore round-trip through the real localStorage
    // (readAllDeviceSettings/applyDeviceSettings, lib/settings.ts, are
    // never mocked) — cleared per test so one test's meologue.* writes
    // never leak into the next.
    localStorage.clear();
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
    mergeBackupIntoDeviceMock.mockReset();
    mergeBackupIntoDeviceMock.mockResolvedValue({
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

  // Issue #195: a Backup is a second, separate artifact from Export above —
  // this page's own wiring around @meologue/core's createBackup (reached
  // via a dynamic import, data-section.tsx's own doc comment on why), not
  // that function's own logic (backup-zip.test.ts covers dumpDatabase/
  // buildBackupMeta against a real driver).
  describe("Backup", () => {
    it("is disabled while the store has not resolved", () => {
      render(<DataSection opened={undefined} />);

      expect(screen.getByRole("button", { name: "Back up this Device" })).toBeDisabled();
    });

    it("is enabled once the store resolves", () => {
      render(<DataSection opened={openedStore()} />);

      expect(screen.getByRole("button", { name: "Back up this Device" })).toBeEnabled();
    });

    it("calls createBackup with this Device's driver, id and every meologue.* setting, saves the zip, and shows a success toast", async () => {
      localStorage.setItem("meologue.theme", "dark");
      localStorage.setItem("meologue.server-url", "https://phone.example");
      // Not a meologue.* key — proves readAllDeviceSettings (settings.ts)
      // filters by prefix rather than carrying everything localStorage
      // happens to hold.
      localStorage.setItem("unrelated-key", "should not travel");
      const successToast = vi.spyOn(toast, "success");

      render(<DataSection opened={openedStore()} />);
      fireEvent.click(screen.getByRole("button", { name: "Back up this Device" }));

      await waitFor(() => expect(saveFileMock).toHaveBeenCalledTimes(1));
      expect(createBackupMock).toHaveBeenCalledWith(
        fakeDriver,
        {
          "meologue.theme": "dark",
          "meologue.server-url": "https://phone.example",
        },
        expect.objectContaining({ deviceId: "device-a" }),
      );
      const call = saveFileMock.mock.calls[0];
      expect(call).toBeDefined();
      const [fileName] = call ?? ["", new Uint8Array()];
      expect(fileName).toMatch(/^meologue-backup-\d{8}-\d{6}\.zip$/);
      expect(successToast).toHaveBeenCalledWith(expect.stringContaining(fileName));
    });

    // Mirrors Export's own "cancelled" case above (ticket 47's defect fix,
    // docs/adr/0016) — a cancelled save panel / share sheet must raise
    // neither toast, since nothing was actually written anywhere.
    it("raises no toast at all when the user cancels the save", async () => {
      saveFileMock.mockResolvedValue("cancelled");
      const successToast = vi.spyOn(toast, "success");
      const errorToast = vi.spyOn(toast, "error");

      render(<DataSection opened={openedStore()} />);
      fireEvent.click(screen.getByRole("button", { name: "Back up this Device" }));

      await waitFor(() => expect(saveFileMock).toHaveBeenCalledTimes(1));
      expect(successToast).not.toHaveBeenCalled();
      expect(errorToast).not.toHaveBeenCalled();
    });

    it("shows an error toast carrying the real error when creating the Backup fails", async () => {
      createBackupMock.mockRejectedValue(new Error("Backup isn't supported on Android yet."));
      const errorToast = vi.spyOn(toast, "error");

      render(<DataSection opened={openedStore()} />);
      fireEvent.click(screen.getByRole("button", { name: "Back up this Device" }));

      await waitFor(() =>
        expect(errorToast).toHaveBeenCalledWith("Backup isn't supported on Android yet."),
      );
    });
  });

  // Issue #199: Merge sits between Backup and Restore — additive, not
  // destructive (CONTEXT.md's Merge entry), so it gates on a plain
  // window.confirm() rather than DestructiveConfirmDialog's typed word.
  // This exercises data-section.tsx's own wiring around loadFile/
  // unzipBackup/mergeBackupIntoDevice, not any of those three's own logic
  // (each already has its own test file against a real driver).
  describe("Merge", () => {
    let confirmMock: ReturnType<typeof vi.fn>;
    // A successful Merge reloads the page too (data-section.tsx's own
    // handleMerge doc comment) — same reasoning, and same stub, as
    // Restore's own describe block below.
    let reloadMock: ReturnType<typeof vi.fn>;
    let originalLocation: Location;

    beforeEach(() => {
      confirmMock = vi.fn(() => true);
      vi.stubGlobal("confirm", confirmMock);
      reloadMock = vi.fn();
      originalLocation = window.location;
      Object.defineProperty(window, "location", {
        configurable: true,
        value: { ...originalLocation, reload: reloadMock },
      });
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      Object.defineProperty(window, "location", {
        configurable: true,
        value: originalLocation,
      });
    });

    it("is disabled while the store has not resolved", () => {
      render(<DataSection opened={undefined} />);

      expect(screen.getByRole("button", { name: "Merge a Backup…" })).toBeDisabled();
    });

    it("is enabled once the store resolves", () => {
      render(<DataSection opened={openedStore()} />);

      expect(screen.getByRole("button", { name: "Merge a Backup…" })).toBeEnabled();
    });

    it("does nothing at all when the user cancels the file picker", async () => {
      loadFileMock.mockResolvedValue({ outcome: "cancelled" });

      render(<DataSection opened={openedStore()} />);
      fireEvent.click(screen.getByRole("button", { name: "Merge a Backup…" }));

      await waitFor(() => expect(loadFileMock).toHaveBeenCalledTimes(1));
      expect(unzipBackupMock).not.toHaveBeenCalled();
      expect(confirmMock).not.toHaveBeenCalled();
      expect(mergeBackupIntoDeviceMock).not.toHaveBeenCalled();
    });

    it("shows an error toast and never confirms when the picked file isn't a valid Backup", async () => {
      loadFileMock.mockResolvedValue({
        outcome: "loaded",
        fileName: "not-a-backup.zip",
        bytes: new Uint8Array([1, 2, 3]),
      });
      unzipBackupMock.mockReturnValue({ ok: false, reason: "That file isn't a zip." });
      const errorToast = vi.spyOn(toast, "error");

      render(<DataSection opened={openedStore()} />);
      fireEvent.click(screen.getByRole("button", { name: "Merge a Backup…" }));

      await waitFor(() => expect(errorToast).toHaveBeenCalledWith("That file isn't a zip."));
      expect(confirmMock).not.toHaveBeenCalled();
      expect(mergeBackupIntoDeviceMock).not.toHaveBeenCalled();
    });

    async function pickValidBackup() {
      loadFileMock.mockResolvedValue({
        outcome: "loaded",
        fileName: "meologue-backup-20260816-114500.zip",
        bytes: new Uint8Array([1, 2, 3]),
      });
      unzipBackupMock.mockReturnValue({
        ok: true,
        backup: {
          databaseSql: "CREATE TABLE `entries` (`id` text PRIMARY KEY NOT NULL);",
          settingsJson: "{}",
          metaJson: "{}",
        },
      });
      render(<DataSection opened={openedStore()} />);
      fireEvent.click(screen.getByRole("button", { name: "Merge a Backup…" }));
      await waitFor(() => expect(unzipBackupMock).toHaveBeenCalledTimes(1));
    }

    it("never calls mergeBackupIntoDevice when the reader declines the confirm", async () => {
      confirmMock.mockReturnValue(false);

      await pickValidBackup();

      await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
      expect(mergeBackupIntoDeviceMock).not.toHaveBeenCalled();
    });

    it("calls mergeBackupIntoDevice with this Device's driver and database.sql, and reports the outcome", async () => {
      mergeBackupIntoDeviceMock.mockResolvedValue({
        ok: true,
        result: { inserted: 3, updated: 1, unchanged: 20, skippedTables: [], skippedColumns: [] },
      });
      const successToast = vi.spyOn(toast, "success");

      await pickValidBackup();

      await waitFor(() => expect(mergeBackupIntoDeviceMock).toHaveBeenCalledTimes(1));
      expect(mergeBackupIntoDeviceMock).toHaveBeenCalledWith(
        fakeDriver,
        "CREATE TABLE `entries` (`id` text PRIMARY KEY NOT NULL);",
      );
      await waitFor(() =>
        expect(successToast).toHaveBeenCalledWith(
          expect.stringContaining("3 inserted, 1 updated, 20 unchanged"),
        ),
      );
      // Reloads a moment later, the same reasoning as Restore's own
      // handleConfirmRestore doc comment.
      await waitFor(() => expect(reloadMock).toHaveBeenCalledTimes(1), { timeout: 3000 });
    });

    it("shows an error toast and does not reload when mergeBackupIntoDevice refuses the file", async () => {
      mergeBackupIntoDeviceMock.mockResolvedValue({
        ok: false,
        reason: "database.sql is not a Backup this build can read: unrecognised statement",
      });
      const errorToast = vi.spyOn(toast, "error");

      await pickValidBackup();

      await waitFor(() =>
        expect(errorToast).toHaveBeenCalledWith(
          "database.sql is not a Backup this build can read: unrecognised statement",
        ),
      );
      expect(reloadMock).not.toHaveBeenCalled();
    });

    it("shows an error toast carrying the real error when mergeBackupIntoDevice throws", async () => {
      mergeBackupIntoDeviceMock.mockRejectedValue(
        new Error("Merge isn't supported on Android yet."),
      );
      const errorToast = vi.spyOn(toast, "error");

      await pickValidBackup();

      await waitFor(() =>
        expect(errorToast).toHaveBeenCalledWith("Merge isn't supported on Android yet."),
      );
    });
  });

  // Issue #197: Restore is the destructive counterpart to Backup just
  // above — this page's own wiring around @meologue/core's loadFile/
  // unzipBackup/restoreFromBackup (all reached via a dynamic import, same
  // reasoning as Backup's own), not any of those three's own logic (each
  // has its own test file already covering that).
  describe("Restore", () => {
    // A successful Restore reloads the page (data-section.tsx's own
    // handleConfirmRestore doc comment) — stubbed here so jsdom's real
    // "not implemented: navigation" warning never fires and the reload
    // itself is something a test can assert on.
    let reloadMock: ReturnType<typeof vi.fn>;
    let originalLocation: Location;

    beforeEach(() => {
      reloadMock = vi.fn();
      originalLocation = window.location;
      Object.defineProperty(window, "location", {
        configurable: true,
        value: { ...originalLocation, reload: reloadMock },
      });
    });

    afterEach(() => {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: originalLocation,
      });
    });

    it("is disabled while the store has not resolved", () => {
      render(<DataSection opened={undefined} />);

      expect(screen.getByRole("button", { name: "Restore from a Backup…" })).toBeDisabled();
    });

    it("is enabled once the store resolves", () => {
      render(<DataSection opened={openedStore()} />);

      expect(screen.getByRole("button", { name: "Restore from a Backup…" })).toBeEnabled();
    });

    it("does nothing at all when the user cancels the file picker", async () => {
      loadFileMock.mockResolvedValue({ outcome: "cancelled" });

      render(<DataSection opened={openedStore()} />);
      fireEvent.click(screen.getByRole("button", { name: "Restore from a Backup…" }));

      await waitFor(() => expect(loadFileMock).toHaveBeenCalledTimes(1));
      expect(unzipBackupMock).not.toHaveBeenCalled();
      expect(screen.queryByText("Restore this Device from a Backup?")).not.toBeInTheDocument();
    });

    it("shows an error toast and never opens the confirmation dialog when the picked file isn't a valid Backup", async () => {
      loadFileMock.mockResolvedValue({
        outcome: "loaded",
        fileName: "not-a-backup.zip",
        bytes: new Uint8Array([1, 2, 3]),
      });
      unzipBackupMock.mockReturnValue({ ok: false, reason: "That file isn't a zip." });
      const errorToast = vi.spyOn(toast, "error");

      render(<DataSection opened={openedStore()} />);
      fireEvent.click(screen.getByRole("button", { name: "Restore from a Backup…" }));

      await waitFor(() => expect(errorToast).toHaveBeenCalledWith("That file isn't a zip."));
      expect(screen.queryByText("Restore this Device from a Backup?")).not.toBeInTheDocument();
      expect(restoreFromBackupMock).not.toHaveBeenCalled();
    });

    async function openConfirmDialog() {
      loadFileMock.mockResolvedValue({
        outcome: "loaded",
        fileName: "meologue-backup-20260816-114500.zip",
        bytes: new Uint8Array([1, 2, 3]),
      });

      render(<DataSection opened={openedStore()} />);
      fireEvent.click(screen.getByRole("button", { name: "Restore from a Backup…" }));

      await screen.findByText("Restore this Device from a Backup?");
    }

    it("opens a confirmation dialog after picking a valid Backup, with the destructive button disabled until RESTORE is typed", async () => {
      await openConfirmDialog();

      const confirmButton = screen.getByRole("button", { name: "Restore" });
      expect(confirmButton).toBeDisabled();

      fireEvent.change(screen.getByLabelText("Type RESTORE to confirm"), {
        target: { value: "restore" },
      });
      expect(confirmButton).toBeDisabled();

      fireEvent.change(screen.getByLabelText("Type RESTORE to confirm"), {
        target: { value: "RESTORE" },
      });
      expect(confirmButton).toBeEnabled();
    });

    it("closes the dialog without calling restoreFromBackup when Cancel is clicked", async () => {
      await openConfirmDialog();

      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

      await waitFor(() =>
        expect(screen.queryByText("Restore this Device from a Backup?")).not.toBeInTheDocument(),
      );
      expect(restoreFromBackupMock).not.toHaveBeenCalled();
    });

    async function confirmRestore() {
      fireEvent.change(screen.getByLabelText("Type RESTORE to confirm"), {
        target: { value: "RESTORE" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    }

    it("calls restoreFromBackup with this Device's own driver and database.sql, applies settings.json silently, and reports the outcome", async () => {
      unzipBackupMock.mockReturnValue({
        ok: true,
        backup: {
          databaseSql:
            "CREATE TABLE `kv` (`key` text PRIMARY KEY NOT NULL, `value` text NOT NULL);",
          settingsJson: JSON.stringify({
            "meologue.theme": "dark",
            "meologue.server-url": "https://from-backup.example",
          }),
          metaJson: JSON.stringify({ taken_at: "2026-08-16T11:45:00.000Z" }),
        },
      });
      restoreFromBackupMock.mockResolvedValue({
        ok: true,
        result: { inserted: 2, updated: 1, unchanged: 5, skippedTables: [], skippedColumns: [] },
      });
      const successToast = vi.spyOn(toast, "success");
      await openConfirmDialog();

      await confirmRestore();

      await waitFor(() => expect(restoreFromBackupMock).toHaveBeenCalledTimes(1));
      expect(restoreFromBackupMock).toHaveBeenCalledWith(
        fakeDriver,
        "CREATE TABLE `kv` (`key` text PRIMARY KEY NOT NULL, `value` text NOT NULL);",
        expect.any(Function),
      );
      // The theme travelled (ADR 0008's reversal) — the Server URL did not,
      // even though settings.json carried one: the default choice is to
      // keep this Device's current address (ADR 0011), never apply one
      // silently.
      expect(localStorage.getItem("meologue.theme")).toBe("dark");
      expect(localStorage.getItem("meologue.server-url")).not.toBe("https://from-backup.example");
      await waitFor(() =>
        expect(successToast).toHaveBeenCalledWith(
          expect.stringContaining("2 inserted, 1 updated, 5 unchanged"),
        ),
      );
      // Reloads a moment later, once the success toast above has had a
      // chance to be read (data-section.tsx's own handleConfirmRestore doc
      // comment) — 3000ms of real time comfortably covers that delay.
      await waitFor(() => expect(reloadMock).toHaveBeenCalledTimes(1), { timeout: 3000 });
    });

    it("applies the incoming Server URL only when the reader explicitly chooses to accept it", async () => {
      unzipBackupMock.mockReturnValue({
        ok: true,
        backup: {
          databaseSql: "",
          settingsJson: JSON.stringify({ "meologue.server-url": "https://from-backup.example" }),
          metaJson: JSON.stringify({ taken_at: "2026-08-16T11:45:00.000Z" }),
        },
      });
      await openConfirmDialog();

      fireEvent.click(screen.getByRole("switch", { name: "Use the Backup's Server URL" }));
      await confirmRestore();

      await waitFor(() => expect(restoreFromBackupMock).toHaveBeenCalledTimes(1));
      expect(useSettingsStore.getState().serverUrl).toBe("https://from-backup.example");
      // Drains handleConfirmRestore's own delayed reload before this test
      // ends — left pending, it fires 1200ms later against whatever
      // window.location happens to be by then (a later test's own, or the
      // real one once this describe's afterEach restores it), which is
      // exactly the stray-timer noise this waits out instead.
      await waitFor(() => expect(reloadMock).toHaveBeenCalledTimes(1), { timeout: 3000 });
    });

    it("shows an error toast and applies no settings when restoreFromBackup refuses the file", async () => {
      unzipBackupMock.mockReturnValue({
        ok: true,
        backup: {
          databaseSql: "garbage",
          settingsJson: JSON.stringify({ "meologue.theme": "dark" }),
          metaJson: JSON.stringify({ taken_at: "2026-08-16T11:45:00.000Z" }),
        },
      });
      restoreFromBackupMock.mockResolvedValue({
        ok: false,
        reason: "database.sql is not a Backup this build can read: unrecognised statement",
      });
      const errorToast = vi.spyOn(toast, "error");
      await openConfirmDialog();

      await confirmRestore();

      await waitFor(() =>
        expect(errorToast).toHaveBeenCalledWith(
          "database.sql is not a Backup this build can read: unrecognised statement",
        ),
      );
      expect(localStorage.getItem("meologue.theme")).not.toBe("dark");
    });
  });

  // Issue #198: the Server's own Backup/Restore, rendered by DataSection as
  // server-data-group.tsx's own ServerDataGroup. Visible only once a
  // Server URL is set (ADR 0011) — that gate is this describe block's own
  // first concern, before either flow's wiring.
  describe("ServerDataGroup", () => {
    it("shows neither the server Backup nor Restore button when no Server URL is set", () => {
      render(<DataSection opened={openedStore()} />);

      expect(screen.queryByRole("button", { name: "Back up server" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Restore server…" })).not.toBeInTheDocument();
    });

    it("shows both once a Server URL is set", () => {
      useSettingsStore.setState({ serverUrl: "https://server.example" });

      render(<DataSection opened={openedStore()} />);

      expect(screen.getByRole("button", { name: "Back up server" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Restore server…" })).toBeInTheDocument();
    });

    describe("with a Server URL set", () => {
      beforeEach(() => {
        useSettingsStore.setState({ serverUrl: "https://server.example" });
      });

      describe("Backup", () => {
        it("fetches the server's own archive, saves it, and shows a success toast", async () => {
          const successToast = vi.spyOn(toast, "success");

          render(<DataSection opened={openedStore()} />);
          fireEvent.click(screen.getByRole("button", { name: "Back up server" }));

          await waitFor(() => expect(fetchServerBackupMock).toHaveBeenCalledTimes(1));
          await waitFor(() =>
            expect(saveFileMock).toHaveBeenCalledWith(
              "meologue-server-backup.dump",
              expect.any(Uint8Array),
            ),
          );
          await waitFor(() =>
            expect(successToast).toHaveBeenCalledWith(
              expect.stringContaining("meologue-server-backup.dump"),
            ),
          );
        });

        it("raises no toast at all when the user cancels the save", async () => {
          saveFileMock.mockResolvedValue("cancelled");
          const successToast = vi.spyOn(toast, "success");
          const errorToast = vi.spyOn(toast, "error");

          render(<DataSection opened={openedStore()} />);
          fireEvent.click(screen.getByRole("button", { name: "Back up server" }));

          await waitFor(() => expect(saveFileMock).toHaveBeenCalledTimes(1));
          expect(successToast).not.toHaveBeenCalled();
          expect(errorToast).not.toHaveBeenCalled();
        });

        it("shows an error toast when the server can't be reached", async () => {
          fetchServerBackupMock.mockResolvedValue({ ok: false, reason: "unreachable" });
          const errorToast = vi.spyOn(toast, "error");

          render(<DataSection opened={openedStore()} />);
          fireEvent.click(screen.getByRole("button", { name: "Back up server" }));

          await waitFor(() =>
            expect(errorToast).toHaveBeenCalledWith(
              "Couldn't reach the server. Check that it's running and try again.",
            ),
          );
          expect(saveFileMock).not.toHaveBeenCalled();
        });
      });

      describe("Restore", () => {
        it("does nothing at all when the user cancels the file picker", async () => {
          loadFileMock.mockResolvedValue({ outcome: "cancelled" });

          render(<DataSection opened={openedStore()} />);
          fireEvent.click(screen.getByRole("button", { name: "Restore server…" }));

          await waitFor(() => expect(loadFileMock).toHaveBeenCalledTimes(1));
          expect(screen.queryByText("Restore the server from a Backup?")).not.toBeInTheDocument();
        });

        async function openServerConfirmDialog() {
          loadFileMock.mockResolvedValue({
            outcome: "loaded",
            fileName: "meologue-server-backup.dump",
            bytes: new Uint8Array([9, 9, 9]),
          });

          render(<DataSection opened={openedStore()} />);
          fireEvent.click(screen.getByRole("button", { name: "Restore server…" }));

          await screen.findByText("Restore the server from a Backup?");
        }

        it("opens a confirmation dialog after picking a file, with the destructive button disabled until RESTORE SERVER is typed", async () => {
          await openServerConfirmDialog();

          const confirmButton = screen.getByRole("button", { name: "Restore" });
          expect(confirmButton).toBeDisabled();

          fireEvent.change(screen.getByLabelText("Type RESTORE SERVER to confirm"), {
            target: { value: "RESTORE" },
          });
          expect(confirmButton).toBeDisabled();

          fireEvent.change(screen.getByLabelText("Type RESTORE SERVER to confirm"), {
            target: { value: "RESTORE SERVER" },
          });
          expect(confirmButton).toBeEnabled();
        });

        it("closes the dialog without calling restoreServerBackup when Cancel is clicked", async () => {
          await openServerConfirmDialog();

          fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

          await waitFor(() =>
            expect(screen.queryByText("Restore the server from a Backup?")).not.toBeInTheDocument(),
          );
          expect(restoreServerBackupMock).not.toHaveBeenCalled();
        });

        async function confirmServerRestore() {
          fireEvent.change(screen.getByLabelText("Type RESTORE SERVER to confirm"), {
            target: { value: "RESTORE SERVER" },
          });
          fireEvent.click(screen.getByRole("button", { name: "Restore" }));
        }

        it("calls restoreServerBackup with the picked bytes and shows a plain success toast when nothing is mismatched", async () => {
          restoreServerBackupMock.mockResolvedValue({
            ok: true,
            report: { mismatched_embedding_count: 0 },
          });
          const successToast = vi.spyOn(toast, "success");
          await openServerConfirmDialog();

          await confirmServerRestore();

          await waitFor(() => expect(restoreServerBackupMock).toHaveBeenCalledTimes(1));
          expect(restoreServerBackupMock).toHaveBeenCalledWith(new Uint8Array([9, 9, 9]));
          await waitFor(() => expect(successToast).toHaveBeenCalledWith("Server restored."));
          expect(screen.queryByRole("button", { name: /^Rebuild/ })).not.toBeInTheDocument();
        });

        it("reports a nonzero embedding mismatch and offers to rebuild", async () => {
          restoreServerBackupMock.mockResolvedValue({
            ok: true,
            report: { mismatched_embedding_count: 3 },
          });
          const successToast = vi.spyOn(toast, "success");
          await openServerConfirmDialog();

          await confirmServerRestore();

          await waitFor(() =>
            expect(successToast).toHaveBeenCalledWith(
              "Server restored. 3 Entries carry an embedding from a different model.",
            ),
          );
          expect(await screen.findByRole("button", { name: "Rebuild 3" })).toBeInTheDocument();
          expect(screen.getByRole("button", { name: "Leave them" })).toBeInTheDocument();
        });

        it("rebuilds the mismatched embeddings and clears the follow-up once done", async () => {
          restoreServerBackupMock.mockResolvedValue({
            ok: true,
            report: { mismatched_embedding_count: 3 },
          });
          rebuildMismatchedEmbeddingsMock.mockResolvedValue({
            ok: true,
            report: { rebuilt_count: 3 },
          });
          const successToast = vi.spyOn(toast, "success");
          await openServerConfirmDialog();
          await confirmServerRestore();
          await screen.findByRole("button", { name: "Rebuild 3" });

          fireEvent.click(screen.getByRole("button", { name: "Rebuild 3" }));

          await waitFor(() => expect(rebuildMismatchedEmbeddingsMock).toHaveBeenCalledTimes(1));
          await waitFor(() =>
            expect(successToast).toHaveBeenCalledWith("3 Entries queued for re-embedding."),
          );
          expect(screen.queryByRole("button", { name: "Rebuild 3" })).not.toBeInTheDocument();
        });

        it("leaves the mismatched embeddings alone without calling rebuild", async () => {
          restoreServerBackupMock.mockResolvedValue({
            ok: true,
            report: { mismatched_embedding_count: 3 },
          });
          await openServerConfirmDialog();
          await confirmServerRestore();
          await screen.findByRole("button", { name: "Leave them" });

          fireEvent.click(screen.getByRole("button", { name: "Leave them" }));

          expect(rebuildMismatchedEmbeddingsMock).not.toHaveBeenCalled();
          expect(screen.queryByRole("button", { name: "Rebuild 3" })).not.toBeInTheDocument();
        });

        it("shows an error toast and applies nothing when restoreServerBackup fails", async () => {
          restoreServerBackupMock.mockResolvedValue({
            ok: false,
            reason: "http-error",
            status: 500,
            message: "pg_restore failed: archive is corrupt",
          });
          const errorToast = vi.spyOn(toast, "error");
          await openServerConfirmDialog();

          await confirmServerRestore();

          await waitFor(() =>
            expect(errorToast).toHaveBeenCalledWith("pg_restore failed: archive is corrupt"),
          );
          expect(screen.getByText("Restore the server from a Backup?")).toBeInTheDocument();
        });
      });
    });
  });
});
