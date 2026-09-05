import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";

// See load-file.web.ts's LoadFileResult doc comment for why this type is
// declared independently here rather than imported from a shared module —
// the identical reasoning save-file.macos.ts already gives for its own
// copy of SaveFileOutcome.
export type LoadFileResult =
  | { outcome: "loaded"; fileName: string; bytes: Uint8Array }
  | { outcome: "cancelled" };

/**
 * macOS's load-file seam (issue #197): a real open panel via
 * `tauri-plugin-dialog`, filtered to `.zip`, then the picked path's bytes
 * read via `tauri-plugin-fs`.
 *
 * Mirrors save-file.macos.ts's `saveFile` closely, in reverse: `open()`
 * resolves to `null` on cancel exactly like `save()` does, so there is no
 * string to match against (contrast save-file.android.ts's own
 * `SHARE_CANCELED_MESSAGE`) — a `null` result just returns "cancelled"
 * without ever calling `readFile`.
 *
 * Granting `dialog:allow-open` (not the broader `dialog:default`, which
 * also enables save and message dialogs this app never shows) plus
 * `fs:allow-read-file` (not the broader `fs:default` or `fs:read-files`,
 * which also enables listing directories and reading metadata this
 * function never needs) is capabilities/default.json's narrowest granting
 * of what this function needs — the identical discipline
 * save-file.macos.ts's own header comment already documents for
 * `dialog:allow-save`/`fs:allow-write-file`.
 */
export async function loadFile(): Promise<LoadFileResult> {
  const path = await open({
    multiple: false,
    filters: [{ name: "meologue Backup", extensions: ["zip"] }],
  });
  if (path === null) {
    return { outcome: "cancelled" };
  }
  const bytes = await readFile(path);
  // Tauri's open() returns a full filesystem path, not a bare filename —
  // split on both separators since this runs on macOS but the string
  // itself carries no guarantee about which slash a test double hands
  // back.
  const fileName = path.split(/[/\\]/).pop() ?? path;
  return { outcome: "loaded", fileName, bytes };
}
