import type { WireRebuildReport, WireRestoreReport } from "@meologue/core";
import { serverRequest } from "@/lib/server-request";

/**
 * The Server-side counterpart to `@meologue/core`'s Device Backup/Restore
 * (packages/core/src/backup/) — issue #198's `GET /v1/backup`,
 * `POST /v1/restore` and `POST /v1/restore/rebuild-embeddings`, called the
 * same way every other Server-backed transport in this app is
 * (`config-transport.ts`, `models-transport.ts`): through `serverRequest`
 * (`server-request.ts`), which reads the Server URL fresh per call (ADR
 * 0011) and turns a thrown `fetch` into `null` rather than an exception.
 *
 * Unlike Device Restore, none of this ever touches `@meologue/core` — a
 * server backup is an opaque `pg_dump` archive this Device never parses,
 * only relays (`backup.rs`'s own doc comment: `--format=custom`, not plain
 * SQL), so nothing here needs the dynamic-import lazy-loading
 * `data-section.tsx`'s own Device Backup/Restore handlers use to keep
 * `fflate` and `packages/core`'s backup/parse machinery off the Settings
 * route's cold-start path. This module is small enough, and has no such
 * dependency to keep out, to import statically like any other transport.
 */

/** The one shape every failure here collapses to — a status this Server actually returned, or none at all. */
export type ServerBackupFailure =
  | { ok: false; reason: "unreachable" }
  | { ok: false; reason: "http-error"; status: number; message: string };

/**
 * `BackupError`'s `IntoResponse` (server/src/backup.rs) always answers a
 * failure with `{"error": "<message>"}`, plain text a person can read and
 * act on (install a tool, upgrade a version) rather than a bare status
 * code — read here the same defensive way `restore-zip.ts`'s own
 * `UnzipBackupResult` is read on the Device side: a body that doesn't
 * parse the way this function expects degrades to `fallback` rather than
 * throwing.
 */
async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body: unknown = await response.json();
    const message =
      typeof body === "object" && body !== null
        ? (body as Record<string, unknown>).error
        : undefined;
    return typeof message === "string" ? message : fallback;
  } catch {
    return fallback;
  }
}

export type FetchServerBackupResult = { ok: true; bytes: Uint8Array } | ServerBackupFailure;

/**
 * `GET /v1/backup` — the whole Server database as a `pg_dump`
 * custom-format archive (`backup.rs`'s own doc comment: Entries, Tasks,
 * Sessions, Digests, and every embedding). Delivered to disk by the caller
 * (`server-data-group.tsx`) through the identical `@/platform/save-file`
 * seam Device Backup already uses, honouring the same "saved"/"cancelled"
 * outcome — this function's own job stops at handing back bytes.
 */
export async function fetchServerBackup(): Promise<FetchServerBackupResult> {
  const response = await serverRequest("/v1/backup");
  if (response === null) {
    return { ok: false, reason: "unreachable" };
  }
  if (!response.ok) {
    return {
      ok: false,
      reason: "http-error",
      status: response.status,
      message: await readErrorMessage(
        response,
        `The server couldn't produce a backup (HTTP ${response.status}).`,
      ),
    };
  }
  return { ok: true, bytes: new Uint8Array(await response.arrayBuffer()) };
}

export type RestoreServerBackupResult =
  | { ok: true; report: WireRestoreReport }
  | ServerBackupFailure;

/**
 * `POST /v1/restore` — wipes and replaces every table `pg_restore --clean
 * --if-exists` touches with `bytes`' contents (a Server Backup picked via
 * `@/platform/load-file`, the same seam Device Restore uses). This is a
 * Server-wide Restore, not this Device's own (CONTEXT.md's Restore entry
 * still applies — "the one operation that destroys History on purpose" —
 * only here it destroys every Device's Sync history, not just this one's
 * local copy), which is exactly why `server-data-group.tsx` gates it
 * behind the identical typed destructive confirmation Device Restore uses
 * rather than inventing a second, softer one.
 *
 * `mismatched_embedding_count` on the returned `RestoreReport` is what
 * lets the caller offer a rebuild afterward (`rebuildMismatchedEmbeddings`
 * below) rather than leaving a restored Entry silently un-searchable by
 * meaning until the background worker's own schedule happens to catch it.
 */
export async function restoreServerBackup(bytes: Uint8Array): Promise<RestoreServerBackupResult> {
  const response = await serverRequest("/v1/restore", {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    // `Uint8Array` itself isn't a `BodyInit` under this project's `lib.dom`
    // — the same mismatch `save-file.web.ts` already casts around for its
    // own `Blob` constructor call, worked around here the identical way.
    body: new Blob([bytes as BlobPart]),
  });
  if (response === null) {
    return { ok: false, reason: "unreachable" };
  }
  if (!response.ok) {
    return {
      ok: false,
      reason: "http-error",
      status: response.status,
      message: await readErrorMessage(
        response,
        `The server couldn't apply that backup (HTTP ${response.status}).`,
      ),
    };
  }
  const report = (await response.json()) as WireRestoreReport;
  return { ok: true, report };
}

export type RebuildMismatchedEmbeddingsResult =
  | { ok: true; report: WireRebuildReport }
  | ServerBackupFailure;

/**
 * `POST /v1/restore/rebuild-embeddings` — the follow-up action
 * `server-data-group.tsx` offers once `restoreServerBackup`'s own report
 * names a nonzero `mismatched_embedding_count`. Nulls `embedding` for
 * exactly those rows (`backup.rs`'s own `rebuild_mismatched_embeddings`
 * doc comment); this call never re-embeds anything itself, only queues
 * the rows for the background worker ADR 0022 already runs, which is why
 * the report only ever carries a count, not a completion.
 */
export async function rebuildMismatchedEmbeddings(): Promise<RebuildMismatchedEmbeddingsResult> {
  const response = await serverRequest("/v1/restore/rebuild-embeddings", { method: "POST" });
  if (response === null) {
    return { ok: false, reason: "unreachable" };
  }
  if (!response.ok) {
    return {
      ok: false,
      reason: "http-error",
      status: response.status,
      message: await readErrorMessage(
        response,
        `The rebuild request failed (HTTP ${response.status}).`,
      ),
    };
  }
  const report = (await response.json()) as WireRebuildReport;
  return { ok: true, report };
}
