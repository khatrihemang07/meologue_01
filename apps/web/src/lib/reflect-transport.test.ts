import type { WireReflectRequest } from "@meologue/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "@/lib/settings";
import { reflectTransport } from "./reflect-transport";

const request: WireReflectRequest = {
  protocol_version: 1,
  question: "How has my knee been this year?",
  prior_turns: [],
};

describe("reflectTransport", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    useSettingsStore.setState({ serverUrl: "" });
  });

  it("posts the request to the stored Server URL's /v1/reflect and returns the parsed response", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    const responseBody = {
      answer: "Your knee has improved since February.",
      grounding_entry_ids: ["entry-1"],
      grounded: true,
    };
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => responseBody,
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await reflectTransport(request);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://phone.example:41207/v1/reflect",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(request),
      }),
    );
    expect(result).toEqual({ ok: true, response: responseBody });
  });

  it("reports a 404 distinctly, as 'not-supported'", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })),
    );

    const result = await reflectTransport(request);

    expect(result).toEqual({ ok: false, reason: "not-supported" });
  });

  it("reports a non-404 failure status as 'unreachable', without throwing", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })),
    );

    const result = await reflectTransport(request);

    expect(result).toEqual({ ok: false, reason: "unreachable" });
  });

  it("reports a network failure (a thrown fetch) as 'unreachable', without throwing", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    const result = await reflectTransport(request);

    expect(result).toEqual({ ok: false, reason: "unreachable" });
  });

  it("re-reads the stored URL on every call, without re-importing the module", async () => {
    const responseBody = { answer: "", grounding_entry_ids: [], grounded: false };
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => responseBody,
    }));
    vi.stubGlobal("fetch", fetchMock);

    useSettingsStore.getState().setServerUrl("https://first.example");
    await reflectTransport(request);

    useSettingsStore.getState().setServerUrl("https://second.example");
    await reflectTransport(request);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://first.example/v1/reflect",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://second.example/v1/reflect",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
