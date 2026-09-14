/**
 * The Device's memory of which day the reader was looking at in the
 * Composer's History, so leaving `/composer` for `/reflect` (or anywhere
 * else) and coming back lands on that day again instead of jumping to the
 * newest Entry every time — the same problem `last-session.ts` solves for
 * Reflection's own Session, applied to a day instead of a Session id.
 *
 * A plain module-level variable, not `sessionStorage`/`localStorage`
 * (`last-session.ts`'s own key, and `settings.ts`'s two Device-setting
 * keys): this app is a single-page app that never reloads on an ordinary
 * route change, so a module-level ref already survives ComposerPage
 * unmounting and remounting — that's the whole gap this closes. Reaching
 * for storage instead would additionally survive a genuine browser reload,
 * which is exactly the case this must NOT remember through: a reload is a
 * fresh visit, and a fresh visit should open at the newest Entry the same
 * way it always has, not resume a scroll position from whenever the tab
 * was last open. `last-session.ts` keeps its own `sessionStorage` precisely
 * because a Session id is worth surviving a reload; a scroll position, kept
 * only in memory here, deliberately is not.
 *
 * The unit of memory is a day (`dayKey`, ADR 0016's own local-day string),
 * never a pixel offset or a `scrollTop`: History is virtualized with
 * estimated-then-measured row heights (history.tsx's own `estimateSize`),
 * so a raw scroll offset recorded before a remount means nothing once the
 * virtualizer re-measures from scratch after it. A day is the one thing
 * both the seek machinery (`HistorySeekTarget`, history.tsx) and a fresh
 * mount can converge on the same way a followed date Reference already
 * does.
 *
 * Every operation degrades quietly rather than throwing — there is no
 * storage here to fail on, so this is mostly a formality matching
 * `last-session.ts`'s own shape, but keeping every caller's error handling
 * identical either way is one less thing to remember about which of the
 * two modules a given call site is touching.
 */
let rememberedDayKey: string | null = null;

/** The remembered day key, or `null` if none is stored. */
export function readComposerResumeDay(): string | null {
  return rememberedDayKey;
}

/** Remembers `dayKey` as the day a bare `/composer` should resume, or forgets it entirely when passed `null`. */
export function writeComposerResumeDay(dayKey: string | null): void {
  rememberedDayKey = dayKey;
}

/**
 * Forgets the remembered day — called once a Send has landed (the reader
 * just wrote something and wants to see it, not be returned to wherever
 * they were reading before) so a later bare `/composer` opens at the
 * newest Entry instead of seeking back to a day that's no longer where the
 * reader wants to be.
 */
export function clearComposerResumeDay(): void {
  rememberedDayKey = null;
}
