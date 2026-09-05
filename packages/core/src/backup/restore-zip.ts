import { strFromU8, unzipSync } from "fflate";

/**
 * The reverse of ./backup-zip.ts's `createBackup`: turns a Backup's raw
 * zip bytes — whatever `@/platform/load-file` (apps/web) just read off
 * disk — back into its three named parts, for the Settings page to show a
 * confirmation from (`meta.json`, `settings.json`) and for
 * ./restore.ts's `restoreFromBackup` to apply (`database.sql`). Pure and
 * platform-free, the identical posture `createBackup` itself documents:
 * only *picking* the file is platform-specific (`@/platform/load-file`),
 * unzipping it is not.
 */
export interface UnzippedBackup {
  databaseSql: string;
  /** Raw JSON text — the caller (settings-page.tsx) parses and validates the shape it actually needs, the same "don't validate what you don't use" restraint ./meta.ts's own `BackupMeta` interface documents rather than a schema this file would have to keep in step with it. */
  settingsJson: string;
  metaJson: string;
}

export type UnzipBackupResult =
  | { ok: true; backup: UnzippedBackup }
  | { ok: false; reason: string };

const REQUIRED_ENTRIES = ["database.sql", "settings.json", "meta.json"] as const;

/**
 * Unzips `bytes` and pulls out the three files every Backup this build (or
 * an older one — `createBackup`'s own shape hasn't changed since
 * `BACKUP_SCHEMA_VERSION` 1) ever writes. Refuses, rather than throwing,
 * for the two ways an arbitrary file picked off disk can fail to be a
 * Backup at all: not a zip (`unzipSync` throws on garbage bytes), or a zip
 * missing one of the three entries a Backup always has — a user picking
 * the wrong file entirely (an Export's zip, say, which has no
 * `database.sql`) is a mistake worth naming plainly, not a stack trace.
 */
export function unzipBackup(bytes: Uint8Array): UnzipBackupResult {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    return { ok: false, reason: "That file isn't a zip — pick a Backup file (.zip)." };
  }

  const missing = REQUIRED_ENTRIES.filter((name) => entries[name] === undefined);
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `That zip isn't a meologue Backup — missing ${missing.join(", ")}.`,
    };
  }

  return {
    ok: true,
    backup: {
      databaseSql: strFromU8(entries["database.sql"] as Uint8Array),
      settingsJson: strFromU8(entries["settings.json"] as Uint8Array),
      metaJson: strFromU8(entries["meta.json"] as Uint8Array),
    },
  };
}
