import type { WireConfigPatch, WireConfigResponse, WireTogglePatch } from "@meologue/core";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { DeviceGroup } from "@/components/settings/device-group";
import {
  describeConfigFailure,
  ServerGroup,
  ServerSaveButton,
  type ServerSaveStatus,
  ServerSaveStatusLine,
  ServerTextField,
  ServerToggleField,
} from "@/components/settings/server-config-form";
import { SettingsSection } from "@/components/settings/settings-section";
import { SwitchRow } from "@/components/settings/switch-row";
import type { ConfigResult } from "@/lib/config-transport";
import { describeSemanticRetrievalGap } from "@/lib/describe-server-check";
import { modelsTransport } from "@/lib/models-transport";
import { MODELS_QUERY_KEY } from "@/lib/query-keys";
import {
  HIDEABLE_DESTINATIONS,
  type HideableDestinationId,
  useSettingsStore,
} from "@/lib/settings";
import { useServerConfig } from "@/lib/use-server-config";

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

  // Issue #203's own server sub-group: the three feature toggles, the six
  // chat/embed endpoint fields, and the unembedded-Entry count. `configState`
  // is created here (not inside `ServerAiFields`) so `useServerConfig`'s one
  // `useQuery` is shared with whatever `ServerGroup` below needs to decide
  // which of its own four non-happy-path states applies — a second
  // `useQuery` call with the identical key would just read the same cache
  // entry a second time for no benefit.
  const configState = useServerConfig();

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

      <ServerGroup heading="On the server" query={configState.query}>
        {(config) => <ServerAiFields config={config} save={configState.save} />}
      </ServerGroup>
    </section>
  );
}

/**
 * A stored toggle (`FeatureConfig.stored`, whose own doc comment is
 * explicit that this is the raw column value, not `resolve`'s
 * `locked`-aware one) read back as the draft a `ServerToggleField` needs —
 * `null`/`undefined` (nothing stored) and the "Default" option share one
 * meaning, matching `resolve_toggle`'s own "unset defers to configuration."
 */
function toggleDraftFromStored(stored: boolean | null | undefined): WireTogglePatch {
  if (stored === true) return "on";
  if (stored === false) return "off";
  return "unset";
}

/** This group's own seven text fields and three toggles, read off one `ConfigResponse`. */
interface AiServerDraft {
  chatBaseUrl: string;
  chatModel: string;
  chatApiKey: string;
  embedBaseUrl: string;
  embedModel: string;
  embedApiKey: string;
  reflectEnabled: WireTogglePatch;
  digestEnabled: WireTogglePatch;
  embeddingsEnabled: WireTogglePatch;
}

function draftFromConfig(config: WireConfigResponse): AiServerDraft {
  return {
    chatBaseUrl: config.chat_base_url.value ?? "",
    chatModel: config.chat_model.value ?? "",
    chatApiKey: config.chat_api_key.value ?? "",
    embedBaseUrl: config.embed_base_url.value ?? "",
    embedModel: config.embed_model.value ?? "",
    embedApiKey: config.embed_api_key.value ?? "",
    reflectEnabled: toggleDraftFromStored(config.reflect.stored),
    digestEnabled: toggleDraftFromStored(config.digest.stored),
    embeddingsEnabled: toggleDraftFromStored(config.embeddings.stored),
  };
}

/**
 * Builds the `PATCH` body from exactly the fields that changed since the
 * last load or save — the read-merge-write contract's own client-side
 * half (`server/src/settings.rs`'s `ConfigPatch` doc comment: a key absent
 * from the JSON body is untouched, present-and-empty clears it to `NULL`).
 * Submitting every field on every Save, touched or not, would silently
 * convert an environment-sourced value into a stored one just by pressing
 * Save on a *different* field — this is what this ticket's own "manual
 * check" (clearing one field must not disturb another) actually depends
 * on structurally, not just by convention.
 */
function buildAiPatch(original: AiServerDraft, draft: AiServerDraft): WireConfigPatch {
  const patch: WireConfigPatch = {};
  if (draft.chatBaseUrl !== original.chatBaseUrl) patch.chat_base_url = draft.chatBaseUrl;
  if (draft.chatModel !== original.chatModel) patch.chat_model = draft.chatModel;
  if (draft.chatApiKey !== original.chatApiKey) patch.chat_api_key = draft.chatApiKey;
  if (draft.embedBaseUrl !== original.embedBaseUrl) patch.embed_base_url = draft.embedBaseUrl;
  if (draft.embedModel !== original.embedModel) patch.embed_model = draft.embedModel;
  if (draft.embedApiKey !== original.embedApiKey) patch.embed_api_key = draft.embedApiKey;
  if (draft.reflectEnabled !== original.reflectEnabled)
    patch.reflect_enabled = draft.reflectEnabled;
  if (draft.digestEnabled !== original.digestEnabled) patch.digest_enabled = draft.digestEnabled;
  if (draft.embeddingsEnabled !== original.embeddingsEnabled) {
    patch.embeddings_enabled = draft.embeddingsEnabled;
  }
  return patch;
}

const FEATURE_ROWS: { key: "reflect" | "digest" | "embeddings"; label: string }[] = [
  { key: "reflect", label: "Reflect" },
  { key: "digest", label: "Digest" },
  { key: "embeddings", label: "Embeddings" },
];

/**
 * `configured && !boot_active` per feature — "restart required," read
 * straight off two facts the Server itself reports (`FeatureConfig`'s own
 * doc comment on each), never inferred from anything guessed on this end.
 * Persistent, not tied to "did this Device just Save": the gap it names is
 * a standing fact about this process (something is now configured that its
 * own boot never registered a route for) regardless of which Device, or
 * which earlier session, is the one that last wrote the value.
 */
function restartRequiredLabels(config: WireConfigResponse): string[] {
  return FEATURE_ROWS.filter(({ key }) => config[key].configured && !config[key].boot_active).map(
    ({ label }) => label,
  );
}

/**
 * The AI section's "On the server" rows — three toggles, six chat/embed
 * endpoint fields, and the unembedded-Entry backlog (issue #203).
 *
 * Only ever rendered once `ServerGroup` has a loaded `ConfigResponse` in
 * hand, so this component's own state can seed straight from it with no
 * "loading" branch of its own to worry about. `draft` re-seeds from `config`
 * on every render where `config` is a new object — `useServerConfig`'s
 * `save` invalidates the query on success, so a save that lands hands this
 * component a fresh `config`, which is also what clears every field this
 * save just touched back to "not dirty" with no separate reset needed.
 */
function ServerAiFields({
  config,
  save,
}: {
  config: WireConfigResponse;
  save: (patch: WireConfigPatch) => Promise<ConfigResult>;
}) {
  const original = draftFromConfig(config);
  const [draft, setDraft] = useState<AiServerDraft>(original);
  const [status, setStatus] = useState<ServerSaveStatus>({ state: "idle" });

  // Re-seeds whenever the Server hands back a genuinely new `config` (a
  // fresh load, or the refetch a successful Save's own invalidation
  // triggers) — not on every render, which would overwrite whatever the
  // reader is still mid-typing with the value that render started from.
  useEffect(() => {
    setDraft(draftFromConfig(config));
  }, [config]);

  const locked = config.locked;
  const patch = buildAiPatch(original, draft);
  const dirty = Object.keys(patch).length > 0;

  function editField<K extends keyof AiServerDraft>(key: K, value: AiServerDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    setStatus({ state: "idle" });
  }

  async function handleSave() {
    setStatus({ state: "saving" });
    const result = await save(patch);
    if (result.ok) {
      setStatus({ state: "saved" });
    } else {
      setStatus({ state: "failed", message: describeConfigFailure(result) });
    }
  }

  const restartLabels = restartRequiredLabels(config);
  const semanticGap = describeSemanticRetrievalGap(
    config.reflect.effective,
    config.embeddings.effective,
  );
  const unembeddedCount = config.unembedded_entries;

  return (
    <>
      <SettingsSection
        label="Features"
        hint="Default follows whatever chat/embed configuration is otherwise available; On and Off override it regardless."
      >
        <ServerToggleField
          label="Reflect"
          value={draft.reflectEnabled}
          onChange={(value) => editField("reflectEnabled", value)}
          locked={locked}
        />
        <ServerToggleField
          label="Digest"
          value={draft.digestEnabled}
          onChange={(value) => editField("digestEnabled", value)}
          locked={locked}
        />
        <ServerToggleField
          label="Embeddings"
          value={draft.embeddingsEnabled}
          onChange={(value) => editField("embeddingsEnabled", value)}
          locked={locked}
        />
      </SettingsSection>

      <SettingsSection label="Chat endpoint">
        <ServerTextField
          id="server-chat-base-url"
          label="Chat base URL"
          field={config.chat_base_url}
          value={draft.chatBaseUrl}
          onChange={(value) => editField("chatBaseUrl", value)}
          locked={locked}
        />
        <ServerTextField
          id="server-chat-model"
          label="Chat model"
          field={config.chat_model}
          value={draft.chatModel}
          onChange={(value) => editField("chatModel", value)}
          locked={locked}
        />
        <ServerTextField
          id="server-chat-api-key"
          label="Chat API key"
          field={config.chat_api_key}
          value={draft.chatApiKey}
          onChange={(value) => editField("chatApiKey", value)}
          locked={locked}
          type="password"
        />
      </SettingsSection>

      <SettingsSection
        label="Embedding endpoint"
        hint={`${unembeddedCount} ${unembeddedCount === 1 ? "Entry" : "Entries"} not yet embedded.`}
      >
        <ServerTextField
          id="server-embed-base-url"
          label="Embed base URL"
          field={config.embed_base_url}
          value={draft.embedBaseUrl}
          onChange={(value) => editField("embedBaseUrl", value)}
          locked={locked}
        />
        <ServerTextField
          id="server-embed-model"
          label="Embed model"
          field={config.embed_model}
          value={draft.embedModel}
          onChange={(value) => editField("embedModel", value)}
          locked={locked}
        />
        <ServerTextField
          id="server-embed-api-key"
          label="Embed API key"
          field={config.embed_api_key}
          value={draft.embedApiKey}
          onChange={(value) => editField("embedApiKey", value)}
          locked={locked}
          type="password"
        />
        {semanticGap && (
          <p data-testid="semantic-retrieval-gap" className="text-muted-foreground text-xs">
            {semanticGap}
          </p>
        )}
      </SettingsSection>

      <div className="flex items-center gap-3">
        <ServerSaveButton
          onClick={handleSave}
          disabled={locked || !dirty}
          label="Save server AI settings"
        />
        <ServerSaveStatusLine status={status} />
      </div>
      {restartLabels.length > 0 && (
        <p data-testid="ai-restart-required" className="text-muted-foreground text-xs">
          Restart the server to enable {restartLabels.join(" and ")}.
        </p>
      )}
    </>
  );
}
