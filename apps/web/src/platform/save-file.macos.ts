import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";

// See save-file.web.ts's SaveFileOutcome doc comment for why this type is
// declared independently here rather than imported from a shared module:
// vite.config.ts's build alias means only one save-file.<target>.ts is ever
// compiled into a given target, and this keeps each target's file
// self-contained rather than depending on a sibling that will never ship
// alongside it.
export type SaveFileOutcome = "saved" | "cancelled";

/**
 * macOS's save-file seam (ticket 47): a real save panel via
 * `tauri-plugin-dialog`, pre-filled with the generated filename, then the
 * bytes written to whatever path the user picked via `tauri-plugin-fs`.
 *
 * Deliberately not save-file.web.ts's `<a download>` (there is no browser
 * download surface in a WKWebView) nor save-file.android.ts's write-then-share
 * (macOS has no share-sheet equivalent, and a native save panel is exactly
 * the "user picks a path" UI Android's share sheet exists to work around not
 * having).
 *
 * Cancellation reads differently here than on Android: `save()` resolves to
 * `null` rather than throwing, so there is no string to match against
 * (contrast `save-file.android.ts`'s SHARE_CANCELED_MESSAGE) — a `null`
 * result just returns "cancelled" without ever calling `writeFile`. Reported
 * outcome, not just resolving quietly (that was the defect: settings-page.tsx
 * used to toast a success message on cancel too, because it had no way to
 * tell "nothing thrown" apart from "something was actually written" — see
 * SaveFileOutcome's doc comment in save-file.web.ts and docs/adr/0016).
 *
 * Granting `dialog:allow-save` (not the broader `dialog:default`, which also
 * enables open and message dialogs this app never shows) plus
 * `fs:allow-write-file` (not the broader `fs:default` read-oriented set, or
 * `fs:write-files`, which also enables create/copy/remove/rename/truncate)
 * is capabilities/default.json's narrowest granting of what this function
 * needs.
 */
export async function saveFile(fileName: string, bytes: Uint8Array): Promise<SaveFileOutcome> {
  const path = await save({ defaultPath: fileName });
  if (path === null) {
    return "cancelled";
  }
  await writeFile(path, bytes);
  return "saved";
}
