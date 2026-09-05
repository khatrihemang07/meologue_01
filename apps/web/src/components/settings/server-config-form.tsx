import type {
  WireConfigResponse,
  WireResolvedField,
  WireSource,
  WireTogglePatch,
} from "@meologue/core";
import type { UseQueryResult } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ChoiceRow } from "@/components/settings/choice-row";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ConfigResult } from "@/lib/config-transport";
import { useServerReachable, useSettingsStore } from "@/lib/settings";
import { cn } from "@/lib/utils";

/**
 * A Server row's own save cycle (issue #203's own acceptance criterion:
 * "Server rows show saving / saved / failed states"). Shared by the AI and
 * Sync sections' Save buttons rather than each section inventing its own
 * three-state union — a Device row (`switch-row.tsx`, `choice-row.tsx`)
 * applies instantly and has nothing to report beyond its new value; a
 * Server row round-trips over the network and can fail for reasons a
 * Device row structurally cannot (the Server is unreachable, an older
 * Server predates this field, a real HTTP failure), so it needs somewhere
 * to say which of those happened.
 */
export type ServerSaveStatus =
  | { state: "idle" }
  | { state: "saving" }
  | { state: "saved" }
  | { state: "failed"; message: string };

/**
 * The sentence a failed `ConfigResult` reads as — shared between a Save
 * failure (this file) and a load failure (`ServerGroup` below), so
 * "unreachable"/"not-supported"/"http-error" are described in exactly one
 * place regardless of which of the two ever produced them. Mirrors
 * `describeServerCheck`'s own reasoning (`describe-server-check.ts`): a
 * failure this Device only guessed at ("unreachable") reads differently
 * from one the Server actually reported ("http-error"), and an older
 * Server that has simply never heard of `/v1/config` ("not-supported") is
 * neither of those — it's "older than this setting," not a failure at all.
 */
export function describeConfigFailure(result: Extract<ConfigResult, { ok: false }>): string {
  switch (result.reason) {
    case "unreachable":
      return "Couldn't reach the server. Check that it's running and try again.";
    case "not-supported":
      return "This server is older than this setting — update it to change this here.";
    case "http-error":
      return `The server rejected this (HTTP ${result.status}).`;
  }
}

/**
 * One Server row's own status line, rendered under its control(s) — `null`
 * while idle, so a row that has never been touched shows nothing extra
 * (matching every Device row's own quiet default). "Saved" fades to nothing
 * on the next edit rather than lingering — see each section's own
 * `useState` reset, not anything in this component.
 */
export function ServerSaveStatusLine({ status }: { status: ServerSaveStatus }) {
  if (status.state === "idle") {
    return null;
  }
  if (status.state === "saving") {
    return <p className="text-muted-foreground text-xs">Saving…</p>;
  }
  if (status.state === "saved") {
    return <p className="text-muted-foreground text-xs">Saved.</p>;
  }
  return <p className="text-destructive text-xs">{status.message}</p>;
}

/** What a `ResolvedField`'s own `source` reads as, next to the control it describes. */
export function sourceHint(source: WireSource): string {
  switch (source) {
    case "stored":
      return "Stored on this server. Clear it to fall back to the environment.";
    case "env":
      return "From this server's own environment.";
    case "unset":
      return "Not set anywhere.";
  }
}

/**
 * One text field a Server holds (a chat/embed endpoint's base URL, model or
 * API key; Sync's timezone) — a controlled input whose value is the
 * caller's own draft, not `field.value` directly: the caller has to know
 * what the reader is mid-typing to decide whether this field is dirty
 * (issue #203's own read-merge-write contract — only an edited field
 * belongs in the `PATCH` at all, `settings::apply_patch`'s "absent means
 * untouched" rule), so the draft has to live one level up, in the section's
 * own form state, not inside this row.
 *
 * Disabled outright when `locked` — issue #200's `MEOLOGUE_CONFIG_LOCK`:
 * a write while locked is silently inert (`patch_config_handler`'s own doc
 * comment), and a control a reader can operate but that visibly does
 * nothing is worse than one that can't be operated at all.
 */
export function ServerTextField({
  id,
  label,
  field,
  value,
  onChange,
  locked,
  type = "text",
}: {
  id: string;
  label: string;
  field: WireResolvedField;
  value: string;
  onChange: (value: string) => void;
  locked: boolean;
  type?: "text" | "password";
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <Input
        id={id}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={locked}
        placeholder="Clear to fall back to the environment"
        className="h-11"
      />
      <p className="text-muted-foreground text-xs">{sourceHint(field.source)}</p>
    </div>
  );
}

const TOGGLE_OPTIONS: { id: WireTogglePatch; label: string }[] = [
  { id: "unset", label: "Default" },
  { id: "on", label: "On" },
  { id: "off", label: "Off" },
];

/**
 * One of the three tri-state feature toggles (issue #201/ADR 0062) — a
 * `ChoiceRow`, not a `SwitchRow`, per this ticket's own brief: a switch's
 * `aria-checked` is binary and cannot express "unset," the state that
 * means "defer to whatever the resolved chat/embed configuration would
 * otherwise make available" (`resolve_toggle`'s own doc comment,
 * `server/src/settings.rs`) rather than either "on" or "off" outright.
 *
 * `value` is the caller's own draft (`WireTogglePatch`), not derived from
 * `stored` here: the three-way choice already lives on the wire in exactly
 * this shape (`TogglePatch`), so the section holding this row's draft state
 * needs no second, ad hoc representation to translate to and from it.
 */
export function ServerToggleField({
  label,
  value,
  onChange,
  locked,
}: {
  label: string;
  value: WireTogglePatch;
  onChange: (value: WireTogglePatch) => void;
  locked: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm">{label}</span>
      <ChoiceRow columns={3}>
        {TOGGLE_OPTIONS.map((option) => (
          <Button
            key={option.id}
            type="button"
            size="touch"
            variant={value === option.id ? "default" : "outline"}
            aria-pressed={value === option.id}
            disabled={locked}
            onClick={() => onChange(option.id)}
          >
            {option.label}
          </Button>
        ))}
      </ChoiceRow>
    </div>
  );
}

/**
 * The "On the server" sub-group every topic section that holds a Server
 * setting wraps its rows in (issue #203) — `DeviceGroup`'s counterpart,
 * filling in the sub-group `device-group.tsx`'s own doc comment says every
 * topic section already reserves space for.
 *
 * Handles every state short of "here is the config, render the rows"
 * itself, so `AiSection`/`SyncSection` never have to repeat the same four
 * branches: no Server configured at all (ADR 0011 — nothing to reach),
 * configured but not currently reachable (`useServerReachable`, matching
 * `digest-page.tsx`'s own gate), still loading, or loaded but the Server
 * itself answered with a failure (`describeConfigFailure`). Only once none
 * of those apply does `children` — the section's own rows — ever render,
 * and it receives the resolved `WireConfigResponse` directly rather than
 * the whole `ConfigResult`, so no caller of this component ever has to
 * re-check `.ok` itself.
 *
 * A locked Server (`config.locked`) gets one shared notice here, above
 * `children`, rather than each section writing its own copy — every row
 * `children` renders is expected to pass `locked` through to its own
 * controls regardless; this banner is what explains why they're disabled.
 */
export function ServerGroup({
  heading,
  query,
  children,
}: {
  heading: string;
  query: UseQueryResult<ConfigResult, unknown>;
  children: (config: WireConfigResponse) => ReactNode;
}) {
  const serverUrl = useSettingsStore((state) => state.serverUrl);
  const serverReachable = useServerReachable();

  let body: ReactNode;
  if (serverUrl === "") {
    body = (
      <p className="text-muted-foreground text-sm">
        No server configured — add a Server URL under Sync to change these here.
      </p>
    );
  } else if (!serverReachable) {
    body = (
      <p className="text-muted-foreground text-sm">
        Couldn't reach the server to load these — check the Server URL under Sync.
      </p>
    );
  } else if (query.data === undefined) {
    // Covers both `isPending` and `isError` — the latter never actually
    // happens (`getConfig` never throws, mirroring `modelsTransport`'s own
    // discipline), kept here anyway as the honest fallback for "no data
    // yet, for whatever reason" rather than assuming only one cause.
    body = <p className="text-muted-foreground text-sm">Loading…</p>;
  } else if (!query.data.ok) {
    body = <p className="text-muted-foreground text-sm">{describeConfigFailure(query.data)}</p>;
  } else {
    const { config } = query.data;
    body = (
      <>
        {config.locked && (
          <p data-testid="server-config-locked" className="text-muted-foreground text-xs">
            This server's configuration is locked (MEOLOGUE_CONFIG_LOCK) — these settings are
            read-only here.
          </p>
        )}
        {children(config)}
      </>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <h3 className="px-1 text-muted-foreground text-xs">{heading}</h3>
      {body}
    </div>
  );
}

/**
 * A Save button sized and styled identically wherever a Server row needs
 * one. `label` defaults to plain "Save" but every caller on this page that
 * isn't the only Server-writing form in its own section should override
 * it — `sync-section.tsx`'s pre-existing Server URL form already has an
 * unrelated "Save" button of its own (a Device setting, unaffected by this
 * ticket), and two controls sharing one accessible name on the same page
 * is exactly what `apps/e2e/tests/settings.spec.ts`'s own touch-target
 * sweep, and any `getByRole("button", { name: "Save" })` query, cannot
 * tell apart.
 */
export function ServerSaveButton({
  onClick,
  disabled,
  label = "Save",
  className,
}: {
  onClick: () => void;
  disabled: boolean;
  label?: string;
  className?: string;
}) {
  return (
    <Button
      type="button"
      size="touch"
      onClick={onClick}
      disabled={disabled}
      className={cn(className)}
    >
      {label}
    </Button>
  );
}
