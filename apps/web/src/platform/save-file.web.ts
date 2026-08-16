/**
 * Outcome of a saveFile call (ticket 47's defect fix): "saved" only when
 * bytes actually landed somewhere the user can find them again; "cancelled"
 * when the user backed out with nothing written. There's no shared
 * `@/platform` types module, so this type is declared identically in each
 * save-file.<target>.ts — vite.config.ts's build alias means only one of
 * the three is ever compiled into a given target, so nothing enforces the
 * three stay in sync but each file's own save-file.*.test.ts asserting the
 * literal return values. Callers (settings-page.tsx's handleExport) must
 * toast success on "saved" and stay silent on "cancelled" — see
 * docs/adr/0016.
 */
export type SaveFileOutcome = "saved" | "cancelled";

/**
 * Web's save-file seam (ticket 46): a Blob plus a synthetic `<a download>`
 * click. Deliberately not `showSaveFilePicker` — it's Chromium-only, needs a
 * user-activation gesture and a permission prompt neither of which are easy
 * to drive headlessly, and this app has no need for a user-chosen path; a
 * browser's own downloads location is exactly where an export belongs.
 *
 * Always reports "saved". Unlike a native save panel (save-file.macos.ts)
 * or share sheet (save-file.android.ts), a browser download gives the page
 * no cancellation signal at all — once `click()` fires, `<a download>`
 * either starts a download or the browser silently blocks it (e.g. a
 * popup-blocker-style download guard), and JavaScript can't tell which
 * happened. That's a real asymmetry between the platforms, not an
 * oversight: the web build simply has nothing truthful to report besides
 * "the click was dispatched."
 */
export async function saveFile(fileName: string, bytes: Uint8Array): Promise<SaveFileOutcome> {
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
  return "saved";
}
