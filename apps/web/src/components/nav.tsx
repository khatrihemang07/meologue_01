import {
  History as HistoryIcon,
  Lightbulb,
  Settings as SettingsIcon,
  SquarePen,
} from "lucide-react";
import { Link, NavLink } from "react-router";
import { cn } from "@/lib/utils";

// Ticket 54, settling #49's chosen config, extended by ADR 0020: three
// persistent nav destinations — Composer, History, then Reflect — Settings
// is deliberately not one of them (SettingsLink below). All three are bare
// route links, not readers of the Entry store, so — like the old
// SettingsLink — they stay live regardless of whether the store ever opens;
// every page renders this same Nav through Shell's `nav` prop
// (composer-page.tsx, history-page.tsx, reflection-page.tsx,
// settings-page.tsx), which is what makes "every page becomes reachable
// directly" (issue #54) literally true even from Settings.
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
          // both layouts this renders into: a row of two in the bottom
          // bar, a column of two in the rail.
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
// config, reaffirmed by ADR 0020 when Reflect joined the nav): Material 3
// reserves a navigation bar for 3-5 destinations at the same hierarchy
// level, and Settings is a utility, not a peer of Composer/History/Reflect
// — Telegram and Slack both demote settings the same way. Present
// regardless of Entry store status, same reasoning as Nav above and ADR
// 0008/0009: Settings must stay reachable and usable even when the store
// never opens.
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
