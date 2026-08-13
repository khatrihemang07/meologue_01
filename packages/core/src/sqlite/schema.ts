import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Mirrors the `Entry` type (../types.ts) exactly — six columns, nothing
 * dormant. See ADR 0007: editing needs a server migration regardless, so
 * columns for it buy nothing until that's designed.
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
