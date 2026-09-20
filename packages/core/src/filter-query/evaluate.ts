import type { Label } from "../label-types";
import type { Project, Section } from "../project-types";
import { addDays } from "../quick-add/date-math";
import { normalize } from "../task-search";
import type { Task } from "../task-types";
import { effectiveDateKey } from "../task-views";
import type { FilterNode, ParsedFilterQuery } from "./types";

/**
 * Matches a parsed Filter query against a Task list — the evaluator half
 * of ADR 0058, the sibling of ./parser.ts (which only builds the tree,
 * never asks what it matches). Platform-free and a plain function over
 * plain arrays, exactly like ../task-views.ts's `today()`: "a Task list
 * this app's whole personal scale fits in memory" needs no query SQLite
 * can answer faster than a JS filter, and a pure function is trivially
 * unit-testable with fixtures — no store, no driver, nothing to keep two
 * implementations of this in sync the way `TaskStore.list()`'s own
 * ordering guarantee exists to avoid.
 *
 * **Criterion 4, and what became of it.** A `date` predicate
 * (`date:2026-09-10`) names that one field explicitly — the criterion 3
 * case, "a query can name a date." A `today`/`tomorrow`/`overdue` flag is
 * a different question — "what is due" — which this module answers with
 * `effectiveDateKey` (../task-views.ts), reused here rather than
 * reimplemented. Criterion 4 originally spelled out a rule for a Task
 * carrying *both* a Date and a Deadline ("considers both... preferring
 * the Date"); issue #375 stopped `effectiveDateKey` reading `deadline` at
 * all (D12: Deadline is Pro-gated in Todoist and 0 Tasks carry one in
 * either live database), and issue #377 removed Deadline as a concept
 * this grammar can even name (`deadline:`/`deadline<`/`deadline>` are
 * gone from ./parser.ts) — so criterion 4's own "preferring" question no
 * longer has two fields to choose between. `matchesFlag`'s `undated` case
 * below is the one place that removal is visible directly, rather than
 * inherited through `effectiveDateKey`: it used to read `task.deadline`
 * of its own accord (naming both fields explicitly, the way criterion 3
 * predicates do), and now reads `task.date` alone, for the identical
 * "Deadline no longer names anything" reason.
 *
 * Name matching (`#Project`, `/Section`, `@Label`) is
 * case-and-diacritic-insensitive via ../task-search.ts's `normalize` —
 * reused rather than reimplemented, the same convention every other
 * user-typed-text match in this codebase already follows. None of
 * Project, Section or Label names are unique (their own `assertValid*`
 * comments in ../project-fields.ts/../label-fields.ts say so), so a name
 * predicate matches *every* live row sharing that name, not "the first
 * one found."
 */

export interface FilterEvalContext {
  tasks: Task[];
  projects: Project[];
  sections: Section[];
  labels: Label[];
  /** A floating `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM` reference instant — only its first ten characters are read, the identical "day-granular, not time-of-day-granular" convention ../task-views.ts's `today()` uses, for the identical testability reason (a caller supplies it; this module never reads the system clock). */
  now: string;
}

export interface FilterResultListMatch {
  label: string;
  tasks: Task[];
}

export interface FilterEvaluation {
  lists: FilterResultListMatch[];
}

/** Matches every list of `parsed` against `ctx.tasks`, in the order the query named them (criterion 2). Each list's own `tasks` preserves `ctx.tasks`'s incoming order — this function sorts nothing; ordering a result list for display is a caller concern, the identical division ../task-views.ts's `tasksForDay` draws between "which Tasks belong here" and "what order they render in." */
export function evaluateFilterQuery(
  parsed: ParsedFilterQuery,
  ctx: FilterEvalContext,
): FilterEvaluation {
  const lookups = buildLookups(ctx);
  return {
    lists: parsed.lists.map((list) => ({
      label: list.label,
      tasks: ctx.tasks.filter((task) => matchesNode(list.expr, task, lookups)),
    })),
  };
}

// Precomputed, memoized once per evaluateFilterQuery() call rather than
// per Task per node — a personal task list is nowhere near the scale
// where this would matter for correctness, but recomputing a Project's
// whole descendant set for every Task a `##Project` predicate is checked
// against is needless work a query with more than a handful of Tasks
// would otherwise redo thousands of times over.
interface Lookups {
  now: string;
  projectIdsForName: (name: string, includeDescendants: boolean) => ReadonlySet<string>;
  sectionIdsForName: (name: string) => ReadonlySet<string>;
  labelIdsForName: (name: string) => ReadonlySet<string>;
}

function buildLookups(ctx: FilterEvalContext): Lookups {
  const childrenByParentId = new Map<string, Project[]>();
  for (const project of ctx.projects) {
    if (project.parentId === null) {
      continue;
    }
    const siblings = childrenByParentId.get(project.parentId) ?? [];
    siblings.push(project);
    childrenByParentId.set(project.parentId, siblings);
  }

  const projectCache = new Map<string, ReadonlySet<string>>();
  const sectionCache = new Map<string, ReadonlySet<string>>();
  const labelCache = new Map<string, ReadonlySet<string>>();

  return {
    now: ctx.now,
    projectIdsForName(name, includeDescendants) {
      const cacheKey = `${includeDescendants ? "##" : "#"}${normalize(name)}`;
      const cached = projectCache.get(cacheKey);
      if (cached !== undefined) {
        return cached;
      }
      const target = normalize(name);
      const ids = new Set(
        ctx.projects.filter((p) => normalize(p.name) === target).map((p) => p.id),
      );
      if (includeDescendants) {
        // BFS down `childrenByParentId` from every directly-named Project
        // — "a Project with everything under it" (criterion 3), applied
        // once per matching Project in case the name is shared.
        const queue = [...ids];
        while (queue.length > 0) {
          // biome-ignore lint/style/noNonNullAssertion: the while condition already guarantees a next element.
          const id = queue.shift()!;
          for (const child of childrenByParentId.get(id) ?? []) {
            if (!ids.has(child.id)) {
              ids.add(child.id);
              queue.push(child.id);
            }
          }
        }
      }
      projectCache.set(cacheKey, ids);
      return ids;
    },
    sectionIdsForName(name) {
      const cacheKey = normalize(name);
      const cached = sectionCache.get(cacheKey);
      if (cached !== undefined) {
        return cached;
      }
      const target = normalize(name);
      const ids = new Set(
        ctx.sections.filter((s) => normalize(s.name) === target).map((s) => s.id),
      );
      sectionCache.set(cacheKey, ids);
      return ids;
    },
    labelIdsForName(name) {
      const cacheKey = normalize(name);
      const cached = labelCache.get(cacheKey);
      if (cached !== undefined) {
        return cached;
      }
      const target = normalize(name);
      const ids = new Set(ctx.labels.filter((l) => normalize(l.name) === target).map((l) => l.id));
      labelCache.set(cacheKey, ids);
      return ids;
    },
  };
}

function matchesNode(node: FilterNode, task: Task, lookups: Lookups): boolean {
  switch (node.kind) {
    case "and":
      return matchesNode(node.left, task, lookups) && matchesNode(node.right, task, lookups);
    case "or":
      return matchesNode(node.left, task, lookups) || matchesNode(node.right, task, lookups);
    case "not":
      return !matchesNode(node.operand, task, lookups);
    case "flag":
      return matchesFlag(node.flag, task, lookups.now);
    case "priority":
      return uiPriorityOfTask(task) === node.level;
    case "project":
      return (
        task.projectId !== null &&
        lookups.projectIdsForName(node.name, node.includeDescendants).has(task.projectId)
      );
    case "section":
      return task.sectionId !== null && lookups.sectionIdsForName(node.name).has(task.sectionId);
    case "label": {
      const ids = lookups.labelIdsForName(node.name);
      return task.labelIds.some((id) => ids.has(id));
    }
    case "due":
      return matchesDue(node.op, node.value, task);
  }
}

// Inverted against the stored 1-4 (../task-types.ts's `uiPriorityOf`),
// never open-coded — see that function's own doc comment for why.
function uiPriorityOfTask(task: Task): number {
  return 5 - task.priority;
}

function matchesFlag(
  flag: "today" | "tomorrow" | "overdue" | "undated" | "recurring" | "subtask",
  task: Task,
  now: string,
): boolean {
  switch (flag) {
    // Issue #377: used to read `task.date === null && task.deadline ===
    // null` — Deadline no longer names anything this grammar can ask
    // about, so "undated" is just "no Date" now, the same simplification
    // `effectiveDateKey` (../task-views.ts) already made for #375.
    case "undated":
      return task.date === null;
    case "recurring":
      return task.dateString !== null;
    case "subtask":
      return task.parentId !== null;
    case "overdue": {
      const day = effectiveDueDay(task);
      return day !== null && day < today(now);
    }
    case "today": {
      const day = effectiveDueDay(task);
      return day !== null && day === today(now);
    }
    case "tomorrow": {
      const day = effectiveDueDay(task);
      return day !== null && day === addDays(today(now), 1);
    }
  }
}

function today(now: string): string {
  return now.slice(0, 10);
}

// "What is due, preferring the Date when a Task has both" (criterion 4) —
// see this module's own header comment for the full reasoning and the one
// case this deliberately disagrees with ../task-views.ts's `today()` on.
function effectiveDueDay(task: Task): string | null {
  const key = effectiveDateKey(task);
  return key === null ? null : key.slice(0, 10);
}

// A `date` predicate names that field explicitly (criterion 3) — until
// issue #377 this also covered `deadline`, a second field name this
// grammar could match against with the identical three operators; with
// Deadline gone, `date` is the only field left to name.
function matchesDue(op: "on" | "before" | "after", value: string, task: Task): boolean {
  if (task.date === null) {
    return false;
  }
  const day = task.date.slice(0, 10);
  if (op === "on") {
    return day === value;
  }
  return op === "before" ? day < value : day > value;
}
