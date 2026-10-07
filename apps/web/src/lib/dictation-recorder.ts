/**
 * Microphone capture for Composer dictation (issue #454). A thin wrapper
 * over `getUserMedia` + `MediaRecorder` that owns the one thing callers must
 * not get wrong: every track is stopped on every exit path, because a live
 * track keeps the OS microphone indicator on (and on Android keeps the mic
 * held) long after the UI looks finished.
 */

export type DictationRecorderErrorKind =
  | "denied"
  | "no-device"
  | "insecure-context"
  | "cancelled"
  | "unknown";

export class DictationRecorderError extends Error {
  readonly kind: DictationRecorderErrorKind;

  constructor(kind: DictationRecorderErrorKind, message: string) {
    super(message);
    this.name = "DictationRecorderError";
    this.kind = kind;
  }
}

export interface DictationRecording {
  /** Ends the recording and resolves the captured audio. */
  stop(): Promise<Blob>;
  /**
   * Ends the recording and discards the audio. A `stop()` still pending
   * rejects with a `"cancelled"` error rather than hanging.
   */
  cancel(): void;
}

/**
 * Preference order: the first type an engine supports is what it records, so
 * this list decides the format per engine: webm/opus on Chromium and Android
 * WebView, mp4 on WebKit. No match falls through to the browser's own default
 * rather than failing. The gateway converts every upload with ffmpeg, which
 * probes the content, so the order is not a compatibility requirement.
 */
const MIME_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder.isTypeSupported !== "function") {
    return undefined;
  }
  return MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
}

export async function startDictationRecording(): Promise<DictationRecording> {
  // `navigator.mediaDevices` is undefined outside a secure context (plain
  // http on a LAN address), which is a different fix for the user than a
  // denied permission, so it gets its own kind.
  if (typeof navigator === "undefined" || !navigator.mediaDevices) {
    throw new DictationRecorderError(
      "insecure-context",
      "Dictation needs a secure (HTTPS or localhost) page.",
    );
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (error) {
    const name = error instanceof DOMException ? error.name : "";
    if (name === "NotAllowedError" || name === "SecurityError") {
      throw new DictationRecorderError("denied", "Microphone access was denied.");
    }
    if (name === "NotFoundError") {
      throw new DictationRecorderError("no-device", "No microphone was found.");
    }
    throw new DictationRecorderError("unknown", "The microphone couldn't be started.");
  }

  const stopTracks = () => {
    for (const track of stream.getTracks()) {
      track.stop();
    }
  };

  let recorder: MediaRecorder;
  try {
    const mimeType = pickMimeType();
    recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    recorder.start();
  } catch {
    stopTracks();
    throw new DictationRecorderError("unknown", "The microphone couldn't be started.");
  }

  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) {
      chunks.push(event.data);
    }
  };

  // A MediaRecorder `error` ends the recording on its own; the tracks are
  // released at once and any pending or later `stop()` rejects.
  let failure: DictationRecorderError | null = null;
  let rejectPending: ((error: DictationRecorderError) => void) | null = null;
  recorder.onerror = () => {
    failure = new DictationRecorderError("unknown", "The recording failed.");
    stopTracks();
    rejectPending?.(failure);
    rejectPending = null;
  };

  return {
    stop() {
      return new Promise<Blob>((resolve, reject) => {
        if (failure !== null) {
          reject(failure);
          return;
        }
        const finish = () => {
          rejectPending = null;
          stopTracks();
          resolve(new Blob(chunks, { type: recorder.mimeType }));
        };
        if (recorder.state === "inactive") {
          finish();
          return;
        }
        rejectPending = reject;
        recorder.onstop = finish;
        recorder.stop();
      });
    },
    cancel() {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
      if (recorder.state !== "inactive") {
        recorder.stop();
      }
      stopTracks();
      rejectPending?.(new DictationRecorderError("cancelled", "Dictation was cancelled."));
      rejectPending = null;
    },
  };
}
