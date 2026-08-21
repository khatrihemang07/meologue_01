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
