/**
 * Issue #352: the Device's memory of which of Todo's own views (Inbox,
 * Today, a specific Project, a specific Filter, ...) the reader was last
 * on — what a bare `/todo` (App.tsx's own redirect) resolves to before
 * falling back to Inbox, the same "before the reader notices it was ever
 * bare" job `last-session.ts`'s own header comment describes for a bare
 * `/reflect`.
 *
 * `localStorage`, not `sessionStorage` (`last-session.ts`'s own choice)
 * and not a module-level variable (`last-destination.ts`'s own choice,
 * reversing `last-session.ts` again in the opposite direction) — this is
 * the third module in the family, and it takes the third position on the
 * same persistence axis those two already staked out the other two ends
 * of. `last-session.ts` chose `sessionStorage` because a fresh tab
 * resuming a *stranger's* Session (or `use-history-search.ts`'s Search)
 * would be a surprising, unearned claim about that tab; `last-
 * destination.ts` went further still and chose no persistence at all,
 * because a cold load genuinely has no Destination to continue and an
 * absent Continue card is the *correct* reading of that state, not a
 * missed one. Todo has neither excuse: issue #352's own acceptance
 * criteria name the exact thing those two modules were built to avoid as
 * the explicit requirement here instead — "the memory survives a full
 * app restart" — because unlike a Session someone else might resume, or a
 * "Continue" card with nothing to continue, there is no reading of a
 * fresh launch where "always Inbox" is the reader's own correct default;
 * it is the same wrong default issue #352 exists to fix, just reached by
 * a different door. `sessionStorage` or a module variable would both
 * still hand back "nothing remembered" on every relaunch, which is
 * exactly the bug, not a smaller version of the fix.
 *
 * Every operation is wrapped in try/catch and degrades to "nothing
 * remembered" rather than throwing — the identical posture `last-
 * session.ts` and `settings.ts` (this codebase's other `localStorage`
 * user) already take: `localStorage` throws on write in Safari private
 * browsing, and can throw on read too, and Todo must keep working with no
 * memory at all rather than break because this convenience couldn't be
 * kept.
 */
const LAST_TODO_VIEW_KEY = "meologue.last-todo-view";

/**
 * The subset of Todo's views worth returning to — every `TodoBackgroundView`
 * (`todo-page.tsx`) except `"search"`: that file's own header comment on
 * `backgroundView` is why a Task detail address never appears here either
 * (it carries no `view` of its own to record). `projectId`/`filterId` are
 * the same "which one" fields `TodoBackgroundView` already carries for
 * those two views, narrowed to what a `JSON.stringify` round-trip can
 * actually prove: a plain string id, or (for a Filter) `null` for
 * `/todo/filters/new`'s still-unsaved query.
 */
export type LastTodoView =
  | { view: "inbox" }
  | { view: "today" }
  | { view: "upcoming" }
  | { view: "projects" }
  | { view: "project"; projectId: string }
  | { view: "filters" }
  | { view: "filter"; filterId: string | null }
  | { view: "labels" }
  | { view: "activity" }
  | { view: "browse" };

/** Every `LastTodoView["view"]` value, for validating a stored payload's shape on read. */
const KNOWN_VIEWS: ReadonlySet<string> = new Set([
  "inbox",
  "today",
  "upcoming",
  "projects",
  "project",
  "filters",
  "filter",
  "labels",
  "activity",
  "browse",
]);

/**
 * Whether `value` is a `LastTodoView` this module actually wrote — not
 * just "valid JSON," but the exact shape each variant above requires.
 * Anything else (a future format, a hand-edited value, a key some other
 * app version used differently) reads as "nothing remembered" rather than
 * being trusted half-parsed, the same "unresolvable is unresolvable, not
 * guessed at" rule `todo-page.tsx`'s own Inbox fallback already applies
 * to a Task's own address with no `location.state` to recover one from.
 */
function isLastTodoView(value: unknown): value is LastTodoView {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { view } = value as { view?: unknown };
  if (typeof view !== "string" || !KNOWN_VIEWS.has(view)) {
    return false;
  }
  if (view === "project") {
    return typeof (value as { projectId?: unknown }).projectId === "string";
  }
  if (view === "filter") {
    const { filterId } = value as { filterId?: unknown };
    return filterId === null || typeof filterId === "string";
  }
  return true;
}

/**
 * The remembered view, or `null` if none is stored, the stored value is
 * corrupt, or storage refused the read.
 */
export function readLastTodoView(): LastTodoView | null {
  try {
    const raw = localStorage.getItem(LAST_TODO_VIEW_KEY);
    if (raw === null) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    return isLastTodoView(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Remembers `view` as the one a bare `/todo` should resolve to next. */
export function writeLastTodoView(view: LastTodoView): void {
  try {
    localStorage.setItem(LAST_TODO_VIEW_KEY, JSON.stringify(view));
  } catch {
    // Storage refused the write (e.g. private browsing) — Todo still works
    // for this visit, it just won't be resumed automatically later.
  }
}

/**
 * Forgets the remembered view. Not currently called by anything in this
 * app — kept for the same reason `last-destination.ts` keeps its own
 * unused `clearLastDestination`: a module that can remember but never
 * forget is a smaller interface than the one callers will eventually
 * need, the first time some future invalidation path needs this before
 * the next write happens to overwrite it.
 */
export function clearLastTodoView(): void {
  try {
    localStorage.removeItem(LAST_TODO_VIEW_KEY);
  } catch {
    // Nothing to do — if the write above never landed, there's nothing
    // stored to remove either.
  }
}

/**
 * The path a bare `/todo` (App.tsx) should redirect to — the remembered
 * view's own address, or `/todo/inbox`, the identical fallback App.tsx's
 * `<Navigate>` already pointed at unconditionally before issue #352. This
 * only reconstructs an address from what was stored; it cannot know
 * whether that Project/Filter still exists (this module has no access to
 * Todo's own data) — `todo-page.tsx`'s own `backgroundView` is what
 * catches a stale id once the real Project/Filter list is available, the
 * same Inbox fallback reused rather than a second one written here.
 */
export function lastTodoPath(): string {
  const view = readLastTodoView();
  if (view === null) {
    return "/todo/inbox";
  }
  if (view.view === "project") {
    return `/todo/projects/${view.projectId}`;
  }
  if (view.view === "filter") {
    return view.filterId === null ? "/todo/filters/new" : `/todo/filters/${view.filterId}`;
  }
  return `/todo/${view.view}`;
}
