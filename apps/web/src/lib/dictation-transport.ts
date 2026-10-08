/**
 * The client half of dictation (issue #454, reworked by #455 / ADR 0091):
 * upload a recording to the meologue Server, get text back. The Server
 * proxies to the OpenWhispr gateway and holds its token, so this speaks
 * only to the Server URL and sends no Authorization header; nothing here
 * knows about Whisper, cleanup or the gateway's address.
 *
 * Deliberately NOT routed through `server-request.ts`. That helper flips
 * `serverReachable` in the settings store on every network failure, and a
 * dictation outage (gateway down, recording too long) must never mark Sync
 * as down (ADR 0011). `fetch` is injectable for tests, the same way
 * `server-check.ts` injects it.
 */

import { useSettingsStore } from "@/lib/settings";

export type DictationErrorKind =
  | "unreachable"
  | "unavailable"
  | "gateway-unreachable"
  | "gateway-rejected"
  | "failed"
  | "timeout"
  | "aborted"
  | "bad-response";

/** One error class with a discriminating `kind`, so the button maps kinds to sentences in one switch. */
export class DictationError extends Error {
  readonly kind: DictationErrorKind;

  constructor(kind: DictationErrorKind, message: string) {
    super(message);
    this.name = "DictationError";
    this.kind = kind;
  }
}

export interface DictationResult {
  text: string;
  rawText: string;
  /** The gateway's own warning, e.g. `"no_speech"` for near-silent audio; `null` when absent. */
  warning: string | null;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface TranscribeOptions {
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
  pollIntervalMs?: number;
  /** How long to keep polling a 202 before giving up. Default 10 minutes: a long dictation on a busy Mac is slow, and the audio is already uploaded. */
  timeoutMs?: number;
  /** Bounds the initial upload; each poll uses its own shorter default. Tests pass small values for both. */
  requestTimeoutMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
/** The gateway holds `?wait=1` for up to 25 s, and a long recording takes time to upload over Wi-Fi. */
const UPLOAD_REQUEST_TIMEOUT_MS = 90 * 1000;
const POLL_REQUEST_TIMEOUT_MS = 15 * 1000;

/**
 * Container extension for a recorded blob. The gateway converts every upload
 * with ffmpeg, which probes the content, so the extension is cosmetic: it
 * only makes logs and debugging legible. It still follows what the
 * MediaRecorder actually produced (mp4 on WebKit, webm elsewhere).
 */
function extensionFor(mimeType: string): string {
  const base = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  switch (base) {
    case "audio/mp4":
    case "audio/x-m4a":
      return "m4a";
    case "audio/ogg":
      return "ogg";
    case "audio/wav":
    case "audio/x-wav":
      return "wav";
    default:
      return "webm";
  }
}

function defaultFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, init);
}

interface BoundedSignal {
  signal: AbortSignal;
  /** True when the per-request timeout fired rather than the caller's own signal. */
  timedOut: () => boolean;
  /** Clears the timer once the request has finished. */
  dispose: () => void;
}

/**
 * The caller's signal combined with a per-request timeout. On a real Android
 * phone an unroutable address drops packets instead of refusing, so a bare
 * `fetch` hangs for minutes. `AbortSignal.any` and `AbortSignal.timeout` are
 * used when present; otherwise a manual controller and timer do the same job.
 */
function boundSignal(caller: AbortSignal | undefined, ms: number): BoundedSignal {
  if (typeof AbortSignal.any === "function" && typeof AbortSignal.timeout === "function") {
    const timeout = AbortSignal.timeout(ms);
    return {
      signal: caller ? AbortSignal.any([caller, timeout]) : timeout,
      timedOut: () => timeout.aborted && !caller?.aborted,
      dispose: () => {},
    };
  }
  const controller = new AbortController();
  let fired = false;
  const timer = setTimeout(() => {
    fired = true;
    controller.abort();
  }, ms);
  const onCallerAbort = () => controller.abort();
  if (caller?.aborted) {
    controller.abort();
  } else {
    caller?.addEventListener("abort", onCallerAbort, { once: true });
  }
  return {
    signal: controller.signal,
    timedOut: () => fired && !caller?.aborted,
    dispose: () => {
      clearTimeout(timer);
      caller?.removeEventListener("abort", onCallerAbort);
    },
  };
}

/** Runs one request, turning every failure into a `DictationError`. */
async function request(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<Response> {
  const bound = boundSignal(callerSignal, timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, signal: bound.signal });
  } catch (error) {
    if (bound.timedOut()) {
      throw new DictationError("unreachable", "Couldn't reach the Server.");
    }
    if (callerSignal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
      throw new DictationError("aborted", "Dictation was cancelled.");
    }
    // A thrown fetch is a TypeError in every browser (DNS, refused, CORS,
    // mixed content); anything else is unexpected and reads the same to a
    // user: the Server could not be reached.
    throw new DictationError("unreachable", "Couldn't reach the Server.");
  } finally {
    bound.dispose();
  }
  return response;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null) {
      return body as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  throw new DictationError("bad-response", "The Server sent an unreadable response.");
}

/**
 * The error for a non-ok response. The Server's own three errors
 * (`dictation_unavailable`, `gateway_unreachable`, `gateway_rejected_token`)
 * get their own kinds so the toast can say which hop failed. Everything else
 * is the gateway's passthrough: it answers a failed
 * `?wait=1` job with 500 and `{id, status:"failed", error}`, and 400/404/413
 * with `{error}`, so the body's own message is used when it has one; only an
 * unreadable body falls back to the bare status.
 */
async function failureFrom(response: Response): Promise<DictationError> {
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null) {
      const { error } = body as Record<string, unknown>;
      if (error === "dictation_unavailable") {
        return new DictationError("unavailable", "Dictation is turned off on the Server.");
      }
      if (error === "gateway_unreachable") {
        return new DictationError(
          "gateway-unreachable",
          "The Server couldn't reach the dictation gateway.",
        );
      }
      if (error === "gateway_rejected_token") {
        return new DictationError(
          "gateway-rejected",
          "The Server's dictation token was rejected by the gateway.",
        );
      }
      if (typeof error === "string" && error !== "") {
        return new DictationError("failed", error);
      }
    }
  } catch {
    // fall through to the status-only message
  }
  return new DictationError("failed", `The Server answered ${response.status}.`);
}

function resultFrom(body: Record<string, unknown>): DictationResult {
  const text = body.text;
  if (typeof text !== "string") {
    throw new DictationError("bad-response", "The Server sent no text.");
  }
  return {
    text,
    rawText: typeof body.rawText === "string" ? body.rawText : text,
    warning: typeof body.warning === "string" ? body.warning : null,
  };
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DictationError("aborted", "Dictation was cancelled."));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DictationError("aborted", "Dictation was cancelled."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Uploads `blob` and resolves with the transcript. `?wait=1` lets the
 * Server answer in one round trip when the job is quick (200); otherwise
 * it returns 202 and this polls `GET /v1/dictations/:id` until the job is
 * `done` or `failed`.
 */
export async function transcribeRecording(
  blob: Blob,
  options: TranscribeOptions,
): Promise<DictationResult> {
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const uploadTimeoutMs = options.requestTimeoutMs ?? UPLOAD_REQUEST_TIMEOUT_MS;
  const pollTimeoutMs = options.requestTimeoutMs ?? POLL_REQUEST_TIMEOUT_MS;
  const baseUrl = useSettingsStore.getState().serverUrl;

  const form = new FormData();
  form.append("audio", blob, `dictation.${extensionFor(blob.type)}`);

  const startedAt = Date.now();
  let response = await request(
    fetchImpl,
    `${baseUrl}/v1/dictations?wait=1`,
    { method: "POST", body: form },
    options.signal,
    uploadTimeoutMs,
  );
  if (!response.ok) {
    throw await failureFrom(response);
  }
  let body = await readJson(response);
  if (response.status === 200 && body.status === "done") {
    return resultFrom(body);
  }
  if (response.status === 200 && body.status === undefined) {
    return resultFrom(body);
  }

  const id = body.id;
  if (typeof id !== "string") {
    throw new DictationError("bad-response", "The Server sent no job id.");
  }

  for (;;) {
    if (body.status === "done") {
      return resultFrom(body);
    }
    if (body.status === "failed") {
      const message = typeof body.error === "string" && body.error !== "" ? body.error : null;
      throw new DictationError("failed", message ?? "Dictation failed.");
    }
    if (Date.now() - startedAt >= timeoutMs) {
      throw new DictationError("timeout", "Dictation took too long.");
    }
    await sleep(pollIntervalMs, options.signal);
    response = await request(
      fetchImpl,
      `${baseUrl}/v1/dictations/${encodeURIComponent(id)}`,
      {},
      options.signal,
      pollTimeoutMs,
    );
    if (!response.ok) {
      throw await failureFrom(response);
    }
    body = await readJson(response);
  }
}
