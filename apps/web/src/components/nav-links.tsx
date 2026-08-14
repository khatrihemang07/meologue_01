import { ArrowLeft, History as HistoryIcon, Settings as SettingsIcon } from "lucide-react";
import { Link } from "react-router";

// Shared between whichever pages need them (ticket 27) — three pages now
// link to each other and the affordance should look and behave the same
// wherever it appears rather than being redefined per page.

/** Present regardless of Entry store status — Settings is reachable even while the store is still opening or failed to. */
export function SettingsLink() {
  return (
    <Link
      to="/settings"
      aria-label="Settings"
      className="text-muted-foreground transition-colors hover:text-foreground"
    >
      <SettingsIcon aria-hidden="true" className="size-4" />
    </Link>
  );
}

/** Present regardless of Entry store status, for the same reason as SettingsLink. */
export function HistoryLink() {
  return (
    <Link
      to="/history"
      aria-label="History"
      className="text-muted-foreground transition-colors hover:text-foreground"
    >
      <HistoryIcon aria-hidden="true" className="size-4" />
    </Link>
  );
}

/** Returns to the Composer. Used by every page that isn't it. */
export function BackLink() {
  return (
    <Link
      to="/"
      className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
    >
      <ArrowLeft aria-hidden="true" className="size-4" />
      Back
    </Link>
  );
}
