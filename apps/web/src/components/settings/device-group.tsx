import type { ReactNode } from "react";

/**
 * Sub-groups a topic section's own settings by who owns them — "On this
 * device" today; "On the server" arrives once a Server setting actually
 * exists to fill it (issue #202 is blocked-by the ticket that adds one —
 * see CONTEXT.md's own **Server setting** entry). Every topic section
 * wraps its contents in one of these even before a second sub-group has
 * anything to hold, so the structure the follow-up fills in is already in
 * place rather than something that ticket has to invent alongside its
 * first Server-owned row.
 *
 * Deliberately NOT a `<fieldset>`, unlike `SettingsSection`
 * (settings-section.tsx): a nested fieldset announces poorly to a screen
 * reader, and `apps/e2e/tests/settings.spec.ts` sweeps every `<fieldset>`
 * on this page asserting one uniform label-to-control gap — a second,
 * nested fieldset here would fail that sweep for a reason that has nothing
 * to do with what it's actually testing. A plain `<div>` with a muted
 * heading carries the same visual grouping with none of that risk; the
 * individual settings underneath still get their own real `<fieldset>`
 * from `SettingsSection`, unchanged.
 *
 * The heading is a `<h3>` under each topic's own `<h2>` (the five
 * `*-section.tsx` files), matching the weight `today-view.tsx` already
 * gives a sub-grouping heading under its own `<h2>`s.
 */
export function DeviceGroup({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-4">
      <h3 className="px-1 text-muted-foreground text-xs">{heading}</h3>
      {children}
    </div>
  );
}
