/**
 * True when this device can hover a pointer over content. Re-read at the
 * moment of each tap/render rather than cached in state: hover capability
 * can change mid-session (a mouse plugged into a tablet), there is no
 * event to subscribe to that fires only when it does, and a stale cached
 * value would be wrong for exactly as long as it was cached.
 *
 * `window.matchMedia` is guarded rather than assumed, matching this
 * repo's own precedent in `lib/theme.ts` — unlike that module's
 * `(prefers-color-scheme: dark)`, nothing here needs to react to the
 * value changing, so a plain read (no `addEventListener`) is enough.
 *
 * Moved here from `components/entry-actions.tsx` (issue #213) so
 * `lib/settings.ts` can read it too, for the same "device draws its own
 * chrome" reason `entry-actions.tsx`/`entry-row.tsx` already did — a
 * `lib/` module reaching into a `components/` file is the one import
 * direction this codebase calls out by name (see `composer-editor.ts`'s
 * own comment on `quickAddOptionsNow`).
 */
export function hoverCapable(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(hover: hover)").matches;
}
