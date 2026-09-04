/**
 * One Filter's own screen (issue #185, ADR 0058) — criterion 1's "opening
 * one shows what it matches" and criterion 7's "a live preview shows what
 * a query matches before it is saved" are the *same* code path here, not
 * two: this component always re-parses and re-evaluates whatever text is
 * currently in the query field, whether that's a Filter already saved
 * (`filter` non-null) or one still being composed (`filter === null`,
 * `/todo/filters/new`). Opening a saved Filter is simply "the preview,
 * pre-filled with what was saved last time."
 *
 * **Criterion 6, concretely.** `parseFilterQuery` (@meologue/core) either
 * returns a tree to evaluate or throws a `FilterParseError` naming
 * exactly what's wrong — this component shows that message plainly,
 * where the query was typed, and Save (for a new Filter) is disabled
 * whenever it's showing: the reference implementation's own defect
 * (silently blank, Save still enabled) has no equivalent state to be in
 * here, because there is nothing in between "shows the error" and "shows
 * the matches."
 *
 * **Scope: active Tasks only.** `tasks` is the flat, cross-Project
 * *active* list every other Todo view already renders from
 * (task-search-page.tsx's own header comment makes the identical
 * choice) — nothing in issue #185's acceptance criteria asks a Filter to
 * reach into completed Tasks, and Today/Inbox don't either.
 *
 * **Sections, fetched flat.** Unlike `tasks`/`projects`/`labels`, Todo's
 * outlet context has no eagerly-loaded, cross-Project Section list —
 * `ProjectStore.listSections` is per-Project, read lazily by whichever
 * one Project's own view is open (use-projects.ts's own doc comment).
 * A Filter's `/Section` predicate has no one Project to scope to, so
 * this component fetches every Project's Sections itself
 * (`useAllSections` below) rather than this ticket inventing a new,
 * globally-loaded `sections` field on the outlet context for the one
 * caller that needs it.
 */
import type { Filter, Label, Project, Section, Task } from "@meologue/core";
import {
  DEFAULT_LABEL_COLOUR,
  evaluateFilterQuery,
  FilterParseError,
  LABEL_COLOURS,
  parseFilterQuery,
} from "@meologue/core";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { localDayKey } from "@/components/date-picker-sheet";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { projectNameFor } from "@/lib/project-name";
import { cn } from "@/lib/utils";

export interface FilterViewProps {
  /** `null` means "not saved yet" — `/todo/filters/new`. */
  filter: Filter | null;
  tasks: Task[];
  projects: Project[];
  labels: Label[];
  listSections: (projectId: string) => Promise<Section[]>;
  onCreate: (name: string, query: string, colour: string) => string;
  onRename: (name: string) => void;
  onSetColour: (colour: string) => void;
  onSetQuery: (query: string) => Promise<void>;
  onRemove: () => void;
  onOpenTask: (task: Task) => void;
}

function useAllSections(
  projects: Project[],
  listSections: (projectId: string) => Promise<Section[]>,
) {
  const projectIds = projects.map((p) => p.id);
  return useQuery({
    queryKey: ["filter-view-all-sections", ...projectIds],
    queryFn: async () => (await Promise.all(projectIds.map((id) => listSections(id)))).flat(),
    // Every Project this Device has, however many that is — a personal
    // task list's own Project count is small (projects-view.tsx's
    // identical assumption), so fetching everyone's Sections up front
    // for the one screen that needs a flat view of them costs nothing
    // worth guarding.
    enabled: projectIds.length > 0,
  });
}

export function FilterView({
  filter,
  tasks,
  projects,
  labels,
  listSections,
  onCreate,
  onRename,
  onSetColour,
  onSetQuery,
  onRemove,
  onOpenTask,
}: FilterViewProps) {
  const navigate = useNavigate();
  const isNew = filter === null;

  const [name, setName] = useState(filter?.name ?? "");
  const [colour, setColour] = useState(
    filter?.colour ?? LABEL_COLOURS[0]?.hex ?? DEFAULT_LABEL_COLOUR,
  );
  const [queryText, setQueryText] = useState(filter?.query ?? "");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  const sectionsQuery = useAllSections(projects, listSections);
  const sections = sectionsQuery.data ?? [];

  // The one evaluation both "show what a saved Filter matches" and "show
  // a live preview before saving" read from — this component's own
  // header comment explains why those are the same computation.
  const evaluation = useMemo(() => {
    try {
      const parsed = parseFilterQuery(queryText);
      return {
        error: null,
        result: evaluateFilterQuery(parsed, {
          tasks,
          projects,
          sections,
          labels,
          now: localDayKey(new Date()),
        }),
      };
    } catch (error) {
      if (error instanceof FilterParseError) {
        return { error, result: null };
      }
      throw error;
    }
  }, [queryText, tasks, projects, sections, labels]);

  const trimmedName = name.trim();
  // Criterion 6: Save (the create door) is never offered for a query
  // that cannot be saved meaningfully.
  const canSave = trimmedName !== "" && evaluation.error === null;

  function handleSave() {
    setSaveError(null);
    try {
      const id = onCreate(trimmedName, queryText, colour);
      navigate(`/todo/filters/${id}`);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Couldn't save this Filter.");
    }
  }

  function commitRename() {
    if (isNew || trimmedName === "" || trimmedName === filter.name) {
      return;
    }
    onRename(trimmedName);
  }

  function commitColour(next: string) {
    setColour(next);
    if (!isNew) {
      onSetColour(next);
    }
  }

  // Mirrors project-view.tsx's own commitRename-on-blur shape, extended
  // with criterion 6's own rule: a query that doesn't parse is never
  // committed. The field itself keeps whatever the reader typed either
  // way — the error shown below is exactly what's stopping the commit,
  // so clearing the text on top of that would hide the one thing telling
  // the reader what to fix.
  async function commitQuery() {
    if (isNew || evaluation.error !== null || queryText === filter.query) {
      return;
    }
    try {
      await onSetQuery(queryText);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Couldn't save this query.");
    }
  }

  return (
    <div className="flex flex-col gap-4 p-3">
      <div className="flex items-center gap-2">
        <select
          aria-label="Filter colour"
          value={colour}
          onChange={(event) => commitColour(event.target.value)}
          className="shrink-0 rounded-md border border-border bg-background px-1.5 text-xs"
        >
          {LABEL_COLOURS.map((option) => (
            <option key={option.hex} value={option.hex}>
              {option.name.replace(/_/g, " ")}
            </option>
          ))}
        </select>
        <Input
          type="text"
          aria-label="Filter name"
          placeholder="Filter name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          onBlur={commitRename}
          className="flex-1"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Textarea
          aria-label="Filter query"
          placeholder="today, #Work & p1, @urgent | overdue"
          value={queryText}
          onChange={(event) => setQueryText(event.target.value)}
          onBlur={() => void commitQuery()}
          rows={3}
          className="font-mono text-sm"
        />
        {evaluation.error !== null && (
          <p role="alert" className="text-destructive text-sm">
            {evaluation.error.message}
          </p>
        )}
        {saveError !== null && (
          <p role="alert" className="text-destructive text-sm">
            {saveError}
          </p>
        )}
      </div>

      {isNew && (
        <Button type="button" onClick={handleSave} disabled={!canSave}>
          Save
        </Button>
      )}

      {!isNew && (
        <Button type="button" variant="outline" onClick={() => setConfirmingRemove(true)}>
          Remove Filter
        </Button>
      )}

      {evaluation.result !== null && (
        <div className="flex flex-col gap-4">
          {evaluation.result.lists.map((list, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a query's own comma-separated lists have no id of their own — `list.label` alone isn't unique if the reader types the same segment twice ("today, today"), which this key still has to tolerate.
            <div key={`${list.label}-${index}`} className="flex flex-col gap-1.5">
              {evaluation.result.lists.length > 1 && (
                <h3 className="px-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">
                  {list.label} · {list.tasks.length}
                </h3>
              )}
              {list.tasks.length === 0 ? (
                <p className="px-1 py-2 text-muted-foreground text-sm">No matching Tasks.</p>
              ) : (
                <ul className="flex flex-col gap-0.5">
                  {list.tasks.map((task) => (
                    <li key={task.id}>
                      <button
                        type="button"
                        onClick={() => onOpenTask(task)}
                        className="flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-2 text-left text-sm hover:bg-muted"
                      >
                        <span
                          className={cn("truncate", task.completedAt !== null && "line-through")}
                        >
                          {task.content}
                        </span>
                        <span className="truncate text-muted-foreground text-xs">
                          {projectNameFor(projects, task.projectId)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={confirmingRemove}
        onOpenChange={setConfirmingRemove}
        title="Remove this Filter?"
        description={
          filter && (
            <>
              Removing "{filter.name}" only removes the saved query — none of the Tasks it matches
              are touched.
            </>
          )
        }
        confirmLabel="Remove"
        onConfirm={() => {
          onRemove();
          navigate("/todo/filters");
        }}
      />
    </div>
  );
}
