import { Suspense, useState } from "react";
import { toast } from "sonner";
import { DeviceGroup } from "@/components/settings/device-group";
import { LazyDestructiveConfirmDialog as DestructiveConfirmDialog } from "@/components/settings/lazy-destructive-confirm-dialog";
import { SettingsSection } from "@/components/settings/settings-section";
import { Button } from "@/components/ui/button";
import {
  fetchServerBackup,
  rebuildMismatchedEmbeddings,
  restoreServerBackup,
} from "@/lib/server-backup-transport";
import { useSyncEnabled } from "@/lib/settings";
import { loadFile } from "@/platform/load-file";
import { saveFile } from "@/platform/save-file";

/**
 * The Server's own Backup and Restore (issue #198) — `data-section.tsx`'s
 * "On the server" sub-group, distinct from that file's own "On this
 * device" one in a way none of the other four topic sections' Server
 * sub-groups are: a Server Backup is a `pg_dump` archive of every Device's
 * shared History (Entries, Tasks, Sessions, Digests, embeddings), not this
 * one Device's own copy, and restoring it replaces that shared database
 * for every Device syncing against it, not just this Device's local rows.
 * CONTEXT.md's Restore entry ("it asks before it acts, because this is the
 * one operation that destroys History on purpose") applies here at least
 * as much as it does to Device Restore in `data-section.tsx` — reused via
 * the identical `DestructiveConfirmDialog`, not a second, softer
 * confirmation, per issue #198's own brief.
 *
 * Visible only once a Server URL is set (`useSyncEnabled`, ADR 0011):
 * unlike `ServerGroup` (`server-config-form.tsx`), which stays mounted and
 * explains *why* it has nothing to show for an unset or unreachable
 * Server, this section renders nothing at all rather than a permanently
 * disabled pair of destructive buttons — there is no `/v1/config`-style
 * query backing it to make a "loading" or "unreachable" state meaningful,
 * and a Backup/Restore button that always fails the moment it's pressed
 * would be worse than one that simply isn't there.
 */
export function ServerDataGroup() {
  const syncEnabled = useSyncEnabled();

  const [backingUp, setBackingUp] = useState(false);
  const [pendingRestoreBytes, setPendingRestoreBytes] = useState<Uint8Array | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [restoring, setRestoring] = useState(false);
  const [mismatchCount, setMismatchCount] = useState<number | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  // Turns true, and stays true, the first time a reader picks a file to
  // restore — see lazy-destructive-confirm-dialog.ts's own doc comment for
  // why the dialog isn't simply mounted with `open={false}` from the
  // start.
  const [restoreDialogSummoned, setRestoreDialogSummoned] = useState(false);

  // No progress UI beyond `backingUp` disabling the button — matching
  // `data-section.tsx`'s own Device Backup, a personal-log-scale database
  // is fast enough over `pg_dump` that success/failure toasts are the
  // whole story. Delivered through the identical `@/platform/save-file`
  // seam, honouring "saved"/"cancelled" the same way (ticket 47's defect
  // fix, docs/adr/0016): a cancelled save panel / share sheet must raise
  // neither toast, since nothing was written anywhere.
  async function handleServerBackup() {
    setBackingUp(true);
    try {
      const result = await fetchServerBackup();
      if (!result.ok) {
        toast.error(
          result.reason === "unreachable"
            ? "Couldn't reach the server. Check that it's running and try again."
            : result.message,
        );
        return;
      }
      const outcome = await saveFile("meologue-server-backup.dump", result.bytes);
      if (outcome === "cancelled") {
        return;
      }
      toast.success("Backed up the server to meologue-server-backup.dump.");
    } catch (error) {
      console.error("meologue: server backup failed", error);
      toast.error(error instanceof Error ? error.message : "Backup failed.");
    } finally {
      setBackingUp(false);
    }
  }

  // A distinct word from Device Restore's own "RESTORE" (data-section.tsx)
  // — deliberately, not by omission: the two destroy different things (this
  // Device's own rows vs. every Device's shared History on the Server),
  // and a reader who has both dialogs' shape memorised should still have
  // to read which one is open rather than pattern-match the same six
  // letters onto whichever button they clicked.
  const RESTORE_CONFIRM_WORD = "RESTORE SERVER";

  // Reuses `@/platform/load-file` — the identical file-picking seam Device
  // Restore uses, despite that seam's web implementation hinting `.zip`
  // (load-file.web.ts's own `accept` attribute) where a Server Backup is
  // actually a bare `.dump` file: `accept` is a filter hint an OS picker's
  // "All Files" option can always route around, not an enforced
  // allowlist, and this app has exactly one file-picking primitive to
  // reuse rather than a second one purpose-built for one extension.
  // Picking a file is not itself destructive, so it opens the confirmation
  // dialog rather than restoring immediately — only
  // handleConfirmServerRestore below ever calls the Server.
  async function handlePickServerRestoreFile() {
    const picked = await loadFile();
    if (picked.outcome === "cancelled") {
      return;
    }
    setPendingRestoreBytes(picked.bytes);
    setConfirmText("");
    setRestoreDialogSummoned(true);
  }

  // The confirmation dialog's own destructive action. Unlike Device
  // Restore, there is nothing local to reload afterward — a Server Restore
  // changes the Server's own database, not anything this Device holds —
  // so this reports the outcome and, if `mismatched_embedding_count` is
  // nonzero, leaves the "Rebuild" follow-up below on screen rather than
  // reloading anything out from under the reader.
  async function handleConfirmServerRestore() {
    if (pendingRestoreBytes === null) {
      return;
    }
    setRestoring(true);
    try {
      const result = await restoreServerBackup(pendingRestoreBytes);
      if (!result.ok) {
        toast.error(
          result.reason === "unreachable"
            ? "Couldn't reach the server. Check that it's running and try again."
            : result.message,
        );
        return;
      }
      const { mismatched_embedding_count: mismatched } = result.report;
      toast.success(
        mismatched > 0
          ? `Server restored. ${mismatched} Entries carry an embedding from a different model.`
          : "Server restored.",
      );
      setMismatchCount(mismatched > 0 ? mismatched : null);
      setPendingRestoreBytes(null);
    } catch (error) {
      console.error("meologue: server restore failed", error);
      toast.error(error instanceof Error ? error.message : "Restore failed.");
    } finally {
      setRestoring(false);
    }
  }

  // The "rebuild or leave" choice `POST /v1/restore/rebuild-embeddings`
  // exists for (server-backup-transport.ts's own doc comment): nulls
  // `embedding` for every mismatched row so ADR 0022's background worker
  // refills it on its own schedule. "Leave them" is simply not clicking
  // this — those Entries stay searchable by keyword, just not yet by
  // meaning, until whatever eventually re-embeds them (this call, or the
  // worker catching a mismatch some other way).
  async function handleRebuildEmbeddings() {
    setRebuilding(true);
    try {
      const result = await rebuildMismatchedEmbeddings();
      if (!result.ok) {
        toast.error(
          result.reason === "unreachable"
            ? "Couldn't reach the server. Check that it's running and try again."
            : result.message,
        );
        return;
      }
      toast.success(`${result.report.rebuilt_count} Entries queued for re-embedding.`);
      setMismatchCount(null);
    } catch (error) {
      console.error("meologue: rebuild failed", error);
      toast.error(error instanceof Error ? error.message : "Rebuild failed.");
    } finally {
      setRebuilding(false);
    }
  }

  if (!syncEnabled) {
    return null;
  }

  return (
    <DeviceGroup heading="On the server">
      <SettingsSection
        label="Backup"
        hint="A pg_dump archive of everything the server holds for every Device that syncs with it — Entries, Tasks, Sessions, Digests and embeddings included."
      >
        <div>
          <Button type="button" size="touch" onClick={handleServerBackup} disabled={backingUp}>
            Back up server
          </Button>
        </div>
      </SettingsSection>

      <SettingsSection
        label="Restore"
        hint="Replaces the server's whole database with a Backup's contents, for every Device that syncs with it. This is the one action here that destroys History on purpose — you'll be asked to confirm before anything is written."
      >
        <div className="flex flex-col gap-2">
          <Button
            type="button"
            size="touch"
            variant="destructive"
            onClick={handlePickServerRestoreFile}
            disabled={restoring}
          >
            Restore server…
          </Button>
          {mismatchCount !== null && (
            <div className="flex flex-col gap-2 rounded-lg border border-border p-2">
              <p className="text-muted-foreground text-xs">
                {mismatchCount} {mismatchCount === 1 ? "Entry carries" : "Entries carry"} an
                embedding from a different model — searchable by keyword now, not yet by meaning.
              </p>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  onClick={handleRebuildEmbeddings}
                  disabled={rebuilding}
                >
                  Rebuild {mismatchCount}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setMismatchCount(null)}
                  disabled={rebuilding}
                >
                  Leave them
                </Button>
              </div>
            </div>
          )}
        </div>
      </SettingsSection>

      {restoreDialogSummoned && (
        <Suspense fallback={null}>
          <DestructiveConfirmDialog
            open={pendingRestoreBytes !== null}
            onOpenChange={(nextOpen) => {
              if (!nextOpen) {
                setPendingRestoreBytes(null);
              }
            }}
            title="Restore the server from a Backup?"
            description="Every Entry, Task, Project, Session and Digest the server holds is replaced with what's in the Backup — for every Device that syncs with it, not just this one. Anything written since the Backup was taken and not itself backed up separately will be lost."
            confirmWord={RESTORE_CONFIRM_WORD}
            confirmText={confirmText}
            onConfirmTextChange={setConfirmText}
            busy={restoring}
            progress="Restoring…"
            onConfirm={handleConfirmServerRestore}
          />
        </Suspense>
      )}
    </DeviceGroup>
  );
}
