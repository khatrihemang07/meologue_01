import { beforeEach, describe, expect, it, vi } from "vitest";

const openMock = vi.fn(async (_options: unknown): Promise<string | null> => null);
const readFileMock = vi.fn(async (_path: string): Promise<Uint8Array> => new Uint8Array());

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: openMock,
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  readFile: readFileMock,
}));

describe("load-file.macos", () => {
  beforeEach(() => {
    vi.resetModules();
    openMock.mockClear();
    readFileMock.mockClear();
  });

  it('opens a .zip-filtered open panel, reads the picked path\'s bytes, and reports "loaded" with the bare filename', async () => {
    openMock.mockResolvedValueOnce("/Users/dev/Downloads/meologue-backup-20260101-000000.zip");
    const bytes = new Uint8Array([0, 1, 2, 255, 254, 253]);
    readFileMock.mockResolvedValueOnce(bytes);
    const { loadFile } = await import("./load-file.macos");

    const result = await loadFile();

    expect(openMock).toHaveBeenCalledWith({
      multiple: false,
      filters: [{ name: "meologue Backup", extensions: ["zip"] }],
    });
    expect(readFileMock).toHaveBeenCalledWith(
      "/Users/dev/Downloads/meologue-backup-20260101-000000.zip",
    );
    expect(result).toEqual({
      outcome: "loaded",
      fileName: "meologue-backup-20260101-000000.zip",
      bytes,
    });
  });

  it('reports "cancelled" and never reads a file when the user cancels the open panel', async () => {
    openMock.mockResolvedValueOnce(null);
    const { loadFile } = await import("./load-file.macos");

    const result = await loadFile();

    expect(result).toEqual({ outcome: "cancelled" });
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it("propagates a read failure", async () => {
    openMock.mockResolvedValueOnce("/Users/dev/Downloads/broken.zip");
    readFileMock.mockRejectedValueOnce(new Error("permission denied"));
    const { loadFile } = await import("./load-file.macos");

    await expect(loadFile()).rejects.toThrow("permission denied");
  });
});
