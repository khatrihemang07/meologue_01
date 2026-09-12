import type { Event, Project, Task } from "@meologue/core";
import { Link } from "react-router";
import {
  describeEventLine,
  type EventSubject,
  eventTimestamp,
  groupEventsByDay,
  isRenderableEvent,
} from "@/lib/format-event";

export interface ActivityFeedProps {
  /** Already whichever scope the caller resolved — everything, one Task's own history, or one Project's own (issue #184's three surfaces). Any order; this component sorts and groups it itself. */
  events: Event[];
  /** Every Task this Device holds, active and completed alike — resolves a "○ Task Name" chip's live label and link; falls back to the Event's own cached label when a Task doesn't resolve (deleted, or not yet Synced here). */
  tasks: Task[];
  /** Resolves a "# Project Name"/"▭ Section Name" chip. */
  projects: Project[];
  /**
   * Narrows to completions only — issue #184's own acceptance criterion:
   * "completed work is reached by narrowing the log to completions, not
   * from a separate destination of its own." The caller owns the toggle
   * itself (a checkbox above this component, say); this prop is only the
   * narrowing.
   */
  completedOnly?: boolean;
  /**
   * The Task this feed is already scoped to, when it's a per-Task history
   * (`task-detail-view.tsx`'s own Activity section) — every line's own
   * primary subject is suppressed when it would otherwise just repeat
   * this same Task, the one surface where naming the object is redundant
   * rather than necessary (the coordinator's own gap-fix report).
   * `undefined` on the Project and global surfaces, where a line's
   * subject is never redundant.
   */
  currentTaskId?: string;
  emptyMessage?: string;
}

/** One resolved subject, rendered as a live link when it has one and inert text when it doesn't — `entry-row.tsx`'s own Task Reference rule ("render the cached words, and stay inert") applied to an activity chip. */
function SubjectChip({ subject }: { subject: EventSubject }) {
  const label = (
    <>
      <span aria-hidden="true">{subject.glyph}</span> {subject.label}
    </>
  );
  if (subject.href === null) {
    return <span className="font-medium">{label}</span>;
  }
  return (
    <Link to={subject.href} className="font-medium underline-offset-2 hover:underline">
      {label}
    </Link>
  );
}

/**
 * CMT-06's `{content}` (a comment's own text, or a description's own text)
 * — Todoist's own DOM, re-driven live (flow 5), shows this unquoted as a
 * clickable content-preview chip; the artifacts that measured it captured
 * only its rendered text, never its markup or click target, so this chip
 * stays a plain, non-interactive `<span>` rather than guessing at a
 * destination to link to. `truncate` bounds it to one line the same way
 * `entry-row.tsx`'s own `EntryReferenceLink` chip does — CSS ellipsis,
 * not a hand-picked character count this ticket has no artifact to justify.
 */
function ContentPreviewChip({ text }: { text: string }) {
  return (
    <span
      title={text}
      className="mx-0.5 inline-block max-w-[16rem] truncate rounded-full border border-border bg-background/60 px-2 align-bottom text-xs leading-normal"
    >
      {text}
    </span>
  );
}

/**
 * The one activity-log renderer behind all three surfaces issue #184
 * names (a Task's own history, a Project's own, and the view across
 * everything) — grouped by calendar day, newest first, relative
 * timestamps for recent Events and absolute ones beyond that
 * (`format-event.ts`'s own `groupEventsByDay`/`eventTimestamp`). One
 * component rather than three, mirroring `CompletedTasks`'/`TaskList`'s
 * own "one rendering, several callers with different scopes" shape —
 * what differs between a Task's own history and the view across
 * everything is only which Events the caller hands in (and, on the
 * per-Task surface alone, `currentTaskId`), never how a line is laid out.
 */
export function ActivityFeed({
  events,
  tasks,
  projects,
  completedOnly = false,
  currentTaskId,
  emptyMessage = "Nothing here yet.",
}: ActivityFeedProps) {
  const narrowed = (
    completedOnly ? events.filter((e) => e.eventType === "completed") : events
  ).filter(isRenderableEvent);
  const groups = groupEventsByDay(narrowed);

  if (groups.length === 0) {
    return <p className="px-3 py-6 text-center text-muted-foreground text-sm">{emptyMessage}</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      {groups.map(([heading, dayEvents]) => (
        <section key={heading}>
          <h3 className="px-3 py-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">
            {heading}
          </h3>
          <ul className="flex flex-col">
            {dayEvents.map((event) => {
              const line = describeEventLine(event, { tasks, projects }, currentTaskId);
              return (
                <li
                  key={event.id}
                  className="flex items-baseline gap-2 border-border border-b px-3 py-2 text-sm last:border-b-0"
                >
                  <span className="min-w-0 flex-1">
                    {line.lead}
                    {line.subject && (
                      <>
                        {" "}
                        <SubjectChip subject={line.subject} />
                      </>
                    )}
                    {line.detail && <> {line.detail}</>}
                    {line.contentPreview !== undefined && (
                      <ContentPreviewChip text={line.contentPreview} />
                    )}
                    {line.trailingLead && <> {line.trailingLead}</>}
                    {line.trailingSubject && (
                      <>
                        {" "}
                        <SubjectChip subject={line.trailingSubject} />
                      </>
                    )}
                  </span>
                  <time
                    dateTime={event.occurredAt}
                    className="shrink-0 text-muted-foreground text-xs"
                  >
                    {eventTimestamp(event.occurredAt)}
                  </time>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
