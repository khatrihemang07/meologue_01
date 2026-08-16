import { beforeEach, describe, expect, it, vi } from "vitest";

const writeFileMock = vi.fn(
  async (_options: { path: string; data: string; directory: string }) => ({
    uri: "file:///cache/unused",
  }),
);
const getUriMock = vi.fn(async ({ path }: { path: string }) => ({
  uri: `file:///cache/${path}`,
}));
const shareMock = vi.fn(async () => ({ activityType: "" }));

vi.mock("@capacitor/filesystem", () => ({
  Directory: { Cache: "CACHE" },
  Filesystem: {
    writeFile: writeFileMock,
    getUri: getUriMock,
  },
}));

vi.mock("@capacitor/share", () => ({
  Share: {
    share: shareMock,
  },
}));

describe("save-file.android", () => {
  beforeEach(() => {
    vi.resetModules();
    writeFileMock.mockClear();
    getUriMock.mockClear();
    shareMock.mockClear();
  });

  it('writes the zip to the cache directory as base64, shares its file:// URI, and reports "saved"', async () => {
    const { saveFile } = await import("./save-file.android");
    // Includes every byte value, including ones that read as UTF-8
    // continuation bytes if mishandled — the point being proven is that the
    // bytes survive base64 round-tripping unmodified, not just ASCII ones.
    const bytes = new Uint8Array([0, 1, 2, 255, 254, 253, 65, 66, 67]);

    const outcome = await saveFile("meologue-export-20260101-000000.zip", bytes);

    expect(outcome).toBe("saved");
    expect(writeFileMock).toHaveBeenCalledWith({
      path: "meologue-export-20260101-000000.zip",
      data: base64Encode(bytes),
      directory: "CACHE",
    });
    // No `encoding` option: Filesystem.writeFile treats data as binary
    // (decoding it from base64) only when `encoding` is omitted entirely.
    expect(writeFileMock.mock.calls[0]?.[0]).not.toHaveProperty("encoding");

    expect(getUriMock).toHaveBeenCalledWith({
      path: "meologue-export-20260101-000000.zip",
      directory: "CACHE",
    });
    expect(shareMock).toHaveBeenCalledWith({
      files: ["file:///cache/meologue-export-20260101-000000.zip"],
      dialogTitle: "Export meologue",
    });
  });

  it('reports "cancelled", not "saved", when the user dismisses the share sheet', async () => {
    shareMock.mockRejectedValueOnce(new Error("Share canceled"));
    const { saveFile } = await import("./save-file.android");

    const outcome = await saveFile("export.zip", new Uint8Array([1]));

    // This is the assertion ticket 47's defect fix exists for: resolving
    // without throwing used to be the entire signal the caller
    // (settings-page.tsx's handleExport) had, which is exactly what let a
    // dismissed share sheet raise a false "Exported" toast.
    expect(outcome).toBe("cancelled");
  });

  it("still writes the cache copy Share.share needs even when the user goes on to cancel", async () => {
    // Share.share requires a real file to hand off, so the cache write
    // below always happens before the user ever sees the share sheet — it
    // is not itself "the export" (it sits in app-private storage no
    // file-manager can reach) and cancelling afterwards is correctly
    // reported as "cancelled" regardless.
    shareMock.mockRejectedValueOnce(new Error("Share canceled"));
    const { saveFile } = await import("./save-file.android");

    await saveFile("export.zip", new Uint8Array([1]));

    expect(writeFileMock).toHaveBeenCalledTimes(1);
    expect(shareMock).toHaveBeenCalledTimes(1);
  });

  it("propagates a real share failure instead of swallowing it", async () => {
    shareMock.mockRejectedValueOnce(new Error("No app can handle this share"));
    const { saveFile } = await import("./save-file.android");

    await expect(saveFile("export.zip", new Uint8Array([1]))).rejects.toThrow(
      "No app can handle this share",
    );
  });

  it("propagates a write failure without ever reaching Share", async () => {
    writeFileMock.mockRejectedValueOnce(new Error("disk full"));
    const { saveFile } = await import("./save-file.android");

    await expect(saveFile("export.zip", new Uint8Array([1]))).rejects.toThrow("disk full");
    expect(shareMock).not.toHaveBeenCalled();
  });
});

/** Reference encoder the test uses to assert against — deliberately independent of save-file.android.ts's own chunked implementation. */
function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
