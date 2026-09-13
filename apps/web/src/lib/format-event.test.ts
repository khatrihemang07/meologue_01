import type { Event, Project, Task } from "@meologue/core";
import { describe, expect, it } from "vitest";
import {
  describeEventLine,
  eventDayHeading,
  groupEventsByDay,
  isRenderableEvent,
} from "./format-event";
import { taskDetailPath } from "./task-detail-route";

function event(overrides: Partial<Event> = {}): Event {
  return {
    id: "e1",
    deviceId: "device-a",
    eventType: "added",
    objectType: "task",
    objectId: "t1",
    taskId: "t1",
    projectId: null,
    occurredAt: "2026-01-01T00:00:00.000Z",
    extra: null,
    seq: 1,
    syncedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    deviceId: "device-a",
    content: "Buy milk",
    completedAt: null,
    orderKey: "V",
    dayOrder: "V",
    // Issue #196: updatedAt starts equal to createdAt
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    seq: 1,
    syncedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    date: null,
    deadline: null,
    priority: 1,
    labelIds: [],
    dateString: null,
    projectId: null,
    sectionId: null,
    parentId: null,
    description: null,
    ...overrides,
  };
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "p1",
    deviceId: "device-a",
    name: "Groceries",
    colour: "#808080",
    favourite: false,
    archived: false,
    parentId: null,
    description: null,
    orderKey: "A",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    seq: 1,
    syncedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

describe("describeEventLine", () => {
  // The coordinator's own gap-fix report: "Completed alone is unusable in
  // a view that aggregates across every Task, Project and Comment" — every
  // line must name its object.
  it("names its object — a completed Task resolves a live subject, not just a bare verb", () => {
    const line = describeEventLine(event({ eventType: "completed" }), {
      tasks: [task()],
      projects: [],
    });
    // CMT-06: `You completed {task}`.
    expect(line.lead).toBe("You completed");
    expect(line.subject).toEqual({ glyph: "○", label: "Buy milk", href: taskDetailPath(task()) });
  });

  it("CMT-06: uncompleting a Task carries no extra clause", () => {
    const line = describeEventLine(event({ eventType: "uncompleted" }), {
      tasks: [task()],
      projects: [],
    });
    expect(line.lead).toBe("You uncompleted");
    expect(line.detail).toBeUndefined();
  });

  it("CMT-06: adding a Task", () => {
    const line = describeEventLine(event({ eventType: "added" }), {
      tasks: [task()],
      projects: [],
    });
    expect(line.lead).toBe("You added");
  });

  it("a Task event's subject links to that Task's own address", () => {
    const t = task({ id: "t9", content: "Water the plants" });
    const line = describeEventLine(event({ objectId: "t9", taskId: "t9", eventType: "added" }), {
      tasks: [t],
      projects: [],
    });
    expect(line.subject?.href).toBe(taskDetailPath(t));
    expect(line.subject?.label).toBe("Water the plants");
  });

  // ADR 0056 / entry-row.tsx's own Task Reference rule: an unresolvable
  // object (deleted, or not yet Synced here) still renders a name, from
  // the Event's own cached label — never an empty phrase or a dangling
  // link.
  it("an Event whose object was deleted still renders a cached name, with no link", () => {
    const line = describeEventLine(
      event({ eventType: "completed", extra: { content: "Gone now" } }),
      { tasks: [], projects: [] }, // the Task is nowhere in the live list — deleted
    );
    expect(line.subject).toEqual({ glyph: "○", label: "Gone now", href: null });
  });

  it("falls back to a generic label when even the cached name is missing", () => {
    const line = describeEventLine(event({ eventType: "completed", extra: null }), {
      tasks: [],
      projects: [],
    });
    expect(line.subject).toEqual({ glyph: "○", label: "a Task", href: null });
  });

  // task-detail-view.tsx's own Activity section — the one surface where
  // naming the Task is redundant, since the reader is already looking at
  // it.
  it("suppresses the primary subject when it matches suppressSubjectFor, without dropping the verb", () => {
    const line = describeEventLine(
      event({ eventType: "completed" }),
      { tasks: [task()], projects: [] },
      "t1",
    );
    expect(line.subject).toBeUndefined();
    expect(line.lead).toBe("You completed");
  });

  it("does not suppress a different Task's own subject", () => {
    const line = describeEventLine(
      event({ eventType: "completed", objectId: "t1", taskId: "t1" }),
      { tasks: [task()], projects: [] },
      "some-other-task",
    );
    expect(line.subject).toBeDefined();
  });

  it("says 'set' when there is no previous date, naming the Task either way", () => {
    const line = describeEventLine(
      event({
        eventType: "updated",
        extra: { date: "2026-02-01", lastDate: null, content: "Buy milk" },
      }),
      { tasks: [], projects: [] },
    );
    expect(line.lead).toBe("Set the date on");
    // format-task-date.ts's formatDay now reads day-then-month (DATE-11,
    // parity-ledger.md) — this Activity surface was never itself measured
    // against Todoist, but day-then-month is Todoist's order everywhere
    // else, so the fix reaches here too rather than leaving one date
    // phrase in the app spelled the old way.
    expect(line.detail).toBe("to 1 Feb");
    expect(line.subject?.label).toBe("Buy milk");
  });

  it("says 'changed' when a previous date is present", () => {
    const line = describeEventLine(
      event({
        eventType: "updated",
        extra: { date: "2026-02-01", lastDate: "2026-01-15", content: "Buy milk" },
      }),
      { tasks: [], projects: [] },
    );
    expect(line.lead).toBe("Changed the date on");
  });

  it("drops the trailing preposition when the date's own Task is suppressed", () => {
    const line = describeEventLine(
      event({ eventType: "updated", extra: { date: "2026-02-01", lastDate: null } }),
      { tasks: [task()], projects: [] },
      "t1",
    );
    expect(line.lead).toBe("Set the date");
    expect(line.subject).toBeUndefined();
  });

  it("CMT-06: a rename shows only the resulting name, never an old→new pair", () => {
    const line = describeEventLine(
      event({ eventType: "updated", extra: { content: "new title", lastContent: "old title" } }),
      { tasks: [task({ content: "new title" })], projects: [] },
    );
    expect(line.lead).toBe("You changed the name of");
    expect(line.subject?.label).toBe("new title");
    expect(line.detail).toBeUndefined();
  });

  // CMT-06, re-driven live (flow 5): `{content}` renders as an unquoted
  // chip in Todoist's own DOM, not the quoted `detail` string this module
  // used to build — so it rides in `contentPreview`, never wrapped in
  // literal quote marks.
  it("CMT-06: Description templates — added, changed, removed, content unquoted", () => {
    const added = describeEventLine(
      event({ eventType: "updated", extra: { description: "buy milk", lastDescription: null } }),
      { tasks: [task()], projects: [] },
    );
    expect(added.lead).toBe("You added a description");
    expect(added.contentPreview).toBe("buy milk");
    expect(added.detail).toBeUndefined();
    expect(added.trailingLead).toBe("to");
    expect(added.trailingSubject?.label).toBe("Buy milk");

    const changed = describeEventLine(
      event({
        eventType: "updated",
        extra: { description: "get the good milk", lastDescription: "buy milk" },
      }),
      { tasks: [task()], projects: [] },
    );
    expect(changed.lead).toBe("You changed the description of");
    expect(changed.subject?.label).toBe("Buy milk");
    expect(changed.detail).toBe("to");
    expect(changed.contentPreview).toBe("get the good milk");

    const removed = describeEventLine(
      event({ eventType: "updated", extra: { description: null, lastDescription: "buy milk" } }),
      { tasks: [task()], projects: [] },
    );
    expect(removed.lead).toBe("You removed the description");
    expect(removed.contentPreview).toBe("buy milk");
    expect(removed.detail).toBeUndefined();
    expect(removed.trailingLead).toBe("from");
    expect(removed.trailingSubject?.label).toBe("Buy milk");
  });

  it("resolves a moved Task's destination Project as its own linked chip", () => {
    const line = describeEventLine(
      event({
        eventType: "moved",
        extra: { projectId: "p1", lastProjectId: null, content: "Buy milk" },
      }),
      { tasks: [task()], projects: [project()] },
    );
    expect(line.lead).toBe("Moved");
    expect(line.subject?.label).toBe("Buy milk");
    expect(line.trailingLead).toBe("to");
    expect(line.trailingSubject).toEqual({
      glyph: "#",
      label: "Groceries",
      href: "/todo/projects/p1",
    });
  });

  // CMT-06, re-driven live (flow 5): `{content}` is an unquoted, clickable
  // preview chip in Todoist's own DOM — `contentPreview`, never a quoted
  // `detail` string.
  it("CMT-06: You commented {content} on {task}, content unquoted", () => {
    const line = describeEventLine(
      event({
        objectType: "comment",
        objectId: "c1",
        taskId: "t1",
        eventType: "added",
        extra: { text: "sounds good", taskContent: "Buy milk" },
      }),
      { tasks: [task()], projects: [] },
    );
    expect(line.lead).toBe("You commented");
    expect(line.contentPreview).toBe("sounds good");
    expect(line.detail).toBeUndefined();
    expect(line.trailingLead).toBe("on");
    expect(line.trailingSubject?.label).toBe("Buy milk");
  });

  it("suppresses the Comment's own Task chip on that Task's own Activity view", () => {
    const line = describeEventLine(
      event({
        objectType: "comment",
        objectId: "c1",
        taskId: "t1",
        eventType: "added",
        extra: { text: "sounds good" },
      }),
      { tasks: [], projects: [] },
      "t1",
    );
    expect(line.lead).toBe("You commented");
    expect(line.trailingSubject).toBeUndefined();
    expect(line.subject).toBeUndefined();
  });

  it("CMT-06: You deleted a comment from {task}, with no comment body shown", () => {
    const line = describeEventLine(
      event({
        objectType: "comment",
        objectId: "c1",
        taskId: "t1",
        eventType: "deleted",
        extra: { text: "sounds good", taskContent: "Buy milk" },
      }),
      { tasks: [task()], projects: [] },
    );
    expect(line.lead).toBe("You deleted a comment");
    expect(line.trailingLead).toBe("from");
    expect(line.trailingSubject?.label).toBe("Buy milk");
    expect(line.detail).toBeUndefined();
  });

  // CMT-06 (re-driven live, flow 5) reverses this: Todoist records no
  // Event at all for a comment edit, so use-comments.ts no longer records
  // one either. This shape can still turn up from an old store or a
  // restored backup written before that fix — `describeEventLine` still
  // renders it safely rather than crashing, but `isRenderableEvent` below
  // is what actually keeps it out of the feed a reader sees.
  it("still renders a comment 'updated' Event safely, for an old stored shape this app no longer writes", () => {
    const line = describeEventLine(
      event({ objectType: "comment", objectId: "c1", eventType: "updated" }),
      { tasks: [], projects: [] },
    );
    expect(line.lead).toBe("Edited a comment on");
  });

  it("describes a Project being renamed", () => {
    const line = describeEventLine(
      event({
        objectType: "project",
        objectId: "p1",
        eventType: "updated",
        extra: { name: "New Name", lastName: "Old Name" },
      }),
      { tasks: [], projects: [] },
    );
    expect(line.lead).toBe("Renamed");
    expect(line.detail).toBe('from "Old Name" to "New Name"');
    expect(line.subject?.label).toBe("New Name");
  });

  it("names a Section, linking to its parent Project when one resolves", () => {
    const line = describeEventLine(
      event({
        objectType: "section",
        objectId: "s1",
        projectId: "p1",
        eventType: "archived",
        extra: { name: "Errands" },
      }),
      { tasks: [], projects: [project()] },
    );
    expect(line.subject).toEqual({ glyph: "▭", label: "Errands", href: "/todo/projects/p1" });
  });
});

describe("isRenderableEvent", () => {
  // CMT-06: the one Event shape this app must hide from a reader entirely
  // — Todoist has no equivalent line to show for a comment edit, so an old
  // "updated" comment Event (from a store or backup written before this
  // fix) renders nothing rather than the "Edited a comment" line this app
  // used to show.
  it("is false for a comment's 'updated' Event", () => {
    expect(isRenderableEvent(event({ objectType: "comment", eventType: "updated" }))).toBe(false);
  });

  it("is true for every other comment Event", () => {
    expect(isRenderableEvent(event({ objectType: "comment", eventType: "added" }))).toBe(true);
    expect(isRenderableEvent(event({ objectType: "comment", eventType: "deleted" }))).toBe(true);
  });

  it("is true for a Task's own 'updated' Event — only a Comment's is suppressed", () => {
    expect(isRenderableEvent(event({ objectType: "task", eventType: "updated" }))).toBe(true);
  });
});

describe("eventDayHeading", () => {
  it("reads 'Today' for an Event that occurred today", () => {
    expect(eventDayHeading(new Date().toISOString())).toBe("Today");
  });

  it("reads an absolute day for an Event further in the past", () => {
    expect(eventDayHeading("2020-01-01T00:00:00.000Z")).not.toBe("Today");
    expect(eventDayHeading("2020-01-01T00:00:00.000Z")).not.toBe("Yesterday");
  });
});

describe("groupEventsByDay", () => {
  it("groups consecutive same-day Events together, preserving order", () => {
    const events = [
      event({ id: "a", occurredAt: "2020-01-02T10:00:00.000Z" }),
      event({ id: "b", occurredAt: "2020-01-02T09:00:00.000Z" }),
      event({ id: "c", occurredAt: "2020-01-01T09:00:00.000Z" }),
    ];

    const groups = groupEventsByDay(events);

    expect(groups).toHaveLength(2);
    expect(groups[0]?.[1].map((e) => e.id)).toEqual(["a", "b"]);
    expect(groups[1]?.[1].map((e) => e.id)).toEqual(["c"]);
  });

  it("returns an empty list for no Events", () => {
    expect(groupEventsByDay([])).toEqual([]);
  });
});
