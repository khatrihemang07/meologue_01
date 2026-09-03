import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { assertValidCommentText } from "../comment-fields";
import type { CommentStore } from "../comment-store";
import type { Comment } from "../comment-types";
import { matchesSubstring } from "../task-search";
import type { SqliteDriver } from "./driver";
import { comments, kv } from "./schema";

/**
 * The SQLite-backed CommentStore (issue #180) — mirrors SqliteLabelStore
 * (./sqlite-label-store.ts) closely enough that a reader of one
 * recognises the other, including the same non-atomicity every store
 * built against ../migrator.ts's transaction-free driver carries. See
 * ./open.ts rather than this constructor directly: `comments` (migration
 * 12) has to exist before this can query it.
 */
export class SqliteCommentStore implements CommentStore {
  private readonly db: ReturnType<typeof drizzle>;

  constructor(driver: SqliteDriver) {
    this.db = drizzle((sqlText, params, method) => driver.execute(sqlText, params, method));
  }

  async list(): Promise<Comment[]> {
    // Every live Comment, oldest first — `comments_task_id_created_at_id_idx`
    // (../schema.ts) covers `task_id` first, so it doesn't directly serve
    // this table-wide scan, but a personal task list's own Comments sit
    // at a scale (../comment-store.ts's own doc comment) where that
    // doesn't matter in practice.
    return this.db
      .select()
      .from(comments)
      .where(isNull(comments.deletedAt))
      .orderBy(asc(comments.createdAt), asc(comments.id));
  }

  // See CommentStore.listByTask's own doc comment.
  // `comments_task_id_created_at_id_idx` is what makes the `task_id = ?`
  // filter plus this ORDER BY cheap.
  async listByTask(taskId: string): Promise<Comment[]> {
    return this.db
      .select()
      .from(comments)
      .where(and(eq(comments.taskId, taskId), isNull(comments.deletedAt)))
      .orderBy(asc(comments.createdAt), asc(comments.id));
  }

  async get(id: string): Promise<Comment | undefined> {
    const [found] = await this.db
      .select()
      .from(comments)
      .where(and(eq(comments.id, id), isNull(comments.deletedAt)))
      .limit(1);
    return found;
  }

  async upsert(newComments: Comment[]): Promise<void> {
    if (newComments.length === 0) {
      return;
    }
    await this.db
      .insert(comments)
      .values(newComments)
      .onConflictDoUpdate({
        target: comments.id,
        set: {
          deviceId: sql`excluded.device_id`,
          taskId: sql`excluded.task_id`,
          text: sql`excluded.text`,
          createdAt: sql`excluded.created_at`,
          seq: sql`excluded.seq`,
          syncedAt: sql`excluded.synced_at`,
          deletedAt: sql`excluded.deleted_at`,
        },
      });
  }

  async edit(id: string, text: string): Promise<void> {
    assertValidCommentText(text);
    await this.updateIfLive(id, { text, seq: null, syncedAt: null });
  }

  /**
   * Tombstones a Comment — never a hard delete (ADR 0028's rule). Blanks
   * `text` for the identical reason SqliteLabelStore.remove() blanks
   * `name`: a tombstone that still carried its old words would assert
   * "removed" and "still says X" about the same row at once.
   */
  async remove(id: string): Promise<void> {
    await this.db
      .update(comments)
      .set({ deletedAt: new Date().toISOString(), text: "", seq: null, syncedAt: null })
      .where(eq(comments.id, id));
  }

  async pending(): Promise<Comment[]> {
    return this.db.select().from(comments).where(isNull(comments.seq));
  }

  // See CommentStore.search's own doc comment for why this reuses list()'s
  // own already-wholesale scan rather than a second FTS5 index.
  async search(query: string): Promise<Comment[]> {
    if (query.trim() === "") {
      return [];
    }
    const all = await this.list();
    return all.filter((c) => matchesSubstring(c.text, query));
  }

  async getCursor(): Promise<number> {
    // Namespaced apart from every other stream's own cursor key, for the
    // identical reason SqliteTaskStore.getCursor's own comment gives: a
    // shared key would collide two independent streams' progress into
    // one number.
    const value = await this.getKv(COMMENT_CURSOR_KEY);
    return value === undefined ? 0 : Number(value);
  }

  async setCursor(seq: number): Promise<void> {
    await this.setKv(COMMENT_CURSOR_KEY, String(seq));
  }

  // Mirrors SqliteLabelStore.updateIfLive/SqliteTaskStore.updateIfLive
  // exactly — see either's own comment for why a mutation against an
  // unknown or tombstoned id is a no-op rather than an error.
  private async updateIfLive(id: string, patch: Partial<Comment>): Promise<void> {
    await this.db
      .update(comments)
      .set(patch)
      .where(and(eq(comments.id, id), isNull(comments.deletedAt)));
  }

  private async getKv(key: string): Promise<string | undefined> {
    const rows = await this.db.select({ value: kv.value }).from(kv).where(eq(kv.key, key)).limit(1);
    return rows[0]?.value;
  }

  private async setKv(key: string, value: string): Promise<void> {
    await this.db
      .insert(kv)
      .values({ key, value })
      .onConflictDoUpdate({ target: kv.key, set: { value } });
  }
}

const COMMENT_CURSOR_KEY = "comment_cursor";
