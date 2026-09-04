/**
 * The Task detail route's own address (issue #178's own acceptance
 * criterion: "A Task has its own address"). `/todo/task/<slug>-<id>`,
 * mirroring Todoist's own `/app/task/<slug>-<id>` shape (this ticket's own
 * "reference behaviour, observed live") rather than a bare `/todo/task/:id`
 * — the slug carries no meaning a lookup needs (every parser below reads
 * only the trailing id), but it's what makes a copied link, a browser tab
 * title, or a history entry read as "buy milk" instead of an opaque uuid.
 *
 * Kept in its own module rather than inline in todo-page.tsx/task-row.tsx:
 * both the row (building a link to open) and the detail view (building one
 * to copy, and reading the current URL's own id back out of it) need the
 * identical slugify/parse pair, and a route's own shape belongs in one
 * place rather than encoded twice and left to agree by convention.
 */
import type { Task } from "@meologue/core";

// `mintId()` (@meologue/core's id.ts) always mints a uuidv7 in the
// canonical 8-4-4-4-12 hyphenated form — the one fixed shape this regex
// leans on to find *where the id starts* inside `<slug>-<id>`, since the
// id's own hyphens make a naive "split on the last hyphen" wrong the
// moment a slug is also present. Case-insensitive: `mintId` always lowers,
// but a hand-typed or copy-pasted URL might not.
const TRAILING_UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/**
 * Turns a Task's `content` into the slug half of its own address. Lower-
 * cased, non-alphanumeric runs collapsed to a single `-`, and capped well
 * short of a URL's practical length limits — long enough to still read as
 * the Task's own words, short enough that a very long first line never
 * produces an unwieldy link. Never contains a `.`: App.tsx's own top
 * comment names that as the one character no `/todo/*` segment may carry
 * (Capacitor's html5mode fallback treats a dot in the last segment as a
 * request for a real file), and collapsing every non-alphanumeric run to
 * `-` already strips it along with every other punctuation mark.
 */
export function taskDetailSlug(content: string): string {
  const slug = content
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  // A Task can be empty of anything slug-worthy (rare — content is never
  // blank per addTask/renameTask's own trim-and-ignore rule, but every
  // character in it could still be punctuation) — "task" is a plain,
  // honest filler rather than an empty path segment, which would collapse
  // `/todo/task/-<id>` into something that reads as malformed.
  return slug === "" ? "task" : slug;
}

/** The full `/todo/task/<slug>-<id>` address for `task` — see this module's own header comment. */
export function taskDetailPath(task: Task): string {
  return `/todo/task/${taskDetailSlug(task.content)}-${task.id}`;
}

/**
 * Recovers a Task's id from the `:taskSlugId` route param — the inverse of
 * `taskDetailPath` above, tolerant of a slug that changed or is missing
 * entirely (a reader who renamed the Task after copying its link, or typed
 * a bare id by hand): only the trailing uuid is ever read, never the slug
 * text itself, so an out-of-date slug in a bookmarked URL still resolves
 * to the right Task. `null` when the param carries no recognisable id at
 * all — the caller's job is to treat that the same as "Task not found."
 */
export function taskIdFromParam(param: string): string | null {
  const match = TRAILING_UUID.exec(param);
  const id = match?.[1];
  return id === undefined ? null : id.toLowerCase();
}
