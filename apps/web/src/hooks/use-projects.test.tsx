import type { EventStore, Project, ProjectStore, Section } from "@meologue/core";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { useProjects as UseProjects } from "./use-projects";

// Mirrors use-tasks.test.tsx's own `importFresh` for the identical reason
// (that file's own comment): each test needs a fresh module registry, or a
// query cached by one test leaks into the next.
async function importFresh() {
  vi.resetModules();
  const [hook, client] = await Promise.all([
    import("./use-projects"),
    import("@/lib/query-client"),
  ]);
  return { ...hook, ...client };
}

// Issue #184: `useProjects` now records an Event alongside every
// add/rename/archive/unarchive of a Project or Section — a bare cast
// would leave `.record`/`.list` undefined and throw the moment any of
// those mutations reaches for it, so this is a working stub rather than
// `{} as EventStore` the way sync-runner.test.ts's own fakes get away
// with (that suite mocks `sync()` itself, so its stores' methods are
// never actually called).
function fakeEventStore(): EventStore {
  return {
    list: vi.fn(async () => []),
    listByTask: vi.fn(async () => []),
    listByProject: vi.fn(async () => []),
    record: vi.fn(async () => {}),
    upsert: vi.fn(async () => {}),
    pending: vi.fn(async () => []),
    getCursor: vi.fn(async () => 0),
    setCursor: vi.fn(async () => {}),
  };
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "p1",
    deviceId: "device-a",
    name: "Groceries",
    colour: "#808080",
    favourite: false,
    archived: false,
    parentId: null,
    description: null,
    orderKey: "A",
    createdAt: "2026-01-01T00:00:00.000Z",
    seq: null,
    syncedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function section(overrides: Partial<Section> = {}): Section {
  return {
    id: "s1",
    deviceId: "device-a",
    projectId: "p1",
    name: "Errands",
    description: null,
    orderKey: "A",
    archived: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    seq: null,
    syncedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function createFakeStore(): ProjectStore {
  let projects: Project[] = [];
  let sections: Section[] = [];
  return {
    listProjects: vi.fn(async () => projects),
    getProject: vi.fn(async (id: string) => projects.find((p) => p.id === id)),
    upsertProjects: vi.fn(async (incoming: Project[]) => {
      projects = [...projects, ...incoming];
    }),
    renameProject: vi.fn(async () => {}),
    setProjectColour: vi.fn(async () => {}),
    setProjectDescription: vi.fn(async () => {}),
    setProjectFavourite: vi.fn(async () => {}),
    archiveProject: vi.fn(async () => {}),
    unarchiveProject: vi.fn(async () => {}),
    setProjectParent: vi.fn(async (id: string, parentId: string | null) => {
      if (id === parentId) {
        throw new Error("setProjectParent: a Project cannot be its own parent");
      }
    }),
    reorderProject: vi.fn(async () => {}),
    removeProject: vi.fn(async () => {}),
    pendingProjects: vi.fn(async () => []),
    getProjectCursor: vi.fn(async () => 0),
    setProjectCursor: vi.fn(async () => {}),
    listSections: vi.fn(async (projectId: string) =>
      sections.filter((s) => s.projectId === projectId),
    ),
    getSection: vi.fn(async (id: string) => sections.find((s) => s.id === id)),
    addSection: vi.fn(async (incoming: Section) => {
      const current = sections.filter((s) => s.projectId === incoming.projectId);
      if (current.length >= 20) {
        throw new Error("a Project may hold at most 20 Sections");
      }
      sections = [...sections, incoming];
    }),
    upsertSections: vi.fn(async (incoming: Section[]) => {
      sections = [...sections, ...incoming];
    }),
    renameSection: vi.fn(async () => {}),
    setSectionDescription: vi.fn(async () => {}),
    reorderSection: vi.fn(async () => {}),
    deleteSection: vi.fn(async () => {}),
    archiveSection: vi.fn(async () => {}),
    unarchiveSection: vi.fn(async () => {}),
    pendingSections: vi.fn(async () => []),
    getSectionCursor: vi.fn(async () => 0),
    setSectionCursor: vi.fn(async () => {}),
  };
}

describe("useProjects", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  async function renderUseProjects(
    store: ProjectStore,
    deviceId = "device-a",
    eventStore: EventStore = fakeEventStore(),
  ) {
    const fresh = await importFresh();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={fresh.queryClient}>{children}</QueryClientProvider>
    );
    const rendered = renderHook<ReturnType<typeof UseProjects>, void>(
      () => (fresh.useProjects as typeof UseProjects)(store, eventStore, deviceId),
      { wrapper },
    );
    return { fresh, eventStore, ...rendered };
  }

  it("reads every Project from the store", async () => {
    const store = createFakeStore();
    await store.upsertProjects([project()]);

    const { result } = await renderUseProjects(store);

    await waitFor(() => expect(result.current.projects).toHaveLength(1));
    expect(result.current.projects[0]?.name).toBe("Groceries");
  });

  it("ignores a blank Project name without touching the store", async () => {
    const store = createFakeStore();
    const { result } = await renderUseProjects(store);

    act(() => result.current.addProject("   "));

    expect(store.upsertProjects).not.toHaveBeenCalled();
  });

  it("adds a Project with the given colour, defaulting favourite/archived/parentId/description to their unset states", async () => {
    const store = createFakeStore();
    const { result } = await renderUseProjects(store);

    act(() => result.current.addProject("Errands", { colour: "#DC4C3E" }));

    await waitFor(() => expect(result.current.projects).toHaveLength(1));
    const added = result.current.projects[0];
    expect(added).toMatchObject({
      name: "Errands",
      colour: "#DC4C3E",
      favourite: false,
      archived: false,
      parentId: null,
      description: null,
    });
  });

  // ProjectStore.addSection throws on the twenty-Section cap
  // (ProjectStore's own doc comment) — this hook's own `addSection` must
  // surface that as a rejected Promise, not swallow it, so a caller
  // (project-view.tsx) can show it legibly rather than losing it.
  it("propagates the store's own rejection when the Section cap is reached", async () => {
    const store = createFakeStore();
    for (let i = 0; i < 20; i++) {
      await store.addSection(section({ id: `s${i}`, orderKey: String(i) }));
    }
    const { result } = await renderUseProjects(store);

    await expect(result.current.addSection("p1", "One too many")).rejects.toThrow(
      "a Project may hold at most 20 Sections",
    );
  });

  it("adds a Section appended after the Project's own existing Sections", async () => {
    const store = createFakeStore();
    await store.addSection(section({ id: "existing", orderKey: "M" }));
    const { result } = await renderUseProjects(store);

    await act(async () => {
      await result.current.addSection("p1", "New Section");
    });

    const added = (store.addSection as ReturnType<typeof vi.fn>).mock.calls[1]?.[0] as Section;
    expect(added.orderKey > "M").toBe(true);
  });

  // setProjectParent returns the write's own Promise, unlike every other
  // setter here (this hook's own doc comment on why) — a caller has to be
  // able to `catch` a cycle refusal.
  it("propagates setProjectParent's own rejection rather than swallowing it", async () => {
    const store = createFakeStore();
    const { result } = await renderUseProjects(store);

    await expect(result.current.setProjectParent("p1", "p1")).rejects.toThrow(
      "cannot be its own parent",
    );
  });

  // Issue #184 / ADR 0056: Project and Section add/rename/archive/delete
  // are each recorded — proving the wiring itself, not the store
  // mechanism packages/core's own event-store-contract.ts already covers.
  describe("Event recording (issue #184)", () => {
    function lastRecordedEvent(eventStore: EventStore) {
      const recordMock = eventStore.record as unknown as { mock: { calls: unknown[][] } };
      const call = recordMock.mock.calls.at(-1);
      return call?.[0] as { eventType: string; objectType: string; extra: unknown } | undefined;
    }

    it("addProject records an 'added' Project Event", async () => {
      const store = createFakeStore();
      const { result, eventStore } = await renderUseProjects(store);

      act(() => result.current.addProject("Groceries"));

      await waitFor(() => expect(eventStore.record).toHaveBeenCalledTimes(1));
      expect(lastRecordedEvent(eventStore)).toMatchObject({
        eventType: "added",
        objectType: "project",
        extra: { name: "Groceries" },
      });
    });

    it("renameProject records an 'updated' Project Event carrying name and lastName", async () => {
      const store = createFakeStore();
      await store.upsertProjects([project({ id: "p1", name: "Old Name" })]);
      const { result, eventStore } = await renderUseProjects(store);
      await waitFor(() => expect(result.current.projects).toHaveLength(1));

      act(() => result.current.renameProject("p1", "New Name"));

      await waitFor(() => expect(eventStore.record).toHaveBeenCalledTimes(1));
      expect(lastRecordedEvent(eventStore)).toMatchObject({
        eventType: "updated",
        objectType: "project",
        extra: { name: "New Name", lastName: "Old Name" },
      });
    });

    it("archiveProject records an 'archived' Project Event", async () => {
      const store = createFakeStore();
      // Seeded, since `archiveProject` now looks the Project up first —
      // it needs a `name` to cache onto the Event even though archiving
      // itself doesn't change one (this hook's own `recordProjectEvent`
      // doc comment).
      await store.upsertProjects([project({ id: "p1", name: "Groceries" })]);
      const { result, eventStore } = await renderUseProjects(store);
      await waitFor(() => expect(result.current.projects).toHaveLength(1));

      act(() => result.current.archiveProject("p1"));

      await waitFor(() => expect(eventStore.record).toHaveBeenCalledTimes(1));
      expect(lastRecordedEvent(eventStore)).toMatchObject({
        eventType: "archived",
        objectType: "project",
        extra: { name: "Groceries" },
      });
    });

    it("unarchiveProject records an 'unarchived' Project Event", async () => {
      const store = createFakeStore();
      await store.upsertProjects([project({ id: "p1", name: "Groceries" })]);
      const { result, eventStore } = await renderUseProjects(store);
      await waitFor(() => expect(result.current.projects).toHaveLength(1));

      act(() => result.current.unarchiveProject("p1"));

      await waitFor(() => expect(eventStore.record).toHaveBeenCalledTimes(1));
      expect(lastRecordedEvent(eventStore)).toMatchObject({
        eventType: "unarchived",
        objectType: "project",
        extra: { name: "Groceries" },
      });
    });

    it("addSection records an 'added' Section Event", async () => {
      const store = createFakeStore();
      const { result, eventStore } = await renderUseProjects(store);

      await act(async () => {
        await result.current.addSection("p1", "Produce");
      });

      await waitFor(() => expect(eventStore.record).toHaveBeenCalledTimes(1));
      expect(lastRecordedEvent(eventStore)).toMatchObject({
        eventType: "added",
        objectType: "section",
        extra: { name: "Produce" },
      });
    });

    it("deleteSection records a 'deleted' Section Event carrying the Section's last name", async () => {
      const store = createFakeStore();
      await store.addSection(section({ id: "s1", projectId: "p1", name: "Produce" }));
      const { result, eventStore } = await renderUseProjects(store);

      act(() => result.current.deleteSection("s1"));

      await waitFor(() => expect(eventStore.record).toHaveBeenCalledTimes(1));
      expect(lastRecordedEvent(eventStore)).toMatchObject({
        eventType: "deleted",
        objectType: "section",
        extra: { name: "Produce" },
      });
    });

    // Reordering is explicitly not recorded (issue #184's own acceptance
    // criterion) — the Project-shaped sibling of use-tasks.test.tsx's
    // identical reorderTask/reorderTaskToday assertions.
    it("reorderProject records no Event", async () => {
      const store = createFakeStore();
      const { result, eventStore } = await renderUseProjects(store);

      act(() => result.current.reorderProject("p1", "W"));

      await waitFor(() => expect(store.reorderProject).toHaveBeenCalled());
      expect(eventStore.record).not.toHaveBeenCalled();
    });
  });
});
