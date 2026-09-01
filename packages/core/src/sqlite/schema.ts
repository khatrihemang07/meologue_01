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
 * Deliberately excludes date, priority, deadline, duration, project,
 * section and parent fields too — issue #169 and #171 add those, each
 * behind its own migration, on purpose: sequencing the tickets this way
 * keeps each migration's blast radius to the one thing it's actually
 * adding.
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
