import { useSettingsStore } from "@/lib/settings";

/**
 * One request to the configured Server, with the two things every transport
 * in this app was repeating around it removed: reading the Server URL, and
 * turning a network failure into a value instead of a thrown Error.
 *
 * Returning `null` for "never got a response" rather than a named reason is
 * deliberate. The four transports do NOT agree on what a status *means* —
 * a 404 from `/v1/reflect` means this Server predates Reflection, from
 * `/v1/sessions/{id}` it means the Session is gone (ordinary, not
 * exceptional — ADR 0025), and from `/v1/sessions` it means neither and
 * collapses into the catch-all. That disagreement is real domain knowledge
 * and belongs with each endpoint, so this helper deliberately stops short
 * of interpreting the response and hands the whole thing back.
 *
 * The Server URL is read per call, never hoisted: a URL saved in Settings
 * between two requests takes effect on the very next one, with no reload
 * (ADR 0011).
 */
export async function serverRequest(path: string, init?: RequestInit): Promise<Response | null> {
  const url = useSettingsStore.getState().serverUrl;
  const target = `${url}${path}`;
  try {
    // `init` is forwarded only when there is one, so a GET reaches `fetch`
    // as `fetch(url)` exactly as it did before this helper existed. Passing
    // an explicit `undefined` behaves identically at runtime, but it makes
    // every test that asserts on the request shape have to know a wrapper
    // sits in the way — which is the opposite of what extracting this was
    // for.
    return init ? await fetch(target, init) : await fetch(target);
  } catch (error) {
    // Same reasoning as `reflect-transport.ts`'s own read-loop `catch`: a
    // caller-initiated abort is routine and not worth logging, but
    // anything else here — DNS failure, connection refused, TLS error —
    // used to vanish with no trace at all, indistinguishable from a
    // deliberate unmount without live device instrumentation.
    if (init?.signal?.aborted !== true) {
      console.error("serverRequest: fetch failed", target, error);
    }
    return null;
  }
}
