import { afterEach, describe, expect, it, vi } from "vitest";
import { hoverCapable } from "./pointer";

/** Same stand-in as entry-row.test.tsx's — see its own comment. */
function stubHoverCapable(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({ matches, media: query })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("hoverCapable", () => {
  it("reflects matchMedia('(hover: hover)')", () => {
    stubHoverCapable(true);
    expect(hoverCapable()).toBe(true);

    stubHoverCapable(false);
    expect(hoverCapable()).toBe(false);
  });

  it("reads false when matchMedia isn't available at all", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(hoverCapable()).toBe(false);
  });
});
