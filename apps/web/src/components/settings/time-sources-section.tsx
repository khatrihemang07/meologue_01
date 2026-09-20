import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TIME_SOURCES_QUERY_KEY } from "@/lib/query-keys";
import { useServerReachable, useSyncEnabled } from "@/lib/settings";
import {
  createTimeSource,
  listTimeSources,
  type TimeSource,
  updateTimeSource,
} from "@/lib/time-transport";

/**
 * Server-owned recorder configuration.
 *
 * The adapter kind is chosen explicitly rather than guessed from the path.
 * Both supported databases are Core Data SQLite files with similar-looking
 * paths, and guessing wrong would mean a source that saves happily and then
 * imports nothing — the Server validates the file against the kind that was
 * asked for, so the kind has to be the user's answer, not an inference.
 */
export function TimeSourcesSection() {
  const syncEnabled = useSyncEnabled();
  const serverReachable = useServerReachable();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<SourceKindId>("toggl_activity");
  const [path, setPath] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const selectedKind = SOURCE_KINDS.find((option) => option.id === kind) ?? SOURCE_KINDS[0];
  const sourcesQuery = useQuery({
    queryKey: TIME_SOURCES_QUERY_KEY,
    queryFn: listTimeSources,
    enabled: syncEnabled && serverReachable,
  });
  const createMutation = useMutation({
    mutationFn: createTimeSource,
    onSuccess: (result) => {
      if (!result.ok) {
        setStatus(createFailureCopy(result.reason));
        return;
      }
      queryClient.setQueryData(TIME_SOURCES_QUERY_KEY, (previous: unknown) => {
        const sources = isSourcesResult(previous) ? previous.sources : [];
        return { ok: true as const, sources: [...sources, result.source] };
      });
      setName("");
      setPath("");
      setStatus("Added. Importing activity in the background.");
    },
  });

  // Archiving and re-enabling share one mutation: they are the same request
  // with a different boolean, and the Server decides what each one means.
  const enabledMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      updateTimeSource(id, { enabled }),
    onSuccess: (result) => {
      if (!result.ok) {
        setStatus(updateFailureCopy(result.reason));
        return;
      }
      queryClient.setQueryData(TIME_SOURCES_QUERY_KEY, (previous: unknown) => {
        const sources = isSourcesResult(previous) ? previous.sources : [];
        return {
          ok: true as const,
          sources: sources.map((source) =>
            source.id === result.source.id ? result.source : source,
          ),
        };
      });
      setStatus(
        result.source.enabled
          ? "Re-enabled. Importing anything recorded since it was archived."
          : "Archived. Its Activity stays on the days it already covered.",
      );
    },
  });

  return (
    <section aria-labelledby="time-sources-heading" className="flex flex-col gap-4">
      <div>
        <h2 id="time-sources-heading" className="font-semibold text-sm">
          Time sources
        </h2>
        <p className="mt-1 text-muted-foreground text-xs">
          Activity databases are read directly by this Server and can contain sensitive window
          titles.
        </p>
      </div>

      {!syncEnabled ? (
        <p className="text-sm text-muted-foreground">
          <Link to="/settings" className="underline underline-offset-2 hover:text-foreground">
            Add a Server URL
          </Link>{" "}
          before configuring Time sources.
        </p>
      ) : (
        <>
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              setStatus(null);
              void createMutation.mutateAsync({ name, kind, path });
            }}
          >
            <div className="flex flex-col gap-1">
              <label htmlFor="time-source-name" className="text-sm">
                Source name
              </label>
              <Input
                id="time-source-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. Work activity"
                required
                className="h-11"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="time-source-kind" className="text-sm">
                Recorder
              </label>
              <select
                id="time-source-kind"
                value={kind}
                onChange={(event) => setKind(event.target.value as SourceKindId)}
                className="h-11 rounded-md border border-border bg-background px-3 text-sm"
              >
                {SOURCE_KINDS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="time-source-path" className="text-sm">
                {selectedKind.pathLabel}
              </label>
              <Input
                id="time-source-path"
                value={path}
                onChange={(event) => setPath(event.target.value)}
                placeholder={selectedKind.placeholder}
                required
                className="h-11"
              />
            </div>
            <div>
              <Button
                type="submit"
                size="touch"
                disabled={createMutation.isPending || !serverReachable}
              >
                {createMutation.isPending ? "Adding…" : "Add Time source"}
              </Button>
            </div>
          </form>
          {status && <p className="text-muted-foreground text-sm">{status}</p>}
          <ConfiguredSources
            query={sourcesQuery.data}
            pending={sourcesQuery.isPending}
            onSetEnabled={(id, enabled) => {
              setStatus(null);
              void enabledMutation.mutateAsync({ id, enabled });
            }}
            pendingId={enabledMutation.isPending ? enabledMutation.variables?.id : undefined}
          />
        </>
      )}
    </section>
  );
}

/** The adapter kinds the Server accepts, and what each one asks the user for. */
const SOURCE_KINDS = [
  {
    id: "toggl_activity",
    label: "Toggl Track — Activity Recording",
    pathLabel: "Toggl database path",
    placeholder: "~/Library/Group Containers/…/DatabaseModel.sqlite",
  },
  {
    id: "clockify_auto_tracker",
    label: "Clockify Desktop — Auto Tracker",
    pathLabel: "Clockify database path",
    placeholder: "~/Library/Application Support/Clockify Desktop/Clockify_….sqlite",
  },
] as const satisfies readonly {
  id: string;
  label: string;
  pathLabel: string;
  placeholder: string;
}[];

type SourceKindId = (typeof SOURCE_KINDS)[number]["id"];

function kindLabel(kind: string): string {
  return SOURCE_KINDS.find((option) => option.id === kind)?.label ?? kind;
}

function ConfiguredSources({
  query,
  pending,
  onSetEnabled,
  pendingId,
}: {
  query: unknown;
  pending: boolean;
  onSetEnabled: (id: string, enabled: boolean) => void;
  pendingId: string | undefined;
}) {
  if (pending) {
    return <p className="text-muted-foreground text-sm">Loading configured sources…</p>;
  }
  if (!isSourcesResult(query)) {
    return (
      <p className="text-muted-foreground text-sm">
        Configured sources couldn't be loaded right now.
      </p>
    );
  }
  if (query.sources.length === 0) {
    return <p className="text-muted-foreground text-sm">No Time sources are configured.</p>;
  }
  return (
    <ul aria-label="Configured Time sources" className="flex flex-col gap-1 text-sm">
      {query.sources.map((source) => (
        <li key={source.id} className="flex items-center justify-between gap-3">
          <span className="flex min-w-0 flex-col">
            <span className="truncate">
              {source.name}
              {!source.enabled && " (archived)"}
            </span>
            <span className="truncate text-muted-foreground text-xs">{kindLabel(source.kind)}</span>
          </span>
          {/* Archive, never delete (issue #423): a source's Activity intervals
              are evidence attributed to it, so there is nothing here that can
              destroy them. */}
          <Button
            type="button"
            size="touch"
            variant="outline"
            className="shrink-0"
            disabled={pendingId === source.id}
            aria-label={`${source.enabled ? "Archive" : "Re-enable"} ${source.name}`}
            onClick={() => onSetEnabled(source.id, !source.enabled)}
          >
            {source.enabled ? "Archive" : "Re-enable"}
          </Button>
        </li>
      ))}
    </ul>
  );
}

function isSourcesResult(value: unknown): value is { ok: true; sources: TimeSource[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    value.ok === true &&
    "sources" in value &&
    Array.isArray(value.sources)
  );
}

function updateFailureCopy(
  reason: "not-supported" | "unreachable" | "rejected" | "locked",
): string {
  switch (reason) {
    case "not-supported":
      return "This Server doesn't support changing Time sources yet.";
    case "unreachable":
      return "Couldn't reach the Server. Check that it's running and try again.";
    case "locked":
      return "This Server's configuration is locked, so its Time sources can't be changed here.";
    case "rejected":
      return "The Server refused that change.";
  }
}

function createFailureCopy(reason: "not-supported" | "unreachable" | "rejected"): string {
  switch (reason) {
    case "not-supported":
      return "This Server doesn't support Time sources yet.";
    case "unreachable":
      return "Couldn't reach the Server. Check that it's running and try again.";
    case "rejected":
      return "The Server couldn't validate that source. Check its name and database path.";
  }
}
