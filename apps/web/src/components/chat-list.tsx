import { CalendarDays, Lightbulb, Settings as SettingsIcon, SquarePen } from "lucide-react";
import { NavLink } from "react-router";
import { cn } from "@/lib/utils";

/**
 * The four rows the root screen is made of (ADR 0036). The same four
 * destinations ADR 0018 first bounded to Material 3's three-to-five and
 * every ADR since has kept — the membership does not change here, only the
 * shape they are shown in.
 *
 * `end` on Composer alone: every other route is a prefix of deeper routes
 * (`/reflect/list`, `/digest/:period/:date`) that should still mark their
 * own row as current, while `/composer` has no children to match.
 */
const DESTINATIONS = [
  {
    to: "/composer",
    label: "Composer",
    Icon: SquarePen,
    end: true,
    summary: "Everything you have written, newest last",
  },
  {
    to: "/reflect",
    label: "Reflect",
    Icon: Lightbulb,
    end: false,
    summary: "Ask a Question of your own History",
  },
  {
    to: "/digest",
    label: "Digest",
    Icon: CalendarDays,
    end: false,
    summary: "What the Server wrote about a stretch of time",
  },
  {
    to: "/settings",
    label: "Settings",
    Icon: SettingsIcon,
    end: false,
    summary: "Theme, Server URL, Export",
  },
] as const;

/**
 * The root screen's list of destinations.
 *
 * `<nav aria-label="Chats">` here is deliberately NOT the persistent
 * landmark ADR 0036 retires. That one sat beside every screen and never went
 * away; this one is scoped to the list itself, which is a screen you
 * navigate away from like any other, and it leaves the accessibility tree
 * along with the rest of this pane the moment a row is opened.
 *
 * `NavLink` rather than `Link` for the same reason the retired `nav.tsx`
 * used it: `aria-current="page"` on the open row for free. ADR 0036 requires
 * an implementation to replace what the persistent landmark gave away, and
 * a real `href` plus `aria-current` is the whole of that debt — both are
 * paid here rather than reconstructed by hand on every route change.
 *
 * The summary line is a fixed descriptor for now, not a preview of each
 * destination's newest content. A real preview needs the Entry store, the
 * Sessions list and the Digest query, and this pane deliberately reads none
 * of them: it renders beside `/settings`, which ADR 0008/0009 require to
 * keep working when the store never opens at all.
 */
export function ChatList() {
  return (
    <nav aria-label="Chats" className="flex flex-col">
      {DESTINATIONS.map(({ to, label, Icon, end, summary }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          className={({ isActive }) =>
            cn(
              "flex items-center gap-3 pl-4 text-left transition-colors hover:bg-muted",
              isActive && "bg-muted",
            )
          }
        >
          <span
            aria-hidden="true"
            className="flex size-11 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
          >
            <Icon className="size-5" />
          </span>
          {/*
            The divider lives on this inner column, not on the row, so it
            starts where the text starts instead of running full-bleed under
            the avatar. `last:border-b-0` rather than a border on the
            container's children generally: the final row has nothing below
            it to be separated from.
          */}
          <span className="flex min-w-0 flex-1 flex-col gap-0.5 border-b border-border py-3 pr-4 last:border-b-0">
            <span className="truncate font-medium text-foreground text-sm">{label}</span>
            {/*
              Every row's summary truncates the same way, including
              Settings'. A row that is allowed to run full width while its
              neighbours clip is what leaves the list's right edge ragged.
            */}
            <span className="truncate text-muted-foreground text-sm">{summary}</span>
          </span>
        </NavLink>
      ))}
    </nav>
  );
}
