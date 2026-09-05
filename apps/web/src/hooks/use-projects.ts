import type { EventStore, Project, ProjectStore, Section } from "@meologue/core";
import { DEFAULT_LABEL_COLOUR, mintId, orderKeyBetween } from "@meologue/core";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEvents } from "@/hooks/use-events";
import { queryClient } from "@/lib/query-client";
import { PROJECTS_QUERY_KEY, sectionsQueryKey } from "@/lib/query-keys";
import { refreshTasks } from "@/lib/tasks-refresh";

/**
 * Everything about a new Project beyond its `name` a caller might already
 * know — mirrors use-tasks.ts's `AddTaskOverrides` shape for the identical
 * reason: every field here is independently optional, so a caller with
 * nothing more to say than "add this Project" states none of them.
 */
export interface AddProjectOverrides {
  /** One of LABEL_COLOURS' current palette hexes (../../packages/core/src/label-colors.ts) — Project.colour's own doc comment on why Projects, Labels and Filters share one palette. `DEFAULT_LABEL_COLOUR` (a neutral grey) when the reader hasn't picked one, mirroring a Label's own creation default (use-labels.ts's `resolveLabelIds`). */
  colour?: string;
  /** The Project this one nests under — `null` (top-level) unless the reader opened "New Project" from inside another Project's own view. */
  parentId?: string | null;
  description?: string | null;
}

export interface UseProjectsResult {
  /** Every Project, `archived` ones included (ProjectStore.listProjects()'s own doc comment: unfiltered by design, a personal Project list is small). */
  projects: Project[];
  /** Creates a Project from plain text. Ignores blank input, mirroring addTask. */
  addProject: (name: string, overrides?: AddProjectOverrides) => void;
  renameProject: (id: string, name: string) => void;
  setProjectColour: (id: string, colour: string) => void;
  setProjectDescription: (id: string, description: string | null) => void;
  setProjectFavourite: (id: string, favourite: boolean) => void;
  archiveProject: (id: string) => void;
  unarchiveProject: (id: string) => void;
  /**
   * Moves a Project to nest under `parentId`, or to top-level for `null`.
   * Returns the write's own Promise, unlike every setter above — mirrors
   * use-tasks.ts's `setTaskParent`: ProjectStore.setProjectParent throws on
   * `parentId === id` and on a `parentId` that is already a descendant of
   * `id` (its own doc comment), and a caller-facing "move Project" control
   * needs to be able to `catch` that rather than have it disappear into a
   * mutation's own internal error state.
   */
  setProjectParent: (id: string, parentId: string | null) => Promise<void>;
  reorderProject: (id: string, orderKey: string) => void;
  /**
   * A Project's own Sections (ProjectStore.listSections) — an async
   * function rather than eagerly-loaded flat state, mirroring
   * entry-store-layout.tsx's `dayHasEntries`/`getEntry`: only whichever
   * one Project's own view is currently open ever needs this, so loading
   * every Project's Sections up front (this app has no Project count large
   * enough to make that expensive, but no caller needs it either) would
   * cost a render's worth of state for data nothing reads. The Project
   * view itself (todo-page.tsx) wraps this in its own `useQuery`, keyed by
   * query-keys.ts's `sectionsQueryKey`, so a Section mutation's own
   * `queryClient.invalidateQueries` below is what keeps it live.
   */
  listSections: (projectId: string) => Promise<Section[]>;
  /**
   * Creates a Section inside `projectId`. Returns the write's own Promise
   * — ProjectStore.addSection throws on an empty name, an unknown
   * `projectId`, and, most reachably from the UI, the twenty-Section cap
   * (its own doc comment) — the same "the caller needs to catch this, not
   * have it vanish" reasoning `setProjectParent` above carries.
   */
  addSection: (projectId: string, name: string) => Promise<void>;
  renameSection: (id: string, name: string) => void;
  setSectionDescription: (id: string, description: string | null) => void;
  reorderSection: (id: string, orderKey: string) => void;
  /** Destroys every Task inside the Section, completed ones included, unrecoverably — ProjectStore.deleteSection's own doc comment. The confirmation is the caller's job (todo-page.tsx's ConfirmDialog), not this hook's. */
  deleteSection: (id: string) => void;
  /** Completes every Task inside the Section and preserves them — ProjectStore.archiveSection's own doc comment, the gentle sibling of deleteSection above. */
  archiveSection: (id: string) => void;
  unarchiveSection: (id: string) => void;
}

/**
 * Owns Todo's Projects and Sections for whichever view is mounted under
 * EntryStoreLayout (issue #171) — the Project/Section-shaped sibling of
 * use-tasks.ts and use-labels.ts, following their exact shape (a query, a
 * mutation per write, the shared `afterLocalWrite`-style cache
 * invalidation) for the identical reason use-tasks.ts's own header comment
 * gives for mirroring use-history.ts.
 *
 * No `afterLocalWrite`/Sync-nudge seam the way use-tasks.ts carries one:
 * Project and Section sync is further out than Task sync (issue #171's
 * own web brief scopes this to the local store only), so there is nothing
 * yet for a mutation here to nudge beyond invalidating the cache — the
 * identical "seam lands with the feature that needs it" posture
 * use-tasks.ts's own `afterLocalWrite` comment describes for issue #172.
 */
export function useProjects(
  projectStore: ProjectStore,
  // Issue #184: Todo's activity log — Project/Section add/rename/archive/
  // unarchive/delete are each recorded (CONTEXT.md's Event entry, ADR
  // 0056's own taxonomy). Not threaded to `requestSync` here the way
  // Tasks' own `eventStore` is: this hook still carries no `requestSync`
  // nudge of its own (this file's own header comment already states why
  // — Project/Section Sync predates this ticket and was never wired to a
  // nudge here), so an Event recorded from this hook simply rides along
  // on the next scheduled sync tick or another mutation's own nudge,
  // exactly as every other write from this hook already does.
  eventStore: EventStore,
  deviceId: string,
): UseProjectsResult {
  const projectsQuery = useQuery({
    queryKey: PROJECTS_QUERY_KEY,
    queryFn: () => projectStore.listProjects(),
  });

  const projects = projectsQuery.data ?? [];

  const { recordEvent } = useEvents(eventStore, deviceId);

  // `name` is always merged into `extra` — the cached label
  // `format-event.ts`'s own `describeEventLine` falls back to once a
  // Project can no longer be resolved live, the identical reasoning
  // use-tasks.ts's `recordTaskEvent` gives for merging `content` in
  // unconditionally rather than only for the events (rename) that
  // already happened to carry it for a diff's own sake. Spread order
  // matches that function's own fix: the default goes first, so a
  // rename's own explicit `extra.name` (the *new* name) still wins over
  // the fallback rather than being clobbered back to the pre-rename one.
  function recordProjectEvent(
    project: Pick<Project, "id" | "name">,
    eventType: "added" | "updated" | "archived" | "unarchived",
    extra: Record<string, unknown> | null = null,
  ): void {
    void recordEvent({
      eventType,
      objectType: "project",
      objectId: project.id,
      taskId: null,
      projectId: project.id,
      extra: { name: project.name, ...extra },
    });
  }

  // Mirrors recordProjectEvent's own `name` merge above, over Sections.
  function recordSectionEvent(
    section: Pick<Section, "id" | "projectId" | "name">,
    eventType: "added" | "updated" | "archived" | "unarchived" | "deleted",
    extra: Record<string, unknown> | null = null,
  ): void {
    void recordEvent({
      eventType,
      objectType: "section",
      objectId: section.id,
      taskId: null,
      projectId: section.projectId,
      extra: { name: section.name, ...extra },
    });
  }

  function invalidateProjects() {
    return queryClient.invalidateQueries({ queryKey: PROJECTS_QUERY_KEY });
  }

  // Every cached Section list, across every Project — see
  // query-keys.ts's own `sectionsQueryKey` doc comment for why this is a
  // bare-prefix invalidation rather than one Project's own key.
  function invalidateSections() {
    return queryClient.invalidateQueries({ queryKey: ["sections"] });
  }

  const addProjectMutation = useMutation({
    mutationFn: async (project: Project) => {
      await projectStore.upsertProjects([project]);
      recordProjectEvent(project, "added", { name: project.name });
    },
    onSuccess: invalidateProjects,
  });

  function addProject(name: string, overrides: AddProjectOverrides = {}) {
    const trimmed = name.trim();
    if (trimmed === "") {
      return;
    }
    const capturedAt = new Date().toISOString();
    addProjectMutation.mutate({
      id: mintId(),
      deviceId,
      name: trimmed,
      colour: overrides.colour ?? DEFAULT_LABEL_COLOUR,
      favourite: false,
      archived: false,
      parentId: overrides.parentId ?? null,
      description: overrides.description ?? null,
      // Appended after every existing Project — mirrors addTask's own
      // `orderKeyBetween(tasks.at(-1)?.orderKey ?? null, null)`, except
      // Projects are read flat (ProjectStore.listProjects()'s own doc
      // comment: "a global order across every `parentId` group at once"),
      // so "last" here means last in that flat order, not last among
      // siblings sharing this Project's own `parentId` — a fresh Project
      // reads as sorted-after in the flat list ProjectsView renders even
      // though the flat list is what the reader actually sees.
      orderKey: orderKeyAfter(projects),
      createdAt: capturedAt,
      // Issue #196: starts equal to createdAt, the same single clock read.
      updatedAt: capturedAt,
      seq: null,
      syncedAt: null,
      deletedAt: null,
    });
  }

  const renameProjectMutation = useMutation({
    mutationFn: async ({ id, name }: { id: string; name: string }) => {
      const before = projects.find((p) => p.id === id) ?? (await projectStore.getProject(id));
      await projectStore.renameProject(id, name);
      if (before) {
        recordProjectEvent(before, "updated", { name, lastName: before.name });
      }
    },
    onSuccess: invalidateProjects,
  });

  function renameProject(id: string, name: string) {
    const trimmed = name.trim();
    if (trimmed === "") {
      return;
    }
    renameProjectMutation.mutate({ id, name: trimmed });
  }

  const setColourMutation = useMutation({
    mutationFn: ({ id, colour }: { id: string; colour: string }) =>
      projectStore.setProjectColour(id, colour),
    onSuccess: invalidateProjects,
  });

  function setProjectColour(id: string, colour: string) {
    setColourMutation.mutate({ id, colour });
  }

  const setDescriptionMutation = useMutation({
    mutationFn: ({ id, description }: { id: string; description: string | null }) =>
      projectStore.setProjectDescription(id, description),
    onSuccess: invalidateProjects,
  });

  function setProjectDescription(id: string, description: string | null) {
    setDescriptionMutation.mutate({ id, description });
  }

  const setFavouriteMutation = useMutation({
    mutationFn: ({ id, favourite }: { id: string; favourite: boolean }) =>
      projectStore.setProjectFavourite(id, favourite),
    onSuccess: invalidateProjects,
  });

  function setProjectFavourite(id: string, favourite: boolean) {
    setFavouriteMutation.mutate({ id, favourite });
  }

  const archiveProjectMutation = useMutation({
    mutationFn: async (id: string) => {
      // Looked up before the write, mirroring use-tasks.ts's own
      // `findTask` — `recordProjectEvent` needs a `name` to cache even
      // though archiving itself doesn't change one.
      const before = projects.find((p) => p.id === id) ?? (await projectStore.getProject(id));
      await projectStore.archiveProject(id);
      if (before) {
        recordProjectEvent(before, "archived");
      }
    },
    onSuccess: invalidateProjects,
  });

  function archiveProject(id: string) {
    archiveProjectMutation.mutate(id);
  }

  const unarchiveProjectMutation = useMutation({
    mutationFn: async (id: string) => {
      const before = projects.find((p) => p.id === id) ?? (await projectStore.getProject(id));
      await projectStore.unarchiveProject(id);
      if (before) {
        recordProjectEvent(before, "unarchived");
      }
    },
    onSuccess: invalidateProjects,
  });

  function unarchiveProject(id: string) {
    unarchiveProjectMutation.mutate(id);
  }

  const setProjectParentMutation = useMutation({
    mutationFn: ({ id, parentId }: { id: string; parentId: string | null }) =>
      projectStore.setProjectParent(id, parentId),
    onSuccess: invalidateProjects,
  });

  function setProjectParent(id: string, parentId: string | null): Promise<void> {
    return setProjectParentMutation.mutateAsync({ id, parentId });
  }

  const reorderProjectMutation = useMutation({
    mutationFn: ({ id, orderKey }: { id: string; orderKey: string }) =>
      projectStore.reorderProject(id, orderKey),
    onSuccess: invalidateProjects,
  });

  function reorderProject(id: string, orderKey: string) {
    reorderProjectMutation.mutate({ id, orderKey });
  }

  function listSections(projectId: string): Promise<Section[]> {
    return projectStore.listSections(projectId);
  }

  const addSectionMutation = useMutation({
    mutationFn: async (section: Section) => {
      await projectStore.addSection(section);
      recordSectionEvent(section, "added", { name: section.name });
    },
    onSuccess: invalidateSections,
  });

  async function addSection(projectId: string, name: string): Promise<void> {
    const trimmed = name.trim();
    if (trimmed === "") {
      // Mirrors addProject/addTask's own "ignore blank input" rule — but
      // this function returns a Promise a caller may be awaiting to learn
      // whether the Section was created, so a resolved (not rejected)
      // Promise is the honest answer here: blank input isn't the
      // twenty-cap or an empty-name refusal this function's own doc
      // comment names, it's simply nothing to do.
      return;
    }
    // Appended after this Project's own existing Sections. Read fresh
    // here rather than trusting a list the caller happens to have on
    // hand: two Sections added back-to-back (a reader typing "Add
    // Section" twice quickly) must each see the other's own orderKey, the
    // same "read fresh off the query cache" reasoning use-labels.ts's
    // `resolveLabelIds` gives for the identical race with a `%label`
    // token typed twice in one line.
    const current =
      queryClient.getQueryData<Section[]>(sectionsQueryKey(projectId)) ??
      (await projectStore.listSections(projectId));
    const capturedAt = new Date().toISOString();
    await addSectionMutation.mutateAsync({
      id: mintId(),
      deviceId,
      projectId,
      name: trimmed,
      description: null,
      orderKey: orderKeyAfter(current),
      archived: false,
      createdAt: capturedAt,
      // Issue #196: starts equal to createdAt, the same single clock read.
      updatedAt: capturedAt,
      seq: null,
      syncedAt: null,
      deletedAt: null,
    });
  }

  const renameSectionMutation = useMutation({
    mutationFn: async ({ id, name }: { id: string; name: string }) => {
      const before = await projectStore.getSection(id);
      await projectStore.renameSection(id, name);
      if (before) {
        recordSectionEvent(before, "updated", { name, lastName: before.name });
      }
    },
    onSuccess: invalidateSections,
  });

  function renameSection(id: string, name: string) {
    const trimmed = name.trim();
    if (trimmed === "") {
      return;
    }
    renameSectionMutation.mutate({ id, name: trimmed });
  }

  const setSectionDescriptionMutation = useMutation({
    mutationFn: ({ id, description }: { id: string; description: string | null }) =>
      projectStore.setSectionDescription(id, description),
    onSuccess: invalidateSections,
  });

  function setSectionDescription(id: string, description: string | null) {
    setSectionDescriptionMutation.mutate({ id, description });
  }

  const reorderSectionMutation = useMutation({
    mutationFn: ({ id, orderKey }: { id: string; orderKey: string }) =>
      projectStore.reorderSection(id, orderKey),
    onSuccess: invalidateSections,
  });

  function reorderSection(id: string, orderKey: string) {
    reorderSectionMutation.mutate({ id, orderKey });
  }

  const deleteSectionMutation = useMutation({
    mutationFn: async (id: string) => {
      const before = await projectStore.getSection(id);
      await projectStore.deleteSection(id);
      if (before) {
        recordSectionEvent(before, "deleted");
      }
    },
    // Destroys Tasks too (ProjectStore.deleteSection's own doc comment),
    // so both caches need to know: Sections for the Section itself, Tasks
    // for every row it just tombstoned.
    onSuccess: () => Promise.all([invalidateSections(), invalidateTasks()]),
  });

  function deleteSection(id: string) {
    deleteSectionMutation.mutate(id);
  }

  const archiveSectionMutation = useMutation({
    mutationFn: async (id: string) => {
      const before = await projectStore.getSection(id);
      await projectStore.archiveSection(id);
      if (before) {
        recordSectionEvent(before, "archived");
      }
    },
    onSuccess: () => Promise.all([invalidateSections(), invalidateTasks()]),
  });

  function archiveSection(id: string) {
    archiveSectionMutation.mutate(id);
  }

  const unarchiveSectionMutation = useMutation({
    mutationFn: async (id: string) => {
      const before = await projectStore.getSection(id);
      await projectStore.unarchiveSection(id);
      if (before) {
        recordSectionEvent(before, "unarchived");
      }
    },
    onSuccess: invalidateSections,
  });

  function unarchiveSection(id: string) {
    unarchiveSectionMutation.mutate(id);
  }

  return {
    projects,
    addProject,
    renameProject,
    setProjectColour,
    setProjectDescription,
    setProjectFavourite,
    archiveProject,
    unarchiveProject,
    setProjectParent,
    reorderProject,
    listSections,
    addSection,
    renameSection,
    setSectionDescription,
    reorderSection,
    deleteSection,
    archiveSection,
    unarchiveSection,
  };
}

// mirrors use-tasks.ts's own `orderKeyBetween(tasks.at(-1)?.orderKey ?? null, null)`
// inline expression — pulled into a named helper here only because
// addProject's own comment above needed somewhere to hang the "flat order,
// not per-`parentId`" caveat without repeating it inline.
function orderKeyAfter(existing: { orderKey: string }[]): string {
  return orderKeyBetween(existing.at(-1)?.orderKey ?? null, null);
}

// deleteSection/archiveSection both cascade into TaskStore
// (ProjectStore's own header comment, point 3), so both need to
// invalidate Todo's own TASKS_QUERY_KEY too, not just this hook's own
// PROJECTS_QUERY_KEY-adjacent keys. Reuses tasks-refresh.ts's own
// refreshTasks rather than duplicating its `invalidateQueries` call.
function invalidateTasks() {
  return refreshTasks();
}
