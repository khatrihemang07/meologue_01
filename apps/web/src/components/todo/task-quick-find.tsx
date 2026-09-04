/**
 * Quick-find (issue #183) — one of Todo's two disjoint search surfaces
 * (this file's own header comment on the other, task-search-page.tsx, has
 * the full split). Opens over whichever Todo view is on screen via `/`,
 * `f` or `⌘K`/`Ctrl+K`, and narrows to **Task titles and Project names
 * only** — never a Description, never a Comment, and never a Section or
 * Label name: issue #183's own reference-behaviour research measured a
 * real Todoist's own quick-find dropdown reaching those two collections
 * too, but this app has no per-Section or per-Label view for a matched
 * result to open (unlike a Task's own address or a Project's own screen,
 * both of which already exist) — showing a match with nothing to open it
 * into is exactly the "no affordance for a gesture that can't happen
 * here" trap task-command-menu.tsx's own header comment already refuses
 * elsewhere in Todo, so this file refuses it too rather than rendering an
 * inert row. Comments are the full search page's own surface, not this
 * one, and completed Tasks are excluded entirely, mirroring
 * TaskStore.search's own default (find something still open, not an
 * archive).
 *
 * Matching reuses @meologue/core's matchesSubstring (../lib/
 * task-search-match.ts's highlightSubstring is its highlighting
 * counterpart) rather than calling through TaskStore.search — `tasks` and
 * `projects` are already loaded wholesale by entry-store-layout.tsx for
 * every other cross-Project view Todo has (Today, the flat `tasks` array
 * itself), so this is one more client-side narrowing of data already in
 * hand, not a second store round trip for what's effectively instant
 * either way at this app's scale.
 */
import type { Project, Task } from "@meologue/core";
import { matchesSubstring } from "@meologue/core";
import { Dialog as DialogPrimitive } from "radix-ui";
import type * as React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { highlightSubstring } from "@/lib/task-search-match";
import { cn } from "@/lib/utils";

export interface TaskQuickFindProps {
  /** Active Tasks only — TaskStore.search's own "find something still open" default, applied here too. */
  tasks: Task[];
  projects: Project[];
  onOpenTask: (task: Task) => void;
  /** `null` opens Inbox — mirrors TaskCommandMenu's own "Move to…" Inbox row. */
  onOpenProject: (projectId: string | null) => void;
  /**
   * "Show more results" (this file's own header comment on the two
   * disjoint surfaces) — hands the current query to the full search page
   * rather than this component navigating there itself, so task-page.tsx
   * stays the one place that knows the full search page's own route.
   */
  onShowMoreResults: (query: string) => void;
}

// A personal task list's own match count never approaches this — capped
// so a broad one- or two-character query (issue #183's own "no minimum
// query length" requirement) can't render an unbounded list.
const MAX_RESULTS = 20;

type QuickFindResult =
  | { kind: "task"; task: Task }
  | { kind: "project"; project: Project }
  | { kind: "inbox" };

function resultKey(result: QuickFindResult): string {
  return result.kind === "task"
    ? `task:${result.task.id}`
    : result.kind === "project"
      ? `project:${result.project.id}`
      : "inbox";
}

export function TaskQuickFind({
  tasks,
  projects,
  onOpenTask,
  onOpenProject,
  onShowMoreResults,
}: TaskQuickFindProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // `/`, `f` and ⌘K/Ctrl+K open Quick-find — issue #183's own
  // reference-behaviour research named exactly these three. Ignored while
  // the keypress lands in a text field (an input, a textarea, or anything
  // `contentEditable`, which covers the Composer/Description/Comment
  // ProseMirror editors) so typing "f" into a Task's own title never hijacks
  // the keystroke — the identical guard issue #165's own slash-menu trigger
  // ("Typing / opens a menu") already has to apply for the same reason.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing =
        target !== null &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      const isShortcut =
        (event.key === "/" || event.key === "f") && !typing && !event.metaKey && !event.ctrlKey;
      const isCommandK = event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey);
      if (isShortcut || isCommandK) {
        event.preventDefault();
        setOpen(true);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (open) {
      setQuery("");
      setHighlighted(0);
    }
  }, [open]);

  // `query` is deliberately the sole trigger here even though it's never
  // read in the body — this resets the highlighted row whenever the query
  // *changes*, not in response to anything the effect reads from it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above — query is a reset trigger, not a value this effect reads.
  useEffect(() => {
    setHighlighted(0);
  }, [query]);

  const results = useMemo<QuickFindResult[]>(() => {
    const trimmed = query.trim();
    if (trimmed === "") {
      return [];
    }
    const taskResults: QuickFindResult[] = tasks
      .filter((t) => matchesSubstring(t.content, trimmed))
      .map((task) => ({ kind: "task", task }) as const);
    const projectResults: QuickFindResult[] = projects
      .filter((p) => !p.archived && matchesSubstring(p.name, trimmed))
      .map((project) => ({ kind: "project", project }) as const);
    const inboxResult: QuickFindResult[] = matchesSubstring("Inbox", trimmed)
      ? [{ kind: "inbox" } as const]
      : [];
    return [...taskResults, ...projectResults, ...inboxResult].slice(0, MAX_RESULTS);
  }, [tasks, projects, query]);

  function openResult(result: QuickFindResult) {
    setOpen(false);
    if (result.kind === "task") {
      onOpenTask(result.task);
    } else if (result.kind === "project") {
      onOpenProject(result.project.id);
    } else {
      onOpenProject(null);
    }
  }

  function onInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlighted((current) => Math.min(current + 1, Math.max(results.length - 1, 0)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlighted((current) => Math.max(current - 1, 0));
    } else if (event.key === "Enter") {
      const result = results[highlighted];
      if (result !== undefined) {
        event.preventDefault();
        openResult(result);
      }
    }
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 duration-150 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Content
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            inputRef.current?.focus();
          }}
          className="fixed top-24 left-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 rounded-xl border border-border bg-popover text-popover-foreground shadow-lg outline-hidden duration-150 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0"
        >
          <DialogPrimitive.Title className="sr-only">Quick-find</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Search Task titles and Project names
          </DialogPrimitive.Description>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="Search Tasks and Projects…"
            aria-label="Search Tasks and Projects"
            className="w-full border-b border-border bg-transparent px-4 py-3 text-sm outline-none placeholder:text-muted-foreground"
          />
          <div className="max-h-80 overflow-y-auto p-1" role="listbox">
            {results.map((result, index) => (
              <div key={resultKey(result)}>
                <button
                  type="button"
                  role="option"
                  aria-selected={index === highlighted}
                  onMouseEnter={() => setHighlighted(index)}
                  onClick={() => openResult(result)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm",
                    index === highlighted && "bg-muted",
                  )}
                >
                  {result.kind === "task" ? (
                    <span className="truncate">
                      <HighlightedText text={result.task.content} query={query} />
                    </span>
                  ) : (
                    <span className="flex items-center gap-2 truncate text-muted-foreground">
                      <span
                        aria-hidden="true"
                        className="size-2.5 shrink-0 rounded-full"
                        style={{
                          backgroundColor:
                            result.kind === "project" ? result.project.colour : undefined,
                        }}
                      />
                      {result.kind === "project" ? (
                        <HighlightedText text={result.project.name} query={query} />
                      ) : (
                        "Inbox"
                      )}
                    </span>
                  )}
                </button>
              </div>
            ))}
            {query.trim() !== "" && results.length === 0 && (
              <div className="px-3 py-6 text-center text-muted-foreground text-sm">No matches</div>
            )}
          </div>
          {query.trim() !== "" && (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onShowMoreResults(query);
              }}
              className="w-full border-t border-border px-3 py-2 text-left text-muted-foreground text-xs hover:bg-muted"
            >
              Show more results — searches Descriptions and Comments too
            </button>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/**
 * `<mark>` highlighting (issue #183's own reference-behaviour finding:
 * this happens in the dropdown, never on the full search page —
 * task-search-page.tsx renders plain text). `highlightSubstring`
 * (../../lib/task-search-match.ts) recomputes on every render from
 * `text`/`query` alone, so a segment's own `text` plus its position in the
 * array is a stable, order-only key for one immutable string — nothing
 * here is ever reordered or removed independently of the whole string
 * changing, which is what the array index it's built from is safe.
 */
function HighlightedText({ text, query }: { text: string; query: string }) {
  return (
    <>
      {highlightSubstring(text, query).map((segment, index) => (
        <mark
          // biome-ignore lint/suspicious/noArrayIndexKey: see this component's own doc comment — segments are a stable, order-only render of one immutable string.
          key={`${index}-${segment.text}`}
          className={
            segment.matched ? "bg-yellow-200 text-foreground dark:bg-yellow-900" : "bg-transparent"
          }
        >
          {segment.text}
        </mark>
      ))}
    </>
  );
}
