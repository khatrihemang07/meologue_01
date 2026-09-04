import type { SqliteDriver } from "./driver";
import { migrate } from "./migrator";
import { SqliteCommentStore } from "./sqlite-comment-store";
import { SqliteEntryStore } from "./sqlite-entry-store";
import { SqliteEventStore } from "./sqlite-event-store";
import { SqliteFilterStore } from "./sqlite-filter-store";
import { SqliteLabelStore } from "./sqlite-label-store";
import { SqliteProjectStore } from "./sqlite-project-store";
import { SqliteTaskStore } from "./sqlite-task-store";

/**
 * What open() hands back once a Device's database is migrated and ready.
 * `store` and `deviceId` are the two fields every existing caller reads —
 * apps/web/src/pages/entry-store-layout.tsx destructures `{ store,
 * deviceId }` directly off this, not off some nested bag, and so do the
 * tests (sqlite-entry-store.test.ts, open.test.ts).
 *
 * Deliberately kept flat rather than, say, `{ stores: { entry, task },
 * deviceId }`: Todo's TaskStore (issue #168, over this same shared driver —
 * one database, no second OPFS lock) lands here as a *third* field
 * (`taskStore`, alongside `store`), never by nesting `store` a level
 * deeper. Nesting now, on the promise that it will pay off later, is the
 * "dormant columns" mistake ADR 0007 already made once and ../schema.ts's
 * own comment still carries the scar of — restructuring a shape ahead of
 * the thing that would justify it, on a guess, breaks every caller today
 * for a shape that might not even fit what TaskStore actually needs. An
 * *additive* field costs those callers nothing: `{ store, deviceId }`
 * destructuring keeps compiling unchanged, and a caller that wants the new
 * field just reads it too. `labelStore` (issue #170) is the second such
 * addition, and `projectStore` (issue #171) the third, following the
 * identical rule.
 */
export interface OpenedSqliteStore {
  store: SqliteEntryStore;
  taskStore: SqliteTaskStore;
  labelStore: SqliteLabelStore;
  projectStore: SqliteProjectStore;
  /** Comments (issue #180) — a fifth field, following the identical additive rule this interface's own header comment states. */
  commentStore: SqliteCommentStore;
  /** Events (issue #184) — a sixth field, following the identical additive rule this interface's own header comment states. */
  eventStore: SqliteEventStore;
  /** Filters (issue #185) — a seventh field, following the identical additive rule this interface's own header comment states. */
  filterStore: SqliteFilterStore;
  deviceId: string;
}

/**
 * Opens the SQLite EntryStore and TaskStore behind a driver (ADR 0007):
 * applies any migrations not yet recorded in the ledger, then resolves
 * this Device's id, minting one on first run. Prefer this over
 * constructing SqliteEntryStore or SqliteTaskStore directly — a store
 * that hasn't been migrated can't be queried.
 *
 * This is the composition root for every store this driver's database
 * holds, not just the Entry one — migrate() already applies every
 * migration in MIGRATIONS (../migrations/index.ts) in one pass, regardless
 * of which store owns the table a given migration creates, so TaskStore's
 * tables (migrations 4 and 5, issue #168) needed nothing new here beyond
 * the two lines this file's own comment above predicted: `new
 * SqliteTaskStore(driver)` and one more field on the object below.
 * `deviceId` is resolved once, here, and is not re-derived per store: it
 * names the Device the whole database belongs to (kv's own doc comment in
 * ../schema.ts), not something specific to Entries, so TaskStore shares
 * this exact value rather than asking `ensureDeviceId()` again or minting
 * its own.
 */
export async function open(driver: SqliteDriver): Promise<OpenedSqliteStore> {
  await migrate(driver);
  const store = new SqliteEntryStore(driver);
  const taskStore = new SqliteTaskStore(driver);
  const labelStore = new SqliteLabelStore(driver);
  // Built after taskStore, not before: SqliteProjectStore's constructor
  // takes a TaskStore collaborator for deleteSection/archiveSection's
  // cascade (../project-store.ts's own header comment, point 3).
  const projectStore = new SqliteProjectStore(driver, taskStore);
  const commentStore = new SqliteCommentStore(driver);
  const eventStore = new SqliteEventStore(driver);
  const filterStore = new SqliteFilterStore(driver);
  const deviceId = await store.ensureDeviceId();
  return {
    store,
    taskStore,
    labelStore,
    projectStore,
    commentStore,
    eventStore,
    filterStore,
    deviceId,
  };
}
