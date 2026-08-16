/**
 * Android's save-file seam (ticket 46): not implemented yet. A real
 * implementation needs `@capacitor/filesystem` and/or `@capacitor/share` to
 * hand the zip to the OS — out of scope here, filled in by ticket #48.
 */
export async function saveFile(_fileName: string, _bytes: Uint8Array): Promise<void> {
  throw new Error("Export isn't supported on Android yet.");
}
