/**
 * macOS's save-file seam (ticket 46): not implemented yet. A real
 * implementation needs `tauri-plugin-fs` and/or `tauri-plugin-dialog` to
 * write the zip to disk — out of scope here, filled in by ticket #47.
 */
export async function saveFile(_fileName: string, _bytes: Uint8Array): Promise<void> {
  throw new Error("Export isn't supported on macOS yet.");
}
