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
