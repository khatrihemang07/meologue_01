import { describe, expect, it } from "vitest";
import { groupEntriesIntoDayFiles } from "./export/day-file";
import type { Task } from "./task-types";
import { storedPriorityOf } from "./task-types";
import { compareForToday, tasksForDay, today } from "./task-views";
import { entry } from "./test-support/entry-fixture";
import { task } from "./test-support/task-fixture";

// A fixed "now" for every test below — a floating timestamp, matching
// Task.date's own encoding (see task-views.ts's doc comment on why only
// its first ten characters, the calendar day, are ever read).
const NOW = "2026-09-02T08:00";

describe("today()'s union — due today, overdue, or deadline today-or-past", () => {
  it("includes a Task due today, an overdue Task, one with a deadline today, and one with a deadline in the past and no date at all — and excludes a Task with neither field and one whose date/deadline are both in the future", () => {
    const dueToday = task({ id: "due-today", date: "2026-09-02" });
    const overdue = task({ id: "overdue", date: "2026-08-30" });
    const deadlineToday = task({ id: "deadline-today", date: null, deadline: "2026-09-02" });
    const deadlinePastNoDate = task({
      id: "deadline-past-no-date",
      date: null,
      deadline: "2026-08-15",
    });
    const neither = task({ id: "neither", date: null, deadline: null });
    const dateFuture = task({ id: "date-future", date: "2026-09-10" });
    const deadlineFuture = task({ id: "deadline-future", date: null, deadline: "2026-09-10" });

    const view = today(
      [dueToday, overdue, deadlineToday, deadlinePastNoDate, neither, dateFuture, deadlineFuture],
      NOW,
    );

    expect(new Set(view.overdue.map((t) => t.id))).toEqual(
      new Set(["overdue", "deadline-past-no-date"]),
    );
    expect(new Set(view.dueToday.map((t) => t.id))).toEqual(
      new Set(["due-today", "deadline-today"]),
    );
    const shown = new Set([...view.overdue, ...view.dueToday].map((t) => t.id));
    expect(shown.has("neither")).toBe(false);
    expect(shown.has("date-future")).toBe(false);
    expect(shown.has("deadline-future")).toBe(false);
  });

  it("treats a passed deadline as overdue even when the Task's own date is still in the future", () => {
    // An unusual combination — planning to do something after its hard
    // cutoff — but not one this module refuses to represent, and the
    // deadline having already passed is what "overdue" means here,
    // independent of what was separately planned for later.
    const t = task({ id: "future-date-past-deadline", date: "2026-09-20", deadline: "2026-08-01" });

    const view = today([t], NOW);

    expect(view.overdue.map((x) => x.id)).toEqual(["future-date-past-deadline"]);
    expect(view.dueToday).toEqual([]);
  });

  it("keeps a Task due earlier today in dueToday, not overdue — the boundary is the calendar day, not the time of day", () => {
    const earlierToday = task({ id: "earlier-today", date: "2026-09-02T00:01" });

    const view = today([earlierToday], NOW);

    expect(view.dueToday.map((t) => t.id)).toEqual(["earlier-today"]);
    expect(view.overdue).toEqual([]);
  });
});

describe("compareForToday's chain: date-and-time -> priority -> deadline -> manual -> created", () => {
  it(
    "priority is a tie-break inside the same date-and-time, never a global rank — " +
      "an unprioritized 09:00 Task outranks the most-urgent 15:00 Task",
    () => {
      // UI p4 ("no priority") is stored 1; UI p1 (most urgent) is stored 4
      // (Task.priority's own doc comment on task-types.ts). If this test
      // starts failing because someone "fixed" the sort to put priority
      // first, that fix is the exact regression Todoist itself shipped
      // and reverted twice in 2026 — this test exists so reintroducing it
      // takes a conscious deletion, not an accidental pass.
      const noPriorityEarly = task({
        id: "p4-at-9am",
        date: "2026-09-02T09:00",
        priority: storedPriorityOf(4),
      });
      const mostUrgentLate = task({
        id: "p1-at-3pm",
        date: "2026-09-02T15:00",
        priority: storedPriorityOf(1),
      });

      const view = today([mostUrgentLate, noPriorityEarly], NOW);

      expect(view.dueToday.map((t) => t.id)).toEqual(["p4-at-9am", "p1-at-3pm"]);
    },
  );

  it("an all-day Task sorts before a timed Task on the same day", () => {
    // Not a special case in compareForToday: "2026-09-02" is a strict
    // prefix of "2026-09-02T00:01" and sorts first under plain `<` for
    // that reason alone (task-views.ts's own doc comment). Chosen here as
    // the rule this module has adopted — an all-day Task reads as
    // "sometime today" rather than competing for a slot among specific
    // hours, the same convention a calendar's day view uses for all-day
    // items shown above the hour grid.
    const allDay = task({ id: "all-day", date: "2026-09-02" });
    const timedFirstMinute = task({ id: "timed-00:01", date: "2026-09-02T00:01" });

    const view = today([timedFirstMinute, allDay], NOW);

    expect(view.dueToday.map((t) => t.id)).toEqual(["all-day", "timed-00:01"]);
  });

  it("breaks a same date-and-time tie by priority, more urgent first", () => {
    const lessUrgent = task({
      id: "less-urgent",
      date: "2026-09-02T09:00",
      priority: storedPriorityOf(4),
    });
    const moreUrgent = task({
      id: "more-urgent",
      date: "2026-09-02T09:00",
      priority: storedPriorityOf(1),
    });

    const view = today([lessUrgent, moreUrgent], NOW);

    expect(view.dueToday.map((t) => t.id)).toEqual(["more-urgent", "less-urgent"]);
  });

  it("breaks a same date-and-time, same-priority tie by deadline — earlier first, no deadline last", () => {
    const noDeadline = task({ id: "no-deadline", date: "2026-09-02T09:00", priority: 2 });
    const withDeadline = task({
      id: "with-deadline",
      date: "2026-09-02T09:00",
      priority: 2,
      deadline: "2026-09-05",
    });

    const view = today([noDeadline, withDeadline], NOW);

    expect(view.dueToday.map((t) => t.id)).toEqual(["with-deadline", "no-deadline"]);
  });

  it("falls back to manual order (orderKey) once date-and-time, priority and deadline all tie", () => {
    const b = task({
      id: "b",
      date: "2026-09-02T09:00",
      priority: 2,
      deadline: "2026-09-05",
      orderKey: "b",
    });
    const a = task({
      id: "a",
      date: "2026-09-02T09:00",
      priority: 2,
      deadline: "2026-09-05",
      orderKey: "a",
    });

    const view = today([b, a], NOW);

    expect(view.dueToday.map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("falls back to createdAt once orderKey ties too — the last named step of the chain", () => {
    const older = task({
      id: "older",
      date: "2026-09-02T09:00",
      priority: 2,
      orderKey: "m",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const newer = task({
      id: "newer",
      date: "2026-09-02T09:00",
      priority: 2,
      orderKey: "m",
      createdAt: "2026-02-01T00:00:00.000Z",
    });

    const view = today([newer, older], NOW);

    expect(view.dueToday.map((t) => t.id)).toEqual(["older", "newer"]);
  });

  it("compareForToday is exported so a caller can sort with the identical chain outside today()'s own sections", () => {
    const list: Task[] = [
      task({ id: "later", date: "2026-09-02T15:00" }),
      task({ id: "earlier", date: "2026-09-02T09:00" }),
    ];

    expect(list.sort(compareForToday).map((t) => t.id)).toEqual(["earlier", "later"]);
  });
});

describe("overdue is its own section, always ordered chronologically", () => {
  it("orders overdue Tasks by date, even when orderKey would say the opposite", () => {
    // orderKey alone ("z" then "a") would put `earlier` last and `later`
    // first — the opposite of due-date order. Overdue never reaches the
    // manual step at all: its Tasks tie neither on date-and-time (their
    // dates differ) nor on any earlier step, so the chain's first
    // comparison — date-and-time — already decides them, regardless of
    // what a "manual sort" display mode might otherwise do to other
    // sections. See task-views.ts's own doc comment for why this holds by
    // construction rather than by a special case for `overdue`.
    const earlier = task({ id: "earlier", date: "2026-08-01", orderKey: "z" });
    const later = task({ id: "later", date: "2026-08-20", orderKey: "a" });

    const view = today([later, earlier], NOW);

    expect(view.overdue.map((t) => t.id)).toEqual(["earlier", "later"]);
  });
});

describe("grouping does not collapse the order to priority", () => {
  it("partitioning an already-sorted dueToday list preserves date-and-time order inside a priority group", () => {
    // Two Tasks share a priority, so grouping by priority puts them in one
    // bucket together — the only thing left to decide their order inside
    // that bucket is the chain's first step, date-and-time, priority being
    // constant within the group. orderKey ("a" then "z") is deliberately
    // set to the *opposite* of date order, so a grouping implementation
    // that quietly falls back to manual order inside a group — instead of
    // preserving the chain-sorted list it was handed — would produce
    // "late" before "early" here and fail this test.
    const late = task({ id: "late", date: "2026-09-02T18:00", priority: 3, orderKey: "a" });
    const early = task({ id: "early", date: "2026-09-02T06:00", priority: 3, orderKey: "z" });

    const view = today([late, early], NOW);

    // Simulates the web layer's grouping control: partition the
    // already-chain-sorted list by priority rather than re-sorting each
    // bucket — the only correct way to group without reintroducing a
    // priority-first sort (task-views.ts's own doc comment on
    // compareForToday explains why grouping must be a partition, not a
    // second, independently-invented ordering).
    const groupedByPriority = new Map<number, Task[]>();
    for (const t of view.dueToday) {
      // Every Task here came from the task() fixture, which always sets a
      // concrete priority (../test-support/task-fixture.ts) — the `?? 1`
      // only satisfies Task.priority's TS-optional type (its own doc
      // comment), not a real fallback this test relies on.
      const priority = t.priority ?? 1;
      const bucket = groupedByPriority.get(priority) ?? [];
      bucket.push(t);
      groupedByPriority.set(priority, bucket);
    }

    expect(groupedByPriority.get(3)?.map((t) => t.id)).toEqual(["early", "late"]);
  });
});

describe("tasksForDay — the day block's own filter (issue #174)", () => {
  it("includes a Task dated that day, a Task deadlined that day, and excludes one dated another day and one with neither field", () => {
    const dated = task({ id: "dated", date: "2026-09-01" });
    const deadlined = task({ id: "deadlined", date: null, deadline: "2026-09-01" });
    const otherDay = task({ id: "other-day", date: "2026-09-02" });
    const neither = task({ id: "neither", date: null, deadline: null });

    const block = tasksForDay([dated, deadlined, otherDay, neither], "2026-09-01");

    expect(new Set(block.map((t) => t.id))).toEqual(new Set(["dated", "deadlined"]));
  });

  it("matches a timed Task's calendar day, not its exact date-and-time string", () => {
    const timed = task({ id: "timed", date: "2026-09-01T17:00" });

    expect(tasksForDay([timed], "2026-09-01").map((t) => t.id)).toEqual(["timed"]);
    expect(tasksForDay([timed], "2026-09-02")).toEqual([]);
  });

  it("does not require the date and deadline to agree — a Task dated elsewhere but deadlined this day still opens this day's block (and its own dated day, independently)", () => {
    const t = task({ id: "future-date-this-deadline", date: "2026-09-20", deadline: "2026-09-01" });

    expect(tasksForDay([t], "2026-09-01").map((x) => x.id)).toEqual(["future-date-this-deadline"]);
    expect(tasksForDay([t], "2026-09-20").map((x) => x.id)).toEqual(["future-date-this-deadline"]);
    expect(tasksForDay([t], "2026-09-15")).toEqual([]);
  });

  it("orders a day's block with the identical compareForToday chain Today and Inbox already use", () => {
    const late = task({ id: "late", date: "2026-09-01T18:00", priority: storedPriorityOf(1) });
    const early = task({ id: "early", date: "2026-09-01T09:00", priority: storedPriorityOf(4) });

    expect(tasksForDay([late, early], "2026-09-01").map((t) => t.id)).toEqual(["early", "late"]);
  });

  it("is a rendering, not a record — a plain filter that neither mutates its input nor produces the same array instance twice", () => {
    const tasks = [task({ id: "a", date: "2026-09-01" }), task({ id: "b", date: "2026-09-02" })];
    const original = [...tasks];

    const first = tasksForDay(tasks, "2026-09-01");
    const second = tasksForDay(tasks, "2026-09-01");

    expect(tasks).toEqual(original);
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
  });

  it("re-dating a Task moves it between days with no membership to update — calling tasksForDay again against the changed array is the whole mechanism", () => {
    // Issue #174's own worked example: a Task re-dated from the 31st to
    // the 1st keeps its own row, and simply stops matching one day's
    // filter and starts matching the other's the next time each is
    // called — there is nothing else to write.
    const redated = task({ id: "redated", date: "2026-08-31" });
    expect(tasksForDay([redated], "2026-08-31").map((t) => t.id)).toEqual(["redated"]);
    expect(tasksForDay([redated], "2026-09-01")).toEqual([]);

    const afterRedate = { ...redated, date: "2026-09-01" };
    expect(tasksForDay([afterRedate], "2026-08-31")).toEqual([]);
    expect(tasksForDay([afterRedate], "2026-09-01").map((t) => t.id)).toEqual(["redated"]);
  });

  // Issue #174's own acceptance criterion: "the block is rendered only:
  // absent from the Export ... nothing should be stored twice." This is
  // provable directly rather than merely argued, because
  // groupEntriesIntoDayFiles (../export/day-file.ts) takes only Entry[] —
  // it has no Task[] parameter to have rendered day-block content from in
  // the first place. The Task below is dated 1 Sept and would open
  // tasksForDay's own 1-Sept block (asserted above); the Entry that
  // References it was captured on 31 Aug and never touches 1 Sept at all.
  // If the day block were anything but a rendering, exporting would have
  // to reach into `tasks` to reconstruct it — it doesn't, and this proves
  // there is genuinely nothing there to reach for: no entries/2026-09-01.txt
  // exists at all, because no Entry was ever captured that day.
  it("never reaches Export — Export groups by Entry.createdAt alone, with no Task in scope to have rendered a day block from", () => {
    const redated = task({ id: "redated-task", date: "2026-09-01", content: "buy milk" });
    expect(tasksForDay([redated], "2026-09-01").map((t) => t.id)).toEqual(["redated-task"]);

    const capturedOn31st = entry({
      id: "entry-31st",
      createdAt: "2026-08-31T10:00:00.000Z",
      // The exact `[[task:...]]` syntax doesn't matter here — day-file.ts
      // never parses a body, only writes it verbatim (its own doc
      // comment) — so plain text referencing the Task's cached label
      // stands in for the real mark this Entry would actually carry.
      body: "- [ ] buy milk",
    });

    const { files } = groupEntriesIntoDayFiles([capturedOn31st], 0);

    expect(files.map((f) => f.path)).toEqual(["entries/2026-08-31.txt"]);
    expect(files.some((f) => f.path === "entries/2026-09-01.txt")).toBe(false);
  });
});
