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
 *
 * Issue #133: every one of the four transports built on this (Reflect,
 * Digest, Sessions, Models) already funnels through here, which makes this
 * the one place that can learn Server reachability from a real request
 * without duplicating the write in each of them. A response of any status
 * — even a 404 or a 500 — means the Server answered, so it marks
 * `serverReachable: true`; only a thrown `fetch` (this function's own
 * `catch` below) marks it `false`. A caller-initiated abort is excluded
 * from both, same as the existing `console.error` guard: the request was
 * withdrawn, not failed, so it says nothing about whether the Server is
 * actually reachable.
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
    const response = init ? await fetch(target, init) : await fetch(target);
    useSettingsStore.getState().setServerReachable(true);
    return response;
  } catch (error) {
    // Same reasoning as `reflect-transport.ts`'s own read-loop `catch`: a
    // caller-initiated abort is routine and not worth logging, but
    // anything else here — DNS failure, connection refused, TLS error —
    // used to vanish with no trace at all, indistinguishable from a
    // deliberate unmount without live device instrumentation.
    if (init?.signal?.aborted !== true) {
      console.error("serverRequest: fetch failed", target, error);
      useSettingsStore.getState().setServerReachable(false);
    }
    return null;
  }
}
