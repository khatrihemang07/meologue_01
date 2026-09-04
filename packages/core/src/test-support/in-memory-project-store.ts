import { compareByOrder } from "../order-key";
import {
  assertSectionCapNotExceeded,
  assertValidProjectColour,
  assertValidProjectName,
  assertValidSectionName,
  withDefaultProjectFields,
  withDefaultSectionFields,
} from "../project-fields";
import type { ProjectStore } from "../project-store";
import type { Project, Section } from "../project-types";
import type { TaskStore } from "../task-store";

/**
 * A fake ProjectStore for exercising Todo's UI in tests — the Project-
 * and-Section-shaped sibling of InMemoryTaskStore/InMemoryLabelStore
 * (./in-memory-task-store.ts, ./in-memory-label-store.ts), mirroring
 * their structure method for method so the shared contract suite
 * (./project-store-contract.ts) sees the same behaviour from both this
 * and SqliteProjectStore (../sqlite/sqlite-project-store.ts).
 *
 * Takes a `TaskStore` collaborator, exactly as SqliteProjectStore does —
 * see ../project-store.ts's own header comment (point 3) for why
 * deleteSection/archiveSection need one and why that's a reason to fold
 * Section into this store rather than the reverse.
 */
export class InMemoryProjectStore implements ProjectStore {
  private readonly projects = new Map<string, Project>();
  private readonly sections = new Map<string, Section>();
  private readonly taskStore: TaskStore;
  private projectCursor = 0;
  private sectionCursor = 0;
  // Issue #186 / ADR 0057 — see EntryStore.catchUpRowShapeEpoch's own doc
  // comment (../store.ts) for what these track; two independent
  // watermarks, mirroring projectCursor/sectionCursor's own split.
  private projectRowShapeEpoch = 0;
  private sectionRowShapeEpoch = 0;

  constructor(taskStore: TaskStore) {
    this.taskStore = taskStore;
  }

  async listProjects(): Promise<Project[]> {
    return [...this.projects.values()].filter((p) => p.deletedAt === null).sort(compareByOrder);
  }

  async getProject(id: string): Promise<Project | undefined> {
    const existing = this.projects.get(id);
    return existing === undefined || existing.deletedAt !== null ? undefined : existing;
  }

  async upsertProjects(newProjects: Project[]): Promise<void> {
    for (const p of newProjects) {
      this.projects.set(p.id, withDefaultProjectFields(p));
    }
  }

  async renameProject(id: string, name: string): Promise<void> {
    assertValidProjectName(name);
    this.applyProjectIfLive(id, { name, seq: null, syncedAt: null });
  }

  async setProjectColour(id: string, colour: string): Promise<void> {
    assertValidProjectColour(colour);
    this.applyProjectIfLive(id, { colour, seq: null, syncedAt: null });
  }

  async setProjectDescription(id: string, description: string | null): Promise<void> {
    this.applyProjectIfLive(id, { description, seq: null, syncedAt: null });
  }

  async setProjectFavourite(id: string, favourite: boolean): Promise<void> {
    this.applyProjectIfLive(id, { favourite, seq: null, syncedAt: null });
  }

  async archiveProject(id: string): Promise<void> {
    this.applyProjectIfLive(id, { archived: true, seq: null, syncedAt: null });
  }

  async unarchiveProject(id: string): Promise<void> {
    this.applyProjectIfLive(id, { archived: false, seq: null, syncedAt: null });
  }

  // Mirrors TaskStore.setParent's own cycle/self-parent guard shape
  // (in-memory-task-store.ts), minus the four-level depth cap — see
  // ProjectStore.setProjectParent's own doc comment for why Projects
  // carry no such cap.
  async setProjectParent(id: string, parentId: string | null): Promise<void> {
    const existing = this.projects.get(id);
    if (existing === undefined || existing.deletedAt !== null) {
      return;
    }
    if (parentId !== null) {
      if (parentId === id) {
        throw new Error(`Project ${id} cannot be its own parent`);
      }
      let cursor = this.projects.get(parentId);
      if (cursor === undefined || cursor.deletedAt !== null) {
        throw new Error(
          `setProjectParent: parent Project ${parentId} does not exist or is tombstoned`,
        );
      }
      const visited = new Set<string>([parentId]);
      while (cursor.parentId !== null) {
        if (cursor.parentId === id) {
          throw new Error(
            `setProjectParent: Project ${id} is already an ancestor of ${parentId} — this would create a cycle`,
          );
        }
        if (visited.has(cursor.parentId)) {
          throw new Error(
            `setProjectParent: ${parentId}'s own ancestor chain already cycles at ${cursor.parentId}`,
          );
        }
        visited.add(cursor.parentId);
        const next = this.projects.get(cursor.parentId);
        if (next === undefined) {
          break;
        }
        cursor = next;
      }
    }
    this.applyProjectIfLive(id, { parentId, seq: null, syncedAt: null });
  }

  async reorderProject(id: string, orderKey: string): Promise<void> {
    this.applyProjectIfLive(id, { orderKey, seq: null, syncedAt: null });
  }

  async removeProject(id: string): Promise<void> {
    const existing = this.projects.get(id);
    if (existing === undefined) {
      return;
    }
    this.projects.set(id, {
      ...existing,
      deletedAt: new Date().toISOString(),
      name: "",
      seq: null,
      syncedAt: null,
    });
  }

  async pendingProjects(): Promise<Project[]> {
    return [...this.projects.values()].filter((p) => p.seq === null);
  }

  async getProjectCursor(): Promise<number> {
    return this.projectCursor;
  }

  async setProjectCursor(seq: number): Promise<void> {
    this.projectCursor = seq;
  }

  // Issue #186 / ADR 0057 — see EntryStore.catchUpRowShapeEpoch's own doc
  // comment (../store.ts) for the mechanism this mirrors.
  async catchUpProjectRowShapeEpoch(currentEpoch: number): Promise<void> {
    if (this.projectRowShapeEpoch >= currentEpoch) {
      return;
    }
    this.projectCursor = 0;
    this.projectRowShapeEpoch = currentEpoch;
  }

  async listSections(projectId: string): Promise<Section[]> {
    return [...this.sections.values()]
      .filter((s) => s.deletedAt === null && s.projectId === projectId)
      .sort(compareByOrder);
  }

  async getSection(id: string): Promise<Section | undefined> {
    const existing = this.sections.get(id);
    return existing === undefined || existing.deletedAt !== null ? undefined : existing;
  }

  // See ProjectStore.addSection's own doc comment for why the twenty-cap
  // check lives here rather than in a bulk-merge upsert path.
  async addSection(section: Section): Promise<void> {
    assertValidSectionName(section.name);
    const project = await this.getProject(section.projectId);
    if (project === undefined) {
      throw new Error(`addSection: Project ${section.projectId} does not exist or is tombstoned`);
    }
    const liveCount = (await this.listSections(section.projectId)).length;
    assertSectionCapNotExceeded(liveCount);
    this.sections.set(section.id, withDefaultSectionFields(section));
  }

  // Sync's write path for Sections (issue #182) — mirrors upsertProjects
  // above, no validation (addSection's own doc comment explains why).
  async upsertSections(newSections: Section[]): Promise<void> {
    for (const s of newSections) {
      this.sections.set(s.id, withDefaultSectionFields(s));
    }
  }

  async renameSection(id: string, name: string): Promise<void> {
    assertValidSectionName(name);
    this.applySectionIfLive(id, { name, seq: null, syncedAt: null });
  }

  async setSectionDescription(id: string, description: string | null): Promise<void> {
    this.applySectionIfLive(id, { description, seq: null, syncedAt: null });
  }

  async reorderSection(id: string, orderKey: string): Promise<void> {
    this.applySectionIfLive(id, { orderKey, seq: null, syncedAt: null });
  }

  // See ProjectStore.deleteSection's own doc comment: tombstones every
  // Task directly filed in this Section, plus every descendant of each
  // one, then tombstones the Section itself.
  async deleteSection(id: string): Promise<void> {
    const section = this.sections.get(id);
    if (section === undefined || section.deletedAt !== null) {
      return;
    }
    const topLevel = await this.taskStore.listInSection(id);
    for (const t of topLevel) {
      const descendants = await this.taskStore.listDescendants(t.id);
      for (const d of descendants) {
        await this.taskStore.remove(d.id);
      }
      await this.taskStore.remove(t.id);
    }
    this.sections.set(id, {
      ...section,
      deletedAt: new Date().toISOString(),
      name: "",
      seq: null,
      syncedAt: null,
    });
  }

  // See ProjectStore.archiveSection's own doc comment: completes every
  // still-active Task in the same reach deleteSection uses, then marks the
  // Section itself archived. Deliberately re-checks `completedAt` for
  // every member of the flattened subtree rather than relying solely on
  // TaskStore.complete's own cascade, so an already-completed top-level
  // Task's still-active sub-tasks are reached too.
  async archiveSection(id: string): Promise<void> {
    const section = this.sections.get(id);
    if (section === undefined || section.deletedAt !== null) {
      return;
    }
    const now = new Date().toISOString();
    const topLevel = await this.taskStore.listInSection(id);
    for (const t of topLevel) {
      const subtree = [t, ...(await this.taskStore.listDescendants(t.id))];
      for (const task of subtree) {
        if (task.completedAt === null) {
          await this.taskStore.complete(task.id, now);
        }
      }
    }
    this.applySectionIfLive(id, { archived: true, seq: null, syncedAt: null });
  }

  async unarchiveSection(id: string): Promise<void> {
    this.applySectionIfLive(id, { archived: false, seq: null, syncedAt: null });
  }

  async pendingSections(): Promise<Section[]> {
    return [...this.sections.values()].filter((s) => s.seq === null);
  }

  async getSectionCursor(): Promise<number> {
    return this.sectionCursor;
  }

  async setSectionCursor(seq: number): Promise<void> {
    this.sectionCursor = seq;
  }

  // The Section-shaped sibling of catchUpProjectRowShapeEpoch above.
  async catchUpSectionRowShapeEpoch(currentEpoch: number): Promise<void> {
    if (this.sectionRowShapeEpoch >= currentEpoch) {
      return;
    }
    this.sectionCursor = 0;
    this.sectionRowShapeEpoch = currentEpoch;
  }

  private applyProjectIfLive(id: string, patch: Partial<Project>): void {
    const existing = this.projects.get(id);
    if (existing === undefined || existing.deletedAt !== null) {
      return;
    }
    this.projects.set(id, { ...existing, ...patch });
  }

  private applySectionIfLive(id: string, patch: Partial<Section>): void {
    const existing = this.sections.get(id);
    if (existing === undefined || existing.deletedAt !== null) {
      return;
    }
    this.sections.set(id, { ...existing, ...patch });
  }
}
