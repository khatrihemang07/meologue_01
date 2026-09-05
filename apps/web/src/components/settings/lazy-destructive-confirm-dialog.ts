import { lazy } from "react";

/**
 * `destructive-confirm-dialog.tsx`'s own component, behind a lazy
 * boundary — like every route past `/` in App.tsx, and for the identical
 * reason named there: `DestructiveConfirmDialog` pulls in Radix's
 * `Dialog` primitive, which nothing else on the Settings route used
 * before Restore existed (Settings' other four topic sections have no
 * dialog of their own). A static import made the Settings route's own
 * bundle-size check (apps/web/scripts/check-bundle-size.mjs) fail at
 * 26,358 gzip bytes against a 17,600 ceiling — Radix's Dialog chunk alone
 * is ~11,800 of those bytes — so this follows the same "not on the
 * cold-start path" rule the dynamic `import("@meologue/core")` calls in
 * `data-section.tsx`'s own Backup/Restore handlers already apply to that
 * data logic.
 *
 * One shared lazy wrapper, not one per caller: `data-section.tsx`'s
 * Device Restore and `server-data-group.tsx`'s Server Restore both need
 * it, and importing the identical specifier from both means Rollup places
 * `destructive-confirm-dialog.tsx` in exactly one lazy chunk regardless of
 * which Restore a reader tries first.
 *
 * Each caller renders this only once its own "has a reader ever tried to
 * open this dialog" flag turns true — mounting it unconditionally, even
 * with `open={false}`, would trigger this `import()` on every Settings
 * visit and defeat the point (see each caller's own `restoreDialogSummoned`-
 * shaped state for why that flag, once true, never goes back to `false`).
 */
export const LazyDestructiveConfirmDialog = lazy(() =>
  import("@/components/settings/destructive-confirm-dialog").then((m) => ({
    default: m.DestructiveConfirmDialog,
  })),
);
