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
   * Ticket 54's slot, unused until that ticket lands. Rendered twice — once
   * per placement — with only one visible at a time via CSS: a left rail on
   * a wide window, a bottom bar on a narrow one (the settled #49 config).
   * Two placements of one prop, not two props, because the content is the
   * same nav either way — only where it sits changes with window width, the
   * same technique the chosen prototype (.scratch/ui-variants, variant 08)
   * uses for its `.lrail`/`.bnav` pair.
   */
  nav?: ReactNode;
  /**
   * Ticket 51's slot, unused until that ticket lands. The Composer keeps
   * rendering as part of `children`/`footer` for now, scrolling with the
   * rest of the page exactly as it does today — this only reserves where a
   * bottom-docked Composer will sit, between the scrollable content and
   * `nav`'s bottom-bar placement.
   */
  composerSlot?: ReactNode;
}

// The app shell every page renders through (ticket 50, replacing the
// centred max-w-xl Card ticket 25 introduced). A fixed top app bar, a
// scrollable content region, and reserved nav/composer slots for #54 and
// #51 to fill in later — this ticket only builds the frame, so today's
// pages keep rendering exactly what they did before, just inside it.
//
// The outer element is a flex row rather than CSS Grid: `nav` is optional
// and, while unused, contributes nothing to the layout either way, so
// there's no responsive repositioning to solve yet — that's #54's problem
// once it has real content to place. Shell only needs shrink-0 chrome
// around a flex-1 scrolling region, which plain flexbox already gives it.
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
    <div className="flex h-svh w-full overflow-hidden bg-background [padding-left:env(safe-area-inset-left)] [padding-right:env(safe-area-inset-right)]">
      {nav && (
        <nav
          aria-label="Navigation"
          className="hidden w-20 shrink-0 flex-col border-r border-border bg-background md:flex"
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
            the reading column inside is capped, at the old Card's max-w-xl,
            so line length doesn't stretch full-window on a wide screen. The
            bottom padding is a stand-in for the docked Composer's own
            safe-area handling (#51): nothing claims the bottom edge yet, so
            this is where "don't sit under system chrome" has to be honoured
            today. */}
        <div className="flex-1 overflow-x-hidden overflow-y-auto">
          <div className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 py-4 [padding-bottom:max(1rem,env(safe-area-inset-bottom))]">
            {message && <p className="text-sm text-destructive">{message}</p>}
            {children}
            {footer}
          </div>
        </div>

        {composerSlot}

        {nav && (
          <nav
            aria-label="Navigation"
            className="flex shrink-0 border-t border-border bg-background md:hidden [padding-bottom:env(safe-area-inset-bottom)]"
          >
            {nav}
          </nav>
        )}
      </div>
    </div>
  );
}
