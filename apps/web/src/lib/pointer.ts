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

/**
 * Whether a physical keyboard is likely attached, and so whether a keyboard
 * hint is worth rendering at all.
 *
 * Issue #285: meologue's Task row menu rendered `Edit ⌘E`, `Delete ⌘⌫ or
 * ⇧Delete` and friends on an Android phone with no keyboard — Mac-specific
 * glyphs naming chords the reader has no way to press. Todoist Android shows
 * no such legend, and has no row overflow menu at all.
 *
 * The test is the one `task-row-content.tsx` already documents for hiding
 * hover-revealed row actions: treat the device as touch-only when it reports
 * BOTH `(pointer: coarse)` AND `(hover: none)`. Either alone is not enough —
 * the Tauri desktop window can misreport a coarse pointer for a trackpad,
 * and a touchscreen laptop hovers and has a keyboard.
 *
 * Defaults to `true` when `matchMedia` is unavailable (jsdom), so a legend
 * is only ever *withheld* on positive evidence of a touch-only device, never
 * on the absence of information. Re-read per render for the same reason
 * `hoverCapable()` is: a keyboard can be attached mid-session.
 */
export function keyboardLikely(): boolean {
  if (typeof window.matchMedia !== "function") {
    return true;
  }
  const touchOnly =
    window.matchMedia("(pointer: coarse)").matches && window.matchMedia("(hover: none)").matches;
  return !touchOnly;
}
