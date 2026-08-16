/**
 * Web's save-file seam (ticket 46): a Blob plus a synthetic `<a download>`
 * click. Deliberately not `showSaveFilePicker` — it's Chromium-only, needs a
 * user-activation gesture and a permission prompt neither of which are easy
 * to drive headlessly, and this app has no need for a user-chosen path; a
 * browser's own downloads location is exactly where an export belongs.
 */
export async function saveFile(fileName: string, bytes: Uint8Array): Promise<void> {
  const blob = new Blob([bytes as BlobPart], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Deferred rather than immediate: revoking the object URL synchronously
  // after click() has raced the download actually starting in some
  // browsers. It only needs to outlive the browser reading it once.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
