/**
 * A named container a Task can live in, and Projects nest (CONTEXT.md's
 * Project entry, issue #171). Structurally this mirrors `Label`
 * (./label-types.ts) for the identical reason that file's own header
 * comment gives for mirroring `Task`: `deviceId`, `createdAt`, `seq`,
 * `syncedAt`, `deletedAt` are the same sync-and-tombstone scaffolding
 * every root-ish store in this codebase carries (ADR 0028's rule, applied
 * a fourth time), even though nothing in this ticket wires a Project sync
 * stream up to the wire protocol or the server. Starting with that
 * scaffolding costs nothing today and avoids a later migration-plus-
 * backfill the day a real sync stream lands — see label-store.ts's own
 * header comment for the fuller argument, made once there rather than
 * repeated at length here.
 *
 * **Inbox is not a row here.** CONTEXT.md's Inbox entry: "Inbox is not a
 * container the way a Project is — it names the absence of one." There is
 * deliberately no Inbox `Project` with a sentinel id, no
 * `isInbox: boolean` flag, nothing at all: a Task with `projectId: null`
 * (../task-types.ts) is in Inbox, full stop. This is also what makes "Inbox
 * cannot be deleted or archived" (issue #171's acceptance criteria) true
 * as a structural property rather than a rule some caller has to remember
 * to check — see ./project-store.ts's own header comment for why every
 * method that could delete or archive a Project is unreachable for Inbox,
 * not merely refused if reached.
 */
export type Project = {
  id: string;
  deviceId: string;
  /** What the user typed as the Project's name. Refused empty by ./project-fields.ts's assertValidProjectName — a Project with no name isn't a lesser Project, it's not a Project, mirroring Label's identical rule. */
  name: string;
  /**
   * One of label-colors.ts's twenty current palette hexes — that module's
   * own header comment already names this table by name ("Todoist's
   * current **label/project/filter** palette"): Projects, Labels and
   * Filters share one palette in Todoist, so this reuses LABEL_COLOURS
   * rather than this file inventing a second, identically-shaped one.
   * Stored as the hex itself, not the palette's numeric `id`, for the same
   * "no join just to answer 'what colour is this'" reason Label.colour's
   * own doc comment gives.
   */
  colour: string;
  /** Starred in the sidebar, ahead of an unstarred Project — a plain flag, not a timestamp: unlike Task.completedAt, nothing here ever needs to know *when* a Project was favourited. */
  favourite: boolean;
  /**
   * Archived Projects are hidden from the working list but not gone —
   * a plain flag, not a tombstone (`deletedAt` below is the tombstone).
   * Deliberately carries **no cascading effect on this Project's own Tasks
   * or Sections** — contrast Section's `archived` (./project-store.ts's
   * archiveSection doc comment), which completes every Task inside it.
   * Nothing in issue #171's acceptance criteria asks a Project's archive
   * to touch its contents the way a Section's does, and inventing that
   * symmetry here would be exactly the kind of behaviour CLAUDE.md's brief
   * warns against adding unasked.
   */
  archived: boolean;
  /** The Project this one nests under, or `null` for a top-level Project (CONTEXT.md: "Projects nest, so a Project can hold other Projects as well as Tasks"). No depth cap — unlike a sub-task's four levels (../task-types.ts), nothing in this ticket asks for one on Project nesting. */
  parentId: string | null;
  /** Optional free text (issue #171's acceptance criteria: "Projects and sections carry an optional description"). `null`, not `""`, for "no description" — an empty string would be a second way to say the same thing. */
  description: string | null;
  /** Fractional index (../order-key.ts) among sibling Projects sharing the same `parentId` — reused exactly as Task's own `orderKey` is, per issue #171's instruction not to invent a second ordering primitive. */
  orderKey: string;
  createdAt: string;
  /** Issue #196 — see Task.updatedAt's own doc comment (../task-types.ts) for the mechanism and reasoning, applied here unchanged. */
  updatedAt: string;
  seq: number | null;
  syncedAt: string | null;
  /** Tombstone (ADR 0028's rule, applied to Projects). */
  deletedAt: string | null;
};

/**
 * A flat division inside a Project (CONTEXT.md's Section entry) — never
 * inside Inbox, which is why `projectId` below is required and non-null,
 * unlike every `*Id` field on `Task` (../task-types.ts) that can point at
 * Inbox by being `null`. See ./project-store.ts's own header comment for
 * why `Section` is folded into `ProjectStore` rather than getting a store
 * of its own.
 */
export type Section = {
  id: string;
  deviceId: string;
  /** The Project this Section belongs to — always a real Project, never Inbox (CONTEXT.md's Section entry: "A flat division inside a Project"). Sections never nest and never move between Projects; there is no `setSectionProject`. */
  projectId: string;
  /** Refused empty by ./project-fields.ts's assertValidSectionName, mirroring Project.name and Label.name. */
  name: string;
  /** Optional free text, mirroring Project.description's own doc comment. */
  description: string | null;
  /**
   * Fractional index among sibling Sections sharing the same `projectId`
   * — Sections are flat (CONTEXT.md), so unlike Project and Task there is
   * only ever one sibling group per Project, never a tree of them.
   */
  orderKey: string;
  /**
   * Archiving a Section marks every Task inside it completed and keeps
   * them that way; unarchiving flips this back without touching a single
   * Task (issue #171's acceptance criteria) — see
   * ./project-store.ts's archiveSection/unarchiveSection for the
   * mechanics and ./project-store.ts's deleteSection for the sibling
   * operation with the far larger blast radius this flag deliberately
   * does *not* have.
   */
  archived: boolean;
  createdAt: string;
  /** Issue #196 — see Task.updatedAt's own doc comment (../task-types.ts) for the mechanism and reasoning, applied here unchanged. */
  updatedAt: string;
  seq: number | null;
  syncedAt: string | null;
  /**
   * Tombstone (ADR 0028's rule, applied to Sections). **Not** what
   * "deleting a Section destroys every Task inside it" means — that's a
   * property of every one of those Tasks' own `deletedAt`
   * (../task-types.ts), set by ./project-store.ts's deleteSection calling
   * through to TaskStore.remove() for each one. This field only ever
   * records whether the *Section itself* is gone; see deleteSection's own
   * doc comment for why "destroys" reads like a hard delete and isn't
   * one, for the Section or for any Task it contained.
   */
  deletedAt: string | null;
};
