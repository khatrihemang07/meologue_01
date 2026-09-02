import { compareByOrder } from "../order-key";
import type { Project } from "../project-types";
import { type Task, uiPriorityOf } from "../task-types";
import { toLocalParts } from "./offset";

export interface TasksFile {
  /** tasks.txt, relative to the zip root. */
  path: string;
  contents: string;
}

const TASKS_FILE_PATH = "tasks.txt";

/**
 * The readable half of Export's Task coverage (issue #175) — manifest.ts's
 * `ExportManifestTask` is the lossless copy ADR 0016 requires, and this is
 * the other leg: "a backup that quietly omits things is worse than none"
 * is only half-answered by a manifest a human has to open a JSON viewer to
 * read. day-file.ts groups Entries by local day because a day is the
 * natural unit an Entry belongs to; a Task has no natural day (it may be
 * undated altogether — task-types.ts's own `date` doc comment), so this
 * groups by Project instead — the unit Todo itself organises Tasks by.
 *
 * **One file, not one per Project (contrast day-file.ts's one-file-per-day
 * split).** A day file is split because a body can be arbitrarily long and
 * a year of Entries concatenated into one file would bury the day boundary
 * a reader actually wants; a rendered Task line is always one short line,
 * so a personal Task list — Todoist's own scale, not a team's — reads more
 * like one document with section headings than a directory of near-empty
 * files. Grouping still happens; it just happens inside the one file
 * rather than across the zip's own directory structure.
 *
 * Both active and completed Tasks are included, unlike Todo's own
 * `TaskStore.list()` (active only) — a backup is a record of what the user
 * did as much as what they still mean to do, and a completed Task quietly
 * absent from the one human-readable Task listing would be exactly the
 * "silently omits things" failure this file exists to avoid.
 */
export function renderTasksFile(
  tasks: Task[],
  projects: Project[],
  utcOffsetMinutes: number,
): TasksFile {
  if (tasks.length === 0) {
    // Written even when there are nothing to list, the same reasoning
    // export-zip.ts gives for always emitting tasks.txt at all (as opposed
    // to day-file.ts's own "no files for no Entries"): a reader seeing no
    // tasks.txt at all in an old export can't tell "this export predates
    // Tasks" from "this export has none" — an explicit, short file answers
    // that without needing manifest.json open alongside it.
    return { path: TASKS_FILE_PATH, contents: "No Tasks.\n" };
  }

  const nameByProjectId = new Map(projects.map((project) => [project.id, project.name] as const));
  const byProjectId = new Map<string | null, Task[]>();
  for (const task of tasks) {
    const bucket = byProjectId.get(task.projectId);
    if (bucket) {
      bucket.push(task);
    } else {
      byProjectId.set(task.projectId, [task]);
    }
  }

  const sections = sortedProjectKeys(byProjectId, nameByProjectId).map((projectId) => {
    const heading = headingFor(projectId, nameByProjectId);
    const lines = sortForDisplay(byProjectId.get(projectId) ?? []).map((task) =>
      renderTaskLine(task, utcOffsetMinutes),
    );
    return [`# ${heading}`, "", ...lines].join("\n");
  });

  return { path: TASKS_FILE_PATH, contents: `${sections.join("\n\n")}\n` };
}

/**
 * Inbox (`projectId === null`) always leads — project-types.ts's own rule
 * that Inbox "names the absence of" a Project rather than being one means
 * it has no `name` to sort alphabetically against, and Todoist's own
 * convention (and every other Todo view in this app) already puts it
 * first rather than wherever "" would happen to collate. Named Projects
 * then sort by name, not by their own `orderKey` — `orderKey` is a sidebar
 * position, meaningful only inside the live app's own UI, not a fact
 * worth preserving in a plain-text backup a reader scans top to bottom;
 * alphabetical is what makes a specific Project findable in this file
 * without already knowing where it sits in the sidebar.
 */
function sortedProjectKeys(
  byProjectId: Map<string | null, Task[]>,
  nameByProjectId: Map<string, string>,
): (string | null)[] {
  return [...byProjectId.keys()].sort((a, b) => {
    if (a === b) {
      return 0;
    }
    if (a === null) {
      return -1;
    }
    if (b === null) {
      return 1;
    }
    const nameA = nameByProjectId.get(a) ?? a;
    const nameB = nameByProjectId.get(b) ?? b;
    return nameA.localeCompare(nameB) || a.localeCompare(b);
  });
}

/**
 * A Task's `projectId` can name a Project this export's own `projects`
 * list doesn't resolve — the identical "an unresolved reference degrades
 * to itself, honestly" rule ADR 0051 gives a Task arriving over Sync with
 * a dangling `projectId`, applied here to a local read instead of a wire
 * arrival. Rather than silently folding those Tasks into Inbox (which
 * would assert something false — this Task *does* name a Project, the
 * export just can't say which), they get their own honestly-labelled
 * section naming the id.
 */
function headingFor(projectId: string | null, nameByProjectId: Map<string, string>): string {
  if (projectId === null) {
    return "Inbox";
  }
  return nameByProjectId.get(projectId) ?? `Unresolved Project (${projectId})`;
}

/**
 * Active Tasks first, in the same (orderKey, id) order Todo's own
 * `TaskStore.list()` returns them in — `compareByOrder` (order-key.ts) is
 * shared with the live app rather than re-derived, so this file's reading
 * order matches what a reader already saw in Todo, not some independent
 * ordering invented for export. Completed Tasks follow, newest completion
 * first with an id-descending tie-break, mirroring `TaskStore.
 * listCompleted()`'s own documented order exactly (that method's own doc
 * comment: "the same time-ordered id, so an ascending tie-break would
 * misorder a same-millisecond pair" reasoning EntryStore.list gives).
 */
function sortForDisplay(tasks: Task[]): Task[] {
  const active = tasks.filter((task) => task.completedAt === null).sort(compareByOrder);
  const completed = tasks
    .filter((task): task is Task & { completedAt: string } => task.completedAt !== null)
    .sort((a, b) => {
      if (a.completedAt !== b.completedAt) {
        return a.completedAt < b.completedAt ? 1 : -1;
      }
      return a.id === b.id ? 0 : a.id < b.id ? 1 : -1;
    });
  return [...active, ...completed];
}

function renderTaskLine(task: Task, utcOffsetMinutes: number): string {
  const marker = task.completedAt === null ? "[ ]" : "[x]";
  const meta = describeMeta(task, utcOffsetMinutes);
  return meta === "" ? `- ${marker} ${task.content}` : `- ${marker} ${task.content} (${meta})`;
}

/**
 * `date`/`deadline`/`dateString` are rendered exactly as stored — they're
 * floating (task-types.ts's own `date` doc comment: "no `Z`, no offset,
 * ever"), so applying `utcOffsetMinutes` to them would misrepresent a
 * plan as an instant it never was. `completedAt`, by contrast, is a real
 * UTC timestamp (the same encoding `Entry.createdAt` uses), so it goes
 * through `toLocalParts` exactly as day-file.ts's own Entry timestamps
 * do — a reader's own local completion date, not the exporting Device's
 * arbitrary UTC one.
 */
function describeMeta(task: Task, utcOffsetMinutes: number): string {
  const parts: string[] = [];
  if (task.priority > 1) {
    parts.push(`p${uiPriorityOf(task.priority)}`);
  }
  if (task.date !== null) {
    parts.push(`due ${task.date}`);
  }
  if (task.deadline !== null) {
    parts.push(`deadline ${task.deadline}`);
  }
  if (task.dateString !== null) {
    parts.push(task.dateString);
  }
  if (task.completedAt !== null) {
    const { date } = toLocalParts(task.completedAt, utcOffsetMinutes);
    parts.push(`completed ${date}`);
  }
  return parts.join(", ");
}
