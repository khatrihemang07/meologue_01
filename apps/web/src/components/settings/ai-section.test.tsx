import type { WireConfigResponse } from "@meologue/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "@/lib/settings";
import { AiSection } from "./ai-section";

function modelsResponse(models: { id: string; streaming: boolean; context_window: number }[]) {
  return { ok: true, status: 200, json: async () => ({ models }) };
}

function renderAiSection() {
  const queryClient = new QueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <AiSection />
    </QueryClientProvider>,
  );
}

// Issue #203: the AI section's own "On the server" sub-group. `EMPTY_CONFIG`
// is a fully-resolved, nothing-stored `ConfigResponse` — everything the
// "server reachability" tests above this block don't care about, at rest.
const EMPTY_CONFIG: WireConfigResponse = {
  mode: "sandbox",
  locked: false,
  unembedded_entries: 0,
  chat_base_url: { value: null, source: "unset" },
  chat_model: { value: null, source: "unset" },
  chat_api_key: { value: null, source: "unset" },
  embed_base_url: { value: null, source: "unset" },
  embed_model: { value: null, source: "unset" },
  embed_api_key: { value: null, source: "unset" },
  tz: { value: null, source: "unset" },
  reflect: { stored: null, configured: false, boot_active: false, effective: false },
  digest: { stored: null, configured: false, boot_active: false, effective: false },
  embeddings: { stored: null, configured: false, boot_active: false, effective: false },
};

/**
 * Routes the one stubbed global `fetch` between `/v1/models` (every
 * pre-existing test in this file) and `/v1/config` (this ticket's own
 * server sub-group) — both hit by `AiSection` on the same mount once a
 * Server URL is set. `onPatch`, given the parsed `WireConfigPatch` body,
 * returns the config the Server would echo back, or `{ status }` for a
 * failed write.
 */
function stubAiFetch(
  initialConfig: WireConfigResponse,
  onPatch?: (patch: Record<string, unknown>) => WireConfigResponse | { status: number },
) {
  // Stateful, not a fixed response per call: a successful `PATCH` has to be
  // visible to the GET the mutation's own `invalidateQueries` triggers
  // right after, the same way a real Server's row would have changed —
  // otherwise a test asserting on the post-Save UI would see the refetch
  // quietly revert whatever the write just landed.
  let current = initialConfig;
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (typeof url === "string" && url.includes("/v1/config")) {
      if (init?.method === "PATCH") {
        const patch = JSON.parse(String(init.body)) as Record<string, unknown>;
        const outcome = onPatch?.(patch) ?? current;
        if ("status" in outcome) {
          return { ok: false, status: outcome.status, json: async () => ({}) };
        }
        current = outcome;
        return { ok: true, status: 200, json: async () => outcome };
      }
      return { ok: true, status: 200, json: async () => current };
    }
    return modelsResponse([]);
  });
}

describe("AiSection", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.setState({ hiddenDestinations: new Set(), defaultReflectModel: "" });
    // A quiet default so a test that doesn't care about the model picker
    // doesn't make a real network call.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => modelsResponse([])),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // Issue #134. Moved from settings-page.test.tsx (issue #202) — unchanged,
  // beyond the rename from a raw `role="switch"` copy check ("Hidden"/
  // "Visible") that `DestinationVisibilityRow` used to own directly to the
  // identical copy `SwitchRow` now produces from its own `onLabel`/
  // `offLabel` props.
  describe("chat list visibility", () => {
    it("lists Composer, Reflect, Digest and Todo, each with a visibility control, and offers none for Settings", () => {
      renderAiSection();

      expect(screen.getByRole("switch", { name: /Composer/ })).toBeInTheDocument();
      expect(screen.getByRole("switch", { name: /Reflect/ })).toBeInTheDocument();
      expect(screen.getByRole("switch", { name: /Digest/ })).toBeInTheDocument();
      expect(screen.getByRole("switch", { name: /Todo/ })).toBeInTheDocument();
      expect(screen.queryByRole("switch", { name: /Settings/ })).not.toBeInTheDocument();
    });

    it("starts every Destination visible when nothing is hidden", () => {
      renderAiSection();

      expect(screen.getByRole("switch", { name: /Digest/ })).toHaveAttribute(
        "aria-checked",
        "true",
      );
    });

    it("hides a Destination on click, and persists it", () => {
      renderAiSection();

      fireEvent.click(screen.getByRole("switch", { name: /Digest/ }));

      expect(screen.getByRole("switch", { name: /Digest/ })).toHaveAttribute(
        "aria-checked",
        "false",
      );
      expect(useSettingsStore.getState().hiddenDestinations).toEqual(new Set(["digest"]));
      expect(localStorage.getItem("meologue.hidden-destinations")).toBe("digest");
    });

    it("shows a hidden Destination again on a second click", () => {
      useSettingsStore.setState({ hiddenDestinations: new Set(["digest"]) });
      renderAiSection();

      fireEvent.click(screen.getByRole("switch", { name: /Digest/ }));

      expect(screen.getByRole("switch", { name: /Digest/ })).toHaveAttribute(
        "aria-checked",
        "true",
      );
      expect(useSettingsStore.getState().hiddenDestinations).toEqual(new Set());
    });

    it("toggles each Destination independently", () => {
      renderAiSection();

      fireEvent.click(screen.getByRole("switch", { name: /Reflect/ }));

      expect(useSettingsStore.getState().hiddenDestinations).toEqual(new Set(["reflect"]));
      expect(screen.getByRole("switch", { name: /Composer/ })).toHaveAttribute(
        "aria-checked",
        "true",
      );
      expect(screen.getByRole("switch", { name: /Digest/ })).toHaveAttribute(
        "aria-checked",
        "true",
      );
    });

    // Every control on this page must clear ADR 0036's 44px minimum touch
    // target — the switch is a `Button` at `size="touch"` (`h-11`, 44px)
    // for exactly that reason; this asserts the class rather than a
    // measured pixel height, the same way this repo already tests Server
    // URL's `Save` button (`className="h-11"` on its `Input` sibling).
    it("gives each visibility switch the 44px touch target every other control here has", () => {
      renderAiSection();

      expect(screen.getByRole("switch", { name: /Digest/ })).toHaveClass("h-11");
    });

    // The hint must say plainly that hiding affects only the row — not
    // Entries, Grounding, Digests, Export or Sync (issue #134's own
    // acceptance criterion).
    it("states in the hint that hiding affects the row only, not Entries, Grounding, Digests, Export or Sync", () => {
      renderAiSection();

      const hint = screen.getByText(/Hides the row only/);
      expect(hint).toHaveTextContent(/Grounding/);
      expect(hint).toHaveTextContent(/summarised into Digests/);
      expect(hint).toHaveTextContent(/Export/);
      expect(hint).toHaveTextContent(/Sync/);
    });
  });

  // Issue #202.
  describe("default Reflect model", () => {
    it("renders a disabled note instead of a picker when the Server offers no models", async () => {
      renderAiSection();

      expect(await screen.findByText(/No models available/i)).toBeInTheDocument();
      expect(screen.queryByLabelText("Default Reflect model")).not.toBeInTheDocument();
    });

    it("offers Server default plus every model the Server returns, once it answers", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          modelsResponse([
            { id: "codex-terra", streaming: false, context_window: 272000 },
            { id: "claude-sonnet", streaming: true, context_window: 200000 },
          ]),
        ),
      );

      renderAiSection();

      const picker = await screen.findByLabelText("Default Reflect model");
      const options = Array.from(picker.querySelectorAll("option")).map(
        (option) => option.textContent,
      );
      expect(options).toEqual(["Server default", "codex-terra", "claude-sonnet"]);
    });

    it("pre-fills the picker from an already-stored Device default", async () => {
      useSettingsStore.setState({ defaultReflectModel: "claude-sonnet" });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          modelsResponse([{ id: "claude-sonnet", streaming: true, context_window: 200000 }]),
        ),
      );

      renderAiSection();

      expect(await screen.findByLabelText("Default Reflect model")).toHaveValue("claude-sonnet");
    });

    it("persists a chosen model as the Device default", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          modelsResponse([{ id: "claude-sonnet", streaming: true, context_window: 200000 }]),
        ),
      );
      renderAiSection();
      const picker = await screen.findByLabelText("Default Reflect model");

      fireEvent.change(picker, { target: { value: "claude-sonnet" } });

      expect(useSettingsStore.getState().defaultReflectModel).toBe("claude-sonnet");
      expect(localStorage.getItem("meologue.default-reflect-model")).toBe("claude-sonnet");
    });

    it("clears the stored Device default when set back to Server default", async () => {
      useSettingsStore.setState({ defaultReflectModel: "claude-sonnet" });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          modelsResponse([{ id: "claude-sonnet", streaming: true, context_window: 200000 }]),
        ),
      );
      renderAiSection();
      const picker = await screen.findByLabelText("Default Reflect model");

      fireEvent.change(picker, { target: { value: "" } });

      expect(useSettingsStore.getState().defaultReflectModel).toBe("");
      expect(localStorage.getItem("meologue.default-reflect-model")).toBeNull();
    });
  });

  // Issue #203: the three feature toggles, the six chat/embed endpoint
  // fields, and the unembedded-Entry count — all only reachable once a
  // Server URL is set, since `useServerConfig` gates its query on that.
  describe("server settings", () => {
    it("shows each field's resolved value and source, and the unembedded count", async () => {
      useSettingsStore.setState({ serverUrl: "https://phone.example:41207" });
      vi.stubGlobal(
        "fetch",
        stubAiFetch({
          ...EMPTY_CONFIG,
          unembedded_entries: 7,
          chat_model: { value: "llm-stub-chat", source: "env" },
        }),
      );

      renderAiSection();

      expect(await screen.findByLabelText("Chat model")).toHaveValue("llm-stub-chat");
      expect(screen.getByText(/from this server's own environment/i)).toBeInTheDocument();
      expect(screen.getByText("7 Entries not yet embedded.")).toBeInTheDocument();
    });

    it("disables every row and the Save button when the Server reports itself locked", async () => {
      useSettingsStore.setState({ serverUrl: "https://phone.example:41207" });
      vi.stubGlobal("fetch", stubAiFetch({ ...EMPTY_CONFIG, locked: true }));

      renderAiSection();

      expect(await screen.findByLabelText("Chat model")).toBeDisabled();
      // One "On" toggle button per feature row (Reflect/Digest/Embeddings) —
      // every one of the three must be disabled, not just the field above.
      for (const button of screen.getAllByRole("button", { name: "On" })) {
        expect(button).toBeDisabled();
      }
      expect(screen.getByRole("button", { name: "Save server AI settings" })).toBeDisabled();
      expect(screen.getByText(/locked/i)).toBeInTheDocument();
    });

    // The issue's own "manual check that a naive implementation gets
    // wrong": editing one field must leave every other field alone in the
    // PATCH body, so an environment-sourced neighbour is never silently
    // pinned into storage just because Save was pressed.
    it("PATCHes only the field that was actually edited, leaving its neighbours untouched", async () => {
      useSettingsStore.setState({ serverUrl: "https://phone.example:41207" });
      const fetchMock = stubAiFetch({
        ...EMPTY_CONFIG,
        chat_base_url: { value: "http://llm.invalid", source: "env" },
      });
      vi.stubGlobal("fetch", fetchMock);

      renderAiSection();
      const chatModelField = await screen.findByLabelText("Chat model");

      fireEvent.change(chatModelField, { target: { value: "a-bogus-model" } });
      fireEvent.click(screen.getByRole("button", { name: "Save server AI settings" }));

      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith("https://phone.example:41207/v1/config", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_model: "a-bogus-model" }),
        }),
      );
    });

    it("clearing a stored field reverts it to the environment's value, not to empty", async () => {
      useSettingsStore.setState({ serverUrl: "https://phone.example:41207" });
      const fetchMock = stubAiFetch(
        { ...EMPTY_CONFIG, chat_model: { value: "a-bogus-model", source: "stored" } },
        (patch) => {
          expect(patch).toEqual({ chat_model: "" });
          return { ...EMPTY_CONFIG, chat_model: { value: "llm-stub-chat", source: "env" } };
        },
      );
      vi.stubGlobal("fetch", fetchMock);

      renderAiSection();
      const chatModelField = await screen.findByLabelText("Chat model");
      expect(chatModelField).toHaveValue("a-bogus-model");

      fireEvent.change(chatModelField, { target: { value: "" } });
      fireEvent.click(screen.getByRole("button", { name: "Save server AI settings" }));

      await waitFor(() => expect(chatModelField).toHaveValue("llm-stub-chat"));
      expect(screen.getByText(/from this server's own environment/i)).toBeInTheDocument();
    });

    it("says a restart is needed for a feature that's now configured but has no route registered yet", async () => {
      useSettingsStore.setState({ serverUrl: "https://phone.example:41207" });
      vi.stubGlobal(
        "fetch",
        stubAiFetch({
          ...EMPTY_CONFIG,
          reflect: { stored: true, configured: true, boot_active: false, effective: false },
        }),
      );

      renderAiSection();

      expect(await screen.findByTestId("ai-restart-required")).toHaveTextContent(
        /restart the server to enable reflect/i,
      );
    });

    it("says nothing about a restart when every configured feature is already active", async () => {
      useSettingsStore.setState({ serverUrl: "https://phone.example:41207" });
      vi.stubGlobal(
        "fetch",
        stubAiFetch({
          ...EMPTY_CONFIG,
          reflect: { stored: true, configured: true, boot_active: true, effective: true },
        }),
      );

      renderAiSection();

      await screen.findByLabelText("Chat model");
      expect(screen.queryByTestId("ai-restart-required")).not.toBeInTheDocument();
    });

    // Issue #203's other named acceptance criterion: Reflect answering with
    // no semantic retrieval behind it has to be visible, not silent.
    it("says Reflect is running without semantic retrieval when embeddings are off", async () => {
      useSettingsStore.setState({ serverUrl: "https://phone.example:41207" });
      vi.stubGlobal(
        "fetch",
        stubAiFetch({
          ...EMPTY_CONFIG,
          reflect: { stored: null, configured: true, boot_active: true, effective: true },
          embeddings: { stored: false, configured: true, boot_active: true, effective: false },
        }),
      );

      renderAiSection();

      expect(await screen.findByTestId("semantic-retrieval-gap")).toHaveTextContent(
        /semantic retrieval/i,
      );
    });

    it("reports a save that fails because the Server is unreachable as that, not as a rejected value", async () => {
      useSettingsStore.setState({ serverUrl: "https://phone.example:41207" });
      vi.stubGlobal(
        "fetch",
        stubAiFetch(EMPTY_CONFIG, () => {
          throw new Error("network down");
        }),
      );

      renderAiSection();
      const chatModelField = await screen.findByLabelText("Chat model");
      fireEvent.change(chatModelField, { target: { value: "a-bogus-model" } });
      fireEvent.click(screen.getByRole("button", { name: "Save server AI settings" }));

      expect(await screen.findByText(/couldn't reach the server/i)).toBeInTheDocument();
    });
  });
});
