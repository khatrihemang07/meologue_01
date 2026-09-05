import { describe, expect, it } from "vitest";
import { describeSemanticRetrievalGap, describeServerCheck } from "./describe-server-check";

function capable(
  overrides: Partial<Record<"reflect" | "digest" | "embeddings" | "todo", boolean>>,
) {
  return { reflect: true, digest: true, embeddings: true, todo: true, ...overrides };
}

describe("describeSemanticRetrievalGap", () => {
  it("names the gap when Reflect is live but embeddings are not", () => {
    expect(describeSemanticRetrievalGap(true, false)).toMatch(/semantic retrieval/i);
  });

  it("says nothing when both are live", () => {
    expect(describeSemanticRetrievalGap(true, true)).toBeNull();
  });

  it("says nothing when Reflect itself isn't live — that's a bigger gap, named elsewhere", () => {
    expect(describeSemanticRetrievalGap(false, false)).toBeNull();
  });
});

describe("describeServerCheck", () => {
  function ok(capabilities?: unknown) {
    return { ok: true as const, protocolVersion: 5, capabilities: capabilities as never };
  }

  it("reads as a plain 'Reachable' when every capability is live", () => {
    expect(describeServerCheck(ok(capable({})))).toBe(
      "Reachable — this server is up and speaking the protocol this app expects.",
    );
  });

  it("still names a missing Digest model exactly as before this ticket", () => {
    const message = describeServerCheck(ok(capable({ digest: false })));
    expect(message).toBe("Reachable — but this server has no Digest model configured.");
  });

  // Issue #203's own acceptance criterion: Reflection running with no
  // semantic retrieval behind it must be visible, appended as its own
  // sentence rather than folded into the "no ... model configured" one
  // (which means the feature cannot run at all — this one still can).
  it("names the semantic-retrieval gap when Reflect is live but embeddings are off", () => {
    const message = describeServerCheck(ok(capable({ embeddings: false })));
    expect(message).toMatch(/^Reachable —/);
    expect(message).toMatch(/semantic retrieval/i);
    expect(message).not.toMatch(/no .* model configured/i);
  });

  it("combines both notes when Digest is missing and embeddings are also off", () => {
    const message = describeServerCheck(ok(capable({ digest: false, embeddings: false })));
    expect(message).toMatch(/no digest model configured/i);
    expect(message).toMatch(/semantic retrieval/i);
  });
});
