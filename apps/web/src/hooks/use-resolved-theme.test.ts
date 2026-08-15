import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useResolvedTheme } from "./use-resolved-theme";

describe("useResolvedTheme", () => {
  beforeEach(() => {
    document.documentElement.classList.remove("dark");
  });

  afterEach(() => {
    document.documentElement.classList.remove("dark");
  });

  it("reads the current class on mount", () => {
    document.documentElement.classList.add("dark");

    const { result } = renderHook(() => useResolvedTheme());

    expect(result.current).toBe("dark");
  });

  it("defaults to light when the dark class isn't present", () => {
    const { result } = renderHook(() => useResolvedTheme());

    expect(result.current).toBe("light");
  });

  it("follows the dark class being added after mount", async () => {
    const { result } = renderHook(() => useResolvedTheme());
    expect(result.current).toBe("light");

    await act(async () => {
      document.documentElement.classList.add("dark");
      await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
    });

    expect(result.current).toBe("dark");
  });

  it("follows the dark class being removed after mount", async () => {
    document.documentElement.classList.add("dark");
    const { result } = renderHook(() => useResolvedTheme());
    expect(result.current).toBe("dark");

    await act(async () => {
      document.documentElement.classList.remove("dark");
      await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
    });

    expect(result.current).toBe("light");
  });
});
