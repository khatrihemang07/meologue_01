import type { WireConfigResponse } from "@meologue/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "@/lib/settings";
import { getConfig, patchConfig } from "./config-transport";

const configBody: WireConfigResponse = {
  mode: "sandbox",
  locked: false,
  unembedded_entries: 3,
  chat_base_url: { value: "http://llm.invalid", source: "env" },
  chat_model: { value: "llm-stub-chat", source: "env" },
  chat_api_key: { value: null, source: "unset" },
  embed_base_url: { value: "http://llm.invalid", source: "env" },
  embed_model: { value: "llm-stub-embed", source: "env" },
  embed_api_key: { value: null, source: "unset" },
  tz: { value: "UTC", source: "env" },
  reflect: { stored: null, configured: true, boot_active: true, effective: true },
  digest: { stored: null, configured: true, boot_active: true, effective: true },
  embeddings: { stored: null, configured: true, boot_active: true, effective: true },
};

describe("getConfig / patchConfig", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    useSettingsStore.setState({ serverUrl: "" });
  });

  it("fetches the stored Server URL's GET /v1/config and returns the parsed response", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => configBody,
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await getConfig();

    expect(fetchMock).toHaveBeenCalledWith("https://phone.example:41207/v1/config");
    expect(result).toEqual({ ok: true, config: configBody });
  });

  it("reports a network-level failure as 'unreachable'", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    const result = await getConfig();

    expect(result).toEqual({ ok: false, reason: "unreachable" });
  });

  // The acceptance criterion this ticket is most explicit about: a 404
  // reads as "this Server predates this route," never as a network
  // failure — distinct from `"unreachable"`, which every existing
  // transport (`digestTransport`'s own `"not-supported"`) already treats
  // as the honest catch-all for a failure this Device can only guess at.
  it("collapses a 404 to 'unsupported', distinct from 'unreachable'", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })),
    );

    const result = await getConfig();

    expect(result).toEqual({ ok: false, reason: "unsupported" });
  });

  it("reports a real Server-side failure as 'http-error', with its status", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })),
    );

    const result = await getConfig();

    expect(result).toEqual({ ok: false, reason: "http-error", status: 500 });
  });

  it("PATCHes the stored Server URL's /v1/config with the given patch body", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => configBody,
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await patchConfig({ chat_model: "a-bogus-model" });

    expect(fetchMock).toHaveBeenCalledWith("https://phone.example:41207/v1/config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_model: "a-bogus-model" }),
    });
    expect(result).toEqual({ ok: true, config: configBody });
  });

  it("reports a failed PATCH caused by an unreachable Server as 'unreachable', not a rejected value", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    const result = await patchConfig({ chat_model: "a-bogus-model" });

    expect(result).toEqual({ ok: false, reason: "unreachable" });
  });
});
