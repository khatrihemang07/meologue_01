import { afterEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION } from "./protocol";
import { checkServer, type ServerFetch } from "./server-check";

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

describe("checkServer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports ok with the server's protocol version when it matches", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { service: "meologue-server", protocol_version: PROTOCOL_VERSION }),
    );

    const result = await checkServer("https://server.example", { fetch: fetchMock });

    expect(result).toEqual({ ok: true, protocolVersion: PROTOCOL_VERSION });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://server.example/v1/health",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("reports not-configured for an empty URL, without calling fetch", async () => {
    const fetchMock = vi.fn();

    const result = await checkServer("", { fetch: fetchMock });

    expect(result).toEqual({ ok: false, reason: "not-configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports invalid-url for text that isn't a URL, without calling fetch", async () => {
    const fetchMock = vi.fn();

    const result = await checkServer("not a url", { fetch: fetchMock });

    expect(result).toEqual({ ok: false, reason: "invalid-url" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports unreachable when fetch rejects", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });

    const result = await checkServer("https://server.example", { fetch: fetchMock });

    expect(result).toEqual({ ok: false, reason: "unreachable" });
  });

  it("reports unreachable when the response body isn't valid JSON", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token");
      },
    }));

    const result = await checkServer("https://server.example", { fetch: fetchMock });

    expect(result).toEqual({ ok: false, reason: "unreachable" });
  });

  it("reports http-error with the status when the server answers with a non-2xx status", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(503, {}));

    const result = await checkServer("https://server.example", { fetch: fetchMock });

    expect(result).toEqual({ ok: false, reason: "http-error", status: 503 });
  });

  it("carries the server's capabilities through when it reports them", async () => {
    const capabilities = { reflect: true, digest: false, embeddings: true };
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, {
        service: "meologue-server",
        protocol_version: PROTOCOL_VERSION,
        capabilities,
      }),
    );

    const result = await checkServer("https://server.example", { fetch: fetchMock });

    expect(result).toEqual({ ok: true, protocolVersion: PROTOCOL_VERSION, capabilities });
  });

  // Issue #133: a Server that predates the `capabilities` field must never
  // be mistaken for one that fails the protocol check — omitting the field
  // is unknown, not a mismatch, and the two checks (protocol_version vs.
  // capabilities) must stay independent of one another.
  it("reports capabilities as unknown, not a protocol mismatch, when the server omits the field", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { service: "meologue-server", protocol_version: PROTOCOL_VERSION }),
    );

    const result = await checkServer("https://server.example", { fetch: fetchMock });

    expect(result).toEqual({
      ok: true,
      protocolVersion: PROTOCOL_VERSION,
      capabilities: undefined,
    });
    expect(result.ok && result.capabilities).toBeUndefined();
  });

  it("reports protocol-mismatch with the server's version when it differs", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { service: "meologue-server", protocol_version: PROTOCOL_VERSION + 1 }),
    );

    const result = await checkServer("https://server.example", { fetch: fetchMock });

    expect(result).toEqual({
      ok: false,
      reason: "protocol-mismatch",
      serverVersion: PROTOCOL_VERSION + 1,
    });
  });

  it("reports unreachable rather than spinning forever against a hung address", async () => {
    vi.useFakeTimers();
    const fetchMock: ServerFetch = vi.fn(
      (_url, init) =>
        new Promise<never>((_resolve, reject) => {
          init.signal.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted", "AbortError"));
          });
        }),
    );

    const pending = checkServer("https://server.example", { fetch: fetchMock, timeoutMs: 3000 });
    await vi.advanceTimersByTimeAsync(3000);

    await expect(pending).resolves.toEqual({ ok: false, reason: "unreachable" });
  });
});
