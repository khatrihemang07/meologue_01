/**
 * Mirrors the server's constants (server/src/sync.rs) — not generated, since
 * they aren't part of the OpenAPI schema. Keep in sync by hand.
 */
// 6, not 5: issue #182 / ADR 0051 widened SyncRequest/SyncResponse a second
// time, with four more entity streams (Projects, Sections, Labels, Comments
// — ADR 0047's remaining root nouns plus #180's Comment), alongside Entries
// and Tasks. See server/src/sync.rs's own PROTOCOL_VERSION doc comment for
// the bump's reasoning and for MIN_PROTOCOL_VERSION, the Server-side detail
// that has no client-side mirror: the Server accepts 4, 5 and 6 for one
// release, so a Device still shipping this constant at 4 or 5 keeps syncing
// Entries and Tasks unaffected and simply never sees a Project, Section,
// Label or Comment.
export const PROTOCOL_VERSION = 6;
export const SYNC_BATCH_SIZE = 500;

/** The continuous-sync poll interval — "a few seconds" is the agreed bar for "live". */
export const SYNC_INTERVAL_MS = 5000;

/**
 * Issue #186 / ADR 0057: how many times each stream's *row shape* has
 * grown a field on a kind of row that already existed, since this map was
 * introduced — independent of `PROTOCOL_VERSION` above, and deliberately
 * so. A Cursor only ever advances through what a Device has already
 * asked for (`fetch_*_since`, `server/src/sync.rs`); it has no way to
 * notice that a row behind it grew a field it never asked about, because
 * the field arrived on a row that was already behind the Cursor before
 * the field existed. Observed directly during #182: a Task's
 * `description` reached the Server, but a second Device whose Task
 * Cursor already covered that row never saw it, until an unrelated edit
 * (a rename) reassigned the row's `seq` and pushed it back to the head of
 * the queue.
 *
 * `PROTOCOL_VERSION` cannot drive this by itself — issue #184 is why:
 * Events became a seventh stream with **no** `PROTOCOL_VERSION` bump at
 * all (that constant's own doc comment explains why none was needed),
 * so a bump is not even a reliable signal that *any* stream's row shape
 * changed, let alone which one. And the reverse also holds: a future
 * bump for a brand-new *stream* has nothing to do with the field-shape
 * of the streams that already exist, so gating a reset on
 * `PROTOCOL_VERSION` would force every existing stream to pointlessly
 * re-walk its whole history the next time any stream earns a bump for
 * any reason. This map is the narrower, honest signal: it moves only
 * when a stream's own row shape gains a field, and each entry names only
 * the stream that changed.
 *
 * **Each Device records, per stream, the highest value of this map it
 * has ever caught up to** (`catchUpRowShapeEpoch` on every store this
 * file's stream keys name — see `EntryStore.catchUpRowShapeEpoch`'s own
 * doc comment for the mechanism). Sync compares that recorded value
 * against the current one here, once per `sync()` call, before building
 * any request: lower means "this Device pulled at least one row of this
 * kind before the field that bumped this number existed," and the
 * repair is to reset *that stream's own Cursor* to 0, so the ordinary,
 * already-paginated sync loop re-walks the whole stream from the start
 * and re-delivers every row exactly once — including the ones that
 * already have the field, which costs a redundant re-fetch but not a
 * second copy (every `insert_*`/`upsert` in this codebase is keyed by
 * `id`, per-stream). Equal or higher is a single local integer
 * comparison and nothing else: no network round trip, no query, the
 * steady-state cost this ticket's own acceptance bar requires.
 *
 * **If you add a field to an existing kind of row's wire shape — not a
 * brand-new stream, see the Events note above — you must bump that
 * stream's own number here by one**, and check
 * `server/src/sync.rs`'s mirror of this comment (next to
 * `PROTOCOL_VERSION`) for the matching note on the Rust side. Skipping
 * this step reproduces the exact bug ADR 0057 exists to describe: the
 * field silently never reaches a Device that already holds the row it
 * belongs to, until something unrelated happens to touch that row again.
 *
 * Issue #196 bumps six of these seven by one — `entries`, `tasks`,
 * `projects`, `sections`, `labels`, `comments` each gain `updated_at`, a
 * field on a kind of row every one of these streams already had, which is
 * precisely the case this map exists for. **Not `events`**: it gains no
 * field (ADR 0056: an Event is never edited, so a last-changed timestamp
 * would mean nothing distinct from `occurred_at`, which it already
 * carries), so its own epoch stays exactly where issue #184 left it. This
 * is a row-shape change, so ADR 0057 applies in full — every Device that
 * has ever synced one of these six streams re-walks it once, in full, the
 * next time it syncs after upgrading; that is the expected, one-time cost
 * this map's own mechanism exists to bound, not a defect to route around.
 */
export const ROW_SHAPE_EPOCH = {
  // Issue #196: `updated_at` gained a wire representation on the existing
  // Entry stream.
  entries: 1,
  // Issue #182: `description` gained a wire representation on the
  // existing Task stream (server/src/sync.rs's own `TaskInput.description`
  // doc comment) — the concrete case ADR 0057 was written to fix.
  // Issue #196 bumps this a second time: `updated_at` is a second field
  // added to a kind of row this stream already had.
  tasks: 2,
  // Issue #196: `updated_at` gained a wire representation on the existing
  // Project stream.
  projects: 1,
  // Issue #196: `updated_at` gained a wire representation on the existing
  // Section stream.
  sections: 1,
  // Issue #196: `updated_at` gained a wire representation on the existing
  // Label stream.
  labels: 1,
  // Issue #196: `updated_at` gained a wire representation on the existing
  // Comment stream.
  comments: 1,
  // Untouched by issue #196 — see this map's own header comment above for
  // why Events carry no `updated_at` at all.
  events: 0,
} as const satisfies Record<string, number>;

export type SyncStream = keyof typeof ROW_SHAPE_EPOCH;
