import type { Event } from "@meologue/core";

export function isRenderableEvent(event: Event): boolean {
  return !(event.objectType === "comment" && event.eventType === "updated");
}
