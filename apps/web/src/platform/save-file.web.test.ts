import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("save-file.web", () => {
  const createObjectURLMock = vi.fn(() => "blob:mock-url");
  const revokeObjectURLMock = vi.fn();
  // jsdom has no real download surface: an anchor's default `click()` action
  // logs "Not implemented: navigation to another Document" because jsdom
  // tries to follow it as a same-document navigation. Stubbing `click`
  // itself (rather than letting jsdom run it) is what lets this test prove
  // the anchor was clicked without depending on jsdom's incomplete
  // navigation support.
  const clickMock = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    createObjectURLMock.mockClear();
    revokeObjectURLMock.mockClear();
    clickMock.mockClear();
    // Spying on the static methods (rather than replacing the `URL` global
    // wholesale) keeps `URL` a real constructor — jsdom's own anchor.href
    // handling calls `new URL(...)` internally, and a plain stub object
    // breaks that.
    vi.spyOn(URL, "createObjectURL").mockImplementation(createObjectURLMock);
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(revokeObjectURLMock);
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(clickMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('always reports "saved": a download click gives the browser no cancellation signal to relay', async () => {
    const { saveFile } = await import("./save-file.web");
    const appendChildSpy = vi.spyOn(document.body, "appendChild");

    const outcome = await saveFile(
      "meologue-export-20260101-000000.zip",
      new Uint8Array([1, 2, 3]),
    );

    expect(outcome).toBe("saved");
    expect(clickMock).toHaveBeenCalledTimes(1);
    const anchor = appendChildSpy.mock.calls[0]?.[0] as HTMLAnchorElement;
    expect(anchor.download).toBe("meologue-export-20260101-000000.zip");
    expect(anchor.href).toBe("blob:mock-url");
    expect(createObjectURLMock).toHaveBeenCalledTimes(1);
  });

  it("revokes the object URL after the click, not before", async () => {
    vi.useFakeTimers();
    const { saveFile } = await import("./save-file.web");

    await saveFile("export.zip", new Uint8Array([1]));
    expect(revokeObjectURLMock).not.toHaveBeenCalled();

    vi.runAllTimers();

    expect(revokeObjectURLMock).toHaveBeenCalledWith("blob:mock-url");
    vi.useRealTimers();
  });
});
