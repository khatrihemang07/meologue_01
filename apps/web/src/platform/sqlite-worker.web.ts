import type { SqliteMethod } from "@meologue/core";
import { toPositionalRow, toPositionalRows } from "@meologue/core";
import sqlite3InitModule, { type OpfsSAHPoolDatabase } from "@sqlite.org/sqlite-wasm";
import type { WorkerRequest, WorkerResponse } from "./sqlite-worker-driver";

const DB_FILENAME = "/meologue.sqlite3";
const POOL_NAME = "meologue-opfs-sahpool";

/**
 * Runs inside a dedicated Worker (ticket 21) — the OPFS pool VFS requires
 * `FileSystemSyncAccessHandle`, only available off the main thread. This is
 * the one place in `apps/web` that talks to SQLite/OPFS directly; everything
 * else goes through `SqliteWorkerDriver`'s postMessage protocol.
 *
 * TypeScript's DOM and WebWorker libs can't both apply to one program (they
 * redefine conflicting globals), and this app is one Vite project compiled
 * under the DOM lib for its main-thread code (ADR 0005) — so `self` here is
 * cast to the narrow worker-scope shape this file actually needs, rather
 * than pulling in a second tsconfig project just for this file.
 */
interface WorkerScope {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse): void;
}
const scope = self as unknown as WorkerScope;

let db: OpfsSAHPoolDatabase | null = null;

scope.onmessage = (event) => {
  const request = event.data;
  if (request.type === "open") {
    void handleOpen();
    return;
  }
  handleExecute(request);
};

async function handleOpen(): Promise<void> {
  try {
    const sqlite3 = await sqlite3InitModule();
    const pool = await sqlite3.installOpfsSAHPoolVfs({ name: POOL_NAME });
    db = new pool.OpfsSAHPoolDb(DB_FILENAME);
    scope.postMessage({ type: "open", ok: true });
  } catch (error) {
    scope.postMessage({
      type: "open",
      ok: false,
      kind: classifyOpenError(error),
      message: describeError(error),
    });
  }
}

function handleExecute(request: Extract<WorkerRequest, { type: "execute" }>): void {
  if (!db) {
    scope.postMessage({
      type: "execute",
      id: request.id,
      ok: false,
      message: "sqlite worker: execute received before open completed",
    });
    return;
  }

  try {
    const rows = runQuery(db, request.sql, request.params, request.method);
    scope.postMessage({ type: "execute", id: request.id, ok: true, rows });
  } catch (error) {
    scope.postMessage({
      type: "execute",
      id: request.id,
      ok: false,
      message: describeError(error),
    });
  }
}

// Mirrors packages/core/src/sqlite/node-driver.ts: `rowMode: "object"` gives
// column-named rows, which core's toPositionalRow/toPositionalRows (the one
// place that translation happens — ADR 0007) turn into drizzle's positional
// row contract.
function runQuery(
  database: OpfsSAHPoolDatabase,
  sql: string,
  params: unknown[],
  method: SqliteMethod,
): unknown[] {
  if (method === "run") {
    database.exec({ sql, bind: params as never });
    return [];
  }

  const resultRows = database.exec({
    sql,
    bind: params as never,
    rowMode: "object",
    returnValue: "resultRows",
  });

  if (method === "get") {
    return resultRows.length === 0 ? [] : toPositionalRow(resultRows[0]);
  }
  return toPositionalRows(resultRows);
}

// The OPFS pool VFS acquires one FileSystemSyncAccessHandle per pool file on
// install. Per the File System Access spec, a second caller trying to
// acquire a handle another tab already holds throws a DOMException named
// NoModificationAllowedError — the only signal available to distinguish
// "already open in another tab" from every other reason OPFS storage isn't
// usable (private browsing, missing OPFS APIs, insecure context).
function classifyOpenError(error: unknown): "second-tab" | "unavailable" {
  return error instanceof DOMException && error.name === "NoModificationAllowedError"
    ? "second-tab"
    : "unavailable";
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
