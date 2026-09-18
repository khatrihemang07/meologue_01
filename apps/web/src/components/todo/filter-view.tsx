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
 * **Scope: active Tasks only, plus completed matches once Settings turns
 * them on (issue #358).** `tasks` is the flat, cross-Project *active* list
 * every other Todo view already renders from (task-search-page.tsx's own
 * header comment makes the identical choice); issue #185's own acceptance
 * criteria never asked a Filter to reach into completed Tasks, and this
 * still evaluates the query against `tasks` alone for that half. Issue
 * #358's own "the behaviour holds... in a Filter view" criterion is what
 * adds the other half: whenever `completedTasksVisible` (lib/settings.ts)
 * is on, the identical parsed query is evaluated a second time against
 * `completedTasks`, and each list's own completed matches render below its
 * active ones, paginated exactly like Inbox/Project's own trailing block
 * (`FilterResultGroup` below, `useCompletedTasksPage`). Off — the
 * default — this component's own behaviour is unchanged from before this
 * ticket: no completed Task ever reaches this screen.
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
import { CompletedTasksLoadMore } from "@/components/todo/completed-tasks-load-more";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useCompletedTasksPage } from "@/hooks/use-completed-tasks-page";
import { localDayKey } from "@/lib/local-day-key";
import { projectNameFor } from "@/lib/project-name";
import { useSettingsStore } from "@/lib/settings";
import { cn } from "@/lib/utils";

export interface FilterViewProps {
  /** `null` means "not saved yet" — `/todo/filters/new`. */
  filter: Filter | null;
  tasks: Task[];
  /** Issue #358: every completed Task anywhere — the identical flat, whole-account list `task-list.tsx`'s own `completedTasks` prop doc comment describes. Only ever evaluated against the query when `completedTasksVisible` is on; ignored entirely while it's off. Defaults to empty. */
  completedTasks?: Task[];
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
  completedTasks = [],
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
  const completedTasksVisible = useSettingsStore((state) => state.completedTasksVisible);

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
  //
  // Issue #358: `completedResult` is the identical parsed query evaluated a
  // second time against `completedTasks` instead of `tasks` — `null` while
  // `completedTasksVisible` is off, so no completed Task is ever matched,
  // let alone rendered, in the default state. `evaluateFilterQuery` takes
  // whatever `tasks` array its context is handed with no assumption about
  // active/completed, so this needs no change to `@meologue/core` — only a
  // second call.
  const evaluation = useMemo(() => {
    try {
      const parsed = parseFilterQuery(queryText);
      const context = { projects, sections, labels, now: localDayKey(new Date()) };
      return {
        error: null,
        result: evaluateFilterQuery(parsed, { tasks, ...context }),
        completedResult: completedTasksVisible
          ? evaluateFilterQuery(parsed, { tasks: completedTasks, ...context })
          : null,
      };
    } catch (error) {
      if (error instanceof FilterParseError) {
        return { error, result: null, completedResult: null };
      }
      throw error;
    }
  }, [queryText, tasks, completedTasks, completedTasksVisible, projects, sections, labels]);

  const trimmedName = name.trim();
  // Criterion 6: Save (the create door) is never offered for a query
  // that cannot be saved meaningfully.
  const canSave = trimmedName !== "" && evaluation.error === null;

  function handleSave() {
    setSaveError(null);
    try {
      const id = onCreate(trimmedName, queryText, colour);
      // `replace` (ADR 0079's follow-up, ADR 0086): landing on the new
      // Filter's own address is still Todo's own interior navigation, not
      // a departure — a plain `navigate` here left `/todo/filters/new`'s
      // now-meaningless address behind for Back to land on.
      navigate(`/todo/filters/${id}`, { replace: true });
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
            <FilterResultGroup
              // biome-ignore lint/suspicious/noArrayIndexKey: a query's own comma-separated lists have no id of their own — `list.label` alone isn't unique if the reader types the same segment twice ("today, today"), which this key still has to tolerate.
              key={`${list.label}-${index}`}
              list={list}
              // Issue #358: this same index into `completedResult.lists`
              // names the identical comma-separated segment of the query —
              // both evaluations parsed the one `parsed` tree, so the
              // number and order of lists depend only on the query text,
              // never on which Task array either call was handed.
              completedTasks={evaluation.completedResult?.lists[index]?.tasks ?? []}
              showHeading={evaluation.result.lists.length > 1}
              projects={projects}
              onOpenTask={onOpenTask}
            />
          ))}
        </div>
      )}

      <ConfirmDialog
        open={confirmingRemove}
        onOpenChange={setConfirmingRemove}
        title="Delete filter?"
        description={filter && <>The {filter.name} filter will be permanently deleted.</>}
        confirmLabel="Delete"
        onConfirm={() => {
          onRemove();
          // `replace` (ADR 0079's follow-up, ADR 0086): the Filter this
          // reader was just standing on no longer exists — a plain
          // `navigate` left its now-dead address behind for Back to land
          // back on, same class of gap as the create path just above.
          navigate("/todo/filters", { replace: true });
        }}
      />
    </div>
  );
}

/**
 * One comma-separated segment of a Filter query's own results — its own
 * active matches, then (issue #358) its own completed matches below them,
 * paginated exactly like Inbox/Project's own trailing block
 * (`task-tree.tsx`'s identical `useCompletedTasksPage` call). Split out from
 * `FilterView` above only because that hook can't be called once per array
 * element inside a `.map()` — the number of lists a query produces can
 * change as the reader edits it, and the Rules of Hooks forbid a hook call
 * count that varies between renders; one component instance per list, each
 * mounted or unmounted as a whole, is what keeps that safe.
 */
function FilterResultGroup({
  list,
  completedTasks,
  showHeading,
  projects,
  onOpenTask,
}: {
  list: { label: string; tasks: Task[] };
  /** This same segment's own completed matches — already `[]` when `completedTasksVisible` is off (`FilterView`'s own call site). */
  completedTasks: Task[];
  showHeading: boolean;
  projects: Project[];
  onOpenTask: (task: Task) => void;
}) {
  const completedPage = useCompletedTasksPage(completedTasks.length);
  const visibleCompletedTasks = completedTasks.slice(0, completedPage.visibleCount);

  return (
    <div className="flex flex-col gap-1.5">
      {showHeading && (
        <h3 className="px-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">
          {list.label} · {list.tasks.length}
        </h3>
      )}
      {list.tasks.length === 0 && visibleCompletedTasks.length === 0 ? (
        <p className="px-1 py-2 text-muted-foreground text-sm">No matching Tasks.</p>
      ) : (
        <>
          {list.tasks.length > 0 && (
            <ul className="flex flex-col gap-0.5">
              {list.tasks.map((task) => (
                <FilterResultRow
                  key={task.id}
                  task={task}
                  projects={projects}
                  onOpenTask={onOpenTask}
                />
              ))}
            </ul>
          )}
          {visibleCompletedTasks.length > 0 && (
            <>
              <ul className="flex flex-col gap-0.5">
                {visibleCompletedTasks.map((task) => (
                  <FilterResultRow
                    key={task.id}
                    task={task}
                    projects={projects}
                    onOpenTask={onOpenTask}
                  />
                ))}
              </ul>
              <CompletedTasksLoadMore
                remaining={completedPage.remaining}
                onLoadMore={completedPage.loadMore}
              />
            </>
          )}
        </>
      )}
    </div>
  );
}

/** One matching Task's own row — active or completed alike, told apart only by `completed-task-text` (`task.completedAt !== null`), the same "same row, distinguished only by an added class" shape `ROW-14` (parity-ledger.md) established for the Inbox/Project row. This screen never used `TaskRow` for either, so there is no fuller row to preserve here — this is the lightweight preview row issue #185 built, unchanged by issue #358 beyond now also rendering a completed Task's row. */
function FilterResultRow({
  task,
  projects,
  onOpenTask,
}: {
  task: Task;
  projects: Project[];
  onOpenTask: (task: Task) => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpenTask(task)}
        className="flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-2 text-left text-sm hover:bg-muted"
      >
        <span className={cn("truncate", task.completedAt !== null && "completed-task-text")}>
          {task.content}
        </span>
        <span className="truncate text-muted-foreground text-xs">
          {projectNameFor(projects, task.projectId)}
        </span>
      </button>
    </li>
  );
}
