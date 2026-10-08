import { beforeEach, describe, expect, it, vi } from "vitest";
import { DictationError, transcribeRecording } from "./dictation-transport";
import { useSettingsStore } from "./settings";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const base = {};

beforeEach(() => {
  useSettingsStore.setState({ serverUrl: "http://server:9" });
});

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
  it("posts multipart audio with a matching extension and no Authorization header, against the Server URL", async () => {
    const fetchImpl = vi.fn(async () =>
      json(200, { id: "1", status: "done", text: "hello", rawText: "hello uh" }),
    );

    const result = await transcribeRecording(new Blob(["x"], { type: "audio/webm;codecs=opus" }), {
      ...base,
      fetchImpl,
    });

    expect(result).toEqual({ text: "hello", rawText: "hello uh", warning: null });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://server:9/v1/dictations?wait=1");
    expect(init.method).toBe("POST");
    expect(init.headers).toBeUndefined();
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
    const fetchImpl = vi.fn(async () => json(200, { text: "", rawText: "", warning: "no_speech" }));
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
    expect(fetchImpl.mock.calls[1]?.[0]).toBe("http://server:9/v1/dictations/j1");
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

  it("reads the gateway's message from a 500 on a failed ?wait=1 job", async () => {
    const fetchImpl = vi.fn(async () =>
      json(500, { id: "j1", status: "failed", error: "ffmpeg exploded" }),
    );
    const error = await transcribeRecording(new Blob(["x"]), { ...base, fetchImpl }).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(DictationError);
    expect(error.kind).toBe("failed");
    expect(error.message).toBe("ffmpeg exploded");
  });

  it.each([
    [400, "missing_audio"],
    [400, "empty_audio"],
    [413, "payload_too_large"],
    [404, "not_found"],
  ])("uses the error string from a %s body (%s)", async (status, code) => {
    const fetchImpl = vi.fn(async () => json(status, { error: code }));
    const error = await transcribeRecording(new Blob(["x"]), { ...base, fetchImpl }).catch(
      (e) => e,
    );
    expect(error.kind).toBe("failed");
    expect(error.message).toBe(code);
  });

  it("keeps the 'answered N' message when the error body is unreadable", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>", { status: 502 }));
    const error = await transcribeRecording(new Blob(["x"]), { ...base, fetchImpl }).catch(
      (e) => e,
    );
    expect(error.kind).toBe("failed");
    expect(error.message).toBe("The Server answered 502.");
  });

  it("reads the gateway's message from a failed poll response", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(202, { id: "j1", status: "queued" }))
      .mockResolvedValueOnce(json(404, { error: "not_found" }));
    const error = await transcribeRecording(new Blob(["x"]), {
      ...base,
      fetchImpl,
      pollIntervalMs: 1,
    }).catch((e) => e);
    expect(error.message).toBe("not_found");
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

  it.each([
    [
      503,
      { error: "dictation_unavailable" },
      "unavailable",
      "Dictation is turned off on the Server.",
    ],
    [
      502,
      { error: "gateway_unreachable" },
      "gateway-unreachable",
      "The Server couldn't reach the dictation gateway.",
    ],
    [
      502,
      { error: "gateway_rejected_token" },
      "gateway-rejected",
      "The Server's dictation token was rejected by the gateway.",
    ],
  ])("maps %i %j to %s", async (status, body, kind, message) => {
    const fetchImpl = vi.fn(async () => json(status, body));
    const error = await transcribeRecording(new Blob(["x"]), { ...base, fetchImpl }).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(DictationError);
    expect(error.kind).toBe(kind);
    expect(error.message).toBe(message);
  });

  it("maps the same Server errors on a poll", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(202, { id: "j1", status: "queued" }))
      .mockResolvedValueOnce(json(502, { error: "gateway_unreachable" }));
    expect(
      await kindOf(transcribeRecording(new Blob(["x"]), { ...base, fetchImpl, pollIntervalMs: 1 })),
    ).toBe("gateway-unreachable");
  });

  it("passes a gateway 400 and 413 message through as failed", async () => {
    for (const status of [400, 413]) {
      const fetchImpl = vi.fn(async () => json(status, { error: "too_big" }));
      const error = await transcribeRecording(new Blob(["x"]), { ...base, fetchImpl }).catch(
        (e) => e,
      );
      expect(error.kind).toBe("failed");
      expect(error.message).toBe("too_big");
    }
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

/** A fetch that, like an unroutable address, never answers until its signal aborts. */
function hangingFetch() {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("aborted", "AbortError")),
      );
    });
  });
}

describe("per-request timeouts", () => {
  it("an upload that never answers is unreachable", async () => {
    expect(
      await kindOf(
        transcribeRecording(new Blob(["x"]), {
          ...base,
          fetchImpl: hangingFetch(),
          requestTimeoutMs: 20,
        }),
      ),
    ).toBe("unreachable");
  });

  it("a poll that never answers is unreachable", async () => {
    const fetchImpl = vi
      .fn(hangingFetch())
      .mockResolvedValueOnce(json(202, { id: "j1", status: "queued" }));
    expect(
      await kindOf(
        transcribeRecording(new Blob(["x"]), {
          ...base,
          fetchImpl,
          pollIntervalMs: 1,
          requestTimeoutMs: 20,
        }),
      ),
    ).toBe("unreachable");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("the caller's abort stays aborted even with a timeout set", async () => {
    const controller = new AbortController();
    const promise = transcribeRecording(new Blob(["x"]), {
      ...base,
      fetchImpl: hangingFetch(),
      signal: controller.signal,
      requestTimeoutMs: 60_000,
    });
    controller.abort();
    expect(await kindOf(promise)).toBe("aborted");
  });

  it("clears its timer after a fast success", async () => {
    vi.useFakeTimers();
    try {
      let seen: AbortSignal | undefined;
      const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
        seen = init?.signal ?? undefined;
        return json(200, { text: "hi", rawText: "hi" });
      });
      await transcribeRecording(new Blob(["x"]), { ...base, fetchImpl, requestTimeoutMs: 50 });
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(1000);
      expect(seen?.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("per-request timeouts without AbortSignal.any", () => {
  it("still times out, keeps caller aborts, and leaks no timer", async () => {
    vi.stubGlobal("AbortSignal", { ...AbortSignal, any: undefined, timeout: undefined });
    try {
      const controller = new AbortController();
      const aborted = transcribeRecording(new Blob(["x"]), {
        ...base,
        fetchImpl: hangingFetch(),
        signal: controller.signal,
        requestTimeoutMs: 60_000,
      });
      controller.abort();
      expect(await kindOf(aborted)).toBe("aborted");

      vi.useFakeTimers();
      const fetchImpl = vi.fn(async () => json(200, { text: "hi", rawText: "hi" }));
      await transcribeRecording(new Blob(["x"]), { ...base, fetchImpl, requestTimeoutMs: 50 });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
