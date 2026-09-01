import { DEFAULT_LABEL_COLOUR, isValidLabelColour } from "./label-colors";
import type { Project, Section } from "./project-types";

/**
 * Validation and defaulting for Project and Section's own fields — the
 * Project/Section-shaped sibling of task-fields.ts and label-fields.ts,
 * called from every ProjectStore implementation's setter rather than
 * re-derived by each, for the identical reason those two modules' own
 * header comments give: a rule checked in only one implementation is a
 * rule the shared contract suite
 * (test-support/project-store-contract.ts) would never catch the other
 * implementation getting wrong.
 */

/** Throws on an empty or whitespace-only name, mirroring label-fields.ts's assertValidLabelName. */
export function assertValidProjectName(name: string): void {
  if (name.trim() === "") {
    throw new Error("project name must not be empty");
  }
}

/** Throws on an empty or whitespace-only name, mirroring assertValidProjectName above. */
export function assertValidSectionName(name: string): void {
  if (name.trim() === "") {
    throw new Error("section name must not be empty");
  }
}

/** Throws unless `colour` is one of label-colors.ts's twenty current palette values — see Project.colour's own doc comment for why a Project reuses that palette rather than its own. */
export function assertValidProjectColour(colour: string): void {
  if (!isValidLabelColour(colour)) {
    throw new Error(
      `colour must be one of LABEL_COLOURS' current palette, got ${JSON.stringify(colour)}`,
    );
  }
}

/**
 * Fills in the fields an incoming Project can sensibly default — mirrors
 * label-fields.ts's withDefaultLabelColour, extended to every field on
 * Project besides `id`/`deviceId`/`name`/`orderKey`/`createdAt`, none of
 * which has a default worth inventing (an omitted `name` or `orderKey` is
 * a caller bug, not a gap to paper over, the identical reasoning
 * label-fields.ts gives for never defaulting `Label.name`). This exists
 * purely as the safety net for a Project arriving over Sync from a Device
 * on an older build whose JSON has no such key, once a sync stream for
 * Projects exists at all — every local caller states these explicitly
 * (../task-types.ts's own doc comment on `priority` makes the identical
 * argument for why Project's fields aren't `?`-optional despite this
 * defaulter existing).
 */
export function withDefaultProjectFields(p: Project): Project {
  return {
    ...p,
    colour: p.colour ?? DEFAULT_LABEL_COLOUR,
    favourite: p.favourite ?? false,
    archived: p.archived ?? false,
    parentId: p.parentId ?? null,
    description: p.description ?? null,
  };
}

/**
 * Fills in the fields an incoming Section can sensibly default — mirrors
 * withDefaultProjectFields above. `projectId` is deliberately excluded:
 * unlike Project's fields, there is no sensible default for "which
 * Project does this belong to" (Section.projectId's own doc comment
 * explains why it can't fall back to Inbox the way Task.projectId does).
 */
export function withDefaultSectionFields(s: Section): Section {
  return {
    ...s,
    description: s.description ?? null,
    archived: s.archived ?? false,
  };
}

/**
 * A Project may hold at most this many live Sections (CONTEXT.md's Section
 * entry, issue #171's acceptance criteria). Exported so both
 * ProjectStore implementations' addSection() check against the identical
 * number rather than each hard-coding `20`, mirroring
 * ../task-fields.ts's MAX_TASK_NESTING_DEPTH.
 */
export const MAX_SECTIONS_PER_PROJECT = 20;

/**
 * Throws if a Project already holding `currentLiveCount` Sections would
 * exceed MAX_SECTIONS_PER_PROJECT by gaining one more. Only ever called
 * from ./project-store.ts's addSection() — see that method's own doc
 * comment for why this check lives in a validated creation door rather
 * than the trusted-bulk-merge `upsertProjects`-shaped path every other
 * creation door in this codebase takes.
 */
export function assertSectionCapNotExceeded(currentLiveCount: number): void {
  if (currentLiveCount >= MAX_SECTIONS_PER_PROJECT) {
    throw new Error(`a Project may hold at most ${MAX_SECTIONS_PER_PROJECT} Sections`);
  }
}
