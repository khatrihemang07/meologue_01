import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * load-file.android.ts is a re-export of load-file.web.ts (see its own
 * header comment for why) — this test exists to prove the re-export itself
 * is wired correctly and behaves identically through the android module
 * path, not to re-derive load-file.web.test.ts's own, more detailed
 * coverage of the underlying `<input type="file">` mechanics.
 */
describe("load-file.android", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
  });

  // See load-file.web.test.ts's own afterEach for why this is needed: a
  // spy on the same object+method is reused across tests within one file
  // unless restored, which would otherwise leave a later test's
  // `.mock.calls[0]` pointing at an earlier test's input.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is the same function load-file.web.ts exports", async () => {
    const android = await import("./load-file.android");
    const web = await import("./load-file.web");
    expect(android.loadFile).toBe(web.loadFile);
  });

  it('resolves "loaded" with the picked file when imported through the android path', async () => {
    const { loadFile } = await import("./load-file.android");
    const appendChildSpy = vi.spyOn(document.body, "appendChild");

    const promise = loadFile();
    const input = appendChildSpy.mock.calls[0]?.[0] as HTMLInputElement;
    const bytes = new Uint8Array([9, 8, 7]);
    const file = new File([bytes], "meologue-backup-20260101-000000.zip");
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new Event("change"));

    const result = await promise;
    expect(result).toEqual({
      outcome: "loaded",
      fileName: "meologue-backup-20260101-000000.zip",
      bytes,
    });
  });

  it('resolves "cancelled" through the android path when the picker is dismissed', async () => {
    const { loadFile } = await import("./load-file.android");
    const appendChildSpy = vi.spyOn(document.body, "appendChild");

    const promise = loadFile();
    const input = appendChildSpy.mock.calls[0]?.[0] as HTMLInputElement;
    input.dispatchEvent(new Event("cancel"));

    expect(await promise).toEqual({ outcome: "cancelled" });
  });
});
