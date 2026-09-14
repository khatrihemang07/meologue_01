/**
 * ADR 0080: the Device's memory of which Destination the reader was last in
 * — what `/`'s own "Continue" card (`chat-list-page.tsx`) offers back at the
 * wide breakpoint, so a reader who left mid-Task or mid-Question has a way
 * to click straight back into it rather than `/` being a dead end.
 *
 * A module-level variable, not `localStorage` or `sessionStorage` —
 * deliberately reversing `last-session.ts`'s own choice rather than copying
 * it. That file remembers a Session id *across a reload*, because ADR 0030
 * decided a reader losing a live Conversation was a real cost worth paying
 * storage for. There is no equivalent cost here: a cold load (a fresh tab, a
 * reload, a relaunch) has no Destination to continue into, and the absence
 * of a card is the correct, deliberate reading of that state — see
 * `chat-list-page.tsx`'s own comment on its empty states. Persisting this
 * would show a stale card pointing at wherever the reader happened to be
 * before the tab last closed, which is a *weaker*, more surprising claim
 * than "here's what you were just doing."
 *
 * Stores the Destination's own `to` (e.g. `"/composer"`), never a full,
 * possibly-deep path — `chat-list-page.tsx` looks that id back up against
 * `useDestinations()`'s live result before ever rendering the card, which is
 * what keeps a since-hidden or since-locked Destination from being silently
 * offered back rather than this module trying to re-derive those rules
 * itself (`chat-list.tsx`'s own `useDestinations()` doc comment, issue
 * #133/#134).
 *
 * Every operation here is synchronous and cannot fail — unlike
 * `sessionStorage`, a plain module-level binding has no private-browsing
 * mode to refuse a write in, so there is no try/catch to mirror from
 * `last-session.ts`.
 */
let lastDestination: string | null = null;

/** The remembered Destination's `to`, or `null` if none has been recorded yet this session. */
export function readLastDestination(): string | null {
  return lastDestination;
}

/** Remembers `to` as the Destination `/`'s Continue card should offer next. */
export function writeLastDestination(to: string): void {
  lastDestination = to;
}

/**
 * Forgets the remembered Destination. Not currently called by anything in
 * this app — kept for the same reason `last-session.ts` keeps its own
 * `clearLastSessionId` even though only one caller (a 404 on fetch) needs
 * it today: a module that can remember but never forget is a smaller
 * interface than the one callers will eventually need, the first time a
 * future change (hiding the last-continued Destination, say) needs to
 * invalidate this without waiting for the next write to overwrite it.
 */
export function clearLastDestination(): void {
  lastDestination = null;
}
