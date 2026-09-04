import type { Event, EventStore, EventType, ObjectType } from "@meologue/core";
import { mintId } from "@meologue/core";
import { useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/query-client";
import { EVENTS_QUERY_KEY } from "@/lib/query-keys";

/**
 * What a caller supplies to record one Event — everything on `Event`
 * (../../../packages/core/src/event-types.ts) except the sync-and-identity
 * scaffolding (`id`/`deviceId`/`seq`/`syncedAt`) this hook fills in itself,
 * and `occurredAt`, which is *always* "now" on the acting Device's own
 * clock (ADR 0056's whole reason for existing) — no caller ever supplies
 * a different one, so it isn't a parameter a caller could get wrong.
 */
export interface RecordEventInput {
  eventType: EventType;
  objectType: ObjectType;
  objectId: string;
  taskId: string | null;
  projectId: string | null;
  extra?: Record<string, unknown> | null;
}

export interface UseEventsResult {
  /** Every Event across the whole app, newest first — the view across everything (issue #184's own acceptance criterion). */
  events: Event[];
  /** One Task's own history, newest first. */
  listEventsByTask: (taskId: string) => Promise<Event[]>;
  /** One Project's own history, newest first — `null` reads Inbox's own history. */
  listEventsByProject: (projectId: string | null) => Promise<Event[]>;
  /**
   * Records one Event, stamped with this Device's own clock right now.
   * Every caller that performs a recorded act (use-tasks.ts, use-projects.ts,
   * use-comments.ts) calls this alongside its own store write — see
   * ../../../CONTEXT.md's Event entry and ADR 0056 for which acts those are.
   */
  recordEvent: (input: RecordEventInput) => Promise<void>;
}

/**
 * Owns Todo's Events for whichever view is mounted under EntryStoreLayout
 * (issue #184) — the Event-shaped sibling of use-comments.ts, following
 * its exact shape (a query, one write door, cache invalidation on
 * success). No `requestSync` nudge of its own: `recordEvent` is called
 * from *inside* another hook's own mutation (use-tasks.ts's `completeTask`,
 * say), which already calls `requestSync` itself once its own store write
 * and this one both land — adding a second nudge here would just be a
 * redundant, immediately-coalesced second call (`requestSync`'s own
 * "runs at most one sync at a time" doc comment).
 */
export function useEvents(eventStore: EventStore, deviceId: string): UseEventsResult {
  const eventsQuery = useQuery({
    queryKey: EVENTS_QUERY_KEY,
    queryFn: () => eventStore.list(),
  });

  const events = eventsQuery.data ?? [];

  function listEventsByTask(taskId: string): Promise<Event[]> {
    return eventStore.listByTask(taskId);
  }

  function listEventsByProject(projectId: string | null): Promise<Event[]> {
    return eventStore.listByProject(projectId);
  }

  async function recordEvent(input: RecordEventInput): Promise<void> {
    await eventStore.record({
      id: mintId(),
      deviceId,
      eventType: input.eventType,
      objectType: input.objectType,
      objectId: input.objectId,
      taskId: input.taskId,
      projectId: input.projectId,
      occurredAt: new Date().toISOString(),
      extra: input.extra ?? null,
      seq: null,
      syncedAt: null,
    });
    await queryClient.invalidateQueries({ queryKey: EVENTS_QUERY_KEY });
  }

  return { events, listEventsByTask, listEventsByProject, recordEvent };
}
