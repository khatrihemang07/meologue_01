import { beforeEach, describe, expect, it, vi } from "vitest";

const saveMock = vi.fn(async (_options: { defaultPath?: string }): Promise<string | null> => null);
const writeFileMock = vi.fn(async (_path: string, _data: Uint8Array): Promise<void> => {});

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: saveMock,
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  writeFile: writeFileMock,
}));

describe("save-file.macos", () => {
  beforeEach(() => {
    vi.resetModules();
    saveMock.mockClear();
    writeFileMock.mockClear();
  });

  it('opens the save panel pre-filled with the generated filename, writes the bytes there, and reports "saved"', async () => {
    saveMock.mockResolvedValueOnce("/Users/dev/Desktop/meologue-export-20260101-000000.zip");
    const { saveFile } = await import("./save-file.macos");
    // Includes every byte value, including ones that read as UTF-8
    // continuation bytes if mishandled — the point being proven is that the
    // bytes reach writeFile unmodified, not just ASCII ones.
    const bytes = new Uint8Array([0, 1, 2, 255, 254, 253, 65, 66, 67]);

    const outcome = await saveFile("meologue-export-20260101-000000.zip", bytes);

    expect(outcome).toBe("saved");
    expect(saveMock).toHaveBeenCalledWith({
      defaultPath: "meologue-export-20260101-000000.zip",
    });
    expect(writeFileMock).toHaveBeenCalledWith(
      "/Users/dev/Desktop/meologue-export-20260101-000000.zip",
      bytes,
    );
  });

  it('reports "cancelled" and never writes when the user cancels the save panel', async () => {
    saveMock.mockResolvedValueOnce(null);
    const { saveFile } = await import("./save-file.macos");

    const outcome = await saveFile("export.zip", new Uint8Array([1]));

    // This is the assertion ticket 47's defect fix exists for: the caller
    // (settings-page.tsx's handleExport) must be able to tell "nothing was
    // written" apart from "nothing was thrown" — resolving without an error
    // used to be the entire signal, which is exactly what let a cancelled
    // export raise a false "Exported" toast.
    expect(outcome).toBe("cancelled");
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it("propagates a write failure", async () => {
    saveMock.mockResolvedValueOnce("/Users/dev/Desktop/export.zip");
    writeFileMock.mockRejectedValueOnce(new Error("disk full"));
    const { saveFile } = await import("./save-file.macos");

    await expect(saveFile("export.zip", new Uint8Array([1]))).rejects.toThrow("disk full");
  });
});
