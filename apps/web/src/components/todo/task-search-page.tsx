/**
 * The full search page (issue #183) — Quick-find's own sibling surface
 * (task-quick-find.tsx's header comment has the full split). Reached by
 * its own URL (`/todo/search?q=…`), not an app-bar narrowing field: it
 * searches Task **titles and Descriptions** (each field checked on its
 * own — @meologue/core's matchesSubstring/matchesWholeWord never span
 * title into Description or vice versa, task-search.ts's own header
 * comment has the full reasoning) in one tab, and Comments in a separate
 * tab, matching neither Project nor Section nor Label names — the mirror
 * image of Quick-find's own title-and-Project-only scope. Never renders a
 * `<mark>` — issue #183's own reference-behaviour research found a real
 * Todoist highlighting only in the dropdown, never on this page.
 *
 * Completed Tasks are excluded until "Show completed" is switched on,
 * which — faithfully, not smoothed away — also switches matching to
 * whole-word only for every Task result, active or completed alike (see
 * TaskSearchOptions.includeCompleted's own doc comment, @meologue/core).
 * A completed result renders struck through with a filled checkbox, and
 * clicking that checkbox un-completes it right from this page — issue
 * #183's own reference-behaviour research observed exactly that
 * affordance on a real Todoist's own search results.
 */
import type { Comment, Project, Task } from "@meologue/core";
import { matchesSubstring, matchesWholeWord } from "@meologue/core";
import { Check } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { useSearchParams } from "react-router";
import { projectNameFor } from "@/lib/project-name";
import { cn } from "@/lib/utils";

export interface TaskSearchPageProps {
  /** Active Tasks — TaskStore.search's own default scope. */
  tasks: Task[];
  /** Completed Tasks, included only once "Show completed" is on. */
  completedTasks: Task[];
  /** Every live Comment across every Task (already loaded — use-comments.ts's own doc comment). */
  comments: Comment[];
  projects: Project[];
  onOpenTask: (task: Task) => void;
  onUncompleteTask: (taskId: string) => void;
}

type Tab = "tasks" | "comments";

const QUERY_PARAM = "q";
const TAB_PARAM = "tab";
const COMPLETED_PARAM = "completed";

export function TaskSearchPage({
  tasks,
  completedTasks,
  comments,
  projects,
  onOpenTask,
  onUncompleteTask,
}: TaskSearchPageProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const query = searchParams.get(QUERY_PARAM) ?? "";
  const tab: Tab = searchParams.get(TAB_PARAM) === "comments" ? "comments" : "tasks";
  const includeCompleted = searchParams.get(COMPLETED_PARAM) === "1";

  function setQuery(next: string) {
    setSearchParams(
      (previous) => {
        const params = new URLSearchParams(previous);
        if (next.trim() === "") {
          params.delete(QUERY_PARAM);
        } else {
          params.set(QUERY_PARAM, next);
        }
        return params;
      },
      { replace: true },
    );
  }

  function setTab(next: Tab) {
    setSearchParams(
      (previous) => {
        const params = new URLSearchParams(previous);
        params.set(TAB_PARAM, next);
        return params;
      },
      { replace: true },
    );
  }

  function setIncludeCompleted(next: boolean) {
    setSearchParams(
      (previous) => {
        const params = new URLSearchParams(previous);
        if (next) {
          params.set(COMPLETED_PARAM, "1");
        } else {
          params.delete(COMPLETED_PARAM);
        }
        return params;
      },
      { replace: true },
    );
  }

  // Title-or-Description, each checked on its own — see this file's own
  // header comment. Creation order (id is a time-ordered uuidv7, ../../
  // ../packages/core/src/id.ts), the same "no relevance re-ranking"
  // ordering TaskStore.search itself uses.
  const taskResults = useMemo(() => {
    const trimmed = query.trim();
    if (trimmed === "") {
      return [];
    }
    const matcher = includeCompleted ? matchesWholeWord : matchesSubstring;
    const candidates = includeCompleted ? [...tasks, ...completedTasks] : tasks;
    return candidates
      .filter((t) => matcher(t.content, trimmed) || matcher(t.description, trimmed))
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  }, [tasks, completedTasks, query, includeCompleted]);

  const commentResults = useMemo(() => {
    const trimmed = query.trim();
    if (trimmed === "") {
      return [];
    }
    return comments
      .filter((c) => matchesSubstring(c.text, trimmed))
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  }, [comments, query]);

  const allTasksById = useMemo(() => {
    const map = new Map<string, Task>();
    for (const t of [...tasks, ...completedTasks]) {
      map.set(t.id, t);
    }
    return map;
  }, [tasks, completedTasks]);

  // Focused on mount, via a ref rather than the `autoFocus` attribute
  // (biome's a11y/noAutofocus — task-quick-find.tsx's own onOpenAutoFocus
  // makes the identical choice for the dropdown's input): a reader who
  // lands on this page, whether from Quick-find's "Show more results" or
  // its own bookmarked URL, is here specifically to type a query.
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div className="flex flex-col gap-3 px-3 py-3">
      <input
        ref={inputRef}
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search Tasks and Comments"
        aria-label="Search Tasks and Comments"
        className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground"
      />

      <div className="flex items-center justify-between">
        <div role="tablist" className="flex gap-1">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "tasks"}
            onClick={() => setTab("tasks")}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm",
              tab === "tasks" ? "bg-muted font-medium" : "text-muted-foreground",
            )}
          >
            Tasks
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "comments"}
            onClick={() => setTab("comments")}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm",
              tab === "comments" ? "bg-muted font-medium" : "text-muted-foreground",
            )}
          >
            Comments
          </button>
        </div>

        {tab === "tasks" && (
          <label className="flex items-center gap-1.5 text-muted-foreground text-xs">
            <input
              type="checkbox"
              checked={includeCompleted}
              onChange={(event) => setIncludeCompleted(event.target.checked)}
            />
            Show completed
          </label>
        )}
      </div>

      {query.trim() === "" ? (
        <p className="px-1 py-6 text-center text-muted-foreground text-sm">
          Type to search Task titles, Descriptions and Comments.
        </p>
      ) : tab === "tasks" ? (
        taskResults.length === 0 ? (
          <p className="px-1 py-6 text-center text-muted-foreground text-sm">No matches</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {taskResults.map((task) => {
              const completed = task.completedAt !== null;
              return (
                <li key={task.id} className="flex items-center gap-2 rounded-md px-2 py-2 text-sm">
                  <button
                    type="button"
                    aria-label={completed ? "Mark as not done" : undefined}
                    onClick={() => (completed ? onUncompleteTask(task.id) : undefined)}
                    className={cn(
                      "flex size-4 shrink-0 items-center justify-center rounded-full border",
                      completed && "border-primary bg-primary text-primary-foreground",
                    )}
                  >
                    {completed && <Check aria-hidden="true" className="size-3" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => onOpenTask(task)}
                    className="flex min-w-0 flex-1 flex-col items-start text-left"
                  >
                    <span
                      className={cn("truncate", completed && "text-muted-foreground line-through")}
                    >
                      {task.content}
                    </span>
                    <span className="truncate text-muted-foreground text-xs">
                      {projectNameFor(projects, task.projectId)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )
      ) : commentResults.length === 0 ? (
        <p className="px-1 py-6 text-center text-muted-foreground text-sm">No matches</p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {commentResults.map((comment) => {
            const task = allTasksById.get(comment.taskId);
            if (task === undefined) {
              // A dangling reference to a tombstoned Task — comment-
              // store.ts's own header comment already treats this as an
              // accepted, unreachable state elsewhere in Todo; this page
              // extends that same tolerance rather than inventing a
              // special "orphaned comment" row.
              return null;
            }
            return (
              <li key={comment.id}>
                <button
                  type="button"
                  onClick={() => onOpenTask(task)}
                  className="flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-2 text-left text-sm"
                >
                  <span className="truncate">{comment.text}</span>
                  <span className="truncate text-muted-foreground text-xs">
                    {task.content} · {projectNameFor(projects, task.projectId)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
