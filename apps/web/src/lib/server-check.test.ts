import { PROTOCOL_VERSION } from "@meologue/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkServerUrl } from "./server-check";

function stubHealthResponse(status: number, body: unknown) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }));
}

describe("checkServerUrl", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    localStorage.clear();
  });

  it("checks the given URL against its health endpoint", async () => {
    const fetchMock = stubHealthResponse(200, {
      service: "meologue-server",
      protocol_version: PROTOCOL_VERSION,
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await checkServerUrl("https://phone.example:41207");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://phone.example:41207/v1/health",
      expect.anything(),
    );
    expect(result).toEqual({ ok: true, protocolVersion: PROTOCOL_VERSION });
  });

  it("falls back to VITE_SERVER_URL when the given URL is empty", async () => {
    vi.stubEnv("VITE_SERVER_URL", "https://built-in.example");
    const fetchMock = stubHealthResponse(200, {
      service: "meologue-server",
      protocol_version: PROTOCOL_VERSION,
    });
    vi.stubGlobal("fetch", fetchMock);

    await checkServerUrl("");

    expect(fetchMock).toHaveBeenCalledWith("https://built-in.example/v1/health", expect.anything());
  });

  it("reports a mismatch when the server speaks a different protocol version", async () => {
    const fetchMock = stubHealthResponse(200, {
      service: "meologue-server",
      protocol_version: PROTOCOL_VERSION + 1,
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await checkServerUrl("https://phone.example:41207");

    expect(result).toEqual({
      ok: false,
      reason: "protocol-mismatch",
      serverVersion: PROTOCOL_VERSION + 1,
    });
  });
});
