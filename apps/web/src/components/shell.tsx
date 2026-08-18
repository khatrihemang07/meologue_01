import type { ReactNode } from "react";
import { SyncStatusIndicator } from "@/components/sync-status-indicator";

interface ShellProps {
  title: ReactNode;
  /** Trailing app-bar action — e.g. the History/Settings links on the Composer page. */
  action?: ReactNode;
  message?: string;
  children: ReactNode;
  /** Rendered after `children`, in the same scrollable region — e.g. the Composer page's History. */
  footer?: ReactNode;
  /**
   * The persistent nav's contents (ticket 54 — Composer and History, #49's
   * settled config: a left rail on a wide window, a bottom bar on a narrow
   * one, the same technique the chosen prototype, .scratch/ui-variants
   * variant 08, uses for its `.lrail`/`.bnav` pair). Rendered into exactly
   * one `<nav>` landmark below, repositioned by CSS rather than duplicated —
   * see that element's own comment for why.
   */
  nav?: ReactNode;
  /**
   * The Composer (ticket 51), docked between the scrollable content and
   * `nav`'s bottom-bar placement so it stays put while History scrolls
   * behind it. The Composer owns its own safe-area-inset-bottom handling —
   * see the scroll region's padding comment below for why Shell doesn't
   * duplicate that here.
   */
  composerSlot?: ReactNode;
}

// The app shell every page renders through (ticket 50, replacing the
// centred max-w-xl Card ticket 25 introduced). A fixed top app bar, a
// scrollable content region, and reserved nav/composer slots that #54 and
// #51 fill in.
//
// The outer element is a flex container whose direction flips at `md`
// (column on a narrow window, row on a wide one) rather than CSS Grid.
// That, plus `order` on the `nav` element below, is what lets one `nav`
// element serve as both the bottom bar and the rail — see its own comment.
//
// h-svh + overflow-hidden on the outer element (rather than min-h-svh, as
// before) is what makes this a real app shell instead of a page that grows
// taller than the viewport: the shell always fills the window exactly, and
// only the content region scrolls internally. That, plus no horizontal
// overflow anywhere in this tree, is what keeps a narrow window free of
// both page-level scrollbars the old centred-card layout never had to
// avoid.
export function Shell({ title, action, message, children, footer, nav, composerSlot }: ShellProps) {
  return (
    <div className="flex h-svh w-full flex-col overflow-hidden bg-background [padding-left:env(safe-area-inset-left)] [padding-right:env(safe-area-inset-right)] md:flex-row">
      {nav && (
        <nav
          aria-label="Navigation"
          // Ticket 54's defect fix: #50 rendered this slot's contents twice
          // — once as a left rail (hidden md:flex), once as a bottom bar
          // (flex md:hidden) — which was harmless while `nav` was empty but
          // becomes two duplicate accessible-tree <nav> landmarks and every
          // link matching Playwright's strict-mode queries twice the moment
          // it holds real links. Fixed by mounting `nav` exactly once here
          // and repositioning this single element with `order` instead of
          // toggling two elements' `display`.
          //
          // The outer shell is a column on a narrow window and a row on a
          // wide one (see its own comment). `order-2` only does anything in
          // the column case: it's what pushes this element after the
          // header/content/composer group below rather than before it —
          // that group defaults to order 0, which would otherwise lose the
          // tie to `nav` coming first in DOM order. `md:order-none` drops
          // back to that DOM order at the wide breakpoint, which already
          // puts `nav` first — i.e. a rail down the left edge. Flexbox's
          // default `align-items: stretch` does the rest without any extra
          // classes: a bottom bar stretches to the full window width in the
          // column case, a rail stretches to the full window height in the
          // row case.
          className="order-2 flex shrink-0 border-t border-border bg-background [padding-bottom:env(safe-area-inset-bottom)] md:order-none md:w-20 md:flex-col md:gap-1 md:border-t-0 md:border-r md:p-2 md:[padding-bottom:0px]"
        >
          {nav}
        </nav>
      )}

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Fixed top app bar: title plus the Sync status dot (ticket 40),
            which loses its home in CardTitle once the Card is gone and
            moves here instead — ambient and always-present on every page,
            unchanged from before. min-h rather than h so the safe-area
            padding-top can grow the bar under a notch/Dynamic Island
            instead of clipping the title against it. */}
        <header className="flex min-h-14 shrink-0 items-center gap-2 border-b border-border bg-background px-4 [padding-top:env(safe-area-inset-top)]">
          <span className="flex items-center gap-2 font-heading text-base font-medium">
            {title}
            <SyncStatusIndicator />
          </span>
          {action && <div className="ml-auto flex items-center gap-3">{action}</div>}
        </header>

        {/* The scrollable content region between the app bar and whatever
            sits below it. Full-bleed on a wide window (no cap here) — only
            the reading column inside is capped, at the width the chosen
            prototype used (#49 variant 08) rather than the old Card's,
            so line length doesn't stretch full-window on a wide screen.
            Plain py-4 is enough here now that the docked Composer (#51)
            claims the bottom edge and handles env(safe-area-inset-bottom)
            itself — padding it again here would double it under a home
            indicator. */}
        <div className="flex-1 overflow-x-hidden overflow-y-auto">
          <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-4">
            {message && <p className="text-sm text-destructive">{message}</p>}
            {children}
            {footer}
          </div>
        </div>

        {composerSlot}
      </div>
    </div>
  );
}
