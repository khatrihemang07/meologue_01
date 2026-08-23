import {
  CalendarDays,
  Lightbulb,
  List as ListIcon,
  Settings as SettingsIcon,
  SquarePen,
} from "lucide-react";
import { Link, NavLink } from "react-router";
import { cn } from "@/lib/utils";

// Issue #75 replaces the History destination with Settings: four
// persistent nav destinations — Composer, Reflect, Digest, Settings — with
// no History entry at all (the Composer view already renders the same
// Entries through the same `history.tsx` component, so History's own page
// was a second door into one room; see history.tsx's remaining consumer).
// This supersedes ADR 0018's "Settings is a utility, not a peer" reasoning
// for keeping Settings out of the nav — that argument held while Settings
// was reachable another way (an app-bar action on every page); once the
// app-bar gear disappears (this ticket removes SettingsLink below too),
// nav is the *only* way in, and a utility that is the sole way to reach it
// stops being distinguishable from a destination. All four are bare route
// links, not readers of the Entry store, so they stay live regardless of
// whether the store ever opens — that guarantee is what makes it safe for
// Settings to move here despite ADR 0008/0009 requiring it to keep working
// when the store never does (see App.tsx's route tree: `/settings` still
// sits outside `EntryStoreLayout`, unchanged by this ticket — only how the
// reader *reaches* it moved, not where it lives or what it depends on).
// Every page renders this same Nav through Shell's `nav` prop
// (composer-page.tsx, reflection-page.tsx, sessions-page.tsx,
// digest-page.tsx, digest-reader-page.tsx, settings-page.tsx), which is
// what makes "every page becomes reachable directly" (issue #54) literally
// true even from Settings — including reaching Settings itself, and
// Settings reaching everything else, from one control.
//
// This renders only the *contents* of Shell's single `<nav>` landmark
// (ticket 50's element, ticket 54's fix for it being duplicated — see
// shell.tsx) — no wrapping <nav> of its own, so the exact same markup
// works whether Shell currently has that landmark laid out as a left rail
// or a bottom bar; only Shell's CSS decides which.
const DESTINATIONS = [
  { to: "/", label: "Composer", Icon: SquarePen, end: true },
  { to: "/reflect", label: "Reflect", Icon: Lightbulb, end: false },
  { to: "/digest", label: "Digest", Icon: CalendarDays, end: false },
  { to: "/settings", label: "Settings", Icon: SettingsIcon, end: false },
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

// Sessions stays an app-bar action, not a NavLink (ticket 62), unchanged by
// issue #75 moving Settings the other way: Sessions is still correctly one
// level down from the four Nav destinations above (Composer, Reflect,
// Digest, Settings) — it opens a list of Reflection's own Sessions
// (`/reflect/list`) rather than being a peer view of History the way those
// four are, and it only ever renders on Reflection's pages
// (reflection-page.tsx's `action` slot). Present regardless of Entry store
// status, same reasoning as Nav above and ADR 0008/0009.
export function SessionsLink() {
  return (
    <Link
      to="/reflect/list"
      aria-label="Sessions"
      // size-11 (44px) for the same tap-size reason as Nav's links above,
      // even though this isn't a nav destination — it's still a target a
      // thumb has to hit reliably in the app bar.
      className="flex size-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <ListIcon aria-hidden="true" className="size-4" />
    </Link>
  );
}

// Issue #80: a deliberate way to start a fresh Conversation, now that a
// bare `/reflect` no longer reliably means "empty" — the resume effect in
// `reflection-page.tsx` reads `last-session.ts`'s memory on every such mount and redirects
// straight back to whatever Session was last open. A plain `<Link
// to="/reflect">` cannot do this on its own: it would land on that same
// bare `/reflect`, the resume effect would run exactly the same way it
// always does, and the reader would be bounced straight back to the
// Conversation they were trying to leave — indistinguishable, from the
// effect's point of view, from Nav's own Reflect link (which *should*
// resume). `state.freshSession` is what tells the two apart: a router-level
// signal for "this one navigation means start over," not a param in the
// URL (ADR 0025 reserves the URL for the Session id itself, not for
// transient navigation intent) and not a write to `last-session.ts` (that
// would forget the Conversation for every *other* tab and every later
// visit too, not just this one deliberate one). It lives here beside
// `SessionsLink` rather than in a page, because both Reflection pages
// render it and a page importing a control out of another page is a
// dependency neither of them wants.
export function NewSessionLink() {
  return (
    <Link
      to="/reflect"
      state={{ freshSession: true }}
      aria-label="New Session"
      // Same size-11 tap target and hover treatment as every other app-bar
      // icon control (nav.tsx's SessionsLink, sessions-page.tsx's Back).
      className="flex size-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <SquarePen aria-hidden="true" className="size-4" />
    </Link>
  );
}
