import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("load-file.web", () => {
  // No type annotation: matching save-file.web.test.ts's own `const
  // clickMock = vi.fn()` call-site inference exactly, rather than
  // `ReturnType<typeof vi.fn>`, which resolves to a broader overload that
  // `.mockImplementation()` then rejects as not assignable to `() => void`.
  let clickMock = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    clickMock = vi.fn();
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(clickMock);
  });

  // Without this, vi.spyOn(document.body, "appendChild") in a later test
  // would reuse the still-installed spy from an earlier one (vitest spies
  // on the same object+method only once), leaving `.mock.calls[0]` pointing
  // at a previous test's input rather than this test's own.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates a file input accepting .zip, clicks it, and resolves "loaded" with the picked file\'s name and bytes', async () => {
    const { loadFile } = await import("./load-file.web");
    const appendChildSpy = vi.spyOn(document.body, "appendChild");

    const promise = loadFile();
    const input = appendChildSpy.mock.calls[0]?.[0] as HTMLInputElement;
    expect(input.type).toBe("file");
    expect(input.accept).toBe(".zip");
    expect(clickMock).toHaveBeenCalledTimes(1);

    const bytes = new Uint8Array([1, 2, 3, 4]);
    const file = new File([bytes], "meologue-backup-20260101-000000.zip");
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new Event("change"));

    const result = await promise;
    expect(result.outcome).toBe("loaded");
    if (result.outcome !== "loaded") {
      return;
    }
    expect(result.fileName).toBe("meologue-backup-20260101-000000.zip");
    expect(Array.from(result.bytes)).toEqual([1, 2, 3, 4]);
  });

  it('resolves "cancelled" when the input fires a cancel event, never hanging', async () => {
    const { loadFile } = await import("./load-file.web");
    const appendChildSpy = vi.spyOn(document.body, "appendChild");

    const promise = loadFile();
    const input = appendChildSpy.mock.calls[0]?.[0] as HTMLInputElement;
    input.dispatchEvent(new Event("cancel"));

    const result = await promise;
    expect(result).toEqual({ outcome: "cancelled" });
  });

  it("removes the input from the document once it resolves, either way", async () => {
    const { loadFile } = await import("./load-file.web");
    const appendChildSpy = vi.spyOn(document.body, "appendChild");

    const promise = loadFile();
    const input = appendChildSpy.mock.calls[0]?.[0] as HTMLInputElement;
    const removeSpy = vi.spyOn(input, "remove");
    input.dispatchEvent(new Event("cancel"));
    await promise;

    expect(removeSpy).toHaveBeenCalledTimes(1);
  });
});
