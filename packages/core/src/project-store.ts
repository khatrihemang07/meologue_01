import type { Project, Section } from "./project-types";

/**
 * The Project-and-Section-shaped sibling of LabelStore (./label-store.ts)
 * and TaskStore (./task-store.ts) — a third (and fourth) store interface
 * beside them, not a widening of either (ADR 0047's reasoning for a
 * second store applies again: neither existing store's method names are
 * shaped for a container that nests and holds a flat sub-collection of
 * its own).
 *
 * **Section is folded into this interface rather than getting a
 * `SectionStore` of its own — the decision issue #171 asks this file to
 * justify.** Three things about this codebase, not merely taste, decide
 * it:
 *
 * 1. *A Section cannot exist without a Project.* Unlike Label (which
 *    stands alone) or even Task (which can exist unfiled, in Inbox),
 *    `Section.projectId` is required and non-null (../project-types.ts) —
 *    there is no Section that isn't already "a Project's Section." A
 *    store named for the thing that can't exist independently of the
 *    other is a store for a sub-resource, not a second root noun the way
 *    ADR 0047 argued Task was against Entry.
 * 2. *./sqlite/open.ts's own header comment* already states the cost of
 *    an additive top-level field on `OpenedSqliteStore`: cheap, but not
 *    free — every caller that destructures that object gains one more
 *    name to know about. `taskStore` and `labelStore` each earned that
 *    cost because each is a real second/third root noun. A `sectionStore`
 *    alongside `projectStore` would be the *fourth* additive field for a
 *    concept that, per point 1, is never used except through a Project.
 * 3. *deleteSection() and archiveSection() below need to reach into
 *    TaskStore* — "deleting a Section destroys every Task inside it" and
 *    "archiving marks them all completed" (issue #171's acceptance
 *    criteria) aren't Section-only operations. Whichever store owns
 *    Section already has to be handed a `TaskStore` collaborator (see this
 *    interface's implementations, which take one in their constructor) to
 *    make that cascade a property of the store instead of a sequence of
 *    calls a caller is trusted to get right and in the right order
 *    (CLAUDE.md's brief: "make it a property of the store that a test can
 *    prove"). Splitting Section into its own store would only mean *two*
 *    stores now need that same TaskStore collaborator, for the identical
 *    operations, with no benefit — Project's own archive/delete never
 *    touch Tasks (Project.archived's own doc comment), so there is no
 *    symmetry being broken by folding Section in beside it.
 *
 * **Inbox is never reachable through any method below.** There is no
 * `Project` row for Inbox (../project-types.ts's own header comment), so
 * `removeProject`/`archiveProject`/every other Project mutator here is
 * structurally unable to target it — not because a caller is expected to
 * avoid passing Inbox's id, but because Inbox has no id to pass. That is
 * what "Inbox cannot be deleted or archived, enforced where it cannot be
 * bypassed" (issue #171) means at this layer: there is no bypass to guard
 * against, by construction.
 *
 * There is deliberately no `add` for either Project or the ordinary path
 * into Section: a new Project is `upsertProjects([project])`, the same
 * door a future Sync round trip would use, mirroring Label and Task. A new
 * *Section* is the one exception — see addSection's own doc comment for
 * why the twenty-section cap (an invariant issue #171 calls out by name as
 * one that must be a store property, not a trusted caller check) forces a
 * validated creation door here that upsertSection's own trusted-bulk-merge
 * semantics could never give it.
 */
export interface ProjectStore {
  /**
   * Every Project that isn't tombstoned, flat regardless of nesting,
   * ordered by (orderKey, id) ascending — a global order across every
   * `parentId` group at once, which only means something once the caller
   * regroups by `parentId` and re-sorts within each group (this store
   * imposes no cross-group ordering, the identical caveat Task's own
   * `orderKey` carries once Tasks are grouped, e.g. by Section). Kept
   * flat and unfiltered by `archived` for the same reason Label.list()
   * doesn't need an "active vs archived" split of its own (../label-
   * store.ts): a personal Project list is small, and a caller wanting
   * only unarchived Projects filters on the `archived` field it already
   * has rather than this store growing a second query shaped for one
   * caller's screen.
   */
  listProjects(): Promise<Project[]>;
  /** One Project by id, or undefined if unknown or tombstoned. */
  getProject(id: string): Promise<Project | undefined>;
  /** Sync's write path: upsert wholesale, exactly as LabelStore.upsert/TaskStore.upsert do. No validation — see this interface's own header comment on why creation goes through here unchecked and mutation goes through the setters below instead, mirroring Label's identical asymmetry. */
  upsertProjects(projects: Project[]): Promise<void>;
  /** Changes `name` and clears `seq`. Refuses (throws) an empty name — ./project-fields.ts's assertValidProjectName. No-op against a tombstone. */
  renameProject(id: string, name: string): Promise<void>;
  /** Changes `colour` and clears `seq`. Refuses (throws) a hex outside label-colors.ts's current palette — ./project-fields.ts's assertValidProjectColour. No-op against a tombstone. */
  setProjectColour(id: string, colour: string): Promise<void>;
  /** Changes `description` and clears `seq`. `null` clears it back to "no description." No-op against a tombstone. */
  setProjectDescription(id: string, description: string | null): Promise<void>;
  /** Changes `favourite` and clears `seq`. No-op against a tombstone. */
  setProjectFavourite(id: string, favourite: boolean): Promise<void>;
  /**
   * Sets `archived` to `true` and clears `seq`. Touches nothing beyond
   * this one Project's own row — see Project.archived's own doc comment
   * for why this deliberately does *not* cascade to this Project's Tasks
   * or Sections the way archiveSection below does. No-op against a
   * tombstone, and — by construction, not by a check here — never
   * reachable for Inbox (this interface's own header comment).
   */
  archiveProject(id: string): Promise<void>;
  /** The inverse of archiveProject — sets `archived` to `false`, clears `seq`. No-op against a tombstone. */
  unarchiveProject(id: string): Promise<void>;
  /**
   * Changes `parentId` and clears `seq` — moves a Project to nest under
   * another, or to `null` for top-level. Refuses (throws) `parentId ===
   * id` and refuses a `parentId` that is already a descendant of `id`
   * (walking the target's own ancestor chain first — the same shape
   * TaskStore.setParent's cycle guard uses, minus the four-level cap
   * neither this ticket nor CONTEXT.md's Project entry asks a Project to
   * have). No-op against a tombstone.
   */
  setProjectParent(id: string, parentId: string | null): Promise<void>;
  /**
   * Changes `orderKey` and clears `seq`. Writes exactly one row — the
   * identical fractional-indexing guarantee TaskStore.reorder's own doc
   * comment describes (ADR 0050), reused rather than reinvented. No-op
   * against a tombstone.
   */
  reorderProject(id: string, orderKey: string): Promise<void>;
  /**
   * Tombstone, never a hard delete (ADR 0028's rule, applied a fourth
   * time). Deliberately does **not** cascade to this Project's Tasks or
   * Sections — nothing in issue #171 asks removing a Project to destroy
   * its contents the way deleteSection does, and CLAUDE.md's brief warns
   * against inventing behaviour nobody asked for. A Task or Section left
   * pointing at a removed Project's id is the same accepted, transient
   * dangling-reference state ../task-types.ts's `labelIds` doc comment
   * names for the identical reason: cleaning it up would need a cross-
   * store write with the non-atomicity problem this codebase's stores are
   * built to avoid (../order-key.ts's header comment), for a case a
   * reading layer can already treat as "no live Project" safely.
   */
  removeProject(id: string): Promise<void>;
  /** Projects with no sequence number, tombstones included — exactly `seq IS NULL`, mirroring LabelStore.pending(). */
  pendingProjects(): Promise<Project[]>;
  getProjectCursor(): Promise<number>;
  setProjectCursor(seq: number): Promise<void>;
  /**
   * Issue #186 / ADR 0057 — see `EntryStore.catchUpRowShapeEpoch`'s own
   * doc comment (./store.ts) for the mechanism; `currentEpoch` here is
   * `protocol.ts`'s `ROW_SHAPE_EPOCH.projects`, tracked independently of
   * `catchUpSectionRowShapeEpoch` below even though both live on this one
   * store — Projects and Sections are two Sync streams with two Cursors
   * (`getProjectCursor`/`getSectionCursor` above), so they earn two
   * independent epoch watermarks for the identical reason.
   */
  catchUpProjectRowShapeEpoch(currentEpoch: number): Promise<void>;

  /** Every Section (any `archived` state) belonging to `projectId` that isn't tombstoned, ordered by (orderKey, id) ascending — Sections are flat (../project-types.ts), so unlike listProjects() this is already the caller's whole rendering order, no client-side regrouping needed. */
  listSections(projectId: string): Promise<Section[]>;
  /** One Section by id, or undefined if unknown or tombstoned. */
  getSection(id: string): Promise<Section | undefined>;
  /**
   * Creates a new *local* Section — deliberately the only *validated*
   * creation door for one (this interface's own header comment explains
   * the general rule every other store's `upsert` follows instead). The
   * twenty-section cap (issue #171's acceptance criteria) is checked here,
   * against the *current* live-Section count for `section.projectId`, and
   * refused (thrown) if it's already at twenty. That check can only live
   * in a validated, local-only creation path: `upsertSections` below, the
   * trusted-bulk-merge Sync's pull now uses (issue #182), must never
   * refuse a row arriving from another Device — refusing there would
   * silently drop data another Device already committed, diverging the
   * two Devices instead of converging them (../order-key.ts's own header
   * comment makes the identical argument about why validation stays out
   * of upsert paths generally). A Device could in principle reach 21+
   * Sections in one Project this way — Device A and Device B each add a
   * twentieth Section while offline from each other — and that is accepted
   * as the same kind of momentary over-cap issue #171's own cap already
   * lives with locally (nothing here rolls one back once Sync reveals it).
   * Refuses (throws) an empty name (./project-fields.ts's
   * assertValidSectionName) and a `projectId` that isn't a live Project.
   */
  addSection(section: Section): Promise<void>;
  /**
   * Sync's write path for Sections (issue #182) — upsert wholesale,
   * mirroring upsertProjects above exactly: no validation, no twenty-cap
   * check (addSection's own doc comment explains why that check cannot
   * live here). Not the door a local Section creation goes through —
   * addSection is — the same asymmetry every other bulk `upsert` beside a
   * validated creation door in this codebase already has.
   */
  upsertSections(sections: Section[]): Promise<void>;
  /** Changes `name` and clears `seq`. Refuses (throws) an empty name. No-op against a tombstone. */
  renameSection(id: string, name: string): Promise<void>;
  /** Changes `description` and clears `seq`. `null` clears it. No-op against a tombstone. */
  setSectionDescription(id: string, description: string | null): Promise<void>;
  /** Changes `orderKey` and clears `seq`. Writes exactly one row, mirroring reorderProject/TaskStore.reorder. No-op against a tombstone. */
  reorderSection(id: string, orderKey: string): Promise<void>;
  /**
   * **Destroys every Task inside this Section, completed ones included,
   * unrecoverably** (issue #171's acceptance criteria) — "unrecoverably"
   * describes what the *reader* experiences, not the row-level mechanics:
   * every Task is tombstoned via TaskStore.remove(), never hard-deleted.
   * ADR 0028's resurrection trap (a hard-deleted row with `seq IS NULL`
   * can come back from a stale Sync response — see
   * ../test-support/task-store-contract.ts's own most-important case) is
   * exactly why. "Destroys" and "tombstones, never hard-deletes" are not
   * in tension: from this method's caller's side, a tombstoned Task is
   * gone — it leaves list(), listCompleted(), get() and search() alike
   * (TaskStore.remove's own doc comment) — the tombstone exists purely so
   * a *Sync response this Device hasn't seen yet* can't resurrect it, not
   * so the reader has any way back in.
   *
   * Reaches every descendant, not only the Tasks whose own `sectionId`
   * names this Section: TaskStore.listInSection() finds the direct
   * members (top-level and completed alike), and TaskStore.listDescendants()
   * is walked from each one so a sub-task nested under a Task this Section
   * held is destroyed too, even though a sub-task's own `sectionId` is
   * typically left `null` (../task-types.ts) rather than mirroring its
   * parent's — see listDescendants' own doc comment for why "a Task whose
   * ancestor was in this Section" still counts as "in it" for this
   * purpose. Then the Section itself is tombstoned. No-op against an
   * already-tombstoned Section.
   */
  deleteSection(id: string): Promise<void>;
  /**
   * Marks every Task inside this Section completed and sets `archived` on
   * the Section itself — the far gentler sibling of deleteSection above:
   * nothing is tombstoned, every Task and every Sub-task remains exactly
   * where it was, just completed. Reaches the same set deleteSection does
   * (direct members plus every descendant), but only actually completes
   * the ones that are still active — an already-completed Task keeps
   * whatever `completedAt` it earned honestly, mirroring
   * TaskStore.complete's own "only active children" cascade rule and for
   * the identical reason (../task-store.ts's complete() doc comment). No-op
   * against an already-tombstoned Section.
   */
  archiveSection(id: string): Promise<void>;
  /**
   * The inverse of archiveSection — clears `archived` on the Section and
   * touches nothing else. Issue #171's acceptance criteria is explicit
   * that this does **not** uncomplete any Task: "unarchiving restores the
   * Section with those Tasks still completed." No-op against an already-
   * tombstoned Section.
   */
  unarchiveSection(id: string): Promise<void>;
  /** Sections with no sequence number, tombstones included — exactly `seq IS NULL`, mirroring pendingProjects(). */
  pendingSections(): Promise<Section[]>;
  getSectionCursor(): Promise<number>;
  setSectionCursor(seq: number): Promise<void>;
  /**
   * The Section-shaped sibling of `catchUpProjectRowShapeEpoch` above —
   * `currentEpoch` here is `protocol.ts`'s `ROW_SHAPE_EPOCH.sections`,
   * its own independent watermark.
   */
  catchUpSectionRowShapeEpoch(currentEpoch: number): Promise<void>;
}
