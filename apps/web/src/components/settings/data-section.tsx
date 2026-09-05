import type { EntryStore, ProjectStore, TaskStore } from "@meologue/core";
import { exportEntriesToZip } from "@meologue/core";
import { toast } from "sonner";
import { DeviceGroup } from "@/components/settings/device-group";
import { SettingsSection } from "@/components/settings/settings-section";
import { Button } from "@/components/ui/button";
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
 */
export interface ExportStoreHandle {
  store: EntryStore;
  taskStore: TaskStore;
  projectStore: ProjectStore;
  deviceId: string;
}

/**
 * What this Device can do with its own copy of the user's History — export
 * it — the fifth and last of five topic sections `settings-page.tsx`
 * composes (issue #202).
 *
 * The one topic section that isn't fully self-contained: every other
 * section reads and writes `useSettingsStore` directly, but Export needs
 * the actual `EntryStore`/`TaskStore`/`ProjectStore` instances, which only
 * exist once the Entry store has opened. Settings is a sibling route
 * outside `EntryStoreLayout` (ADR 0008/0009), so it has no outlet context
 * to read those from — `settings-page.tsx` itself subscribes to the same
 * `entryStoreQueryOptions` `SyncLoop` uses (use-sync-loop.ts) and passes
 * the resolved handle down here as `opened`, `undefined` until the store
 * opens (or forever, if it never does — the whole reason Settings has to
 * keep rendering regardless).
 */
export function DataSection({ opened }: { opened: ExportStoreHandle | undefined }) {
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
      </DeviceGroup>
    </section>
  );
}
