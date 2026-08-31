/**
 * An Entry's own rendering path (issue #148) — split out of `inlineProse`
 * (inline-prose.tsx), which every other prose surface (the Digest reader,
 * the clamped Digest card, Reflect's Question and its Answer) still calls
 * directly and unchanged.
 *
 * The split exists for a constraint only an Entry will ever have: an Entry
 * is about to gain block structure (a list), and a Digest must never get
 * it. `useFittedDigests` (digest-page.tsx) derives a card's line budget by
 * dividing `scrollHeight` by `lineHeight`, arithmetic that only means
 * anything while the measured element is one box of uniform inline lines —
 * a list inside it would not fail loudly, it would just clamp to the wrong
 * height. Giving the Entry body its own entry point now, while it still
 * delegates straight through to `inlineProse`'s walker, is what lets it
 * diverge later without putting a block anywhere near that clamp.
 *
 * `entryProse` is a pure pass-through today and nothing about its output
 * has changed from `inlineProse` — this file is the seam, not the fork.
 */
import type { ReactNode } from "react";
import { inlineProse, type ReferenceRenderers } from "@/components/inline-prose";

export function entryProse(body: string, query = "", refs: ReferenceRenderers = {}): ReactNode {
  return inlineProse(body, query, refs);
}
