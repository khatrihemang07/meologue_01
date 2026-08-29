import { List as ListIcon, SquarePen } from "lucide-react";
import { Link } from "react-router";

// Reflection's own two app-bar controls, moved here from the retired
// `nav.tsx` when ADR 0036 replaced the persistent nav with a chat list.
// They were never nav destinations — they are one level down from the four
// rows the list holds, and they only ever render on Reflection's pages —
// so retiring the nav left them without a home rather than without a
// purpose. They live beside each other rather than inside a page because
// both Reflection pages render them, and a page importing a control out of
// another page is a dependency neither of them wants.

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
