import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mintId } from "./id";

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("mintId", () => {
  it("mints a well-formed uuidv7", () => {
    expect(mintId()).toMatch(UUID_V7_PATTERN);
  });

  it("mints a different id on every call", () => {
    expect(mintId()).not.toBe(mintId());
  });

  describe("with the system clock under control", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("orders ids minted a millisecond apart ascending", () => {
      vi.setSystemTime(1_700_000_000_000);
      const earlier = mintId();
      vi.setSystemTime(1_700_000_000_001);
      const later = mintId();

      expect(earlier < later).toBe(true);
    });

    it("carries a millisecond-timestamp prefix", () => {
      const now = 1_700_000_000_000;
      vi.setSystemTime(now);
      const id = mintId();

      const timestampHex = id.replace(/-/g, "").slice(0, 12);
      expect(BigInt(`0x${timestampHex}`)).toBe(BigInt(now));
    });
  });
});
