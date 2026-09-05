import { beforeEach, describe, expect, it } from "vitest";
import { LABEL_COLOURS } from "../label-colors";
import { MAX_SECTIONS_PER_PROJECT } from "../project-fields";
import type { ProjectStore } from "../project-store";
import type { TaskStore } from "../task-store";
import { project, section } from "./project-fixture";
import { task } from "./task-fixture";

/**
 * The behaviour every ProjectStore implementation (issue #171) must
 * satisfy — the Project-and-Section-shaped sibling of taskStoreContract/
 * labelStoreContract, mirrored section for section so a reader who knows
 * one recognises the other.
 *
 * **Takes a factory returning both a ProjectStore and the TaskStore it
 * was built against**, unlike every other contract in this codebase's
 * single-store factory. This is a deliberate deviation, not an
 * oversight: deleteSection/archiveSection's entire contract is about
 * their effect on Tasks (../project-store.ts's own header comment, point
 * 3), so a test proving that effect needs a TaskStore handle to assert
 * against — there is no way to check "every Task in the Section was
 * tombstoned" through ProjectStore's own interface alone, which
 * (deliberately — see that same header comment) exposes no Task-shaped
 * reads at all.
 */
export function projectStoreContract(
  createStores: () =>
    | { projectStore: ProjectStore; taskStore: TaskStore }
    | Promise<{
        projectStore: ProjectStore;
        taskStore: TaskStore;
      }>,
): void {
  let projectStore: ProjectStore;
  let taskStore: TaskStore;

  beforeEach(async () => {
    ({ projectStore, taskStore } = await createStores());
  });

  describe("Project", () => {
    it("returns a locally created Project immediately, before any sync", async () => {
      const local = project({ id: "local-1", seq: null });

      await projectStore.upsertProjects([local]);

      expect(await projectStore.listProjects()).toEqual([local]);
    });

    it("deduplicates Projects arriving twice by id, rather than appending twice", async () => {
      const first = project({ id: "dup-1", name: "first version" });
      const second = project({ id: "dup-1", name: "second version", seq: 1 });

      await projectStore.upsertProjects([first]);
      await projectStore.upsertProjects([second]);

      const all = await projectStore.listProjects();
      expect(all).toHaveLength(1);
      expect(all[0]).toEqual(second);
    });

    it("orders Projects by orderKey ascending, breaking ties by id ascending", async () => {
      const b = project({ id: "b", orderKey: "b" });
      const a = project({ id: "a", orderKey: "a" });
      const tieB = project({ id: "tie-b", orderKey: "m" });
      const tieA = project({ id: "tie-a", orderKey: "m" });

      await projectStore.upsertProjects([b, a, tieB, tieA]);

      expect((await projectStore.listProjects()).map((p) => p.id)).toEqual([
        "a",
        "b",
        "tie-a",
        "tie-b",
      ]);
    });

    describe("renameProject()", () => {
      it("changes name and clears seq", async () => {
        await projectStore.upsertProjects([project({ id: "a", name: "original", seq: 5 })]);

        await projectStore.renameProject("a", "changed");

        expect(await projectStore.getProject("a")).toMatchObject({
          id: "a",
          name: "changed",
          seq: null,
        });
      });

      it("refuses an empty or whitespace-only name", async () => {
        await projectStore.upsertProjects([project({ id: "a", seq: 1 })]);

        await expect(projectStore.renameProject("a", "")).rejects.toThrow();
        await expect(projectStore.renameProject("a", "   ")).rejects.toThrow();
      });

      // Issue #196: every setter that clears seq/syncedAt also stamps
      // updatedAt — checked here via a fresh value (the fixture's own
      // default is a fixed 2026-01-01 timestamp, always older than
      // whatever the real clock says "now" is while this test runs).
      it("stamps updatedAt with a fresh value", async () => {
        const original = project({ id: "a", seq: 5 });
        await projectStore.upsertProjects([original]);

        await projectStore.renameProject("a", "changed");

        const found = await projectStore.getProject("a");
        expect(found?.updatedAt).not.toBe(original.updatedAt);
        expect((found?.updatedAt as string) > original.updatedAt).toBe(true);
      });
    });

    describe("setProjectColour()", () => {
      it("changes colour and clears seq", async () => {
        await projectStore.upsertProjects([project({ id: "a", seq: 5 })]);
        const target = LABEL_COLOURS.find((c) => c.name === "blue");
        if (target === undefined) {
          throw new Error("LABEL_COLOURS is missing 'blue' — fixture assumption broken");
        }

        await projectStore.setProjectColour("a", target.hex);

        expect(await projectStore.getProject("a")).toMatchObject({
          colour: target.hex,
          seq: null,
        });
      });

      it("refuses a hex outside the current palette — including the retired pre-2024 red", async () => {
        await projectStore.upsertProjects([project({ id: "a", seq: 1 })]);

        await expect(projectStore.setProjectColour("a", "#DB4035")).rejects.toThrow();
      });
    });

    it("setProjectDescription() changes description and clears seq, and null clears it back", async () => {
      await projectStore.upsertProjects([project({ id: "a", seq: 5 })]);

      await projectStore.setProjectDescription("a", "weekly groceries and errands");
      expect(await projectStore.getProject("a")).toMatchObject({
        description: "weekly groceries and errands",
        seq: null,
      });

      await projectStore.setProjectDescription("a", null);
      expect(await projectStore.getProject("a")).toMatchObject({ description: null });
    });

    it("setProjectFavourite() changes favourite and clears seq", async () => {
      await projectStore.upsertProjects([project({ id: "a", favourite: false, seq: 5 })]);

      await projectStore.setProjectFavourite("a", true);

      expect(await projectStore.getProject("a")).toMatchObject({ favourite: true, seq: null });
    });

    describe("archiveProject() / unarchiveProject()", () => {
      it("archiveProject() sets archived and clears seq; unarchiveProject() clears it back", async () => {
        await projectStore.upsertProjects([project({ id: "a", seq: 5 })]);

        await projectStore.archiveProject("a");
        expect(await projectStore.getProject("a")).toMatchObject({ archived: true, seq: null });

        await projectStore.unarchiveProject("a");
        expect(await projectStore.getProject("a")).toMatchObject({ archived: false, seq: null });
      });

      // Project.archived's own doc comment: deliberately no cascade —
      // contrast Section's archiveSection below, which completes every
      // Task inside it.
      it("does not touch this Project's own Tasks", async () => {
        await projectStore.upsertProjects([project({ id: "a", seq: 5 })]);
        await taskStore.upsert([task({ id: "t", projectId: "a", seq: 1 })]);

        await projectStore.archiveProject("a");

        expect(await taskStore.get("t")).toMatchObject({ completedAt: null, deletedAt: null });
      });
    });

    describe("setProjectParent()", () => {
      it("changes parentId and clears seq, and null clears it back to top-level", async () => {
        await projectStore.upsertProjects([
          project({ id: "parent", seq: 1 }),
          project({ id: "child", seq: 5 }),
        ]);

        await projectStore.setProjectParent("child", "parent");
        expect(await projectStore.getProject("child")).toMatchObject({
          parentId: "parent",
          seq: null,
        });

        await projectStore.setProjectParent("child", null);
        expect(await projectStore.getProject("child")).toMatchObject({ parentId: null });
      });

      it("refuses a Project becoming its own parent", async () => {
        await projectStore.upsertProjects([project({ id: "a", seq: 1 })]);

        await expect(projectStore.setProjectParent("a", "a")).rejects.toThrow();
      });

      it("refuses a parentId that would create a cycle", async () => {
        await projectStore.upsertProjects([
          project({ id: "a", seq: 1 }),
          project({ id: "b", parentId: "a", seq: 1 }),
        ]);

        await expect(projectStore.setProjectParent("a", "b")).rejects.toThrow();
      });
    });

    it("reorderProject() changes orderKey and clears seq", async () => {
      await projectStore.upsertProjects([project({ id: "a", orderKey: "m", seq: 5 })]);

      await projectStore.reorderProject("a", "b");

      expect(await projectStore.getProject("a")).toMatchObject({ orderKey: "b", seq: null });
    });

    describe("removeProject() — tombstone, not hard delete", () => {
      it("removes a Project from listProjects() and getProject()", async () => {
        await projectStore.upsertProjects([project({ id: "a", seq: 1 })]);

        await projectStore.removeProject("a");

        expect(await projectStore.listProjects()).toEqual([]);
        expect(await projectStore.getProject("a")).toBeUndefined();
      });

      // Mirrors taskStoreContract/labelStoreContract's identical,
      // most-important case (ADR 0028's resurrection trap).
      it("removing a Project whose seq is already null still leaves a tombstone pending(), not nothing", async () => {
        await projectStore.upsertProjects([project({ id: "a", seq: null })]);

        await projectStore.removeProject("a");

        const pending = await projectStore.pendingProjects();
        expect(pending.map((p) => p.id)).toEqual(["a"]);
        expect(pending[0]?.deletedAt).not.toBeNull();
      });

      // Deliberately does not touch this Project's own Tasks or Sections
      // — ProjectStore.removeProject's own doc comment explains why.
      it("does not touch this Project's own Tasks", async () => {
        await projectStore.upsertProjects([project({ id: "a", seq: 1 })]);
        await taskStore.upsert([task({ id: "t", projectId: "a", seq: 1 })]);

        await projectStore.removeProject("a");

        expect(await taskStore.get("t")).toMatchObject({ deletedAt: null });
      });
    });

    it("returns only Projects with a null sequence from pendingProjects()", async () => {
      const unsynced = project({ id: "unsynced", seq: null });
      const synced = project({ id: "synced", seq: 42 });

      await projectStore.upsertProjects([unsynced, synced]);

      expect((await projectStore.pendingProjects()).map((p) => p.id)).toEqual(["unsynced"]);
    });

    it("starts the Project cursor at 0 and reflects whatever it's set to", async () => {
      expect(await projectStore.getProjectCursor()).toBe(0);

      await projectStore.setProjectCursor(7);

      expect(await projectStore.getProjectCursor()).toBe(7);
    });

    // Issue #186 / ADR 0057 — see EntryStore.catchUpRowShapeEpoch's own
    // doc comment (../store.ts) for the mechanism these pin.
    describe("catchUpProjectRowShapeEpoch", () => {
      it("does nothing for a Device that has never synced this stream", async () => {
        expect(await projectStore.getProjectCursor()).toBe(0);

        await projectStore.catchUpProjectRowShapeEpoch(1);

        expect(await projectStore.getProjectCursor()).toBe(0);
      });

      it("resets an already-advanced Cursor to 0 the first time it sees a higher epoch", async () => {
        await projectStore.setProjectCursor(50);

        await projectStore.catchUpProjectRowShapeEpoch(1);

        expect(await projectStore.getProjectCursor()).toBe(0);
      });

      it("is idempotent: catching up to the same epoch again does not reset a Cursor that has since advanced", async () => {
        await projectStore.catchUpProjectRowShapeEpoch(1);
        await projectStore.setProjectCursor(50);

        await projectStore.catchUpProjectRowShapeEpoch(1);

        expect(await projectStore.getProjectCursor()).toBe(50);
      });

      it("does not reset when asked to catch up to an epoch no higher than one already recorded", async () => {
        await projectStore.catchUpProjectRowShapeEpoch(2);
        await projectStore.setProjectCursor(50);

        await projectStore.catchUpProjectRowShapeEpoch(1);

        expect(await projectStore.getProjectCursor()).toBe(50);
      });
    });
  });

  describe("Section", () => {
    beforeEach(async () => {
      await projectStore.upsertProjects([project({ id: "project-1", seq: 1 })]);
    });

    describe("addSection()", () => {
      it("creates a Section reachable from listSections()/getSection()", async () => {
        await projectStore.addSection(section({ id: "a", projectId: "project-1" }));

        expect((await projectStore.listSections("project-1")).map((s) => s.id)).toEqual(["a"]);
        expect(await projectStore.getSection("a")).toMatchObject({ id: "a" });
      });

      it("refuses an empty or whitespace-only name", async () => {
        await expect(
          projectStore.addSection(section({ id: "a", projectId: "project-1", name: "" })),
        ).rejects.toThrow();
      });

      it("refuses a projectId that isn't a live Project", async () => {
        await expect(
          projectStore.addSection(section({ id: "a", projectId: "never-seen" })),
        ).rejects.toThrow();
      });

      // The twenty-section cap (CONTEXT.md's Section entry, issue #171's
      // acceptance criteria) — made a property of the store, not a
      // trusted caller check (CLAUDE.md's brief).
      it(`refuses a ${MAX_SECTIONS_PER_PROJECT + 1}th Section in the same Project`, async () => {
        for (let i = 0; i < MAX_SECTIONS_PER_PROJECT; i++) {
          await projectStore.addSection(
            section({ id: `section-${i}`, projectId: "project-1", orderKey: `k${i}` }),
          );
        }

        await expect(
          projectStore.addSection(section({ id: "one-too-many", projectId: "project-1" })),
        ).rejects.toThrow();
        expect(await projectStore.listSections("project-1")).toHaveLength(MAX_SECTIONS_PER_PROJECT);
      });

      it("does not count a Section in a different Project against the cap", async () => {
        await projectStore.upsertProjects([project({ id: "project-2", seq: 1 })]);
        for (let i = 0; i < MAX_SECTIONS_PER_PROJECT; i++) {
          await projectStore.addSection(
            section({ id: `section-${i}`, projectId: "project-1", orderKey: `k${i}` }),
          );
        }

        await expect(
          projectStore.addSection(section({ id: "elsewhere", projectId: "project-2" })),
        ).resolves.toBeUndefined();
      });
    });

    // Sync's write path (issue #182) — mirrors ProjectStore's own
    // upsertProjects contract: wholesale insert-or-update, no validation,
    // unlike addSection.
    describe("upsertSections()", () => {
      it("creates a Section reachable from listSections()/getSection(), bypassing the twenty-cap check", async () => {
        for (let i = 0; i < MAX_SECTIONS_PER_PROJECT; i++) {
          await projectStore.addSection(
            section({ id: `section-${i}`, projectId: "project-1", orderKey: `k${i}` }),
          );
        }

        // Sync must never refuse a row another Device already committed —
        // addSection's own doc comment on why this check can't live here.
        await projectStore.upsertSections([
          section({ id: "one-more", projectId: "project-1", seq: 1 }),
        ]);

        expect(await projectStore.getSection("one-more")).toMatchObject({ id: "one-more" });
      });

      it("updates an existing Section's fields in place", async () => {
        await projectStore.addSection(
          section({ id: "a", projectId: "project-1", name: "original" }),
        );

        await projectStore.upsertSections([
          section({ id: "a", projectId: "project-1", name: "renamed by sync", seq: 7 }),
        ]);

        expect(await projectStore.getSection("a")).toMatchObject({
          name: "renamed by sync",
          seq: 7,
        });
      });
    });

    it("listSections() orders Sections by orderKey ascending, breaking ties by id, scoped to the Project", async () => {
      await projectStore.upsertProjects([project({ id: "project-2", seq: 1 })]);
      await projectStore.addSection(section({ id: "b", projectId: "project-1", orderKey: "b" }));
      await projectStore.addSection(section({ id: "a", projectId: "project-1", orderKey: "a" }));
      await projectStore.addSection(section({ id: "elsewhere", projectId: "project-2" }));

      expect((await projectStore.listSections("project-1")).map((s) => s.id)).toEqual(["a", "b"]);
    });

    it("renameSection() changes name and clears seq; refuses an empty name", async () => {
      await projectStore.addSection(
        section({ id: "a", projectId: "project-1", name: "original", seq: 5 }),
      );

      await projectStore.renameSection("a", "changed");
      expect(await projectStore.getSection("a")).toMatchObject({ name: "changed", seq: null });

      await expect(projectStore.renameSection("a", "")).rejects.toThrow();
    });

    // Issue #196 — see the identical Project-level test above.
    it("renameSection() stamps updatedAt with a fresh value", async () => {
      const original = section({ id: "a", projectId: "project-1", seq: 5 });
      await projectStore.addSection(original);

      await projectStore.renameSection("a", "changed");

      const found = await projectStore.getSection("a");
      expect((found?.updatedAt as string) > original.updatedAt).toBe(true);
    });

    it("setSectionDescription() changes description and clears seq, and null clears it back", async () => {
      await projectStore.addSection(section({ id: "a", projectId: "project-1", seq: 5 }));

      await projectStore.setSectionDescription("a", "cold aisle first");
      expect(await projectStore.getSection("a")).toMatchObject({
        description: "cold aisle first",
        seq: null,
      });

      await projectStore.setSectionDescription("a", null);
      expect(await projectStore.getSection("a")).toMatchObject({ description: null });
    });

    it("reorderSection() changes orderKey and clears seq", async () => {
      await projectStore.addSection(
        section({ id: "a", projectId: "project-1", orderKey: "m", seq: 5 }),
      );

      await projectStore.reorderSection("a", "b");

      expect(await projectStore.getSection("a")).toMatchObject({ orderKey: "b", seq: null });
    });

    describe("deleteSection() — destroys every Task inside, unrecoverably", () => {
      it("tombstones every Task directly in the Section, completed ones included", async () => {
        await projectStore.addSection(section({ id: "groceries", projectId: "project-1" }));
        await taskStore.upsert([
          task({ id: "active", sectionId: "groceries", seq: 1 }),
          task({ id: "done", sectionId: "groceries", seq: 1 }),
          task({ id: "elsewhere", sectionId: "other-section", seq: 1 }),
        ]);
        await taskStore.complete("done", "2026-01-05T00:00:00.000Z");

        await projectStore.deleteSection("groceries");

        expect(await taskStore.get("active")).toBeUndefined();
        expect(await taskStore.get("done")).toBeUndefined();
        expect(await taskStore.get("elsewhere")).toMatchObject({ deletedAt: null });
      });

      // "Destroys" is a tombstone, not a hard delete (ADR 0028's
      // resurrection trap) — the same seq-IS-NULL-pending() proof
      // taskStoreContract's own remove() case uses, checked here through
      // the cascade instead of a direct TaskStore.remove() call.
      it("tombstones, never hard-deletes, each Task it destroys", async () => {
        await projectStore.addSection(section({ id: "groceries", projectId: "project-1" }));
        await taskStore.upsert([task({ id: "a", content: "milk", sectionId: "groceries" })]);

        await projectStore.deleteSection("groceries");

        const pending = await taskStore.pending();
        expect(pending.map((t) => t.id)).toEqual(["a"]);
        expect(pending[0]?.deletedAt).not.toBeNull();
        expect(pending[0]?.content).toBe("");
      });

      // A sub-task's own sectionId is typically null (../task-types.ts) —
      // reached only by walking descendants of the Section's direct
      // members (TaskStore.listDescendants).
      it("reaches a sub-task nested under a Task the Section held, even though the sub-task's own sectionId is null", async () => {
        await projectStore.addSection(section({ id: "groceries", projectId: "project-1" }));
        await taskStore.upsert([
          task({ id: "parent", sectionId: "groceries", seq: 1 }),
          task({ id: "child", parentId: "parent", sectionId: null, seq: 1 }),
        ]);

        await projectStore.deleteSection("groceries");

        expect(await taskStore.get("child")).toBeUndefined();
      });

      it("tombstones the Section itself", async () => {
        await projectStore.addSection(section({ id: "groceries", projectId: "project-1" }));

        await projectStore.deleteSection("groceries");

        expect(await projectStore.getSection("groceries")).toBeUndefined();
        expect(await projectStore.listSections("project-1")).toEqual([]);
      });

      it("no-ops against an already-tombstoned Section", async () => {
        await projectStore.addSection(section({ id: "groceries", projectId: "project-1" }));
        await projectStore.deleteSection("groceries");

        await expect(projectStore.deleteSection("groceries")).resolves.toBeUndefined();
      });
    });

    describe("archiveSection() / unarchiveSection()", () => {
      it("marks every active Task in the Section completed and sets archived", async () => {
        await projectStore.addSection(section({ id: "groceries", projectId: "project-1" }));
        await taskStore.upsert([task({ id: "a", sectionId: "groceries", seq: 1 })]);

        await projectStore.archiveSection("groceries");

        expect(await taskStore.get("a")).toMatchObject({ completedAt: expect.any(String) });
        expect(await projectStore.getSection("groceries")).toMatchObject({ archived: true });
      });

      // Mirrors TaskStore.complete's own "only active children" rule —
      // an already-completed Task keeps its own honest completedAt.
      it("does not overwrite a Task that was already completed before archiving", async () => {
        await projectStore.addSection(section({ id: "groceries", projectId: "project-1" }));
        await taskStore.upsert([task({ id: "a", sectionId: "groceries", seq: 1 })]);
        await taskStore.complete("a", "2026-01-01T00:00:00.000Z");

        await projectStore.archiveSection("groceries");

        expect(await taskStore.get("a")).toMatchObject({ completedAt: "2026-01-01T00:00:00.000Z" });
      });

      it("reaches a sub-task nested under a Task the Section held", async () => {
        await projectStore.addSection(section({ id: "groceries", projectId: "project-1" }));
        await taskStore.upsert([
          task({ id: "parent", sectionId: "groceries", seq: 1 }),
          task({ id: "child", parentId: "parent", sectionId: null, seq: 1 }),
        ]);

        await projectStore.archiveSection("groceries");

        expect(await taskStore.get("child")).toMatchObject({ completedAt: expect.any(String) });
      });

      it("does not tombstone any Task — archiving is not deletion", async () => {
        await projectStore.addSection(section({ id: "groceries", projectId: "project-1" }));
        await taskStore.upsert([task({ id: "a", sectionId: "groceries", seq: 1 })]);

        await projectStore.archiveSection("groceries");

        expect(await taskStore.get("a")).toMatchObject({ deletedAt: null });
      });

      // Issue #171's acceptance criteria, verbatim: "unarchiving restores
      // the section with those tasks still completed."
      it("unarchiveSection() clears archived without uncompleting any Task", async () => {
        await projectStore.addSection(section({ id: "groceries", projectId: "project-1" }));
        await taskStore.upsert([task({ id: "a", sectionId: "groceries", seq: 1 })]);
        await projectStore.archiveSection("groceries");

        await projectStore.unarchiveSection("groceries");

        expect(await projectStore.getSection("groceries")).toMatchObject({ archived: false });
        expect(await taskStore.get("a")).toMatchObject({ completedAt: expect.any(String) });
      });

      it("both no-op against an already-tombstoned Section", async () => {
        await projectStore.addSection(section({ id: "groceries", projectId: "project-1" }));
        await projectStore.deleteSection("groceries");

        await expect(projectStore.archiveSection("groceries")).resolves.toBeUndefined();
        await expect(projectStore.unarchiveSection("groceries")).resolves.toBeUndefined();
        expect(await projectStore.getSection("groceries")).toBeUndefined();
      });
    });

    it("returns only Sections with a null sequence from pendingSections()", async () => {
      await projectStore.addSection(section({ id: "unsynced", projectId: "project-1", seq: null }));
      await projectStore.addSection(
        section({ id: "synced", projectId: "project-1", orderKey: "z", seq: 42 }),
      );

      expect((await projectStore.pendingSections()).map((s) => s.id)).toEqual(["unsynced"]);
    });

    it("starts the Section cursor at 0 and reflects whatever it's set to", async () => {
      expect(await projectStore.getSectionCursor()).toBe(0);

      await projectStore.setSectionCursor(7);

      expect(await projectStore.getSectionCursor()).toBe(7);
    });

    // The Section-shaped sibling of the Project describe block above.
    describe("catchUpSectionRowShapeEpoch", () => {
      it("does nothing for a Device that has never synced this stream", async () => {
        expect(await projectStore.getSectionCursor()).toBe(0);

        await projectStore.catchUpSectionRowShapeEpoch(1);

        expect(await projectStore.getSectionCursor()).toBe(0);
      });

      it("resets an already-advanced Cursor to 0 the first time it sees a higher epoch", async () => {
        await projectStore.setSectionCursor(50);

        await projectStore.catchUpSectionRowShapeEpoch(1);

        expect(await projectStore.getSectionCursor()).toBe(0);
      });

      it("is idempotent: catching up to the same epoch again does not reset a Cursor that has since advanced", async () => {
        await projectStore.catchUpSectionRowShapeEpoch(1);
        await projectStore.setSectionCursor(50);

        await projectStore.catchUpSectionRowShapeEpoch(1);

        expect(await projectStore.getSectionCursor()).toBe(50);
      });

      it("does not reset when asked to catch up to an epoch no higher than one already recorded", async () => {
        await projectStore.catchUpSectionRowShapeEpoch(2);
        await projectStore.setSectionCursor(50);

        await projectStore.catchUpSectionRowShapeEpoch(1);

        expect(await projectStore.getSectionCursor()).toBe(50);
      });
    });
  });
}
