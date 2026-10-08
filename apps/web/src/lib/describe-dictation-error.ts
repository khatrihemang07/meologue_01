import { DictationRecorderError } from "@/lib/dictation-recorder";
import { DictationError } from "@/lib/dictation-transport";

/**
 * The one sentence a dictation failure reads as, for the Composer's toast.
 * Returns `null` for an `aborted` or `cancelled` error: the user (or an
 * unmount) cancelled it on purpose, so there is nothing to report.
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
      case "cancelled":
        return null;
      case "unknown":
        return "The microphone couldn't be started.";
    }
  }
  if (error instanceof DictationError) {
    switch (error.kind) {
      case "aborted":
        return null;
      case "unreachable":
        return "Couldn't reach the Server.";
      case "unavailable":
        return "Dictation is turned off on the Server.";
      case "gateway-unreachable":
        return "The Server couldn't reach the dictation gateway.";
      case "gateway-rejected":
        return "The Server's dictation token was rejected by the gateway.";
      case "timeout":
        return "Dictation took too long. Try a shorter recording.";
      case "failed":
      case "bad-response":
        return error.message;
    }
  }
  return "Dictation failed.";
}
