import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshCapabilities, useSettingsStore } from "@/lib/settings";
import { useServerConfig } from "./use-server-config";

vi.mock("@/lib/settings", async () => {
  const actual = await vi.importActual<typeof import("@/lib/settings")>("@/lib/settings");
  return { ...actual, refreshCapabilities: vi.fn(actual.refreshCapabilities) };
});

function configResponse(overrides: Partial<Record<string, unknown>> = {}) {
  return {
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
    ...overrides,
  };
}

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient();
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("useServerConfig", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    localStorage.clear();
    useSettingsStore.setState({ serverUrl: "", serverReachable: true });
  });

  it("does not fetch when no Server URL is set", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useServerConfig(), { wrapper });

    expect(result.current.query.fetchStatus).toBe("idle");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not fetch when the Server is known to be unreachable", () => {
    useSettingsStore.setState({ serverUrl: "https://phone.example:41207", serverReachable: false });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useServerConfig(), { wrapper });

    expect(result.current.query.fetchStatus).toBe("idle");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches GET /v1/config once a Server URL is set and reachable", async () => {
    useSettingsStore.setState({ serverUrl: "https://phone.example:41207", serverReachable: true });
    const body = configResponse();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => body })),
    );

    const { result } = renderHook(() => useServerConfig(), { wrapper });

    await waitFor(() => expect(result.current.query.data).toEqual({ ok: true, config: body }));
  });

  it("on a successful write, invalidates the config query and refreshes capabilities", async () => {
    useSettingsStore.setState({ serverUrl: "https://phone.example:41207", serverReachable: true });
    const body = configResponse();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => body })),
    );

    const { result } = renderHook(() => useServerConfig(), { wrapper });
    await waitFor(() => expect(result.current.query.data).toBeDefined());

    await result.current.save({ chat_model: "a-model" });

    await waitFor(() => expect(refreshCapabilities).toHaveBeenCalled());
  });

  it("on a failed write, does not refresh capabilities", async () => {
    useSettingsStore.setState({ serverUrl: "https://phone.example:41207", serverReachable: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })),
    );

    const { result } = renderHook(() => useServerConfig(), { wrapper });

    const writeResult = await result.current.save({ chat_model: "a-model" });

    expect(writeResult).toEqual({ ok: false, reason: "unsupported" });
    expect(refreshCapabilities).not.toHaveBeenCalled();
  });
});
