export type Entry = {
  id: string;
  deviceId: string;
  body: string;
  createdAt: string;
  seq: number | null;
  syncedAt: string | null;
  // Set when this Entry is a tombstone — `A -> nothing` (ADR 0028). Never
  // optional, like seq and syncedAt: every caller that builds an Entry
  // must say explicitly whether it's live or removed, rather than an
  // omitted field silently defaulting to one or the other.
  deletedAt: string | null;
};
