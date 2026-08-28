import { afterEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "@/lib/settings";
import {
  sessionsDeleteTransport,
  sessionsListTransport,
  sessionsTransport,
} from "./sessions-transport";

const sessionId = "11111111-1111-1111-1111-111111111111";

describe("sessionsTransport", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    useSettingsStore.setState({ serverUrl: "" });
  });

  it("fetches the stored Server URL's /v1/sessions/:id and returns the parsed Session", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    const responseBody = {
      id: sessionId,
      title: "How has my knee been?",
      created_at: "2026-08-01T00:00:00Z",
      updated_at: "2026-08-01T00:00:05Z",
      turns: [
        {
          question: "How has my knee been?",
          answer: "It's improved since February.",
          grounding_entry_ids: ["entry-1"],
          tool_called: true,
          model: "codex-terra",
          created_at: "2026-08-01T00:00:05Z",
        },
      ],
    };
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => responseBody,
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await sessionsTransport(sessionId);

    expect(fetchMock).toHaveBeenCalledWith(`https://phone.example:41207/v1/sessions/${sessionId}`);
    expect(result).toEqual({ ok: true, session: responseBody });
  });

  it("reports a 404 distinctly, as 'not-found'", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })),
    );

    const result = await sessionsTransport(sessionId);

    expect(result).toEqual({ ok: false, reason: "not-found" });
  });

  it("reports a non-404 failure status as 'unreachable', without throwing", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })),
    );

    const result = await sessionsTransport(sessionId);

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

    const result = await sessionsTransport(sessionId);

    expect(result).toEqual({ ok: false, reason: "unreachable" });
  });

  it("re-reads the stored URL on every call, without re-importing the module", async () => {
    const responseBody = {
      id: sessionId,
      title: "",
      created_at: "2026-08-01T00:00:00Z",
      updated_at: "2026-08-01T00:00:00Z",
      turns: [],
    };
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => responseBody,
    }));
    vi.stubGlobal("fetch", fetchMock);

    useSettingsStore.getState().setServerUrl("https://first.example");
    await sessionsTransport(sessionId);

    useSettingsStore.getState().setServerUrl("https://second.example");
    await sessionsTransport(sessionId);

    expect(fetchMock).toHaveBeenNthCalledWith(1, `https://first.example/v1/sessions/${sessionId}`);
    expect(fetchMock).toHaveBeenNthCalledWith(2, `https://second.example/v1/sessions/${sessionId}`);
  });
});

describe("sessionsListTransport", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    useSettingsStore.setState({ serverUrl: "" });
  });

  it("fetches the stored Server URL's /v1/sessions and returns the parsed list", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    const responseBody = [
      {
        id: sessionId,
        title: "How has my knee been?",
        created_at: "2026-08-01T00:00:00Z",
        updated_at: "2026-08-01T00:00:05Z",
      },
    ];
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => responseBody,
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await sessionsListTransport();

    expect(fetchMock).toHaveBeenCalledWith("https://phone.example:41207/v1/sessions");
    expect(result).toEqual({ ok: true, sessions: responseBody });
  });

  it("reports an empty list as ok, not as a failure", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => [] })),
    );

    const result = await sessionsListTransport();

    expect(result).toEqual({ ok: true, sessions: [] });
  });

  it("reports a 404 (this Server predates the route) as 'unreachable', without a 'not-found' reason", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })),
    );

    const result = await sessionsListTransport();

    expect(result).toEqual({ ok: false, reason: "unreachable" });
  });

  it("reports a non-404 failure status as 'unreachable', without throwing", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })),
    );

    const result = await sessionsListTransport();

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

    const result = await sessionsListTransport();

    expect(result).toEqual({ ok: false, reason: "unreachable" });
  });

  it("re-reads the stored URL on every call, without re-importing the module", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => [],
    }));
    vi.stubGlobal("fetch", fetchMock);

    useSettingsStore.getState().setServerUrl("https://first.example");
    await sessionsListTransport();

    useSettingsStore.getState().setServerUrl("https://second.example");
    await sessionsListTransport();

    expect(fetchMock).toHaveBeenNthCalledWith(1, "https://first.example/v1/sessions");
    expect(fetchMock).toHaveBeenNthCalledWith(2, "https://second.example/v1/sessions");
  });

  // Issue #64: Search's `?q=`.
  it("appends ?q=<term> when a non-blank query is given", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => [] }));
    vi.stubGlobal("fetch", fetchMock);

    await sessionsListTransport("knee");

    expect(fetchMock).toHaveBeenCalledWith("https://phone.example:41207/v1/sessions?q=knee");
  });

  it("URL-encodes a term with special characters — spaces, %, and reserved query characters", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    const fetchMock = vi.fn(async (_url: string) => ({
      ok: true,
      status: 200,
      json: async () => [],
    }));
    vi.stubGlobal("fetch", fetchMock);

    await sessionsListTransport("knee % & flat move?");

    const url = fetchMock.mock.calls[0]?.[0] ?? "";
    expect(url).toBe("https://phone.example:41207/v1/sessions?q=knee+%25+%26+flat+move%3F");
    // And it decodes back to exactly the original term — the encoding round-trips.
    expect(new URL(url).searchParams.get("q")).toBe("knee % & flat move?");
  });

  it("omits ?q= entirely when the query is undefined, empty, or whitespace-only — identical to no search", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    const fetchMock = vi.fn(async (_url: string) => ({
      ok: true,
      status: 200,
      json: async () => [],
    }));
    vi.stubGlobal("fetch", fetchMock);

    await sessionsListTransport(undefined);
    await sessionsListTransport("");
    await sessionsListTransport("   ");

    for (const call of fetchMock.mock.calls) {
      expect(call[0]).toBe("https://phone.example:41207/v1/sessions");
    }
  });
});

describe("sessionsDeleteTransport", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    useSettingsStore.setState({ serverUrl: "" });
  });

  it("sends a DELETE to the stored Server URL's /v1/sessions/:id and reports ok on a 204", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    const fetchMock = vi.fn(async () => ({ ok: true, status: 204, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await sessionsDeleteTransport(sessionId);

    expect(fetchMock).toHaveBeenCalledWith(`https://phone.example:41207/v1/sessions/${sessionId}`, {
      method: "DELETE",
    });
    expect(result).toEqual({ ok: true });
  });

  it("reports a 404 distinctly, as 'not-found'", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })),
    );

    const result = await sessionsDeleteTransport(sessionId);

    expect(result).toEqual({ ok: false, reason: "not-found" });
  });

  it("reports a non-404 failure status as 'unreachable', without throwing", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })),
    );

    const result = await sessionsDeleteTransport(sessionId);

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

    const result = await sessionsDeleteTransport(sessionId);

    expect(result).toEqual({ ok: false, reason: "unreachable" });
  });

  it("re-reads the stored URL on every call, without re-importing the module", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 204, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchMock);

    useSettingsStore.getState().setServerUrl("https://first.example");
    await sessionsDeleteTransport(sessionId);

    useSettingsStore.getState().setServerUrl("https://second.example");
    await sessionsDeleteTransport(sessionId);

    expect(fetchMock).toHaveBeenNthCalledWith(1, `https://first.example/v1/sessions/${sessionId}`, {
      method: "DELETE",
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `https://second.example/v1/sessions/${sessionId}`,
      {
        method: "DELETE",
      },
    );
  });
});
