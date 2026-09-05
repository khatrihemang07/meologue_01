export type Entry = {
  id: string;
  deviceId: string;
  body: string;
  createdAt: string;
  // Issue #196: when this Entry's row was last actually changed — a
  // capture and every edit or delete all stamp this, via whichever setter
  // touched the row (see EntryStore.edit/EntryStore.remove's own doc
  // comments). Backfilled to `createdAt` for a row that predates this
  // field (../sqlite/migrations/0014_updated_at.sql), deliberately: it is
  // stable and identical on every Device holding the same row
  // (`server/src/sync.rs`'s `insert_entries` never puts `created_at` in
  // its own `set` list), so two Devices merging a shared pre-existing
  // history land on the exact same value rather than whichever Device
  // happened to migrate later winning by accident.
  //
  // ADR 0028 rejected a client-supplied timestamp for *ordering* Sync's
  // own conflicts, and that rule is unchanged — Sync still resolves a
  // conflict by Server arrival order (the reassigned `seq`), never by
  // comparing this field. This exists for Merge (issue #199) to read
  // later; nothing in this ticket compares one.
  updatedAt: string;
  seq: number | null;
  syncedAt: string | null;
  // Set when this Entry is a tombstone — `A -> nothing` (ADR 0028). Never
  // optional, like seq and syncedAt: every caller that builds an Entry
  // must say explicitly whether it's live or removed, rather than an
  // omitted field silently defaulting to one or the other.
  deletedAt: string | null;
};
