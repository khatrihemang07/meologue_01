import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Mirrors the `Entry` type (../types.ts) exactly. ADR 0007 originally
 * rejected adding columns ahead of an editing design ("dormant columns
 * would commit us to semantics nobody has designed yet") — that reasoning
 * held, but the design that eventually landed (ADR 0028) needs exactly one
 * of the columns it was guarding against: `deleted_at`, added by migration
 * 3 (`migrations/0001_entry_deleted_at.sql`). `rev`, the other column ADR
 * 0007 named, was rejected on its own merits by ADR 0028 and never got a
 * column here. `updated_at` — the third — was rejected by that same ADR
 * for *ordering Sync's own conflicts*, but issue #196 revisits that
 * decision deliberately (ADR 0065 records it): Merge (issue
 * #199) needs a last-changed timestamp to read, even though Sync itself
 * still never compares one. See `updatedAt` below and
 * `migrations/0014_updated_at.sql`.
 */
export const entries = sqliteTable(
  "entries",
  {
    id: text("id").primaryKey(),
    deviceId: text("device_id").notNull(),
    body: text("body").notNull(),
    createdAt: text("created_at").notNull(),
    // Issue #196: last-changed timestamp, added by migration 17
    // (`migrations/0014_updated_at.sql`) as a plain `ALTER TABLE ADD
    // COLUMN` — no SQL-level `NOT NULL` here, mirroring `tasks.dayOrder`'s
    // own reasoning below: the migration's backfill runs unconditionally
    // on every open rather than relying on a constraint SQLite would
    // enforce on write. `.notNull()` here describes the TS-level shape
    // every row is guaranteed to have *after* that backfill, the same gap
    // between this file's declaration and the real column's own SQL
    // constraint `dayOrder`'s comment already explains.
    updatedAt: text("updated_at").notNull(),
    seq: integer("seq"),
    syncedAt: text("synced_at"),
    // Set when this Entry is a tombstone (ADR 0028): `A -> nothing` still
    // has to be a row with a `seq` so the deletion can travel to another
    // Device, so "removed" is represented as this timestamp being set and
    // `body` blanked, never as the row's absence.
    deletedAt: text("deleted_at"),
  },
  (table) => [
    // Supports the contract's list() ordering (createdAt desc, id desc).
    // SQLite can walk a plain ascending index backwards, so one index
    // serves both directions.
    index("entries_created_at_id_idx").on(table.createdAt, table.id),
  ],
);

/**
 * Mirrors the `Task` type (../task-types.ts) exactly (ADR 0047: a Task is
 * a second root noun, not an Entry with fields, so it gets its own table
 * rather than new columns on `entries`). No collaboration column is
 * present here, and none is ever added by an omission — `responsibleUid`,
 * `workspaceId`, a role, an `isShared` flag: meologue is one person's
 * journal and one person's task list, and a column for a feature nobody
 * asked for doesn't sit here quietly "for later." A dead column doesn't
 * cost nothing while it waits; it's schema every future migration and
 * every store method has to keep explaining the absence of use for. This
 * is the same "dormant columns" refusal `entries`' own comment above
 * describes, made permanent rather than provisional, because collaboration
 * was never even sketched the way editing was before ADR 0028 landed.
 *
 * Date, deadline and priority were added by issue #169;
 * `projectId`/`sectionId`/`parentId` by issue #171, behind their own
 * migration (version 9) — sequencing the tickets this way keeps each
 * migration's blast radius to the one thing it's actually adding. Duration
 * (also added by #169) was removed again by issue #179: it existed to
 * serve calendar and time-blocking views this app never built, so it had
 * nowhere to be. Migration 10 (../sqlite/migrations/index.ts) drops the
 * column; this table no longer declares it.
 */
export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    deviceId: text("device_id").notNull(),
    content: text("content").notNull(),
    // Null while active. A timestamp, not a boolean — see Task's own doc
    // comment (../task-types.ts) for why completion needs a *time*.
    completedAt: text("completed_at"),
    // Fractional index (../order-key.ts) — sorts lexicographically as
    // plain text, no numeric column involved.
    orderKey: text("order_key").notNull(),
    // A second, independent fractional index — the Today view's own
    // manual order (issue #182, ../task-types.ts's own `dayOrder` doc
    // comment). Migration 13 backfills every pre-#182 row from its own
    // `order_key` rather than leaving it null, since this column has no
    // SQL-level `NOT NULL` of its own (see that migration's own comment
    // for why — the same reasoning `description` below already needed).
    dayOrder: text("day_order").notNull(),
    createdAt: text("created_at").notNull(),
    // Issue #196 — see `entries.updatedAt`'s own doc comment above for the
    // mechanism and for why this carries `.notNull()` despite the real
    // column having no SQL-level constraint of its own.
    updatedAt: text("updated_at").notNull(),
    seq: integer("seq"),
    syncedAt: text("synced_at"),
    // Tombstone (ADR 0028's rule, applied to Tasks) — same representation
    // as `entries.deletedAt` above, for the same reason: "removed" has to
    // travel to another Device as a row with a `seq`, not as an absence.
    deletedAt: text("deleted_at"),
    // When the user plans to do the Task (../task-types.ts's own comment
    // has the full reasoning). `YYYY-MM-DD` or floating `YYYY-MM-DDTHH:MM`
    // — never a `Z`, never an offset, unlike `created_at` above, which is a
    // real UTC instant.
    date: text("date"),
    // The hard cutoff, date-only — no time, no recurrence, ever (issue
    // #169). Independent of `date`: a Task may carry either, both, or
    // neither.
    deadline: text("deadline"),
    // 1-4, stored inverted against the UI's p1-p4 naming (Todoist's own API
    // does the same) — see ../task-types.ts's uiPriorityOf/storedPriorityOf
    // for the one named place that inversion lives. Not nullable: "no
    // priority" is priority 1 (UI p4), a real level rather than an absence,
    // so every Task — including one migrated in from before this column
    // existed — gets a default rather than a gap the app has to keep
    // special-casing.
    priority: integer("priority").notNull().default(1),
    // The Labels attached to this Task (issue #170), as a JSON array of
    // Label ids — ../task-types.ts's `labelIds` doc comment has the full
    // reasoning for why this is a serialised column on the Task's own
    // row rather than a `task_labels` join table. `{ mode: "json" }` is
    // drizzle-orm's own (de)serialisation for a JSON-shaped column,
    // rather than this store hand-rolling `JSON.parse`/`JSON.stringify`
    // at every read and write the way the FTS5 tables' raw-SQL paths have
    // to (search() below still does, for the one query that bypasses
    // drizzle entirely). `NOT NULL DEFAULT '[]'` for the same reason
    // `priority` above is `NOT NULL DEFAULT 1`: "no Labels" is a concrete
    // value, not a gap every reader has to treat as "maybe absent, maybe
    // just not loaded yet."
    labelIds: text("label_ids", { mode: "json" }).notNull().default("[]").$type<string[]>(),
    // The literal recurrence rule the user typed (issue #170's recurrence
    // engine, ../recurrence/), or null for a Task that doesn't repeat —
    // ../task-types.ts's `dateString` doc comment has the full reasoning
    // for why this column, not `date`, is the thing ../recurrence/'s
    // engine treats as the truth. Nullable with no DEFAULT, the same
    // shape `date`/`deadline` above take, not `priority`'s
    // NOT NULL DEFAULT: "doesn't repeat" is the absence of a rule, not a
    // concrete value the way "no priority" is a real priority level.
    dateString: text("date_string"),
    // `null` is Inbox — there is no `projects` row for it (../project-
    // types.ts's own header comment). Nullable with no DEFAULT, the same
    // shape `date`/`deadline` take: a pre-#171 row backfilled
    // by migration 9 below gets `null` from `ALTER TABLE ADD COLUMN`'s own
    // implicit default, which happens to be exactly the right value
    // (every Task that existed before Projects did was, in effect,
    // already in Inbox).
    projectId: text("project_id"),
    // At most one Section (CONTEXT.md's Section entry) — see
    // ../task-types.ts's own doc comment for why this store does not
    // itself check that `sectionId` and `projectId` agree.
    sectionId: text("section_id"),
    // The parent Task, or null for a top-level Task (CONTEXT.md's Sub-task
    // entry). Nesting depth is enforced by SqliteTaskStore.setParent
    // walking this column, not by a CHECK constraint SQLite has no way to
    // express across rows.
    parentId: text("parent_id"),
    // The Task's own words about itself, beyond `content` (issue #180) —
    // Markdown, rendered by the identical renderer an Entry's body
    // already uses. Nullable with no DEFAULT, the same shape
    // `date`/`deadline`/`projectId` above take: a pre-#180 row backfilled
    // by migration 11 below gets `null` from `ALTER TABLE ADD COLUMN`'s
    // own implicit default, which is exactly "no Description yet."
    description: text("description"),
  },
  (table) => [
    // Supports list()'s actual query: `WHERE completed_at IS NULL AND
    // deleted_at IS NULL ORDER BY order_key ASC, id ASC`. Mirrors
    // `entries_created_at_id_idx` above — a plain composite index on the
    // ORDER BY columns lets SQLite walk it directly for that ordering
    // (and for reorder()'s equality lookups on order_key/id), the same
    // way that index serves `entries.list()` despite not covering
    // `deleted_at` either: the WHERE filter is cheap to apply while
    // walking rows that are already coming back in the wanted order,
    // which is a different job than making the filter itself indexed.
    index("tasks_order_key_id_idx").on(table.orderKey, table.id),
    // Supports listByProject() — a plain index on the column its own
    // WHERE clause filters by, the same "cheap to apply while already
    // walking in the wanted order" reasoning above applies once combined
    // with the index above for the final ORDER BY.
    index("tasks_project_id_idx").on(table.projectId),
    // Supports listChildren()/listDescendants() — both filter by
    // `parent_id`, issue #171's own new query shape this table never had
    // before sub-tasks existed.
    index("tasks_parent_id_idx").on(table.parentId),
    // Supports listInSection() — the direct-membership half of
    // deleteSection()/archiveSection()'s cascade (../project-store.ts).
    index("tasks_section_id_idx").on(table.sectionId),
  ],
);

/**
 * Mirrors the `Project` type (../project-types.ts) exactly (issue #171) —
 * the same "second/third/fourth root noun gets its own table" reasoning
 * `tasks`' and `labels`' own comments above give, applied again. No
 * collaboration column, for the identical reason `tasks`' own comment
 * refuses one.
 */
export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    deviceId: text("device_id").notNull(),
    name: text("name").notNull(),
    // A hex from label-colors.ts's shared label/project/filter palette —
    // see ../project-fields.ts's assertValidProjectColour.
    colour: text("colour").notNull(),
    favourite: integer("favourite", { mode: "boolean" }).notNull().default(false),
    // Metadata-only — deliberately does not cascade to this Project's own
    // Tasks or Sections. See ../project-types.ts's `Project.archived` doc
    // comment for the contrast with `sections.archived` below.
    archived: integer("archived", { mode: "boolean" }).notNull().default(false),
    // The Project this one nests under, or null for top-level — no depth
    // cap, unlike `tasks.parentId` above.
    parentId: text("parent_id"),
    description: text("description"),
    // Fractional index (../order-key.ts) among siblings sharing the same
    // `parentId` — reused, not reinvented, exactly as `tasks.orderKey` is.
    orderKey: text("order_key").notNull(),
    createdAt: text("created_at").notNull(),
    // Issue #196 — see `entries.updatedAt`'s own doc comment above.
    updatedAt: text("updated_at").notNull(),
    seq: integer("seq"),
    syncedAt: text("synced_at"),
    // Tombstone (ADR 0028's rule, applied to Projects) — identical
    // representation to every other table's `deleted_at` above.
    deletedAt: text("deleted_at"),
  },
  (table) => [
    // Supports listProjects()'s ORDER BY and setProjectParent()'s cycle
    // walk — mirrors `tasks_order_key_id_idx` above.
    index("projects_order_key_id_idx").on(table.orderKey, table.id),
    // Supports setProjectParent()'s ancestor walk and a future
    // per-parent listing, mirroring `tasks_parent_id_idx` above.
    index("projects_parent_id_idx").on(table.parentId),
  ],
);

/**
 * Mirrors the `Section` type (../project-types.ts) exactly (issue #171).
 * Folded into `ProjectStore` rather than getting its own store class — see
 * ../project-store.ts's own header comment for why — but that is a
 * store-shape decision, not a schema one: `sections` is still its own
 * table, exactly as `labels` is its own table despite `Label` never
 * nesting either.
 */
export const sections = sqliteTable(
  "sections",
  {
    id: text("id").primaryKey(),
    deviceId: text("device_id").notNull(),
    // Required — a Section always belongs to a real Project, never Inbox
    // (../project-types.ts's `Section.projectId` doc comment).
    projectId: text("project_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    // Fractional index among siblings sharing the same `projectId` —
    // Sections are flat (CONTEXT.md), so there is only ever one sibling
    // group per Project, unlike `projects.orderKey` above.
    orderKey: text("order_key").notNull(),
    // Archiving completes every Task inside this Section and keeps this
    // flag set; unarchiving clears it without touching a single Task
    // (../project-store.ts's archiveSection/unarchiveSection).
    archived: integer("archived", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull(),
    // Issue #196 — see `entries.updatedAt`'s own doc comment above.
    updatedAt: text("updated_at").notNull(),
    seq: integer("seq"),
    syncedAt: text("synced_at"),
    // Tombstone for the Section itself — never what "deleting a Section
    // destroys every Task inside it" means; that's each of those Tasks'
    // own `deleted_at` on the `tasks` table above, set by
    // ../project-store.ts's deleteSection calling TaskStore.remove() for
    // each one it finds.
    deletedAt: text("deleted_at"),
  },
  (table) => [
    // Supports listSections()'s actual query — `WHERE project_id = ? AND
    // deleted_at IS NULL ORDER BY order_key ASC, id ASC` — and addSection's
    // twenty-cap count, both scoped by `project_id` first.
    index("sections_project_id_order_key_id_idx").on(table.projectId, table.orderKey, table.id),
  ],
);

/**
 * Mirrors the `Label` type (../label-types.ts) exactly (issue #170) — the
 * same "second root noun gets its own table" reasoning `tasks`' own
 * comment above gives for Task-vs-Entry, applied a third time. No
 * `order_key` column: unlike `tasks`, nothing asks for a manual Label
 * order (../label-store.ts's own header comment explains why list()
 * sorts alphabetically instead), so there's no fractional index for a
 * column to encode.
 */
export const labels = sqliteTable(
  "labels",
  {
    id: text("id").primaryKey(),
    deviceId: text("device_id").notNull(),
    name: text("name").notNull(),
    // A hex string from label-colors.ts's LABEL_COLOURS, validated by
    // ../label-fields.ts's assertValidLabelColour before any write
    // reaches this column — not a CHECK constraint, because the palette
    // itself is application data that can gain a swatch without a
    // migration, the same reasoning ../task-fields.ts gives for keeping
    // `priority`'s 1-4 range out of SQL.
    colour: text("colour").notNull(),
    createdAt: text("created_at").notNull(),
    // Issue #196 — see `entries.updatedAt`'s own doc comment above.
    updatedAt: text("updated_at").notNull(),
    seq: integer("seq"),
    syncedAt: text("synced_at"),
    // Tombstone (ADR 0028's rule, applied to Labels) — identical
    // representation to `entries.deletedAt`/`tasks.deletedAt` above.
    deletedAt: text("deleted_at"),
  },
  (table) => [
    // Supports list()'s actual query — see ../label-store.ts's own
    // comment for why alphabetical, not orderKey, is this table's
    // ordering. SQLite collates `name` byte-wise by default; the store's
    // `list()` does the case-insensitive comparison in JS rather than
    // relying on a `COLLATE NOCASE` index, so this index still serves the
    // query even though it isn't the exact sort the caller sees.
    index("labels_name_id_idx").on(table.name, table.id),
  ],
);

/**
 * Mirrors the `Filter` type (../filter-types.ts) exactly (issue #185) —
 * a saved query over Tasks (CONTEXT.md's Filter entry), the last of the
 * glossary's nouns to get a table. Structurally identical to `labels`
 * above for the identical reason: `deviceId`, `createdAt`, `seq`,
 * `syncedAt`, `deletedAt` are ADR 0028's sync-and-tombstone scaffolding,
 * shipped ahead of any actual Filter Sync stream — see
 * ../filter-store.ts's own header comment for why, the same argument
 * `labels`' own comment above already makes for Labels. `query` carries
 * whatever the user typed, unparsed and unvalidated at rest by this
 * table itself (validation is ../filter-fields.ts's
 * `assertValidFilterQuery`, enforced by the store's `setQuery`, never by
 * a `CHECK` constraint SQLite has no way to run a recursive-descent
 * parser inside).
 */
export const filters = sqliteTable(
  "filters",
  {
    id: text("id").primaryKey(),
    deviceId: text("device_id").notNull(),
    name: text("name").notNull(),
    // Shares LABEL_COLOURS with `projects`/`labels` above — see
    // ../filter-types.ts's `Filter.colour` doc comment.
    colour: text("colour").notNull(),
    // The literal query text (../filter-query/), never a pre-parsed tree
    // — mirrors `tasks.date_string`'s identical "the string is the
    // truth" reasoning for Recurrence, applied to a Filter's own query.
    query: text("query").notNull(),
    createdAt: text("created_at").notNull(),
    // Issue #196 — see `entries.updatedAt`'s own doc comment above for the
    // mechanism. **Client-only**: unlike every other table's `updatedAt`
    // here, `filters` has no server table and no Sync stream at all (this
    // table's own doc comment above, ../filter-store.ts's own header
    // comment) — no `server/migrations` counterpart exists for it, and no
    // Device but this one ever reads this column.
    updatedAt: text("updated_at").notNull(),
    seq: integer("seq"),
    syncedAt: text("synced_at"),
    // Tombstone (ADR 0028's rule, applied to Filters) — identical
    // representation to every other table's `deleted_at` above.
    deletedAt: text("deleted_at"),
  },
  (table) => [
    // Supports list()'s actual query — identical shape to
    // `labels_name_id_idx` above, for the identical reason: alphabetical
    // by name is this table's only ordering (../filter-store.ts's own
    // comment on why there's no `order_key`).
    index("filters_name_id_idx").on(table.name, table.id),
  ],
);

/**
 * Mirrors the `Comment` type (../comment-types.ts) exactly (issue #180) —
 * a fourth root noun (ADR 0047's move, made a second time), for the
 * identical reason `tasks`/`projects`/`labels` above each got their own
 * table: a Comment has its own identity and its own lifecycle, and it is
 * unbounded and individually addressable in a way `tasks.labelIds`'
 * own doc comment explains a JSON array cannot be. No collaboration
 * column, mirroring every table above it for the identical reason.
 */
export const comments = sqliteTable(
  "comments",
  {
    id: text("id").primaryKey(),
    deviceId: text("device_id").notNull(),
    // The Task this Comment belongs to — no foreign key constraint,
    // mirroring `tasks.projectId`'s own comment: this store does not
    // reach across tables to enforce or clean up a cross-store reference
    // (../comment-store.ts's own header comment on why deleting a Task
    // leaves its Comments behind rather than cascading).
    taskId: text("task_id").notNull(),
    // The Comment's own words — Markdown, rendered by the identical
    // renderer an Entry's body and a Task's description both use.
    text: text("text").notNull(),
    createdAt: text("created_at").notNull(),
    // Issue #196 — see `entries.updatedAt`'s own doc comment above.
    updatedAt: text("updated_at").notNull(),
    seq: integer("seq"),
    syncedAt: text("synced_at"),
    // Tombstone (ADR 0028's rule, applied to Comments) — identical
    // representation to every other table's `deleted_at` above.
    deletedAt: text("deleted_at"),
  },
  (table) => [
    // Supports listByTask()'s actual query — `WHERE task_id = ? AND
    // deleted_at IS NULL ORDER BY created_at ASC, id ASC` — mirroring
    // `sections_project_id_order_key_id_idx`'s identical shape for the
    // identical reason: a plain composite index on the WHERE column plus
    // the ORDER BY columns lets SQLite walk it directly.
    index("comments_task_id_created_at_id_idx").on(table.taskId, table.createdAt, table.id),
  ],
);

/**
 * Mirrors the `Event` type (../event-types.ts) exactly (issue #184) —
 * Todo's own activity log, a sixth root noun (ADR 0047's move made a
 * fifth time after Project/Section/Label/Comment). Structurally unlike
 * every table above it: there is no `deletedAt`, because an Event is
 * never edited or removed once written (../event-types.ts's own header
 * comment) — nothing here needs a "nothing" state for a tombstone to
 * represent.
 */
export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    deviceId: text("device_id").notNull(),
    eventType: text("event_type").notNull(),
    objectType: text("object_type").notNull(),
    objectId: text("object_id").notNull(),
    // The Task this Event concerns — null for a project/section Event.
    // See ../event-types.ts's own `taskId` doc comment for why this is
    // not always equal to `objectId`.
    taskId: text("task_id"),
    // The Project this Event happened in, snapshotted at record time —
    // see ../event-types.ts's own `projectId` doc comment for why this
    // is deliberately not "this Task's current Project."
    projectId: text("project_id"),
    // The acting Device's own clock, never arrival time (ADR 0056) — the
    // only timestamp this table carries (../event-types.ts's own
    // `occurredAt` doc comment on why there is deliberately no second
    // `created_at` column the way every other table here has one).
    occurredAt: text("occurred_at").notNull(),
    // Whatever this event_type/object_type pair needs to say about what
    // changed — a JSON blob, the same `{ mode: "json" }` treatment
    // `tasks.labelIds` already gets, for the identical reason
    // (../event-types.ts's own `extra` doc comment).
    extra: text("extra", { mode: "json" }).$type<Record<string, unknown> | null>(),
    seq: integer("seq"),
    syncedAt: text("synced_at"),
  },
  (table) => [
    // Supports listByTask() — `WHERE task_id = ? ORDER BY occurred_at
    // DESC, id DESC` (no `deleted_at` filter, unlike every other table's
    // equivalent index: there is no tombstone here to exclude).
    index("events_task_id_occurred_at_id_idx").on(table.taskId, table.occurredAt, table.id),
    // Supports listByProject().
    index("events_project_id_occurred_at_id_idx").on(table.projectId, table.occurredAt, table.id),
    // Supports list()'s own global ORDER BY.
    index("events_occurred_at_id_idx").on(table.occurredAt, table.id),
  ],
);

/**
 * Small key-value table holding the Cursor and this Device's id, alongside
 * the Entries they account for. See ADR 0007: the Cursor must live in the
 * same database as the Entries it claims are already local, or a database
 * that doesn't survive can leave a Cursor claiming progress the Entries
 * behind it never made.
 */
export const kv = sqliteTable("kv", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const CURSOR_KEY = "cursor";
export const DEVICE_ID_KEY = "device_id";
// Issue #186 / ADR 0057: the Entry stream's own record of the highest
// `protocol.ts`'s ROW_SHAPE_EPOCH.entries this Device has ever caught up
// to — see EntryStore.catchUpRowShapeEpoch's own doc comment (../store.ts)
// for the mechanism. Lives here, alongside CURSOR_KEY, for the identical
// ADR 0007 reason this table's own header comment already gives for the
// Cursor: an epoch claiming a re-walk happened, backed by a database that
// never held it, is the same failure as a Cursor claiming progress the
// rows behind it never made.
export const ROW_SHAPE_EPOCH_KEY = "row_shape_epoch";
