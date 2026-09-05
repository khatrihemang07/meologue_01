/**
 * Outcome of a loadFile call (issue #197): "loaded" only when the user
 * actually picked a file and its bytes were read; "cancelled" when they
 * backed out with nothing picked. There's no shared `@/platform` types
 * module, so this type is declared identically in each
 * load-file.<target>.ts — the same convention save-file.web.ts's own
 * `SaveFileOutcome` doc comment already explains for the save side:
 * vite.config.ts's build alias means only one of the three (four, counting
 * sandbox) target files is ever compiled into a given target, so nothing
 * enforces the copies stay in sync but each file's own
 * load-file.*.test.ts asserting the literal shape. Cancellation is a
 * first-class outcome here for the identical reason ADR 0016 made it one
 * on the save side: a picker the user dismissed must never look like a
 * thrown error to the caller (settings-page.tsx's Restore flow).
 */
export type LoadFileResult =
  | { outcome: "loaded"; fileName: string; bytes: Uint8Array }
  | { outcome: "cancelled" };

/**
 * Web's load-file seam (issue #197): a programmatically-created
 * `<input type="file" accept=".zip">`, clicked, and read once the user
 * picks something.
 *
 * Cancellation is a real event here, unlike save-file.web.ts's `<a
 * download>` (which has no cancellation signal to relay at all): the
 * `cancel` event fires on a file input when the user dismisses the picker
 * with nothing chosen, in every browser this app currently ships to
 * (Chromium since 2021, and the other major engines since). That's what
 * lets loadFile report `{ outcome: "cancelled" }` rather than resolving
 * from `change` alone and hanging forever when the user backs out — the
 * same "cancellation must be a first-class outcome, never a hang or a
 * thrown error" posture ADR 0016 already established for the save side.
 *
 * The input is appended to the document before `click()` and removed
 * again once it has resolved either way — mirroring save-file.web.ts's
 * identical treatment of its synthetic anchor, and for the same practical
 * reason: some engines are more reliable dispatching a user-agent picker
 * from an element that's actually in the tree.
 */
export async function loadFile(): Promise<LoadFileResult> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".zip";

    function cleanup() {
      input.removeEventListener("change", onChange);
      input.removeEventListener("cancel", onCancel);
      input.remove();
    }

    async function onChange() {
      const file = input.files?.[0];
      cleanup();
      if (file === undefined) {
        // Belt-and-braces: a `change` event with no file selected
        // shouldn't happen for a single, non-multiple file input, but
        // resolving "cancelled" here is the honest read of "nothing was
        // picked" rather than throwing on a shape this input never
        // actually produces.
        resolve({ outcome: "cancelled" });
        return;
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      resolve({ outcome: "loaded", fileName: file.name, bytes });
    }

    function onCancel() {
      cleanup();
      resolve({ outcome: "cancelled" });
    }

    input.addEventListener("change", onChange);
    input.addEventListener("cancel", onCancel);
    document.body.appendChild(input);
    input.click();
  });
}
