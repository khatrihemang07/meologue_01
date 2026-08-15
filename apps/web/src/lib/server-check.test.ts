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

  it("reports not-configured for an empty URL, without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await checkServerUrl("");

    expect(result).toEqual({ ok: false, reason: "not-configured" });
    expect(fetchMock).not.toHaveBeenCalled();
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
