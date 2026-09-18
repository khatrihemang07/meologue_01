import {
  CalendarCheck,
  CalendarClock,
  Compass,
  FolderKanban,
  History,
  ListFilter,
  ListTodo,
} from "lucide-react";

export interface TodoNavDestination {
  to: string;
  label: string;
  Icon: typeof ListTodo;
}

export const TODO_NAV_DESTINATIONS: readonly TodoNavDestination[] = [
  { to: "/todo/inbox", label: "Inbox", Icon: ListTodo },
  { to: "/todo/today", label: "Today", Icon: CalendarCheck },
  { to: "/todo/upcoming", label: "Upcoming", Icon: CalendarClock },
  { to: "/todo/filters", label: "Filters", Icon: ListFilter },
  { to: "/todo/activity", label: "Activity", Icon: History },
  { to: "/todo/projects", label: "Projects", Icon: FolderKanban },
] as const;

// The paths `TODO_BAR_DESTINATIONS` below keeps directly, filtered out of
// `TODO_NAV_DESTINATIONS` above rather than re-typed as a second literal
// list — so the bar's three flat rows can never drift from this file's own
// `to`/`label`/`Icon` for Inbox/Today/Upcoming the way defect 33's two
// independently hand-maintained lists once did.
const BAR_KEPT_PATHS: ReadonlySet<string> = new Set([
  "/todo/inbox",
  "/todo/today",
  "/todo/upcoming",
]);

export const TODO_BAR_DESTINATIONS: readonly TodoNavDestination[] = [
  ...TODO_NAV_DESTINATIONS.filter((destination) => BAR_KEPT_PATHS.has(destination.to)),
  { to: "/todo/browse", label: "Browse", Icon: Compass },
];
