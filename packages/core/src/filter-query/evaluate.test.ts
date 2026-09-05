import { describe, expect, it } from "vitest";
import type { Task } from "../task-types";
import { storedPriorityOf } from "../task-types";
import { filter as filterFixture } from "../test-support/filter-fixture";
import { project, section } from "../test-support/project-fixture";
import { task } from "../test-support/task-fixture";
import { evaluateFilterQuery, type FilterEvalContext } from "./evaluate";
import { parseFilterQuery } from "./parser";

const NOW = "2026-09-10"; // A Thursday — matches nothing test-specific about the day of week, just a fixed reference point.

function matchIds(query: string, ctx: Partial<FilterEvalContext> & { tasks: Task[] }): string[] {
  const parsed = parseFilterQuery(query);
  const evaluation = evaluateFilterQuery(parsed, {
    projects: [],
    sections: [],
    labels: [],
    now: NOW,
    ...ctx,
  });
  return evaluation.lists[0]?.tasks.map((t) => t.id) ?? [];
}

describe("flags", () => {
  const overdueTask = task({ id: "overdue", date: "2026-09-01" });
  const dueTodayTask = task({ id: "due-today", date: NOW });
  const dueTomorrowTask = task({ id: "due-tomorrow", date: "2026-09-11" });
  const futureTask = task({ id: "future", date: "2026-09-20" });
  const undatedTask = task({ id: "undated" });
  const recurringTask = task({ id: "recurring", dateString: "every day", date: NOW });
  const subtaskTask = task({ id: "subtask", parentId: "parent-1", date: "2026-09-20" });
  const allTasks = [
    overdueTask,
    dueTodayTask,
    dueTomorrowTask,
    futureTask,
    undatedTask,
    recurringTask,
    subtaskTask,
  ];

  it("today matches a Task whose effective due day is today", () => {
    expect(matchIds("today", { tasks: allTasks })).toEqual(
      expect.arrayContaining(["due-today", "recurring"]),
    );
    expect(matchIds("today", { tasks: allTasks })).not.toContain("overdue");
    expect(matchIds("today", { tasks: allTasks })).not.toContain("future");
  });

  it("overdue matches a Task whose effective due day is before today", () => {
    expect(matchIds("overdue", { tasks: allTasks })).toEqual(["overdue"]);
  });

  it("tomorrow matches a Task whose effective due day is exactly tomorrow", () => {
    expect(matchIds("tomorrow", { tasks: allTasks })).toEqual(["due-tomorrow"]);
  });

  it("undated matches a Task with neither a Date nor a Deadline", () => {
    expect(matchIds("undated", { tasks: allTasks })).toEqual(["undated"]);
  });

  it("recurring matches a Task carrying a Recurrence rule", () => {
    expect(matchIds("recurring", { tasks: allTasks })).toEqual(["recurring"]);
  });

  it("subtask matches a Task with a parent", () => {
    expect(matchIds("subtask", { tasks: allTasks })).toEqual(["subtask"]);
  });
});

describe("criterion 4: a query asking what is due prefers the Date when a Task has both", () => {
  it("a Task with only a Deadline is found by today/overdue through that Deadline", () => {
    const deadlineOnly = task({ id: "deadline-only", deadline: NOW });
    expect(matchIds("today", { tasks: [deadlineOnly] })).toEqual(["deadline-only"]);

    const overdueDeadline = task({ id: "overdue-deadline", deadline: "2026-09-01" });
    expect(matchIds("overdue", { tasks: [overdueDeadline] })).toEqual(["overdue-deadline"]);
  });

  // The awkward case ../task-views.ts's own header comment names for
  // today(): a future Date with a passed Deadline. today() puts this in
  // `overdue` (its Deadline half fires independently of the Date). A
  // Filter's `overdue` flag does not — see ./evaluate.ts's own header
  // comment for why "preferring the Date" has to mean picking one field,
  // not unioning both, and why that is a deliberate divergence from
  // today()'s own rule rather than an oversight.
  it("a future Date with a passed Deadline is NOT overdue, unlike Today's own union rule", () => {
    const futureButOverdueDeadline = task({
      id: "future-date-passed-deadline",
      date: "2026-09-20",
      deadline: "2026-09-01",
    });

    expect(matchIds("overdue", { tasks: [futureButOverdueDeadline] })).toEqual([]);
    // It reads as due on its future Date instead — not today, not
    // tomorrow, since 2026-09-20 is neither.
    expect(matchIds("today", { tasks: [futureButOverdueDeadline] })).toEqual([]);
  });

  it("a Task due today by Date but overdue by Deadline is found by today, preferring the Date", () => {
    const dateToday = task({ id: "date-today-deadline-past", date: NOW, deadline: "2026-09-01" });
    expect(matchIds("today", { tasks: [dateToday] })).toEqual(["date-today-deadline-past"]);
    expect(matchIds("overdue", { tasks: [dateToday] })).toEqual([]);
  });
});

describe("criterion 3: naming a Date or a Deadline explicitly reads only that one field", () => {
  const both = task({ id: "both", date: "2026-09-15", deadline: "2026-09-01" });

  it("date: matches only the Date field, ignoring the Deadline entirely", () => {
    expect(matchIds("date:2026-09-15", { tasks: [both] })).toEqual(["both"]);
    expect(matchIds("date:2026-09-01", { tasks: [both] })).toEqual([]);
  });

  it("deadline: matches only the Deadline field, ignoring the Date entirely", () => {
    expect(matchIds("deadline:2026-09-01", { tasks: [both] })).toEqual(["both"]);
    expect(matchIds("deadline:2026-09-15", { tasks: [both] })).toEqual([]);
  });

  it("date< / date> compare against the Date field", () => {
    expect(matchIds("date<2026-09-16", { tasks: [both] })).toEqual(["both"]);
    expect(matchIds("date<2026-09-15", { tasks: [both] })).toEqual([]);
    expect(matchIds("date>2026-09-14", { tasks: [both] })).toEqual(["both"]);
  });

  it("deadline< / deadline> compare against the Deadline field", () => {
    expect(matchIds("deadline<2026-09-02", { tasks: [both] })).toEqual(["both"]);
    expect(matchIds("deadline>2026-08-31", { tasks: [both] })).toEqual(["both"]);
    expect(matchIds("deadline>2026-09-01", { tasks: [both] })).toEqual([]);
  });

  it("date: on a Task with no Date at all never matches, even if its Deadline matches the value", () => {
    const deadlineOnly = task({ id: "deadline-only", deadline: "2026-09-15" });
    expect(matchIds("date:2026-09-15", { tasks: [deadlineOnly] })).toEqual([]);
  });

  it("a timed Date matches date: by its calendar day alone", () => {
    const timed = task({ id: "timed", date: "2026-09-15T09:30" });
    expect(matchIds("date:2026-09-15", { tasks: [timed] })).toEqual(["timed"]);
  });
});

describe("priority", () => {
  it.each<[number, 1 | 2 | 3 | 4]>([
    [storedPriorityOf(1), 1],
    [storedPriorityOf(2), 2],
    [storedPriorityOf(3), 3],
    [storedPriorityOf(4), 4],
  ])("p%i matches a Task at stored priority %i", (stored, uiLevel) => {
    const matching = task({ id: "matching", priority: stored });
    const other = task({
      id: "other",
      priority: storedPriorityOf(uiLevel === 4 ? 1 : uiLevel + 1),
    });
    expect(matchIds(`p${uiLevel}`, { tasks: [matching, other] })).toEqual(["matching"]);
  });
});

describe("Project (criterion 3)", () => {
  const work = project({ id: "work", name: "Work" });
  const workSub = project({ id: "work-sub", name: "Client A", parentId: "work" });
  const workSubSub = project({ id: "work-sub-sub", name: "Invoices", parentId: "work-sub" });
  const personal = project({ id: "personal", name: "Personal" });
  const allProjects = [work, workSub, workSubSub, personal];

  const inWork = task({ id: "in-work", projectId: "work" });
  const inWorkSub = task({ id: "in-work-sub", projectId: "work-sub" });
  const inWorkSubSub = task({ id: "in-work-sub-sub", projectId: "work-sub-sub" });
  const inPersonal = task({ id: "in-personal", projectId: "personal" });
  const inInbox = task({ id: "in-inbox", projectId: null });
  const allTasks = [inWork, inWorkSub, inWorkSubSub, inPersonal, inInbox];

  it("#Name matches only Tasks directly in that Project", () => {
    expect(matchIds("#Work", { tasks: allTasks, projects: allProjects })).toEqual(["in-work"]);
  });

  it("##Name matches that Project and every Task nested arbitrarily deep beneath it", () => {
    expect(matchIds("##Work", { tasks: allTasks, projects: allProjects })).toEqual(
      expect.arrayContaining(["in-work", "in-work-sub", "in-work-sub-sub"]),
    );
    expect(matchIds("##Work", { tasks: allTasks, projects: allProjects })).not.toContain(
      "in-personal",
    );
  });

  it("matches a Project name case- and diacritic-insensitively", () => {
    expect(matchIds("#work", { tasks: allTasks, projects: allProjects })).toEqual(["in-work"]);
  });

  it("never matches an Inbox Task (projectId: null)", () => {
    expect(matchIds("##Work", { tasks: [inInbox], projects: allProjects })).toEqual([]);
  });
});

describe("Section", () => {
  const groceries = section({ id: "groceries", name: "Groceries" });
  const inSection = task({ id: "in-section", sectionId: "groceries" });
  const noSection = task({ id: "no-section", sectionId: null });

  it("/Name matches Tasks in that Section", () => {
    expect(
      matchIds("/Groceries", { tasks: [inSection, noSection], sections: [groceries] }),
    ).toEqual(["in-section"]);
  });
});

describe("Label", () => {
  const urgentTask = task({ id: "urgent-task", labelIds: ["label-urgent"] });
  const otherTask = task({ id: "other-task", labelIds: ["label-other"] });
  const noLabelTask = task({ id: "no-label-task", labelIds: [] });
  const labels = [
    {
      id: "label-urgent",
      deviceId: "d",
      name: "urgent",
      colour: "#000000",
      createdAt: "",
      updatedAt: "",
      seq: null,
      syncedAt: null,
      deletedAt: null,
    },
    {
      id: "label-other",
      deviceId: "d",
      name: "waiting",
      colour: "#000000",
      createdAt: "",
      updatedAt: "",
      seq: null,
      syncedAt: null,
      deletedAt: null,
    },
  ];

  it("@Name matches every Task carrying that Label", () => {
    expect(matchIds("@urgent", { tasks: [urgentTask, otherTask, noLabelTask], labels })).toEqual([
      "urgent-task",
    ]);
  });
});

describe("boolean composition", () => {
  const p1Work = task({ id: "p1-work", projectId: "work", priority: storedPriorityOf(1) });
  const p2Work = task({ id: "p2-work", projectId: "work", priority: storedPriorityOf(2) });
  const p1Other = task({ id: "p1-other", projectId: "other", priority: storedPriorityOf(1) });
  const projects = [project({ id: "work", name: "Work" }), project({ id: "other", name: "Other" })];
  const allTasks = [p1Work, p2Work, p1Other];

  it("and requires both sides", () => {
    expect(matchIds("#Work & p1", { tasks: allTasks, projects })).toEqual(["p1-work"]);
  });

  it("or requires either side", () => {
    expect(matchIds("#Work | p1", { tasks: allTasks, projects })).toEqual(
      expect.arrayContaining(["p1-work", "p2-work", "p1-other"]),
    );
  });

  it("not inverts", () => {
    expect(matchIds("!p1", { tasks: allTasks, projects })).toEqual(["p2-work"]);
  });

  it("grouping changes which Tasks match", () => {
    // (#Work | #Other) & p1 — every p1 Task, in either Project.
    expect(matchIds("(#Work | #Other) & p1", { tasks: allTasks, projects })).toEqual(
      expect.arrayContaining(["p1-work", "p1-other"]),
    );
  });
});

describe("criterion 2: several result lists from one query", () => {
  it("evaluates each comma-separated list independently against the same Tasks", () => {
    const overdueTask = task({ id: "overdue", date: "2026-09-01" });
    const dueTodayTask = task({ id: "today", date: NOW });
    const parsed = parseFilterQuery("overdue, today");

    const evaluation = evaluateFilterQuery(parsed, {
      tasks: [overdueTask, dueTodayTask],
      projects: [],
      sections: [],
      labels: [],
      now: NOW,
    });

    expect(evaluation.lists).toHaveLength(2);
    expect(evaluation.lists[0]).toMatchObject({ label: "overdue", tasks: [overdueTask] });
    expect(evaluation.lists[1]).toMatchObject({ label: "today", tasks: [dueTodayTask] });
  });
});

describe("a Filter fixture's own default query evaluates", () => {
  it("parses and matches", () => {
    const f = filterFixture();
    const parsed = parseFilterQuery(f.query);
    const dueToday = task({ id: "due", date: NOW });
    const evaluation = evaluateFilterQuery(parsed, {
      tasks: [dueToday],
      projects: [],
      sections: [],
      labels: [],
      now: NOW,
    });
    expect(evaluation.lists[0]?.tasks.map((t) => t.id)).toEqual(["due"]);
  });
});
