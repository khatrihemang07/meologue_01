import type { Task } from "@meologue/core";
import { describe, expect, it } from "vitest";
import {
  hasCommentReplyIntent,
  taskDetailPath,
  taskDetailSlug,
  taskIdFromParam,
} from "./task-detail-route";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "11111111-1111-7111-8111-111111111111",
    deviceId: "device-a",
    content: "buy milk",
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

describe("taskDetailSlug", () => {
  it("lowercases and collapses non-alphanumeric runs to a single hyphen", () => {
    expect(taskDetailSlug("Buy Milk!")).toBe("buy-milk");
  });

  it("strips leading and trailing hyphens", () => {
    expect(taskDetailSlug("  --Call Mum-- ")).toBe("call-mum");
  });

  it("never contains a '.' — App.tsx's own no-dot-in-a-/todo/*-segment rule", () => {
    expect(taskDetailSlug("v1.2.3 release notes")).not.toContain(".");
  });

  it("falls back to 'task' for content with nothing slug-worthy", () => {
    expect(taskDetailSlug("!!!")).toBe("task");
  });

  it("caps length well short of an unwieldy URL", () => {
    const long = "a".repeat(200);
    expect(taskDetailSlug(long).length).toBeLessThanOrEqual(60);
  });
});

describe("taskDetailPath / taskIdFromParam", () => {
  it("round-trips a Task's id through its own address", () => {
    const t = task({ content: "Buy milk" });
    const path = taskDetailPath(t);

    expect(path).toBe(`/todo/task/buy-milk-${t.id}`);
    expect(taskIdFromParam(path.split("/").pop() as string)).toBe(t.id);
  });

  it("recovers the id even when the slug is stale or missing — only the trailing uuid is ever read", () => {
    const t = task();
    expect(taskIdFromParam(`some-old-slug-${t.id}`)).toBe(t.id);
    expect(taskIdFromParam(t.id)).toBe(t.id);
  });

  it("is case-insensitive, and always returns the id lowercased", () => {
    const t = task();
    expect(taskIdFromParam(t.id.toUpperCase())).toBe(t.id);
  });

  it("returns null for a param carrying no recognisable id", () => {
    expect(taskIdFromParam("not-a-task-id")).toBeNull();
    expect(taskIdFromParam("")).toBeNull();
  });
});

// Issue #306: `taskDetailPath`'s own `commentIntent` option, and
// `hasCommentReplyIntent`'s read of it back out of a URL's search params —
// the door a Task row's comment badge opens onto "land in the thread,
// ready to reply" (ROW-08, matching Todoist's own `?intent=reply`).
describe("taskDetailPath commentIntent / hasCommentReplyIntent", () => {
  it("appends ?intent=reply only when commentIntent is requested", () => {
    const t = task({ content: "Buy milk" });

    expect(taskDetailPath(t, { commentIntent: true })).toBe(
      `/todo/task/buy-milk-${t.id}?intent=reply`,
    );
    expect(taskDetailPath(t, { commentIntent: false })).toBe(`/todo/task/buy-milk-${t.id}`);
    // The default from earlier callers (`taskDetailPath(t)`, no options at
    // all) is unaffected — a bookmarked or copied link stays the bare
    // address, not something a reader could mistake for carrying an
    // instruction they never asked to be issued.
    expect(taskDetailPath(t)).toBe(`/todo/task/buy-milk-${t.id}`);
  });

  it("still recovers the Task's id when the address carries the intent — the id parser never sees the query string", () => {
    const t = task();
    const path = taskDetailPath(t, { commentIntent: true });
    const [routeParam] = path.split("?");

    expect(taskIdFromParam((routeParam as string).split("/").pop() as string)).toBe(t.id);
  });

  it("reads ?intent=reply back out of a URL's search params", () => {
    expect(hasCommentReplyIntent(new URLSearchParams("intent=reply"))).toBe(true);
  });

  it("is false for no intent at all, or an unrecognised one — an exact match, not a guess", () => {
    expect(hasCommentReplyIntent(new URLSearchParams(""))).toBe(false);
    expect(hasCommentReplyIntent(new URLSearchParams("intent=edit"))).toBe(false);
    expect(hasCommentReplyIntent(new URLSearchParams("Intent=reply"))).toBe(false);
  });
});
