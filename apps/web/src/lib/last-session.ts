/**
 * Issue #80: the Device's memory of which Session Reflection last showed —
 * deliberately reversing part of ADR 0025 ("the Device stores nothing at
 * all") in the one direction that ADR turned out to cost a reader
 * something real: leaving Reflect for Composer and coming back landed on a
 * *fresh* Session every time, discarding the Conversation just asked into
 * fifteen seconds of inference ago. This is not a second copy of a
 * Session's content — the Server still holds that, and every read still
 * goes through `sessions-transport.ts` — it is one id, a hint for which
 * URL a bare `/reflect` should redirect to before the reader notices it
 * was ever bare.
 *
 * `sessionStorage`, not `localStorage` (`settings.ts`'s two Device-setting
 * keys) — this is "where you left off in this tab," not a preference that
 * should follow the Device forever, the same choice `use-history-search.ts`
 * makes for `meologue.history-search-query` and for the same reason: a
 * fresh tab should not resume a Conversation (or a Search) some other tab,
 * possibly days old, happened to leave open. The key name follows that
 * file's naming too.
 *
 * Every operation is wrapped in try/catch and degrades to "nothing
 * remembered" rather than throwing — `settings.ts`'s own rule for
 * `localStorage` applies here just as much: `sessionStorage` throws on
 * write in Safari private browsing, and can throw on read too. Reflection
 * must keep working with no memory at all rather than break because this
 * convenience couldn't be kept.
 */
const LAST_SESSION_KEY = "meologue.last-session-id";

/** The remembered Session id, or `null` if none is stored (or storage refused the read). */
export function readLastSessionId(): string | null {
  try {
    return sessionStorage.getItem(LAST_SESSION_KEY);
  } catch {
    return null;
  }
}

/** Remembers `sessionId` as the one a bare `/reflect` should resume. */
export function writeLastSessionId(sessionId: string): void {
  try {
    sessionStorage.setItem(LAST_SESSION_KEY, sessionId);
  } catch {
    // Storage refused the write (e.g. private browsing) — Reflection still
    // works for this visit, it just won't be resumed automatically later.
  }
}

/**
 * Forgets the remembered Session id — called when it's deleted (from this
 * Device or another one, discovered via a 404 on fetch) so a later bare
 * `/reflect` doesn't try to resume a Session that no longer exists.
 */
export function clearLastSessionId(): void {
  try {
    sessionStorage.removeItem(LAST_SESSION_KEY);
  } catch {
    // Nothing to do — if the write above never landed, there's nothing
    // stored to remove either.
  }
}
