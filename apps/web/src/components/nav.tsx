import {
  CalendarDays,
  History as HistoryIcon,
  Lightbulb,
  List as ListIcon,
  Settings as SettingsIcon,
  SquarePen,
} from "lucide-react";
import { Link, NavLink } from "react-router";
import { cn } from "@/lib/utils";

// Ticket 54, settling #49's chosen config, extended by ADR 0020 (Reflect,
// three destinations) and issue #71 (Digest, four — see docs/adr/0020's own
// amendment note): four persistent nav destinations — Composer, History,
// Reflect, then Digest — Settings is deliberately not one of them
// (SettingsLink below). All four are bare route links, not readers of the
// Entry store, so — like the old SettingsLink — they stay live regardless
// of whether the store ever opens; every page renders this same Nav
// through Shell's `nav` prop (composer-page.tsx, history-page.tsx,
// reflection-page.tsx, sessions-page.tsx, digest-page.tsx,
// digest-reader-page.tsx, settings-page.tsx), which is what makes "every
// page becomes reachable directly" (issue #54) literally true even from
// Settings.
//
// This renders only the *contents* of Shell's single `<nav>` landmark
// (ticket 50's element, ticket 54's fix for it being duplicated — see
// shell.tsx) — no wrapping <nav> of its own, so the exact same markup
// works whether Shell currently has that landmark laid out as a left rail
// or a bottom bar; only Shell's CSS decides which.
const DESTINATIONS = [
  { to: "/", label: "Composer", Icon: SquarePen, end: true },
  { to: "/history", label: "History", Icon: HistoryIcon, end: false },
  { to: "/reflect", label: "Reflect", Icon: Lightbulb, end: false },
  { to: "/digest", label: "Digest", Icon: CalendarDays, end: false },
] as const;

export function Nav() {
  return (
    <>
      {DESTINATIONS.map(({ to, label, Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          // NavLink (not Link) so the active destination gets
          // aria-current="page" for free — the accessible half of "the
          // current destination is visibly indicated" (#54's acceptance
          // criteria). The visible half is the isActive-driven classes
          // below. min-h-11 (44px) meets the platform minimum tap size on
          // both layouts this renders into: a row of four in the bottom
          // bar, a column of four in the rail — already stale at three
          // destinations (it was written for two) and staler now at four,
          // which is why this comment names the count rather than a shape
          // ("two", "a pair") that has to be rewritten again the next time
          // Nav grows.
          className={({ isActive }) =>
            cn(
              "flex min-h-11 flex-1 flex-col items-center justify-center gap-1 rounded-lg px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:flex-none md:py-2.5",
              isActive && "font-medium text-foreground md:bg-muted",
            )
          }
        >
          <Icon aria-hidden="true" className="size-5" />
          {label}
        </NavLink>
      ))}
    </>
  );
}

// Settings is an app-bar action, not a nav destination (#49's settled
// config, reaffirmed by ADR 0020 when Reflect joined the nav and again by
// issue #71 when Digest did): Material 3 reserves a navigation bar for 3-5
// destinations at the same hierarchy level, and Settings is a utility, not
// a peer of Composer/History/Reflect/Digest — Telegram and Slack both
// demote settings the same way. Present regardless of Entry store status,
// same reasoning as Nav above and ADR 0008/0009: Settings must stay
// reachable and usable even when the store never opens.
// Ticket 62's Sessions affordance: an app-bar action beside SettingsLink,
// not a NavLink — Sessions is still correctly one level down, unchanged by
// issue #71 raising Nav's own destination count to four (Composer,
// History, Reflect, Digest; see ADR 0020's amendment note and
// DESTINATIONS above) — the same shape Settings already has. It only ever
// renders on Reflection's pages (reflection-page.tsx's `action` slot),
// since it opens a list of Reflection's own Sessions (`/reflect/list`)
// rather than being a peer view of History the way the four Nav
// destinations above are.
export function SessionsLink() {
  return (
    <Link
      to="/reflect/list"
      aria-label="Sessions"
      // Matches SettingsLink's own className exactly — same size-11 (44px)
      // tap-target and muted-to-foreground hover treatment for the same
      // kind of app-bar icon control.
      className="flex size-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <ListIcon aria-hidden="true" className="size-4" />
    </Link>
  );
}

export function SettingsLink() {
  return (
    <Link
      to="/settings"
      aria-label="Settings"
      // size-11 (44px) for the same tap-size reason as Nav's links above,
      // even though this isn't a nav destination — it's still a target a
      // thumb has to hit reliably in the app bar.
      className="flex size-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <SettingsIcon aria-hidden="true" className="size-4" />
    </Link>
  );
}
