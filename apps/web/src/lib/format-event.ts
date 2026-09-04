/**
 * Turns an Event (issue #184, CONTEXT.md's Event entry) into what a
 * reader sees on the three activity surfaces (per-Task, per-Project, and
 * the view across everything) — grouped by calendar day, newest first,
 * relative timestamps for recent events and absolute ones beyond that
 * (issue #184's own acceptance criterion). Pulled into its own module
 * rather than living inside activity-feed.tsx (its one caller today) so a
 * future second caller — a Digest that mentions what changed, say — has
 * somewhere to import this from without reaching into a component file.
 *
 * **Every line names its object** (the coordinator's own gap-fix report
 * against the first cut of this file): "Completed" alone means nothing in
 * a feed that aggregates across every Task, Project and Comment. This
 * module resolves that object the same way `entry-row.tsx`'s
 * `TaskReferenceItem` resolves a Task Reference — a live lookup against
 * whatever this Device currently holds, falling back to a cached label
 * when the row can't be resolved (deleted, or not yet Synced here) —
 * rather than the caller ever seeing an event with nothing to show. The
 * cached label is why every recorded act's own `extra` carries its
 * subject's current name regardless of what else it needed to say (see
 * use-tasks.ts's `recordTaskEvent`/use-projects.ts's
 * `recordProjectEvent`/`recordSectionEvent`/use-comments.ts's
 * `recordCommentEvent`, each of which merges `content`/`name`/
 * `taskContent` into `extra` unconditionally, not only for the event
 * types that would otherwise need it) — this module never has to leave a
 * subject unnamed for want of somewhere to read a fallback label from.
 */
import type { Event, Project, Task } from "@meologue/core";
import { format, formatDistanceToNow, isToday, isYesterday } from "date-fns";
import { formatDay } from "@/lib/format-task-date";
import { taskDetailPath } from "@/lib/task-detail-route";

/** How long an Event reads as "5 minutes ago" rather than an absolute time — a day, matching the day-grouping headers themselves. */
const RECENT_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/**
 * The calendar-day heading an Event's row is grouped under — "Today",
 * "Yesterday", or an absolute day beyond that (`formatDay`'s own "Sep 3"
 * shape, reused from Task scheduling rather than a second date formatter
 * for the identical job).
 */
export function eventDayHeading(occurredAt: string): string {
  const date = new Date(occurredAt);
  if (isToday(date)) {
    return "Today";
  }
  if (isYesterday(date)) {
    return "Yesterday";
  }
  return formatDay(occurredAt.slice(0, 10));
}

/**
 * The timestamp shown beside an Event's own row within its day group —
 * relative ("5 minutes ago") inside the last 24 hours, an absolute
 * time-of-day beyond that (the day heading above it already carries the
 * date, so the row itself only needs the time).
 */
export function eventTimestamp(occurredAt: string): string {
  const date = new Date(occurredAt);
  const ageMs = Date.now() - date.getTime();
  if (ageMs >= 0 && ageMs < RECENT_THRESHOLD_MS) {
    return `${formatDistanceToNow(date)} ago`;
  }
  return format(date, "h:mm a");
}

/**
 * Groups a list of Events (already newest-first, EventStore.list()'s own
 * order) by `eventDayHeading`, preserving that order both across groups
 * and within each one — a plain array of `[heading, events]` pairs
 * rather than a `Map`, since render code just walks it in order and
 * gains nothing from `Map`'s own lookup-by-key.
 */
export function groupEventsByDay(events: readonly Event[]): [string, Event[]][] {
  const groups: [string, Event[]][] = [];
  for (const event of events) {
    const heading = eventDayHeading(event.occurredAt);
    const last = groups.at(-1);
    if (last && last[0] === heading) {
      last[1].push(event);
    } else {
      groups.push([heading, [event]]);
    }
  }
  return groups;
}

/**
 * A named, resolved object an activity line points at — the reference
 * implementation's own "live, clickable chip carrying a type glyph"
 * shape. `href: null` is the deliberate "unresolvable" case
 * `entry-row.tsx`'s own Task Reference already established: render the
 * cached `label` and stay inert, never an empty phrase or a link to
 * nowhere. `glyph` matches the reference's own vocabulary exactly: ○
 * task, ▭ section, # project.
 */
export interface EventSubject {
  glyph: "○" | "▭" | "#";
  label: string;
  href: string | null;
}

/** What `describeEventLine` needs to resolve a subject from an id — the live rows this Device currently holds, `tasks` covering active *and* completed (a `completed` Event's own Task lives in the completed list, not the active one). */
export interface EventRenderContext {
  tasks: readonly Task[];
  projects: readonly Project[];
}

function resolveTaskSubject(
  taskId: string,
  cachedContent: unknown,
  context: EventRenderContext,
): EventSubject {
  const live = context.tasks.find((t) => t.id === taskId);
  if (live) {
    return { glyph: "○", label: live.content, href: taskDetailPath(live) };
  }
  return {
    glyph: "○",
    label: typeof cachedContent === "string" ? cachedContent : "a Task",
    href: null,
  };
}

function resolveProjectSubject(
  projectId: string | null,
  cachedName: unknown,
  context: EventRenderContext,
): EventSubject {
  if (projectId === null) {
    return { glyph: "#", label: "Inbox", href: "/todo/inbox" };
  }
  const live = context.projects.find((p) => p.id === projectId);
  if (live) {
    return { glyph: "#", label: live.name, href: `/todo/projects/${live.id}` };
  }
  return {
    glyph: "#",
    label: typeof cachedName === "string" ? cachedName : "a Project",
    href: null,
  };
}

// A Section has no route of its own to link to — it only ever renders
// inline inside its Project's own view — so its chip links to that
// Project instead when one resolves, rather than staying unlinked purely
// because Sections themselves aren't a navigable destination. No live
// Section list is plumbed into this module (nothing else here needs one),
// so the label is always the cached name captured at record time.
function resolveSectionSubject(
  cachedName: unknown,
  projectId: string | null,
  context: EventRenderContext,
): EventSubject {
  const project = projectId !== null ? context.projects.find((p) => p.id === projectId) : undefined;
  return {
    glyph: "▭",
    label: typeof cachedName === "string" ? cachedName : "a Section",
    href: project ? `/todo/projects/${project.id}` : null,
  };
}

// A day-only string ("YYYY-MM-DD") formats with formatDay; anything else
// is Task.date's own possibly-timed shape, so it borrows formatTaskDate's
// day-only half only when there's no time component, mirroring
// format-task-date.ts's own hasTime split without importing a Task type
// this module has no other reason to know about.
function formatDateValue(value: string): string {
  return value.length > 10 ? value : formatDay(value);
}

/**
 * One rendered activity line, already split into the pieces
 * `activity-feed.tsx` lays out (plain text around one or two live,
 * resolved subjects) rather than one pre-joined string — a subject has to
 * render as a `<Link>` when it resolves and a plain `<span>` when it
 * doesn't, which a caller can't do to a string after the fact without
 * re-parsing it back apart.
 */
export interface EventLine {
  /** The phrase before the primary subject — "Completed", "Renamed", "Commented on". Adjusted by `suppressSubjectFor` when the primary subject would just repeat the Task a per-Task view is already scoped to (e.g. "Commented on" becomes "Commented"). */
  lead: string;
  /**
   * The primary object this Event is about — the Task itself for every
   * `objectType: "task"` Event, and *also* for a `"comment"` Event (the
   * coordinator's own report: "a comment event should say which Task it
   * was on" — a Comment has no view of its own to link to, so naming the
   * Task it was made on is what "names its object" means here).
   * `undefined` only when `suppressSubjectFor` matched it — never because
   * nothing could be resolved (`EventSubject.href: null` is that case,
   * and still renders a label).
   */
  subject?: EventSubject;
  /** Plain text between the subject and any trailing subject — "from "old" to "new"", "not done". */
  detail?: string;
  /** The lead-in word before a second, trailing subject — "to", for "Moved [Task] to [Project]". */
  trailingLead?: string;
  /** A second named object, when an Event's own detail names one too — the destination Project of a "moved" Event. */
  trailingSubject?: EventSubject;
}

/**
 * Builds one activity line for `event` — the render-time "you set the
 * date" vs. "you changed the date" decision issue #184's own acceptance
 * criterion asks for (computed from whether `extra`'s own `last_*`
 * counterpart is present, never a second `event_type`), *and* the
 * gap-fix this module's own header comment describes: every line names
 * its subject, resolved live where possible and from a cached label
 * where the object is gone.
 *
 * `suppressSubjectFor`, when given, is the Task id a per-Task view is
 * already scoped to (`task-detail-view.tsx`'s own Activity section) —
 * naming that exact Task on every one of its own lines is exactly the
 * redundancy the coordinator's report asks this module to drop, so the
 * primary subject is omitted (and `lead` adjusted to still read
 * naturally without it) whenever it would have resolved to that same id.
 * A secondary subject (a "moved to <Project>" Event's own destination)
 * is never suppressed — only the primary one repeats the view's own
 * scope.
 */
export function describeEventLine(
  event: Event,
  context: EventRenderContext,
  suppressSubjectFor?: string,
): EventLine {
  const extra = (event.extra ?? {}) as Record<string, unknown>;

  if (event.objectType === "comment") {
    const onThisTask = event.taskId !== null && event.taskId === suppressSubjectFor;
    const subject = onThisTask
      ? undefined
      : resolveTaskSubject(event.taskId ?? event.objectId, extra.taskContent, context);
    switch (event.eventType) {
      case "updated":
        return { lead: onThisTask ? "Edited a comment" : "Edited a comment on", subject };
      case "deleted":
        return { lead: onThisTask ? "Deleted a comment" : "Deleted a comment on", subject };
      default:
        return { lead: onThisTask ? "Commented" : "Commented on", subject };
    }
  }

  if (event.objectType === "project") {
    const subject = resolveProjectSubject(event.objectId, extra.name, context);
    switch (event.eventType) {
      case "archived":
        return { lead: "Archived", subject };
      case "unarchived":
        return { lead: "Unarchived", subject };
      case "updated":
        return typeof extra.lastName === "string"
          ? { lead: "Renamed", subject, detail: `from "${extra.lastName}" to "${extra.name}"` }
          : { lead: "Renamed", subject };
      default:
        return { lead: "Created", subject };
    }
  }

  if (event.objectType === "section") {
    const subject = resolveSectionSubject(extra.name, event.projectId, context);
    switch (event.eventType) {
      case "deleted":
        return { lead: "Deleted Section", subject };
      case "archived":
        return { lead: "Archived Section", subject };
      case "unarchived":
        return { lead: "Unarchived Section", subject };
      case "updated":
        return typeof extra.lastName === "string"
          ? {
              lead: "Renamed Section",
              subject,
              detail: `from "${extra.lastName}" to "${extra.name}"`,
            }
          : { lead: "Renamed Section", subject };
      default:
        return { lead: "Added Section", subject };
    }
  }

  // event.objectType === "task"
  const onThisTask = event.objectId === suppressSubjectFor;
  const subject = onThisTask
    ? undefined
    : resolveTaskSubject(event.objectId, extra.content, context);
  switch (event.eventType) {
    case "deleted":
      return { lead: "Deleted", subject };
    case "completed":
      return { lead: "Completed", subject };
    case "uncompleted":
      return { lead: "Marked", subject, detail: "not done" };
    case "moved":
      if ("projectId" in extra) {
        return {
          lead: "Moved",
          subject,
          trailingLead: "to",
          trailingSubject: resolveProjectSubject(
            extra.projectId as string | null,
            undefined,
            context,
          ),
        };
      }
      if ("sectionId" in extra) {
        return {
          lead: "Moved",
          subject,
          detail: extra.sectionId === null ? "out of its Section" : "to a Section",
        };
      }
      if ("parentId" in extra) {
        return {
          lead: "Moved",
          subject,
          detail: extra.parentId === null ? "to top level" : "under another Task",
        };
      }
      return { lead: "Moved", subject };
    case "updated":
      // `lastContent`, not `content`, is what actually discriminates a
      // rename from every other update: `content` itself is now always
      // present in `extra` (the cached label every task event carries,
      // per this module's own header comment), so checking for it alone
      // would misroute every date/deadline/priority/label change into
      // this branch too.
      if ("lastContent" in extra) {
        return {
          lead: "Renamed",
          subject,
          detail: `from "${extra.lastContent}" to "${extra.content}"`,
        };
      }
      if ("date" in extra) {
        const on = onThisTask ? "" : " on";
        if (extra.date === null) {
          return { lead: `Removed the date${on}`, subject };
        }
        const value = formatDateValue(extra.date as string);
        return extra.lastDate == null
          ? { lead: `Set the date${on}`, subject, detail: `to ${value}` }
          : { lead: `Changed the date${on}`, subject, detail: `to ${value}` };
      }
      if ("deadline" in extra) {
        const on = onThisTask ? "" : " on";
        if (extra.deadline === null) {
          return { lead: `Removed the deadline${on}`, subject };
        }
        const value = formatDateValue(extra.deadline as string);
        return extra.lastDeadline == null
          ? { lead: `Set the deadline${on}`, subject, detail: `to ${value}` }
          : { lead: `Changed the deadline${on}`, subject, detail: `to ${value}` };
      }
      if ("priority" in extra) {
        return { lead: onThisTask ? "Changed the priority" : "Changed the priority of", subject };
      }
      if ("labelIds" in extra) {
        return { lead: onThisTask ? "Changed Labels" : "Changed Labels on", subject };
      }
      return { lead: "Updated", subject };
    default:
      return { lead: "Added", subject };
  }
}
