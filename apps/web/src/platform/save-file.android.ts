import { Directory, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";

// The literal message the Share plugin's Android side rejects with when the
// user dismisses the system share sheet without picking a target
// (@capacitor/share's SharePlugin.java: `call.reject("Share canceled")`).
// That's the user changing their mind, not a failure — it must not surface
// the way a real write or share failure does (settings-page.tsx's
// handleExport toasts on any thrown error).
const SHARE_CANCELED_MESSAGE = "Share canceled";

// See save-file.web.ts's SaveFileOutcome doc comment for why this type is
// declared independently here rather than imported from a shared module:
// vite.config.ts's build alias means only one save-file.<target>.ts is ever
// compiled into a given target, and this keeps each target's file
// self-contained rather than depending on a sibling that will never ship
// alongside it.
export type SaveFileOutcome = "saved" | "cancelled";

/**
 * Android's save-file seam (ticket 48): write the zip into the app's cache
 * directory, then hand it to the system share sheet so the user can send it
 * to Files, Drive, mail, or anywhere else.
 *
 * Deliberately not a browser-style `<a download>` (save-file.web.ts's
 * approach) and not a write into shared Documents:
 * - `capacitor.config.ts` sets `androidScheme: "http"`, and Capacitor's
 *   local webserver intercepts requests in ways that make download links
 *   unreliable there — there's no `<a download>` seam to reuse on Android.
 * - A file written somewhere the user has no way to find (e.g. app-private
 *   storage with no file-manager path to it) is not an export.
 * The share sheet sidesteps both: it hands the bytes to whatever app the
 * user picks, and that app — not this one — decides where they end up.
 *
 * Sharing a cache file needs a FileProvider; `AndroidManifest.xml` already
 * declares one (`${applicationId}.fileprovider`) with a `cache-path`
 * covering the whole cache directory (`res/xml/file_paths.xml`), so no
 * manifest or provider changes are needed here.
 *
 * The cache write below always happens, even when the share sheet is about
 * to be cancelled — Share.share needs a real file to hand off, so there is
 * no way to defer writing until after the user has picked a target. That
 * cache copy is never the export from the user's point of view, though: it
 * sits in app-private storage with no Files-app path to it, and this
 * function only reports "saved" once the share sheet has actually handed
 * the bytes to somewhere the user chose. A dismissed share sheet correctly
 * reports "cancelled" even though the cache write underneath it succeeded
 * (ticket 47's defect fix — see SaveFileOutcome's doc comment above and
 * docs/adr/0016).
 */
export async function saveFile(fileName: string, bytes: Uint8Array): Promise<SaveFileOutcome> {
  // Filesystem.writeFile only accepts string data. Binary bytes must go in
  // as base64 with no `encoding` option — passing Encoding.UTF8 (or any
  // text encoding) here would have the plugin treat the zip as text and
  // corrupt it.
  await Filesystem.writeFile({
    path: fileName,
    data: toBase64(bytes),
    directory: Directory.Cache,
  });
  const { uri } = await Filesystem.getUri({ path: fileName, directory: Directory.Cache });

  try {
    await Share.share({ files: [uri], dialogTitle: "Export meologue" });
  } catch (error) {
    if (error instanceof Error && error.message === SHARE_CANCELED_MESSAGE) {
      return "cancelled";
    }
    throw error;
  }
  return "saved";
}

// Spreading a large Uint8Array straight into String.fromCharCode risks the
// engine's max-arguments limit (a zip's byte count easily exceeds it);
// chunking keeps every call well under it regardless of export size.
const CHUNK_SIZE = 0x8000;

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK_SIZE));
  }
  return btoa(binary);
}
