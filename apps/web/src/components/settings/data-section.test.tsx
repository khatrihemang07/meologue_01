import type { Entry, EntryStore, Project, ProjectStore, Task, TaskStore } from "@meologue/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SaveFileOutcome } from "@/platform/save-file";
import { DataSection } from "./data-section";

const { saveFileMock } = vi.hoisted(() => ({
  // Resolves "saved" by default (ticket 47's defect fix — see
  // save-file.web.ts's SaveFileOutcome doc comment and docs/adr/0016); the
  // "cancellation" and "failure" tests below override this per test.
  saveFileMock: vi.fn(
    async (_fileName: string, _bytes: Uint8Array): Promise<SaveFileOutcome> => "saved",
  ),
}));

vi.mock("@/platform/save-file", () => ({ saveFile: saveFileMock }));

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
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is disabled while the store has not resolved", () => {
    render(<DataSection opened={undefined} />);

    expect(screen.getByRole("button", { name: "Export as zip" })).toBeDisabled();
  });

  it("is enabled once the store resolves", () => {
    render(
      <DataSection
        opened={{
          store: createFakeStore(),
          taskStore: createFakeTaskStore(),
          projectStore: createFakeProjectStore(),
          deviceId: "device-a",
        }}
      />,
    );

    expect(screen.getByRole("button", { name: "Export as zip" })).toBeEnabled();
  });

  it("reads every Entry, Task and Project, saves a zip, and shows a success toast", async () => {
    const entries: Entry[] = [
      {
        id: "e1",
        deviceId: "device-a",
        body: "went for a walk",
        createdAt: "2026-08-16T06:00:00.000Z",
        seq: 1,
        syncedAt: "2026-08-16T06:00:01.000Z",
        deletedAt: null,
      },
    ];
    const store = createFakeStore(entries);
    const taskStore = createFakeTaskStore();
    const projectStore = createFakeProjectStore();
    const successToast = vi.spyOn(toast, "success");

    render(<DataSection opened={{ store, taskStore, projectStore, deviceId: "device-a" }} />);
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

    render(
      <DataSection
        opened={{
          store,
          taskStore: createFakeTaskStore(),
          projectStore: createFakeProjectStore(),
          deviceId: "device-a",
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Export as zip" }));

    await waitFor(() => expect(saveFileMock).toHaveBeenCalledTimes(1));
    expect(successToast).not.toHaveBeenCalled();
    expect(errorToast).not.toHaveBeenCalled();
  });

  it("shows an error toast carrying the real error when saving fails", async () => {
    const store = createFakeStore([]);
    saveFileMock.mockRejectedValue(new Error("Export isn't supported on Android yet."));
    const errorToast = vi.spyOn(toast, "error");

    render(
      <DataSection
        opened={{
          store,
          taskStore: createFakeTaskStore(),
          projectStore: createFakeProjectStore(),
          deviceId: "device-a",
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Export as zip" }));

    await waitFor(() =>
      expect(errorToast).toHaveBeenCalledWith("Export isn't supported on Android yet."),
    );
  });
});
