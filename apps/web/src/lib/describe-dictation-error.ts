import { DictationRecorderError } from "@/lib/dictation-recorder";
import { DictationError } from "@/lib/dictation-transport";

/**
 * The one sentence a dictation failure reads as, shared by the Composer's
 * toast and Settings' Test line so a given failure is worded identically
 * wherever it surfaces (same reason `describe-server-check.ts` exists for
 * Sync). Returns `null` for an `aborted` error: the user (or an unmount)
 * cancelled it on purpose, so there is nothing to report.
 */
export function describeDictationError(error: unknown): string | null {
  if (error instanceof DictationRecorderError) {
    switch (error.kind) {
      case "denied":
        return "Microphone access was denied.";
      case "no-device":
        return "No microphone was found.";
      case "insecure-context":
        return "Dictation needs a secure (HTTPS or localhost) page.";
      case "unknown":
        return "The microphone couldn't be started.";
    }
  }
  if (error instanceof DictationError) {
    switch (error.kind) {
      case "aborted":
        return null;
      case "unreachable":
        return "Couldn't reach the dictation gateway.";
      case "unauthorized":
        return "The dictation gateway rejected the token.";
      case "timeout":
        return "Dictation took too long. Try a shorter recording.";
      case "failed":
      case "bad-response":
        return error.message;
    }
  }
  return "Dictation failed.";
}
