/**
 * What pressing Send (or the submit chord) should DO, decided as one pure
 * function rather than inline in composer.tsx's event handler — issue #155
 * introduces a rule composer.tsx's old `send()` never needed: committing an
 * edit that never actually changed anything must not happen at all (see
 * this module's own `dirty` parameter, and ADR 0044's "dirty-only commits").
 *
 * Pulled out into its own module for the same reason composer-picker.ts
 * was: it is pure, and composer.tsx's own body — a ProseMirror
 * `contenteditable` — cannot be driven in a vitest/jsdom test (see
 * composer.tsx's module comment). Testing this decision directly, against
 * plain inputs, is what keeps "an unchanged edit commits nothing" and "a
 * whitespace-only draft never sends" covered by a fast unit test rather
 * than resting entirely on Playwright.
 */
import { normalizeEntryBody } from "@/lib/entry-text";

export type SendDecision =
  /** A brand-new Entry, going through `onSend`. */
  | { kind: "send"; body: string }
  /** An edit that actually changed the document, going through `onCommitEdit`. */
  | { kind: "commit"; id: string; body: string }
  /**
   * An edit that never changed anything — ADR 0044's dirty-only commit rule.
   * Treated exactly like Cancel rather than as a no-op Send: both leave edit
   * mode without writing, and reusing the same exit path (rather than a
   * third, parallel "silently do nothing" branch) is what guarantees the
   * pre-edit draft restore composer.tsx's `onCancelEdit` already runs is the
   * ONLY restore path, never duplicated.
   */
  | { kind: "cancelUnchanged" }
  /** Whitespace-only, on either a new Entry or an edit — refused exactly like before ADR 0044, unconditionally on `dirty`. */
  | { kind: "refuseEmpty" };

/**
 * `rawBody` is the document's current serialized text (`entryDocumentToMarkdown`
 * of whatever is in the editor right now) — untrimmed, since a brand-new
 * Entry's own Send has always forwarded the untrimmed value onward
 * (`sendEntry`, use-history.ts, normalizes again itself; see composer.tsx's
 * previous `send()` for the rule this preserves).
 *
 * `dirty` is whatever composer.tsx's ProseMirror `dispatchTransaction`
 * observed: true the moment any transaction since entering edit mode (or
 * since the last commit/cancel) actually changed the document
 * (`transaction.docChanged`), reset to false whenever a fresh Entry starts
 * — either a brand-new draft or a newly seeded edit. It is meaningless
 * outside edit mode (`editingEntryId === null`) and this function never
 * reads it there, on purpose: a brand-new Entry with content in it is
 * always "dirty" by construction — there was nothing to compare it to — so
 * this decision would be the same either way; requiring a caller to reason
 * about `dirty` for the non-editing case would be a second thing to get
 * right for no behavioural difference.
 */
export function decideSend(params: {
  editingEntryId: string | null;
  rawBody: string;
  dirty: boolean;
}): SendDecision {
  const { editingEntryId, rawBody, dirty } = params;
  const body = normalizeEntryBody(rawBody);
  if (body === null) {
    return { kind: "refuseEmpty" };
  }
  if (editingEntryId !== null) {
    if (!dirty) {
      return { kind: "cancelUnchanged" };
    }
    return { kind: "commit", id: editingEntryId, body };
  }
  return { kind: "send", body: rawBody };
}
