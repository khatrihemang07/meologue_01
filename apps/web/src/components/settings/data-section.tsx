import type { EntryStore, ProjectStore, SqliteDriver, TaskStore } from "@meologue/core";
import { exportEntriesToZip } from "@meologue/core";
import { Suspense, useState } from "react";
import { toast } from "sonner";
import { DeviceGroup } from "@/components/settings/device-group";
import { LazyDestructiveConfirmDialog as DestructiveConfirmDialog } from "@/components/settings/lazy-destructive-confirm-dialog";
import { ServerDataGroup } from "@/components/settings/server-data-group";
import { SettingsSection } from "@/components/settings/settings-section";
import { SwitchRow } from "@/components/settings/switch-row";
import { Button } from "@/components/ui/button";
import { applyDeviceSettings, readAllDeviceSettings, useSettingsStore } from "@/lib/settings";
import { loadFile } from "@/platform/load-file";
import { saveFile } from "@/platform/save-file";

/**
 * The slice of `entry-store-layout.tsx`'s `OpenedSqliteStore` this section
 * actually reads — the three store interfaces (not the concrete
 * `SqliteEntryStore`/`SqliteTaskStore`/`SqliteProjectStore` classes
 * `OpenedSqliteStore` names) plus the Device id every Export needs to
 * write. Typed against the interfaces rather than imported wholesale so a
 * test can hand this a plain fake store (the same doubles
 * use-tasks.test.tsx and this file's own test already build) without
 * satisfying every field the concrete SQLite classes carry and nothing
 * here touches.
 *
 * `driver` joined the other four for issue #195: Backup's own
 * `createBackup` (`@meologue/core`) reads `sqlite_master` and
 * `pragma table_info` directly, below every store's own abstraction, so it
 * needs the raw `SqliteDriver` `open()` already constructed
 * (`../../../packages/core/src/sqlite/open.ts`'s own
 * `OpenedSqliteStore.driver` doc comment), not a store built on top of it.
 * Restore (#197) needs the identical driver for the opposite direction.
 */
export interface ExportStoreHandle {
  store: EntryStore;
  taskStore: TaskStore;
  projectStore: ProjectStore;
  deviceId: string;
  driver: SqliteDriver;
}

/**
 * What this Device can do with its own copy of the user's History — Export
 * it (a readable zip, day files plus a manifest), Back it up (a lossless
 * SQL dump, issue #195), or Restore it from a Backup (the destructive
 * replace, issue #197) — the fifth and last of five topic sections
 * `settings-page.tsx` composes (issue #202). `CONTEXT.md`'s Export/Backup/
 * Restore/Merge entries are the vocabulary this whole section is written
 * against: Export is the readable one, a Backup is the lossless one a
 * Device can read back, Restore replaces this Device with a Backup's
 * contents outright, and Merge (folding a Backup's rows in without
 * discarding what's already here) is issue #199 — not built by this
 * ticket, and nothing below should be mistaken for it.
 *
 * The one topic section that isn't fully self-contained: every other
 * section reads and writes `useSettingsStore` directly, but Export/Backup/
 * Restore all need the actual `EntryStore`/`TaskStore`/`ProjectStore`/
 * `SqliteDriver` instances, which only exist once the Entry store has
 * opened. Settings is a sibling route outside `EntryStoreLayout` (ADR
 * 0008/0009), so it has no outlet context to read those from —
 * `settings-page.tsx` itself subscribes to the same `entryStoreQueryOptions`
 * `SyncLoop` uses (use-sync-loop.ts) and passes the resolved handle down
 * here as `opened`, `undefined` until the store opens (or forever, if it
 * never does — the whole reason Settings has to keep rendering
 * regardless). `ServerDataGroup` below is the one part of this section
 * that needs none of that: a Server Backup/Restore (issue #198) round-trips
 * through the Server, not this Device's own driver, so it reads
 * `useSettingsStore`'s Server URL directly the same way every other
 * topic's own "On the server" sub-group does.
 */
export function DataSection({ opened }: { opened: ExportStoreHandle | undefined }) {
  // Issue #197: the Backup a reader just picked, parsed only far enough to
  // drive the confirmation dialog below — non-null is what opens it.
  // `databaseSql` is carried through untouched (restoreFromBackup does its
  // own, stricter parse against the live schema); `settings` and
  // `incomingServerUrl` are read here only far enough to show the reader
  // what they're about to get, never applied before they confirm.
  const [restorePreview, setRestorePreview] = useState<{
    databaseSql: string;
    settings: Record<string, string>;
    incomingServerUrl: string;
    takenAt: string | null;
  } | null>(null);
  // A typed confirmation, not a toast (CONTEXT.md's Restore entry: "it
  // asks before it acts") — the destructive button inside
  // DestructiveConfirmDialog stays disabled until this matches
  // RESTORE_CONFIRM_WORD exactly.
  const [restoreConfirmText, setRestoreConfirmText] = useState("");
  // Defaults to keeping this Device's current Server URL, never the
  // incoming one — ADR 0011 makes an unreachable Server URL mean "Sync is
  // off" *silently*, so the safer default is the one that can't turn Sync
  // off without the reader noticing.
  const [useIncomingServerUrl, setUseIncomingServerUrl] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreProgress, setRestoreProgress] = useState("");
  // Turns true, and stays true, the first time a reader picks a valid
  // Backup — see this file's own `DestructiveConfirmDialog` lazy() comment
  // above for why the dialog isn't simply mounted with `open={false}` from
  // the start. Never reset back to `false`: once the chunk is loaded for
  // one Restore attempt, later attempts in the same session should open
  // and close it instantly, with the dialog's own `data-closed` exit
  // animation intact, rather than re-triggering a Suspense fallback every
  // time.
  const [restoreDialogSummoned, setRestoreDialogSummoned] = useState(false);

  // Always every Entry (store.list()), every Task (taskStore.list() +
  // listCompleted()) and every Project (projectStore.listProjects()),
  // never the current search — a backup that silently omits things is
  // worse than none (ticket 46, extended to Tasks by issue #175: ADR 0016
  // was written about Entries when Entries were the only thing there was
  // to omit). No progress UI: at personal-log scale this is fast enough
  // that success/failure toasts are the whole story.
  async function handleExport() {
    if (!opened) {
      return;
    }
    try {
      const [entries, activeTasks, completedTasks, projects] = await Promise.all([
        opened.store.list(),
        opened.taskStore.list(),
        opened.taskStore.listCompleted(),
        opened.projectStore.listProjects(),
      ]);
      // Both active and completed — see tasks-file.ts's own doc comment
      // for why a backup includes what's done, not just what's open.
      const tasks = [...activeTasks, ...completedTasks];
      const { fileName, bytes } = exportEntriesToZip(entries, tasks, projects, {
        deviceId: opened.deviceId,
        now: new Date(),
        utcOffsetMinutes: -new Date().getTimezoneOffset(),
      });
      const outcome = await saveFile(fileName, bytes);
      if (outcome === "cancelled") {
        // The user backed out of the save panel / share sheet — nothing was
        // written anywhere. Export is a backup, and a false "Exported"
        // toast here would tell the user they have a copy of their History
        // they don't; cancelling is the user changing their mind, and it
        // needs no acknowledgement, success or error (ticket 47's defect
        // fix — see save-file.web.ts's SaveFileOutcome doc comment and
        // docs/adr/0016).
        return;
      }
      const entryLabel = entries.length === 1 ? "1 Entry" : `${entries.length} Entries`;
      const taskLabel = tasks.length === 1 ? "1 Task" : `${tasks.length} Tasks`;
      toast.success(`Exported ${entryLabel} and ${taskLabel} to ${fileName}.`);
    } catch (error) {
      console.error("meologue: export failed", error);
      toast.error(error instanceof Error ? error.message : "Export failed.");
    }
  }

  // A Backup (issue #195, CONTEXT.md's Backup entry) is a second, separate
  // artifact from Export just above — a lossless SQL dump of this Device's
  // whole database plus its settings, answering "is my data safe" rather
  // than Export's "can I read this." `readAllDeviceSettings()`
  // (lib/settings.ts) is the one place `packages/core` gets
  // `localStorage`'s contents from: that package has no `localStorage` of
  // its own (ADR 0008), so Settings collects the `meologue.*` keys and
  // hands them over the same way it already hands over `deviceId` below.
  //
  // `await import("@meologue/core")` rather than a top-level import of
  // `createBackup`: the bundle-budget regression this exact UI failed on
  // once already (28,393 gzip bytes against a 17,600 ceiling,
  // apps/web/scripts/check-bundle-size.mjs) came from a static import of
  // `createBackup`/`unzipBackup`/`restoreFromBackup` dragging dump.ts,
  // parse.ts, restore.ts, restore-zip.ts and row-diff.ts — none of them
  // used by anything else this route touches — into the Settings chunk
  // Vite fetches on every visit. None of those five modules are reachable
  // from this file's own static imports any more, so Rollup places them in
  // a chunk fetched only when a reader actually clicks Backup or Restore,
  // never on Settings' own cold start. No progress UI, same reasoning as
  // handleExport just above: at personal-log scale a Backup is fast enough
  // that a toast is the whole story.
  async function handleBackup() {
    if (!opened) {
      return;
    }
    try {
      const { createBackup } = await import("@meologue/core");
      const { fileName, bytes } = await createBackup(opened.driver, readAllDeviceSettings(), {
        deviceId: opened.deviceId,
        now: new Date(),
        utcOffsetMinutes: -new Date().getTimezoneOffset(),
      });
      const outcome = await saveFile(fileName, bytes);
      if (outcome === "cancelled") {
        // Same defect fix handleExport's own comment above already covers
        // (ticket 47, docs/adr/0016): a false "Backed up" toast here would
        // claim a copy of this Device's whole database exists when it
        // doesn't.
        return;
      }
      toast.success(`Backed up this Device to ${fileName}.`);
    } catch (error) {
      console.error("meologue: backup failed", error);
      toast.error(error instanceof Error ? error.message : "Backup failed.");
    }
  }

  // The word a reader must type verbatim before Restore's own destructive
  // button (inside DestructiveConfirmDialog below) enables — CONTEXT.md's
  // Restore entry: "it asks before it acts, because this is the one
  // operation that destroys History on purpose."
  const RESTORE_CONFIRM_WORD = "RESTORE";

  // Opens the confirmation dialog rather than restoring immediately —
  // picking and unzipping the file is not itself destructive, so it needs
  // no confirmation of its own; only handleConfirmRestore below writes
  // anything. `unzipBackup` failures here are reported and stop before the
  // dialog ever opens, so a reader is never asked to confirm restoring a
  // file this build can't even read the wrapper of.
  async function handlePickRestoreFile() {
    if (!opened) {
      return;
    }
    const picked = await loadFile();
    if (picked.outcome === "cancelled") {
      // The reader backed out of the file picker — nothing to report, the
      // same silent-on-cancel posture handleExport/handleBackup already
      // take for their own save-side pickers (ticket 47, docs/adr/0016).
      return;
    }
    const { unzipBackup } = await import("@meologue/core");
    const unzipped = unzipBackup(picked.bytes);
    if (!unzipped.ok) {
      toast.error(unzipped.reason);
      return;
    }

    // settings.json and meta.json are read only far enough to populate the
    // confirmation dialog (the incoming Server URL, and when the Backup
    // was taken) — parsed defensively, not validated against a schema: a
    // Backup's own database.sql is the thing restoreFromBackup actually
    // applies and structurally checks; these two files are shown, not
    // written, until the reader confirms.
    let settings: Record<string, string> = {};
    try {
      const parsed: unknown = JSON.parse(unzipped.backup.settingsJson);
      if (typeof parsed === "object" && parsed !== null) {
        settings = parsed as Record<string, string>;
      }
    } catch {
      // An unreadable settings.json still lets the data itself restore —
      // the confirmation dialog just shows no incoming Server URL and
      // applies no settings, rather than refusing the whole Restore over a
      // file that fails to parse for a concern this page treats as
      // secondary to the data.
    }
    let takenAt: string | null = null;
    try {
      const meta: unknown = JSON.parse(unzipped.backup.metaJson);
      const takenAtValue =
        typeof meta === "object" && meta !== null
          ? (meta as Record<string, unknown>).taken_at
          : undefined;
      takenAt = typeof takenAtValue === "string" ? takenAtValue : null;
    } catch {
      takenAt = null;
    }

    setRestorePreview({
      databaseSql: unzipped.backup.databaseSql,
      settings,
      incomingServerUrl:
        typeof settings["meologue.server-url"] === "string" ? settings["meologue.server-url"] : "",
      takenAt,
    });
    setRestoreConfirmText("");
    setUseIncomingServerUrl(false);
    setRestoreDialogSummoned(true);
  }

  // The confirmation dialog's own destructive action — everything issue
  // #197 calls for happens here, in order: replace the database
  // (restoreFromBackup, which does its own BEGIN/COMMIT/ROLLBACK and FTS5
  // rebuild), then apply the Backup's settings silently
  // (applyDeviceSettings, lib/settings.ts — this overturns ADR 0008; see
  // the ADR that supersedes it), then apply the incoming Server URL only
  // if the reader explicitly chose to (useIncomingServerUrl — ADR 0011's
  // "an unreachable Server URL means Sync is off, silently" is exactly why
  // this is never applied by default).
  //
  // Reloads the page on success, after a moment for the success toast to
  // be read: Restore replaces the database and settings out from under
  // every already-rendered part of this app (React Query's cached reads,
  // the Zustand settings store's own state, the Nav's lock checks) — a
  // full reload is the same honest "start over from what's actually on
  // disk now" reset app-error-boundary.tsx's own Reload button already
  // uses for a comparable "too much has changed to patch in place"
  // situation.
  async function handleConfirmRestore() {
    if (!opened || restorePreview === null) {
      return;
    }
    setRestoring(true);
    setRestoreProgress("Starting…");
    try {
      const { restoreFromBackup } = await import("@meologue/core");
      const outcome = await restoreFromBackup(
        opened.driver,
        restorePreview.databaseSql,
        (message) => setRestoreProgress(message),
      );
      if (!outcome.ok) {
        toast.error(outcome.reason);
        return;
      }

      applyDeviceSettings(restorePreview.settings);
      if (useIncomingServerUrl) {
        useSettingsStore.getState().setServerUrl(restorePreview.incomingServerUrl);
      }

      const { inserted, updated, unchanged, skippedTables, skippedColumns } = outcome.result;
      const skippedCount = skippedTables.length + skippedColumns.length;
      toast.success(
        `Restored: ${inserted} inserted, ${updated} updated, ${unchanged} unchanged.${
          skippedCount > 0
            ? ` ${skippedCount} field(s) from a different build's Backup were skipped.`
            : ""
        }`,
      );
      setRestorePreview(null);
      window.setTimeout(() => window.location.reload(), 1200);
    } catch (error) {
      console.error("meologue: restore failed", error);
      toast.error(error instanceof Error ? error.message : "Restore failed.");
    } finally {
      setRestoring(false);
    }
  }

  return (
    <section aria-labelledby="data-heading" className="flex flex-col gap-4">
      <h2 id="data-heading" className="font-semibold text-sm">
        Data
      </h2>
      <DeviceGroup heading="On this device">
        <SettingsSection label="Export">
          <div>
            <Button type="button" size="touch" onClick={handleExport} disabled={!opened}>
              Export as zip
            </Button>
          </div>
        </SettingsSection>

        {/*
          Issue #195. Sits beside Export, not inside it — a Backup and an
          Export are two different artifacts (CONTEXT.md's Backup entry):
          an Export is a readable zip of day files, and a Backup is a
          lossless SQL dump of this Device's whole database, settings
          included, meant to be restored rather than read.
        */}
        <SettingsSection
          label="Backup"
          hint="A lossless copy of everything on this Device — every Entry, Task, Project, Section, Label, Filter, Comment and Event, tombstones included, plus your settings. Meant to be restored, not read — see Export above for a plain-text copy you can open directly."
        >
          <div>
            <Button type="button" size="touch" onClick={handleBackup} disabled={!opened}>
              Back up this Device
            </Button>
          </div>
        </SettingsSection>

        {/*
          Issue #197. Restore is the honest, destructive counterpart to
          Backup just above: "this Device becomes the Backup" rather than
          "gains a copy of it." Deliberately its own section, not folded
          into Backup's: the two do opposite things to the same artifact,
          and a reader scanning this page should never mistake one button
          for the other.
        */}
        <SettingsSection
          label="Restore"
          hint="Replaces everything on this Device with a Backup's contents. This is the one action on this page that destroys History on purpose — you'll be asked to confirm before anything is written."
        >
          <div>
            <Button
              type="button"
              size="touch"
              variant="destructive"
              onClick={handlePickRestoreFile}
              disabled={!opened || restoring}
            >
              Restore from a Backup…
            </Button>
          </div>
        </SettingsSection>
      </DeviceGroup>

      <ServerDataGroup />

      {restoreDialogSummoned && (
        <Suspense fallback={null}>
          <DestructiveConfirmDialog
            open={restorePreview !== null}
            onOpenChange={(nextOpen) => {
              if (!nextOpen) {
                setRestorePreview(null);
              }
            }}
            title="Restore this Device from a Backup?"
            description={
              <>
                Taken {formatTakenAt(restorePreview?.takenAt ?? null)}. Every Entry, Task, Project,
                Section, Label, Filter, Comment and Event on this Device is replaced with what's in
                the Backup. Anything created here since then that hasn't Synced yet will be lost.
              </>
            }
            extra={
              <div className="flex flex-col gap-2">
                <SwitchRow
                  label="Server URL"
                  checked={useIncomingServerUrl}
                  onToggle={() => setUseIncomingServerUrl((current) => !current)}
                  onLabel="Use Backup's"
                  offLabel="Keep current"
                  ariaLabel="Use the Backup's Server URL"
                />
                <p className="text-muted-foreground text-xs">
                  The Backup's own Server URL is {restorePreview?.incomingServerUrl || "(none)"} —
                  shown, never applied without a choice (ADR 0011: an unreachable Server URL turns
                  Sync off silently).
                </p>
              </div>
            }
            confirmWord={RESTORE_CONFIRM_WORD}
            confirmText={restoreConfirmText}
            onConfirmTextChange={setRestoreConfirmText}
            busy={restoring}
            progress={restoreProgress}
            onConfirm={handleConfirmRestore}
          />
        </Suspense>
      )}
    </section>
  );
}

/** `restorePreview.takenAt`'s own display form — `null` (an unreadable or missing meta.json) reads as "an unknown time" rather than blocking the confirmation dialog over metadata this page treats as secondary to the data itself. */
function formatTakenAt(takenAt: string | null): string {
  if (takenAt === null) {
    return "an unknown time";
  }
  const parsed = Date.parse(takenAt);
  if (Number.isNaN(parsed)) {
    return takenAt;
  }
  return new Date(parsed).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
