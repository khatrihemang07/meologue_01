import { useEffect, useRef } from "react";

// A private, minimal copy of a slice of `@/lib/todo-keymap`'s own
// `isTypingTarget` (same input-type exclusions, same three element
// checks) — not that function reused. `todo-keymap.ts` is a big table
// (`TODO_KEY_BINDINGS`, every hint `todo-keyboard-shortcuts-overlay.tsx`
// renders) that only `todo-page.tsx` has ever needed; importing even one
// function from it here would pull the whole module into whichever chunk
// this one ends up in. `todo-keymap.test.tsx`/`use-todo-keymap.test.tsx`
// already cover the real logic this mirrors.
const NON_TYPING_INPUT_TYPES = new Set([
  "checkbox",
  "radio",
  "button",
  "submit",
  "reset",
  "file",
  "image",
  "color",
  "range",
]);

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  if (target.tagName === "TEXTAREA") {
    return true;
  }
  if (target.tagName === "INPUT") {
    const type = (target.getAttribute("type") ?? "text").toLowerCase();
    return !NON_TYPING_INPUT_TYPES.has(type);
  }
  return false;
}

/**
 * The `Z`/`⌘Z` undo binding (CMT-05), reachable outside Todo too (issue
 * #355). Todo's own copy lives in the full `TODO_KEY_BINDINGS` table
 * (`@/lib/todo-keymap`) because that table is also what
 * `todo-keyboard-shortcuts-overlay.tsx` renders its "Z or ⌘Z | Undo" hint
 * from — `todo-page.tsx` keeps using it unchanged, wiring its
 * `onUndoComplete` option straight to a `useCompletionToast`
 * (`use-completion-toast.tsx`) instance's own `fireUndo`. The Composer's
 * Task overlay has no such table, and no shortcuts overlay of its own to
 * keep in sync with one, so `composer-page.tsx` mounts this instead: a
 * standalone chord match (`isTypingTarget` above; the chord check below is
 * a narrower, two-key special case of `chordFor`'s own `mod+`/`shift+`
 * composition, not that general formatter) reaching the identical
 * `fireUndo` a `useCompletionToast` instance already exposes.
 *
 * Deliberately its own module, not folded into `use-completion-toast.tsx`
 * alongside the hook it calls into: `todo-page.tsx` never needs this half
 * (its own `Z`/`⌘Z` reachability already comes from `TODO_KEY_BINDINGS`
 * above), and Vite's own automatic chunking groups a module with whichever
 * other modules share its exact set of importers — folding this in there
 * would have put it in the one chunk `use-completion-toast.tsx` itself
 * lands in, which `todo-page.tsx` also depends on for the half it *does*
 * need, paying for code it never calls. Keeping this the one and only
 * thing `composer-page.tsx` alone imports from here keeps it out of
 * `todo-page.tsx`'s own bundle entirely.
 */
export function useCompletionUndoShortcut(fireUndo: () => void): void {
  const fireUndoRef = useRef(fireUndo);
  fireUndoRef.current = fireUndo;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.altKey || event.shiftKey || isTypingTarget(event.target)) {
        return;
      }
      if (event.key.toLowerCase() === "z") {
        event.preventDefault();
        fireUndoRef.current();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
}
