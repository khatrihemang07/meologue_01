import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Mirrors the `Entry` type (../types.ts) exactly. ADR 0007 originally
 * rejected adding columns ahead of an editing design ("dormant columns
 * would commit us to semantics nobody has designed yet") — that reasoning
 * held, but the design that eventually landed (ADR 0028) needs exactly one
 * of the columns it was guarding against: `deleted_at`, added by migration
 * 3 (`migrations/0001_entry_deleted_at.sql`). `rev` and `updated_at`, the
 * other two ADR 0007 named, were rejected on their own merits by ADR 0028
 * and never got a column here.
 */
export const entries = sqliteTable(
  "entries",
  {
    id: text("id").primaryKey(),
    deviceId: text("device_id").notNull(),
    body: text("body").notNull(),
    createdAt: text("created_at").notNull(),
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
 * Date, deadline, duration and priority were added by issue #169;
 * `projectId`/`sectionId`/`parentId` by issue #171, behind their own
 * migration (version 9) — sequencing the tickets this way keeps each
 * migration's blast radius to the one thing it's actually adding.
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
    createdAt: text("created_at").notNull(),
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
    // Minutes; requires `date` to carry a time (there's nothing to measure
    // a length from otherwise) and is capped at 1440 (24 hours). Both
    // rules are enforced in ../task-fields.ts, not here — a column
    // constraint can't express "requires another column to have a
    // particular shape."
    duration: integer("duration"),
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
    // shape `date`/`deadline`/`duration` above take, not `priority`'s
    // NOT NULL DEFAULT: "doesn't repeat" is the absence of a rule, not a
    // concrete value the way "no priority" is a real priority level.
    dateString: text("date_string"),
    // `null` is Inbox — there is no `projects` row for it (../project-
    // types.ts's own header comment). Nullable with no DEFAULT, the same
    // shape `date`/`deadline`/`duration` take: a pre-#171 row backfilled
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
