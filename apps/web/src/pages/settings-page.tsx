import { ArrowLeft } from "lucide-react";
import { Link } from "react-router";
import { Shell } from "@/components/shell";

// Placeholder only (ticket 25) — the theme control and Server URL field
// this page exists for arrive in the ticket this one blocks (#26).
export function SettingsPage() {
  return (
    <Shell title="Settings">
      <Link
        to="/"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft aria-hidden="true" className="size-4" />
        Back
      </Link>
    </Shell>
  );
}
