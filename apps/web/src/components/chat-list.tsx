import {
  CalendarDays,
  Lightbulb,
  ListTodo,
  Lock,
  Settings as SettingsIcon,
  SquarePen,
} from "lucide-react";
import { useEffect } from "react";
import { NavLink } from "react-router";
import {
  type HideableDestinationId,
  useCapabilities,
  useHiddenDestinations,
  useSyncEnabled,
} from "@/lib/settings";
import { cn } from "@/lib/utils";

/**
 * The five rows the root screen is made of (ADR 0036). Four of them were
 * ADR 0018's original bound, Material 3's three-to-five, and every ADR
 * since had kept the membership there unchanged — until Todo (issue #168,
 * ADR 0047), the first Destination to actually reach that fifth slot.
 * Unlike Reflect's Sessions, which ADR 0036 explicitly declined to promote
 * to a row of its own, Todo is not a second view onto something another
 * Destination already shows — it is a second root noun with its own
 * lifecycle, and a full-bleed row is what every other root noun here
 * already gets. Issue #134 lets a reader hide Composer, Reflect, Digest or
 * Todo from the *rendered* list without touching this array — see
 * `useDestinations()` below for where that filter actually happens.
 *
 * `end` on Composer alone: every other route is a prefix of deeper routes
 * (`/reflect/list`, `/digest/:period/:date`, `/todo/inbox`) that should
 * still mark their own row as current, while `/composer` has no children to
 * match.
 *
 * `requiresSync` marks the Destinations that have nothing to show without
 * a Server. Only Reflection and Digest do: both are written by the Server
 * and neither exists locally. **Composer and Todo are deliberately not
 * among them.** meologue is a local-first log (CONTEXT.md's own opening
 * line) — an Entry is captured, searched, edited and Exported on the
 * Device whether or not Sync is on, so `composer-page.tsx` keeps its
 * thread and its input fully working with an unset Server URL and shows
 * only a Sync-off note beside them. Todo is the second Destination that
 * works fully offline, for the same underlying reason: a Task's own store
 * sits on the same local `SqliteDriver` an Entry's does (ADR 0047), and a
 * personal task list has no technical dependency on a Server to add,
 * complete or reorder a Task — Todoist itself is offline-first, and issue
 * #168's own acceptance criterion is "Todo is fully usable with Sync off."
 * Locking either row would claim a Destination that always works is
 * unavailable, and since an unset Server URL is the *default* (ADR 0011)
 * it would greet every fresh install with three locked rows out of five
 * instead of two.
 *
 * `capability` names which key of `ServerCapabilities` (`@meologue/core`)
 * a Destination reads to decide it's locked, once Sync is on. Settings has
 * neither flag: it configures the Server itself and must never lock (issue
 * #133 — it is the only way out of every other locked row). Todo has
 * neither either, for the reason just above: there is no
 * `ServerCapabilities` key to gate it on, because nothing about Todo ever
 * depends on what the Server can serve.
 */
const DESTINATIONS = [
  {
    to: "/composer",
    label: "Composer",
    Icon: SquarePen,
    end: true,
    summary: "Everything you have written, newest last",
    requiresSync: false,
    capability: undefined,
  },
  {
    to: "/reflect",
    label: "Reflect",
    Icon: Lightbulb,
    end: false,
    summary: "Ask a Question of your own History",
    requiresSync: true,
    capability: "reflect",
  },
  {
    to: "/digest",
    label: "Digest",
    Icon: CalendarDays,
    end: false,
    summary: "What the Server wrote about a stretch of time",
    requiresSync: true,
    capability: "digest",
  },
  {
    to: "/todo",
    label: "Todo",
    Icon: ListTodo,
    end: false,
    summary: "Add, complete and reorder your Tasks",
    requiresSync: false,
    capability: undefined,
  },
  {
    to: "/settings",
    label: "Settings",
    Icon: SettingsIcon,
    end: false,
    summary: "Theme, Server URL, Backup, Restore",
    requiresSync: false,
    capability: undefined,
  },
] as const;

/**
 * `DESTINATIONS` plus each row's current lock state (issue #133) — the
 * prefactor the ticket asks for, so #134's own filter has a derivation to
 * extend rather than a second one to invent beside it.
 *
 * A row locks when:
 * - Sync itself is off (`useSyncEnabled` — no Server URL, ADR 0011), for
 *   every Destination that `requiresSync` (Composer included: it works
 *   fully offline, but the row still signals that Sync is off, the same
 *   fact `composer-page.tsx`'s own "Sync is off" line already tells a
 *   reader who opens it); or
 * - Sync is on, but the cached capability report (`useCapabilities`) says
 *   the Server has no model behind this Destination's feature.
 *
 * Deliberately reads only the settings store — no Entry-store read, no
 * network call — both hooks above are synchronous selectors over state
 * that was already resolved before this component ever rendered
 * (`settings.ts`'s own doc comments cover where each one is populated).
 * That's what keeps this list rendering beside `/settings` on a bad Server
 * URL (ADR 0008/0009) and what keeps a fresh cold launch — capabilities
 * still `null` — drawing every row unlocked rather than guessing "locked"
 * for a Server nothing has been learned about yet.
 *
 * After locking, issue #134's `hiddenDestinations` (`useHiddenDestinations`,
 * `settings.ts`) removes a row from the returned array outright rather than
 * marking it. Hiding is list curation, not access control — the row's own
 * route in `App.tsx` carries no guard and is unaffected — so there is
 * nothing here for a hidden-but-still-locked Destination to show: it is
 * simply absent, never a locked row that's also somehow hidden. Settings is
 * filtered out of that check unconditionally (`destination.to === "/settings"`
 * below), independent of what `hiddenDestinations` actually contains —
 * `settings-page.tsx` never offers a control for it, but this is the second,
 * load-bearing guarantee: even a hand-edited `localStorage` value naming
 * "settings" cannot make the one recovery route (ADR 0008/0009) disappear.
 */
function useDestinations() {
  const syncEnabled = useSyncEnabled();
  const capabilities = useCapabilities();
  const hiddenDestinations = useHiddenDestinations();

  return DESTINATIONS.map((destination) => {
    const capabilityMissing =
      destination.capability !== undefined &&
      capabilities !== null &&
      capabilities[destination.capability] === false;
    const locked = destination.requiresSync && (!syncEnabled || capabilityMissing);
    return { ...destination, locked };
  }).filter((destination) => {
    if (destination.to === "/settings") {
      return true;
    }
    // Every other `to` in `DESTINATIONS` is one of the four literal
    // hideable routes, so the slug this slice produces is always a real
    // `HideableDestinationId` — the cast repeats what `DESTINATIONS`'s own
    // `as const` already guarantees rather than asserting something new.
    return !hiddenDestinations.has(destination.to.slice(1) as HideableDestinationId);
  });
}

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
 *
 * A locked row (issue #133) stays a full, real link — opening it lands on
 * the Destination's own screen, which already explains the gap in its own
 * words (the "Sync is off" or "this Server doesn't support …" prose every
 * page here already carries). Locking only mutes the row and adds a lock
 * glyph; it never turns red — CONTEXT.md's Sync status entry is explicit
 * that Sync being off "reads as a neutral state, not an error," and the
 * same posture applies to a configured-but-featureless Server.
 */
export function ChatList() {
  const destinations = useDestinations();

  // Issue #168: the only prefetch anywhere in this app, and deliberately
  // narrow rather than a general "warm every row's chunk" mechanism —
  // Composer, Reflect, Digest and Settings already shipped behind
  // `React.lazy` (issue #150) with no prefetch at all, and this doesn't
  // reopen that call for them. Todo earns its own: Inbox's drag-to-reorder
  // (ADR 0050) is the first per-pointer-movement gesture on any root-screen
  // Destination, and a gesture reads as broken the moment it's mid-motion
  // when the browser is still parsing and evaluating the code that has to
  // answer the next `pointermove` — a cost typing into the Composer or
  // waiting on a Reflect answer never pays, since neither has a frame
  // budget to miss. Firing the dynamic `import()` the instant the row is
  // on screen, rather than waiting for the tap that opens it, is what
  // spends that parse-and-eval cost before the first drag can ever start.
  //
  // A bare side effect, not a hover- or pointerdown-triggered one: the
  // smallest mechanism that's still honest about what it's for. Hovering
  // first would still race a fast tap-through on a touch device, which has
  // no hover at all; this instead accepts paying the fetch unconditionally
  // whenever the row is visible, on the same reasoning `App.tsx`'s own
  // lazy split already accepts paying `/`'s cold-start weight
  // unconditionally rather than trying to predict who needs what. Safe to
  // re-run on every render (`todoVisible` toggling is the only thing that
  // re-fires it): the browser's own module cache makes a repeated
  // `import()` of an already-fetched specifier a no-op, not a second
  // request.
  const todoVisible = destinations.some((destination) => destination.to === "/todo");
  useEffect(() => {
    if (todoVisible) {
      void import("@/pages/todo-page");
    }
  }, [todoVisible]);

  return (
    <nav aria-label="Chats" className="flex flex-col">
      {destinations.map(({ to, label, Icon, end, summary, locked }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          data-locked={locked ? "true" : undefined}
          className={({ isActive }) =>
            cn(
              "flex items-center gap-3 pl-4 text-left transition-colors hover:bg-muted",
              isActive && "bg-muted",
              // Muted, never red/destructive — a locked row is a neutral
              // fact about the current Server, not a failure of this
              // Device's own (see this component's own doc comment).
              locked && "text-muted-foreground",
            )
          }
        >
          <span
            aria-hidden="true"
            className={cn(
              "flex size-11 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground",
              locked && "opacity-60",
            )}
          >
            <Icon className="size-5" />
          </span>
          {/*
            The divider lives on this inner column, not on the row, so it
            starts where the text starts instead of running full-bleed under
            the avatar. `last:border-b-0` rather than a border on the
            container's children generally: the final row has nothing below
            it to be separated from.

            `--separator`, not `border-border` (#128). In the dark theme
            `--border` is white at 10%, which is right for a card edge beside
            a fill that already reads as one and far too faint for a hairline
            that is the ONLY thing between two rows of the same colour —
            these dividers were effectively invisible there. A second token
            rather than raising `--border`, which every input, card and pill
            in the app also reads.
          */}
          <span
            className={cn(
              "flex min-w-0 flex-1 flex-col gap-0.5 border-[var(--separator)] border-b py-3 pr-4 last:border-b-0",
              locked && "opacity-70",
            )}
          >
            <span className="truncate font-medium text-foreground text-sm">{label}</span>
            {/*
              Every row's summary truncates the same way, including
              Settings'. A row that is allowed to run full width while its
              neighbours clip is what leaves the list's right edge ragged.
            */}
            <span className="truncate text-muted-foreground text-sm">{summary}</span>
          </span>
          {locked && (
            // Sibling of the text column above, not nested inside it — a
            // trailing glyph rather than a second line of copy, so opening
            // the row for the explanation stays the only way to learn more
            // (this component intentionally carries no new prose of its
            // own; see the Destination pages listed in this file's own
            // module doc comment for where that explanation actually
            // lives).
            <Lock aria-hidden="true" className="mr-4 size-4 shrink-0 text-muted-foreground" />
          )}
        </NavLink>
      ))}
    </nav>
  );
}
