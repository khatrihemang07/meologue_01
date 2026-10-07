/**
 * The client half of the dictation gateway contract (issue #454, ADR 0090):
 * upload a recording, get text back. The gateway is a separate service on
 * the user's network that runs OpenWhispr's own pipeline; meologue only
 * speaks its small HTTP surface, so nothing here knows about Whisper or
 * cleanup.
 *
 * Deliberately NOT routed through `server-request.ts`. That helper flips
 * `serverReachable` in the settings store on every network failure, and the
 * gateway is not the meologue Server: a gateway outage must never mark Sync
 * as down (ADR 0011). `fetch` is injectable for tests, the same way
 * `server-check.ts` injects it.
 */

export type DictationErrorKind =
  | "unauthorized"
  | "unreachable"
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

export interface GatewayHealth {
  ok: boolean;
  openwhispr: { reachable: boolean; version: string | null; verifiedVersion: string | null };
  status: "ok" | "degraded" | "down";
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface TranscribeOptions {
  url: string;
  token: string;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
  pollIntervalMs?: number;
  /** How long to keep polling a 202 before giving up. Default 10 minutes: a long dictation on a busy Mac is slow, and the audio is already uploaded. */
  timeoutMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

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

/** Runs one request, turning every failure into a `DictationError`. */
async function request(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, ...(signal ? { signal } : {}) });
  } catch (error) {
    if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
      throw new DictationError("aborted", "Dictation was cancelled.");
    }
    // A thrown fetch is a TypeError in every browser (DNS, refused, CORS,
    // mixed content); anything else is unexpected and reads the same to a
    // user: the gateway could not be reached.
    throw new DictationError("unreachable", "Couldn't reach the dictation gateway.");
  }
  if (response.status === 401) {
    throw new DictationError("unauthorized", "The dictation gateway rejected the token.");
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
  throw new DictationError("bad-response", "The dictation gateway sent an unreadable response.");
}

/**
 * The error for a non-ok, non-401 response. The gateway answers a failed
 * `?wait=1` job with 500 and `{id, status:"failed", error}`, and 400/404/413
 * with `{error}`, so the body's own message is used when it has one; only an
 * unreadable body falls back to the bare status.
 */
async function failureFrom(response: Response): Promise<DictationError> {
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null) {
      const { error } = body as Record<string, unknown>;
      if (typeof error === "string" && error !== "") {
        return new DictationError("failed", error);
      }
    }
  } catch {
    // fall through to the status-only message
  }
  return new DictationError("failed", `The dictation gateway answered ${response.status}.`);
}

function resultFrom(body: Record<string, unknown>): DictationResult {
  const text = body.text;
  if (typeof text !== "string") {
    throw new DictationError("bad-response", "The dictation gateway sent no text.");
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
 * gateway answer in one round trip when the job is quick (200); otherwise
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
  const headers = { Authorization: `Bearer ${options.token}` };

  const form = new FormData();
  form.append("audio", blob, `dictation.${extensionFor(blob.type)}`);

  const startedAt = Date.now();
  let response = await request(
    fetchImpl,
    `${options.url}/v1/dictations?wait=1`,
    { method: "POST", headers, body: form },
    options.signal,
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
    throw new DictationError("bad-response", "The dictation gateway sent no job id.");
  }

  for (;;) {
    if (body.status === "done") {
      return resultFrom(body);
    }
    if (body.status === "failed") {
      const message = typeof body.error === "string" && body.error !== "" ? body.error : null;
      throw new DictationError("failed", message ?? "Dictation failed on the gateway.");
    }
    if (Date.now() - startedAt >= timeoutMs) {
      throw new DictationError("timeout", "Dictation took too long.");
    }
    await sleep(pollIntervalMs, options.signal);
    response = await request(
      fetchImpl,
      `${options.url}/v1/dictations/${encodeURIComponent(id)}`,
      { headers },
      options.signal,
    );
    if (!response.ok) {
      throw await failureFrom(response);
    }
    body = await readJson(response);
  }
}

/** `GET /v1/health`, for Settings' Test button. Throws a `DictationError` on 401, a network failure or a malformed body. */
export async function checkDictationGateway(
  url: string,
  token: string,
  fetchImpl: FetchLike = defaultFetch,
): Promise<GatewayHealth> {
  const response = await request(
    fetchImpl,
    `${url}/v1/health`,
    { headers: { Authorization: `Bearer ${token}` } },
    undefined,
  );
  if (!response.ok) {
    throw new DictationError("failed", `The dictation gateway answered ${response.status}.`);
  }
  const body = await readJson(response);
  const openwhispr = body.openwhispr as Record<string, unknown> | undefined;
  const status = body.status;
  if (status !== "ok" && status !== "degraded" && status !== "down") {
    throw new DictationError("bad-response", "That address isn't a dictation gateway.");
  }
  return {
    ok: body.ok === true,
    openwhispr: {
      reachable: openwhispr?.reachable === true,
      version: typeof openwhispr?.version === "string" ? openwhispr.version : null,
      verifiedVersion:
        typeof openwhispr?.verifiedVersion === "string" ? openwhispr.verifiedVersion : null,
    },
    status,
  };
}
