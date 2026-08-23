/**
 * The keyboard chord that sends an Entry (Composer) or asks a Question
 * (Question composer) from a textarea where plain Enter must stay free to
 * insert a newline (issue #76). What counts as "the chord" is a build-time
 * decision, not a per-keystroke OS probe — ADR 0005's platform seam already
 * settles that distinction for wake signals, storage and file-saving, and
 * `import.meta.env.MODE` (set by the same `--mode` this app is built with:
 * "web", "android", "macos", or "sandbox" — see apps/web/vite.config.ts's
 * BUILD_TARGETS) is the cheapest possible instance of it here: no per-target
 * *file* is needed, just a value threaded through pure functions.
 *
 * `mode` is a parameter with `import.meta.env.MODE` as its default, rather
 * than read directly inside the function body, so every rule below is
 * testable by passing a mode string — no env stubbing, no build-time alias
 * to fake.
 */

/** The subset of a KeyboardEvent this module actually reads. */
interface SubmitChordEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
}

/**
 * True when `event`, under the given build `mode`, is the chord that sends.
 *
 * - `"android"`: never — Android has no reliable hardware-keyboard modifier
 *   to key off (most input is a soft keyboard with no Cmd/Ctrl at all), so
 *   the Send button is the only way to send, full stop.
 * - `"macos"`: Cmd+Enter only. This build is Tauri wrapping a real macOS
 *   window (docs/adr/0005), so "which OS" is a build-time fact, not a
 *   runtime guess — Cmd is the platform's actual submit modifier.
 * - anything else (`"web"`, `"sandbox"`, and vitest's own `"test"`, which
 *   deliberately falls through to this same, more permissive rule rather
 *   than getting a fourth branch): Cmd *or* Ctrl. `import.meta.env.MODE`
 *   names the build target, not the operating system underneath it — one
 *   web bundle runs on macOS, Windows and Linux alike, and there is no
 *   build-time seam narrow enough to tell those apart the way it can tell
 *   Android or a Tauri build apart. Accepting either modifier means a user
 *   pressing the "wrong" one for their OS still sends: the failure mode
 *   nobody notices (an Entry that quietly won't send) is worse than the
 *   one that gets filed as a bug (an OS probe that misfires and accepts a
 *   modifier a real user's OS doesn't have).
 *
 * Shift+Enter is never the chord, on any platform — it's the browser's own
 * "definitely a newline, not a send" gesture, and this function must not
 * fight it.
 */
export function isSubmitChord(
  event: SubmitChordEvent,
  mode: string = import.meta.env.MODE,
): boolean {
  if (event.key !== "Enter" || event.shiftKey) {
    return false;
  }
  if (mode === "android") {
    return false;
  }
  if (mode === "macos") {
    return event.metaKey;
  }
  return event.metaKey || event.ctrlKey;
}
