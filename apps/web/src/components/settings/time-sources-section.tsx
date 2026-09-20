import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TIME_SOURCES_QUERY_KEY } from "@/lib/query-keys";
import { useServerReachable, useSyncEnabled } from "@/lib/settings";
import { createTimeSource, listTimeSources, type TimeSource } from "@/lib/time-transport";

/**
 * Server-owned recorder configuration. This first source form names Toggl
 * Activity Recording explicitly; Clockify and source lifecycle controls are
 * follow-up slices, rather than pretending their adapters exist today.
 */
export function TimeSourcesSection() {
  const syncEnabled = useSyncEnabled();
  const serverReachable = useServerReachable();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [status, setStatus] = useState<string | null>(null);
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
              void createMutation.mutateAsync({ name, kind: "toggl_activity", path });
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
              <label htmlFor="toggl-database-path" className="text-sm">
                Toggl database path
              </label>
              <Input
                id="toggl-database-path"
                value={path}
                onChange={(event) => setPath(event.target.value)}
                placeholder="~/Library/Group Containers/…/DatabaseModel.sqlite"
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
          <ConfiguredSources query={sourcesQuery.data} pending={sourcesQuery.isPending} />
        </>
      )}
    </section>
  );
}

function ConfiguredSources({ query, pending }: { query: unknown; pending: boolean }) {
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
        <li key={source.id}>
          {source.name}
          {!source.enabled && " (archived)"}
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
