/**
 * Microphone capture for Composer dictation (issue #454). A thin wrapper
 * over `getUserMedia` + `MediaRecorder` that owns the one thing callers must
 * not get wrong: every track is stopped on every exit path, because a live
 * track keeps the OS microphone indicator on (and on Android keeps the mic
 * held) long after the UI looks finished.
 */

export type DictationRecorderErrorKind = "denied" | "no-device" | "insecure-context" | "unknown";

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
  /** Ends the recording and discards the audio. */
  cancel(): void;
}

/**
 * Preference order: Opus-in-WebM is what Chromium and Firefox record; mp4 is
 * what Safari/WKWebView records; no match falls through to the browser's own
 * default rather than failing on an engine that supports none of these by
 * name. The gateway accepts any container, so the order is a preference for
 * small files, not a compatibility requirement.
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

  return {
    stop() {
      return new Promise<Blob>((resolve) => {
        const finish = () => {
          stopTracks();
          resolve(new Blob(chunks, { type: recorder.mimeType }));
        };
        if (recorder.state === "inactive") {
          finish();
          return;
        }
        recorder.onstop = finish;
        recorder.stop();
      });
    },
    cancel() {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      if (recorder.state !== "inactive") {
        recorder.stop();
      }
      stopTracks();
    },
  };
}
