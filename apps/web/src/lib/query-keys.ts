/**
 * Query keys shared across the Entry store, History, and the Sync loop
 * (ticket 38) — pulled out on their own so `use-sync-loop.ts`,
 * `entry-store-layout.tsx`, and `use-history.ts` can all reference the same
 * key without importing one another and creating a cycle.
 */
export const ENTRY_STORE_QUERY_KEY = ["entry-store"] as const;
export const ENTRIES_QUERY_KEY = ["entries"] as const;
export const SYNC_QUERY_KEY = ["sync"] as const;
// Issue #98: `GET /v1/models`, the Question composer's own model picker.
export const MODELS_QUERY_KEY = ["models"] as const;

// Issue #203: `GET /v1/config` (server/src/settings.rs), the AI and Sync
// sections' own "On the server" sub-groups. Flat and unpaginated, mirroring
// MODELS_QUERY_KEY — there is exactly one settings row per Server, the same
// "one thing, not a list" shape `/v1/models` already has. `use-server-config.ts`
// invalidates this prefix after every successful `PATCH /v1/config`, which
// is also what makes a second mounted section (AI and Sync both read this
// key) refetch the same write without a second round trip of its own.
export const CONFIG_QUERY_KEY = ["config"] as const;

/**
 * Digest's keys (issue #71), kept here rather than inline in
 * `digest-page.tsx`/`digest-reader-page.tsx` the way Reflection's own keys
 * ended up scattered across `reflection-page.tsx` and `sessions-page.tsx` —
 * that scatter is drift this file exists to avoid, not a precedent to
 * repeat. `digestQueryKey(period)` is what the cards page's three
 * `useQuery` calls key on; `digestAtQueryKey(period, date)` extends it
 * (prefix-invalidatable — TanStack Query's default array-prefix match) for
 * the reader page's single Digest, so invalidating `digestQueryKey("day")`
 * also invalidates every `digestAtQueryKey("day", ...)` already in the
 * cache without either page needing to know the other's key shape.
 */
export function digestQueryKey(period: string) {
  return ["digest", period] as const;
}

export function digestAtQueryKey(period: string, date: string) {
  return ["digest", period, date] as const;
}

/**
 * Issue #79's regression fix: reflection-page.tsx's Grounding-id lookup
 * (`EntryStoreOutletContext.getEntries`, ADR 0013) keyed on the exact,
 * sorted, deduplicated set of ids it's resolving — not on the Session id,
 * so two different asks that happen to ground in the same ids share a
 * cache entry, and a Conversation that grows a new turn with new ids gets
 * a new key (and so a fresh fetch) for free from TanStack Query's own key
 * equality, with no invalidation wiring needed on this end. A child of
 * ENTRIES_QUERY_KEY, mirroring `[...ENTRIES_QUERY_KEY, "search", query]`
 * above — same reasoning: this reads Entries the same local store `list()`
 * and `search()` do, just by id instead of by page or by word.
 */
export function groundingEntriesQueryKey(ids: string[]) {
  return [...ENTRIES_QUERY_KEY, "grounding", ids] as const;
}

/**
 * Issue #142: a date Reference's own "does this day have anything to link
 * to?" check (`dayHasEntries`, day-has-entries.ts). A child of
 * ENTRIES_QUERY_KEY, same reasoning as `groundingEntriesQueryKey` above —
 * this reads Entries the same local store does, just keyed by day rather
 * than by id set. Keyed on the day alone, not the Device's UTC offset too:
 * the offset is read once per Device per session (deviceUtcOffsetMinutes,
 * entry-day.ts) and does not vary per Reference, so folding it into the key
 * would only ever produce one value in practice while making every day's
 * cache entry harder to read in devtools.
 */
export function dayHasEntriesQueryKey(dayKey: string) {
  return [...ENTRIES_QUERY_KEY, "day-has-entries", dayKey] as const;
}

/**
 * Issue #143: an Entry Reference's own "what does the target look like right
 * now?" probe (`getEntry`, entry-store-layout.tsx), which the chip
 * (entry-row.tsx's `EntryReferenceLink`) resolves through. A child of
 * ENTRIES_QUERY_KEY, same shape as `dayHasEntriesQueryKey` above — this
 * reads Entries the same local store does, just keyed by the target's id
 * rather than by day. Keyed on that id alone, so every chip anywhere in the
 * app pointing at the same Entry shares one cache entry and the probe runs
 * at most once per distinct target, not once per occurrence.
 *
 * `refreshNewestEntriesPage` (entries-pagination.ts) invalidates this same
 * prefix on every local write, the same way it does for Search — that is
 * what makes a chip's snippet live rather than a snapshot: editing the
 * target invalidates its cache entry, so every mounted chip pointing at it
 * refetches and shows the new text.
 */
export function entryReferenceQueryKey(entryId: string) {
  return [...ENTRIES_QUERY_KEY, "entry-reference", entryId] as const;
}

/**
 * Issue #147: a day's own "what Refers to me?" lookup (`dayReferrers`,
 * day-referrers.ts) — the reverse of `dayHasEntriesQueryKey` above. A
 * child of ENTRIES_QUERY_KEY for the same reason every sibling key here
 * is: this reads Entries the same local store does, just by which day's
 * text they match rather than by page, id set, or single id. Keyed on the
 * day alone, same reasoning as `dayHasEntriesQueryKey`.
 *
 * `refreshNewestEntriesPage` (entries-pagination.ts) invalidates this same
 * prefix on every local write, the same way it already does for Search and
 * `entryReferenceQueryKey` — a new `[[date]]` Reference, or removing/editing
 * an Entry that carried one, has to be reflected in what a day reports it's
 * Referred by.
 */
export function dayReferrersQueryKey(dayKey: string) {
  return [...ENTRIES_QUERY_KEY, "day-referrers", dayKey] as const;
}

/**
 * Issue #168: Todo's active Tasks (TaskStore.list(), ADR 0047), read by
 * use-tasks.ts. Unlike ENTRIES_QUERY_KEY, this has no paging sibling —
 * TaskStore.list() returns the whole active list in one call, because Todo
 * has nothing like History's fifty-at-a-time window (issue #79) to key a
 * page around; see tasks-refresh.ts's own header for why that absence is
 * what makes its refresh function simpler than refreshNewestEntriesPage,
 * not merely a smaller copy of it.
 */
export const TASKS_QUERY_KEY = ["tasks"] as const;

/**
 * Completed Tasks (TaskStore.listCompleted()), the other half of Todo's
 * Inbox (issue #168's own acceptance criterion that a completed Task stays
 * "findable and restorable afterwards," not just for the toast's
 * lifetime). A child of TASKS_QUERY_KEY, not a sibling — completing or
 * uncompleting a Task moves it between the active and completed lists at
 * once, so tasks-refresh.ts's single invalidateQueries({ queryKey:
 * TASKS_QUERY_KEY }) call (TanStack's default array-prefix match) already
 * catches this key too, the same way digestAtQueryKey rides along with
 * digestQueryKey's own invalidation above.
 */
export const COMPLETED_TASKS_QUERY_KEY = [...TASKS_QUERY_KEY, "completed"] as const;

/**
 * A Project's own top-level Tasks (TaskStore.listByProject(projectId)),
 * `projectId: null` meaning Inbox — issue #171. A child of TASKS_QUERY_KEY,
 * not a sibling, for the same reason COMPLETED_TASKS_QUERY_KEY is: any
 * write that changes what belongs in one Project's list (a completion, a
 * move, a delete) already invalidates the bare TASKS_QUERY_KEY prefix via
 * tasks-refresh.ts's `refreshTasks`, and TanStack's default prefix match
 * catches every `tasksInProjectQueryKey(...)` entry the same way it
 * already catches COMPLETED_TASKS_QUERY_KEY — no second invalidation call
 * needed anywhere a Task write already happens.
 *
 * Not eagerly loaded the way `tasks`/`completedTasks` are: Inbox used to
 * read the flat, cross-Project `tasks` array directly (issue #168), but
 * that reads every Task in every Project once Tasks can live in one
 * (TaskStore.list()'s own doc comment on why its meaning stays global
 * rather than narrowing to "Inbox"). TodoPage's own Inbox/Project views
 * key a `useQuery` on this instead, per whichever scope is currently open
 * — the same "page-scoped, not app-wide" reasoning `sectionsQueryKey`
 * above already carries for a Project's own Sections.
 */
export function tasksInProjectQueryKey(projectId: string | null) {
  return [...TASKS_QUERY_KEY, "project", projectId] as const;
}

/**
 * A Task's own direct sub-tasks (TaskStore.listChildren(parentId)) —
 * issue #171. A child of TASKS_QUERY_KEY for the identical reason
 * `tasksInProjectQueryKey` above is: every Task write already invalidates
 * the bare prefix, so a sub-task list needs no bespoke invalidation of its
 * own. Keyed per parent, not eagerly loaded, mirroring
 * `tasksInProjectQueryKey`: a sub-task list is only ever read by whichever
 * Task's own row is currently rendering its children.
 */
export function taskChildrenQueryKey(parentId: string) {
  return [...TASKS_QUERY_KEY, "children", parentId] as const;
}

/**
 * Issue #170: every active Label (LabelStore.list()), read by
 * use-labels.ts. A flat key, unpaginated and with no completed sibling —
 * mirroring TASKS_QUERY_KEY's own reasoning rather than
 * COMPLETED_TASKS_QUERY_KEY's: a Label has no active/completed split for a
 * second key to distinguish.
 */
export const LABELS_QUERY_KEY = ["labels"] as const;

/**
 * Issue #171: every active Project (ProjectStore.listProjects()), read by
 * use-projects.ts. Flat and unpaginated, mirroring LABELS_QUERY_KEY —
 * `listProjects()` already returns every Project regardless of `archived`
 * (that store's own doc comment: "a personal Project list is small"), so
 * there is no second, archived-only key the way COMPLETED_TASKS_QUERY_KEY
 * exists for Tasks.
 */
export const PROJECTS_QUERY_KEY = ["projects"] as const;

/**
 * A Project's own Sections (ProjectStore.listSections(projectId)) — keyed
 * per Project rather than loaded eagerly and flat the way `projects`/
 * `tasks`/`labels` are, because a Section is only ever read by whichever
 * one Project's own view is open (use-projects.ts's own `listSections`
 * doc comment), the same "page-scoped, not app-wide" reasoning
 * `dayHasEntriesQueryKey`/`entryReferenceQueryKey` above already carry for
 * an Entry Reference. Every Section mutation invalidates the bare
 * `["sections"]` prefix rather than one Project's own key specifically
 * (use-projects.ts) — cheap and correct at this app's personal scale, and
 * simpler than threading which Project a given Section write belongs to
 * through every mutation's own success handler.
 */
export function sectionsQueryKey(projectId: string) {
  return ["sections", projectId] as const;
}

/**
 * Issue #180: every live Comment across every Task (CommentStore.list()),
 * read by use-comments.ts. Flat and unpaginated, mirroring
 * LABELS_QUERY_KEY — a personal task list's own Comments sit at the same
 * scale Labels and Tasks themselves already do, not History's (ADR
 * 0016's own reasoning for why *that* list() gained paging). One key for
 * the whole app rather than one per Task: task-row.tsx's own
 * comment-count badge needs every Task's count at once, and the Task
 * detail view's own thread narrows this same list to one Task's Comments
 * client-side (comment-counts.ts's `commentsForTask`) rather than this
 * file growing a second, per-Task key the way `taskChildrenQueryKey`
 * exists for Tasks — a personal Comment list is small enough that a
 * second round trip buys nothing list() itself doesn't already have in
 * memory.
 */
export const COMMENTS_QUERY_KEY = ["comments"] as const;

/**
 * Issue #184: every Event across the whole app (EventStore.list()), read
 * by use-events.ts — the view across everything (CONTEXT.md's Event
 * entry). Flat and unpaginated, mirroring COMMENTS_QUERY_KEY: a personal
 * task list's own activity log sits at the same scale Comments already
 * do, and retention is unlimited (issue #184's own acceptance
 * criterion), not paged the way History's ENTRIES_QUERY_KEY is.
 */
export const EVENTS_QUERY_KEY = ["events"] as const;

/**
 * Issue #185: every active Filter (FilterStore.list()), read by
 * use-filters.ts. Flat and unpaginated, mirroring LABELS_QUERY_KEY — a
 * personal task list's own saved Filters sit at the same small scale
 * Labels and Projects already do, and there is no archived/active split
 * the way COMPLETED_TASKS_QUERY_KEY exists for Tasks.
 */
export const FILTERS_QUERY_KEY = ["filters"] as const;
