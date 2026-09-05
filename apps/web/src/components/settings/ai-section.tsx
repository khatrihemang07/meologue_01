import { useQuery } from "@tanstack/react-query";
import { DeviceGroup } from "@/components/settings/device-group";
import { SettingsSection } from "@/components/settings/settings-section";
import { SwitchRow } from "@/components/settings/switch-row";
import { modelsTransport } from "@/lib/models-transport";
import { MODELS_QUERY_KEY } from "@/lib/query-keys";
import {
  HIDEABLE_DESTINATIONS,
  type HideableDestinationId,
  useSettingsStore,
} from "@/lib/settings";

/**
 * Where this Device turns Server-backed intelligence on or off for
 * itself — which Destination rows show in the chat list, and which model a
 * fresh Reflect Conversation starts on — the third of five topic sections
 * `settings-page.tsx` composes (issue #202).
 *
 * Every setting here is Device-local (ADR 0008), read and written straight
 * off `useSettingsStore` with no props threaded down from the page. The
 * models query below is the one exception to "no network here beyond the
 * store": it's the identical `GET /v1/models` call `reflection-page.tsx`
 * already makes for `question-composer.tsx`'s own per-ask picker, reusing
 * `MODELS_QUERY_KEY` so the two share one cache entry rather than each
 * fetching it separately, and it runs unconditionally on mount the same way
 * that caller's own `modelsQuery` does — not gated on a Server URL being
 * set or on Sync being on, the identical choice that caller's own comment
 * makes: the picker (and this row) is meaningful the moment Settings opens,
 * not only once something else has already confirmed a Server exists. An
 * unset or unreachable Server URL simply resolves to no models, the same
 * "no picker" outcome question-composer.tsx already shows for that case.
 */
export function AiSection() {
  const hiddenDestinations = useSettingsStore((state) => state.hiddenDestinations);
  const setStoredHiddenDestinations = useSettingsStore((state) => state.setHiddenDestinations);
  const defaultReflectModel = useSettingsStore((state) => state.defaultReflectModel);
  const setStoredDefaultReflectModel = useSettingsStore((state) => state.setDefaultReflectModel);

  // No `apply*` step to run first, unlike Appearance's own controls — hiding
  // a Destination has nothing to paint immediately on *this* screen; the
  // only visible effect is the next time `chat-list.tsx` renders, which
  // happens wherever this reader navigates to next.
  function toggleDestinationHidden(id: HideableDestinationId) {
    const next = new Set(hiddenDestinations);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setStoredHiddenDestinations(next);
  }

  // Issue #98's own route, reused rather than duplicated — see this file's
  // own doc comment above for why sharing `MODELS_QUERY_KEY` with
  // `reflection-page.tsx` is deliberate rather than incidental.
  const modelsQuery = useQuery({
    queryKey: MODELS_QUERY_KEY,
    queryFn: async () => {
      const result = await modelsTransport();
      return result.ok ? result.models : [];
    },
  });
  const models = modelsQuery.data ?? [];

  return (
    <section aria-labelledby="ai-heading" className="flex flex-col gap-4">
      <h2 id="ai-heading" className="font-semibold text-sm">
        AI
      </h2>
      <DeviceGroup heading="On this device">
        {/*
          Issue #134, extended to Todo by issue #168. Settings is never
          offered a control here, because ADR 0008/0009 make it the
          recovery route when the Entry store won't open or the Server URL
          is wrong, and a control that could hide the way out of every
          other problem this page fixes would defeat the point of it.
          `HIDEABLE_DESTINATIONS` (settings.ts) is the whole list this maps
          over, so a fifth row added there in some future version shows up
          here with no further change.

          This toggle reaches no Server and starts no request — it is a
          `localStorage` write, full stop. In particular it cannot stop a
          Digest being generated: the Digest worker runs on the Server's
          own schedule from Server configuration and takes no input from
          any Device (issue #134's own text). There is deliberately
          nothing here that calls the Server to try.
        */}
        <SettingsSection
          label="Chat list"
          hint="Hides the row only — the Destination itself keeps working. A hidden Composer, Reflect, Digest or Todo still opens at its own address; a hidden Entry-backed row still appears in Reflection's Grounding, is still summarised into Digests, is still included in an Export, and still Syncs to every other Device — Todo has no Server-side counterpart to any of that, but hiding its row is exactly as reversible."
        >
          {HIDEABLE_DESTINATIONS.map((destination) => (
            <SwitchRow
              key={destination.id}
              label={destination.label}
              checked={!hiddenDestinations.has(destination.id)}
              onToggle={() => toggleDestinationHidden(destination.id)}
              onLabel="Visible"
              offLabel="Hidden"
              ariaLabel={`${destination.label} in the chat list`}
            />
          ))}
        </SettingsSection>

        {/*
          Issue #202. Pre-selects question-composer.tsx's own per-ask
          picker for a fresh Conversation — it does not make every ask
          sticky to this model; the picker still starts from scratch on
          each new Conversation, and any Question can still choose a
          different model of its own without touching this setting
          (settings.ts's own `defaultReflectModel` doc comment).
        */}
        <SettingsSection
          label="Default Reflect model"
          hint="Pre-selects the model picker when you open Reflect. Any Question can still choose a different model without changing this."
        >
          {models.length === 0 ? (
            // Matches what question-composer.tsx's own picker already does
            // with no models offered: no functioning picker rather than an
            // empty one with nothing to choose from. That picker simply
            // renders nothing; this row can't disappear the same way — it's
            // a permanent part of Settings, not an ephemeral composer
            // slot — so it says why there's nothing to choose instead.
            <p className="text-muted-foreground text-sm">
              No models available yet. This Server hasn't reported any — check back once it does, or
              after entering a Server URL under Sync.
            </p>
          ) : (
            <>
              <label htmlFor="default-reflect-model" className="sr-only">
                Default Reflect model
              </label>
              <select
                id="default-reflect-model"
                value={defaultReflectModel}
                onChange={(event) => setStoredDefaultReflectModel(event.target.value)}
                className="h-11 rounded-md border border-border bg-background px-3 text-sm"
              >
                <option value="">Server default</option>
                {models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.id}
                  </option>
                ))}
              </select>
            </>
          )}
        </SettingsSection>
      </DeviceGroup>
    </section>
  );
}
