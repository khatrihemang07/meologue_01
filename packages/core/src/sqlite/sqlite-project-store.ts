import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/sqlite-proxy";
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
import type { SqliteDriver } from "./driver";
import { kv, projects, sections } from "./schema";

/**
 * The SQLite-backed ProjectStore (issue #171) — mirrors SqliteLabelStore
 * (./sqlite-label-store.ts) closely enough that a reader of one
 * recognises the other, including the same non-atomicity every store
 * built against ../migrator.ts's transaction-free driver carries. See
 * ./open.ts rather than this constructor directly: `projects`/`sections`
 * (migration 9) have to exist before this can query them.
 *
 * Takes a `TaskStore` as a second constructor argument — see
 * ../project-store.ts's own header comment (point 3) for why
 * deleteSection/archiveSection need one, and why Section is folded into
 * this store rather than getting a `SectionStore` of its own.
 */
export class SqliteProjectStore implements ProjectStore {
  private readonly db: ReturnType<typeof drizzle>;
  private readonly taskStore: TaskStore;

  constructor(driver: SqliteDriver, taskStore: TaskStore) {
    this.db = drizzle((sqlText, params, method) => driver.execute(sqlText, params, method));
    this.taskStore = taskStore;
  }

  async listProjects(): Promise<Project[]> {
    return this.db
      .select()
      .from(projects)
      .where(isNull(projects.deletedAt))
      .orderBy(asc(projects.orderKey), asc(projects.id));
  }

  async getProject(id: string): Promise<Project | undefined> {
    const [found] = await this.db
      .select()
      .from(projects)
      .where(and(eq(projects.id, id), isNull(projects.deletedAt)))
      .limit(1);
    return found;
  }

  async upsertProjects(newProjects: Project[]): Promise<void> {
    if (newProjects.length === 0) {
      return;
    }
    const normalized = newProjects.map(withDefaultProjectFields);
    await this.db
      .insert(projects)
      .values(normalized)
      .onConflictDoUpdate({
        target: projects.id,
        set: {
          deviceId: sql`excluded.device_id`,
          name: sql`excluded.name`,
          colour: sql`excluded.colour`,
          favourite: sql`excluded.favourite`,
          archived: sql`excluded.archived`,
          parentId: sql`excluded.parent_id`,
          description: sql`excluded.description`,
          orderKey: sql`excluded.order_key`,
          createdAt: sql`excluded.created_at`,
          seq: sql`excluded.seq`,
          syncedAt: sql`excluded.synced_at`,
          deletedAt: sql`excluded.deleted_at`,
        },
      });
  }

  async renameProject(id: string, name: string): Promise<void> {
    assertValidProjectName(name);
    await this.updateProjectIfLive(id, { name, seq: null, syncedAt: null });
  }

  async setProjectColour(id: string, colour: string): Promise<void> {
    assertValidProjectColour(colour);
    await this.updateProjectIfLive(id, { colour, seq: null, syncedAt: null });
  }

  async setProjectDescription(id: string, description: string | null): Promise<void> {
    await this.updateProjectIfLive(id, { description, seq: null, syncedAt: null });
  }

  async setProjectFavourite(id: string, favourite: boolean): Promise<void> {
    await this.updateProjectIfLive(id, { favourite, seq: null, syncedAt: null });
  }

  async archiveProject(id: string): Promise<void> {
    await this.updateProjectIfLive(id, { archived: true, seq: null, syncedAt: null });
  }

  async unarchiveProject(id: string): Promise<void> {
    await this.updateProjectIfLive(id, { archived: false, seq: null, syncedAt: null });
  }

  // Mirrors SqliteTaskStore.setParent's own cycle/self-parent guard shape,
  // minus the four-level depth cap — see ProjectStore.setProjectParent's
  // own doc comment for why Projects carry no such cap.
  async setProjectParent(id: string, parentId: string | null): Promise<void> {
    const current = await this.getProject(id);
    if (current === undefined) {
      return;
    }
    if (parentId !== null) {
      if (parentId === id) {
        throw new Error(`Project ${id} cannot be its own parent`);
      }
      let cursor = await this.getProject(parentId);
      if (cursor === undefined) {
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
        const next = await this.getProject(cursor.parentId);
        if (next === undefined) {
          break;
        }
        cursor = next;
      }
    }
    await this.updateProjectIfLive(id, { parentId, seq: null, syncedAt: null });
  }

  async reorderProject(id: string, orderKey: string): Promise<void> {
    await this.updateProjectIfLive(id, { orderKey, seq: null, syncedAt: null });
  }

  // Tombstones a Project — never a hard delete (ADR 0028's rule).
  // Deliberately touches nothing beyond this one row — see
  // ProjectStore.removeProject's own doc comment for why this doesn't
  // cascade to this Project's Tasks or Sections. Blanks `name`, mirroring
  // every other tombstone in this codebase.
  async removeProject(id: string): Promise<void> {
    await this.db
      .update(projects)
      .set({ deletedAt: new Date().toISOString(), name: "", seq: null, syncedAt: null })
      .where(eq(projects.id, id));
  }

  async pendingProjects(): Promise<Project[]> {
    return this.db.select().from(projects).where(isNull(projects.seq));
  }

  async getProjectCursor(): Promise<number> {
    const value = await this.getKv(PROJECT_CURSOR_KEY);
    return value === undefined ? 0 : Number(value);
  }

  async setProjectCursor(seq: number): Promise<void> {
    await this.setKv(PROJECT_CURSOR_KEY, String(seq));
  }

  async listSections(projectId: string): Promise<Section[]> {
    return this.db
      .select()
      .from(sections)
      .where(and(eq(sections.projectId, projectId), isNull(sections.deletedAt)))
      .orderBy(asc(sections.orderKey), asc(sections.id));
  }

  async getSection(id: string): Promise<Section | undefined> {
    const [found] = await this.db
      .select()
      .from(sections)
      .where(and(eq(sections.id, id), isNull(sections.deletedAt)))
      .limit(1);
    return found;
  }

  // See ProjectStore.addSection's own doc comment for why the twenty-cap
  // check lives here rather than in a bulk-merge upsert path — there is
  // deliberately no `upsertSections`.
  async addSection(section: Section): Promise<void> {
    assertValidSectionName(section.name);
    const project = await this.getProject(section.projectId);
    if (project === undefined) {
      throw new Error(`addSection: Project ${section.projectId} does not exist or is tombstoned`);
    }
    const liveCount = (await this.listSections(section.projectId)).length;
    assertSectionCapNotExceeded(liveCount);
    await this.db.insert(sections).values(withDefaultSectionFields(section));
  }

  async renameSection(id: string, name: string): Promise<void> {
    assertValidSectionName(name);
    await this.updateSectionIfLive(id, { name, seq: null, syncedAt: null });
  }

  async setSectionDescription(id: string, description: string | null): Promise<void> {
    await this.updateSectionIfLive(id, { description, seq: null, syncedAt: null });
  }

  async reorderSection(id: string, orderKey: string): Promise<void> {
    await this.updateSectionIfLive(id, { orderKey, seq: null, syncedAt: null });
  }

  // See ProjectStore.deleteSection's own doc comment: tombstones every
  // Task directly filed in this Section, plus every descendant of each
  // one (via TaskStore.listDescendants), then tombstones the Section
  // itself. Not wrapped in a transaction — ../migrator.ts's own header
  // comment explains why one isn't available anywhere in this stack — so
  // a process dying partway through leaves some Tasks tombstoned and
  // others not; re-running this method (or a caller retrying the same
  // operation) finishes the job, since TaskStore.remove() and this
  // method's own Section update are each idempotent on their own.
  async deleteSection(id: string): Promise<void> {
    const section = await this.getSection(id);
    if (section === undefined) {
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
    await this.db
      .update(sections)
      .set({ deletedAt: new Date().toISOString(), name: "", seq: null, syncedAt: null })
      .where(eq(sections.id, id));
  }

  // See ProjectStore.archiveSection's own doc comment: completes every
  // still-active Task in the same reach deleteSection uses, then marks the
  // Section itself archived. Deliberately re-checks `completedAt` for
  // every member of the flattened subtree rather than relying solely on
  // TaskStore.complete's own cascade, so an already-completed top-level
  // Task's still-active sub-tasks are reached too.
  async archiveSection(id: string): Promise<void> {
    const section = await this.getSection(id);
    if (section === undefined) {
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
    await this.updateSectionIfLive(id, { archived: true, seq: null, syncedAt: null });
  }

  async unarchiveSection(id: string): Promise<void> {
    await this.updateSectionIfLive(id, { archived: false, seq: null, syncedAt: null });
  }

  async pendingSections(): Promise<Section[]> {
    return this.db.select().from(sections).where(isNull(sections.seq));
  }

  async getSectionCursor(): Promise<number> {
    const value = await this.getKv(SECTION_CURSOR_KEY);
    return value === undefined ? 0 : Number(value);
  }

  async setSectionCursor(seq: number): Promise<void> {
    await this.setKv(SECTION_CURSOR_KEY, String(seq));
  }

  // Mirrors SqliteTaskStore/SqliteLabelStore's identical updateIfLive —
  // a mutation against an unknown or already-tombstoned id is a no-op.
  private async updateProjectIfLive(id: string, patch: Partial<Project>): Promise<void> {
    await this.db
      .update(projects)
      .set(patch)
      .where(and(eq(projects.id, id), isNull(projects.deletedAt)));
  }

  private async updateSectionIfLive(id: string, patch: Partial<Section>): Promise<void> {
    await this.db
      .update(sections)
      .set(patch)
      .where(and(eq(sections.id, id), isNull(sections.deletedAt)));
  }

  private async getKv(key: string): Promise<string | undefined> {
    const rows = await this.db.select({ value: kv.value }).from(kv).where(eq(kv.key, key)).limit(1);
    return rows[0]?.value;
  }

  private async setKv(key: string, value: string): Promise<void> {
    await this.db
      .insert(kv)
      .values({ key, value })
      .onConflictDoUpdate({ target: kv.key, set: { value } });
  }
}

// Namespaced apart from the Entry/Task/Label cursor keys for the same
// reason each of those give their own — see SqliteTaskStore.getCursor's
// comment: a shared key would collide independent streams' progress into
// one number. Two separate keys, one per entity, mirroring
// pendingProjects()/pendingSections()'s own separate-streams shape.
const PROJECT_CURSOR_KEY = "project_cursor";
const SECTION_CURSOR_KEY = "section_cursor";
