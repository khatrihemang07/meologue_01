/**
 * The web implementation of the wake-signals seam (ticket 12): @meologue/core's
 * scheduler is DOM-free, so visibility, focus, and online state are read and
 * observed here and injected into it as `isVisible`/`subscribe`.
 */
export function isTabVisible(): boolean {
  return document.visibilityState === "visible";
}

export function subscribeToWakeEvents(wake: () => void): () => void {
  const onVisibilityChange = () => {
    if (document.visibilityState === "visible") {
      wake();
    }
  };

  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("focus", wake);
  window.addEventListener("online", wake);

  return () => {
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("focus", wake);
    window.removeEventListener("online", wake);
  };
}
