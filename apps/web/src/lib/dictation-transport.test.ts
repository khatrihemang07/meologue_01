import { describe, expect, it, vi } from "vitest";
import { checkDictationGateway, DictationError, transcribeRecording } from "./dictation-transport";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const base = { url: "http://gw:1", token: "tok" };

async function kindOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DictationError) {
      return error.kind;
    }
    throw error;
  }
  return "none";
}

describe("transcribeRecording", () => {
  it("posts multipart audio with a matching extension and the bearer token", async () => {
    const fetchImpl = vi.fn(async () =>
      json(200, { id: "1", status: "done", text: "hello", rawText: "hello uh" }),
    );

    const result = await transcribeRecording(new Blob(["x"], { type: "audio/webm;codecs=opus" }), {
      ...base,
      fetchImpl,
    });

    expect(result).toEqual({ text: "hello", rawText: "hello uh", warning: null });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://gw:1/v1/dictations?wait=1");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    const file = (init.body as FormData).get("audio") as File;
    expect(file.name).toBe("dictation.webm");
  });

  it.each([
    ["audio/mp4", "dictation.m4a"],
    ["audio/ogg;codecs=opus", "dictation.ogg"],
    ["", "dictation.webm"],
  ])("names a %s blob %s", async (type, name) => {
    const fetchImpl = vi.fn(async () => json(200, { text: "a", rawText: "a" }));
    await transcribeRecording(new Blob(["x"], { type }), { ...base, fetchImpl });
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(((init.body as FormData).get("audio") as File).name).toBe(name);
  });

  it("surfaces the no_speech warning", async () => {
    const fetchImpl = vi.fn(async () =>
      json(200, { text: "", rawText: "", warning: "no_speech" }),
    );
    const result = await transcribeRecording(new Blob(["x"]), { ...base, fetchImpl });
    expect(result.warning).toBe("no_speech");
  });

  it("polls a 202 until done", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(202, { id: "j1", status: "queued" }))
      .mockResolvedValueOnce(json(200, { id: "j1", status: "running" }))
      .mockResolvedValueOnce(json(200, { id: "j1", status: "done", text: "yo", rawText: "yo" }));

    const result = await transcribeRecording(new Blob(["x"]), {
      ...base,
      fetchImpl,
      pollIntervalMs: 1,
    });

    expect(result.text).toBe("yo");
    expect(fetchImpl.mock.calls[1]?.[0]).toBe("http://gw:1/v1/dictations/j1");
  });

  it("reports a failed job with the gateway's message", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(202, { id: "j1", status: "queued" }))
      .mockResolvedValueOnce(json(200, { id: "j1", status: "failed", error: "whisper crashed" }));

    const error = await transcribeRecording(new Blob(["x"]), {
      ...base,
      fetchImpl,
      pollIntervalMs: 1,
    }).catch((e) => e);

    expect(error).toBeInstanceOf(DictationError);
    expect(error.kind).toBe("failed");
    expect(error.message).toBe("whisper crashed");
  });

  it("times out when the job never finishes", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes("wait=1")
        ? json(202, { id: "j1", status: "queued" })
        : json(200, { id: "j1", status: "running" }),
    );
    expect(
      await kindOf(
        transcribeRecording(new Blob(["x"]), {
          ...base,
          fetchImpl,
          pollIntervalMs: 1,
          timeoutMs: 20,
        }),
      ),
    ).toBe("timeout");
  });

  it("maps 401 to unauthorized", async () => {
    const fetchImpl = vi.fn(async () => json(401, { error: "no" }));
    expect(await kindOf(transcribeRecording(new Blob(["x"]), { ...base, fetchImpl }))).toBe(
      "unauthorized",
    );
  });

  it("maps a thrown TypeError to unreachable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await kindOf(transcribeRecording(new Blob(["x"]), { ...base, fetchImpl }))).toBe(
      "unreachable",
    );
  });

  it("maps an abort to aborted", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    });
    const promise = transcribeRecording(new Blob(["x"]), {
      ...base,
      fetchImpl,
      signal: controller.signal,
    });
    controller.abort();
    expect(await kindOf(promise)).toBe("aborted");
  });

  it("maps a malformed body to bad-response", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>", { status: 200 }));
    expect(await kindOf(transcribeRecording(new Blob(["x"]), { ...base, fetchImpl }))).toBe(
      "bad-response",
    );
  });
});

describe("checkDictationGateway", () => {
  it("returns the health report", async () => {
    const fetchImpl = vi.fn(async (_url: string) =>
      json(200, {
        ok: true,
        openwhispr: { reachable: true, version: "1.2.3", verifiedVersion: "1.2.3" },
        status: "ok",
      }),
    );
    const health = await checkDictationGateway("http://gw:1", "tok", fetchImpl);
    expect(health.status).toBe("ok");
    expect(health.openwhispr.version).toBe("1.2.3");
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://gw:1/v1/health");
  });

  it("maps 401 to unauthorized", async () => {
    const fetchImpl = vi.fn(async () => json(401, {}));
    expect(await kindOf(checkDictationGateway("http://gw:1", "bad", fetchImpl))).toBe(
      "unauthorized",
    );
  });

  it("maps a network failure to unreachable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("nope");
    });
    expect(await kindOf(checkDictationGateway("http://gw:1", "t", fetchImpl))).toBe("unreachable");
  });
});
