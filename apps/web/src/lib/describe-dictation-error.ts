import { DictationRecorderError } from "@/lib/dictation-recorder";
import { DictationError, type GatewayHealth } from "@/lib/dictation-transport";

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

/**
 * Settings' Test line for a gateway that answered `/v1/health`. `degraded`
 * and `down` describe OpenWhispr behind the gateway, not the gateway
 * itself, which is why both still start "Connected": the address and token
 * are right, and the fix lives elsewhere.
 */
export function describeGatewayHealth(health: GatewayHealth): string {
  const { openwhispr, status } = health;
  const version = openwhispr.version ?? "unknown version";
  if (status === "ok") {
    return `Connected — OpenWhispr ${version}`;
  }
  if (!openwhispr.reachable) {
    return "Connected, but degraded: the gateway can't reach OpenWhispr.";
  }
  if (openwhispr.verifiedVersion !== null && openwhispr.version !== openwhispr.verifiedVersion) {
    return `Connected, but degraded: OpenWhispr ${version} hasn't been verified (the gateway expects ${openwhispr.verifiedVersion}).`;
  }
  return `Connected, but ${status}: OpenWhispr ${version} isn't healthy.`;
}
