export interface ContinuousSyncOptions {
  /** Performs one sync attempt (push + pull). */
  run: () => Promise<void>;
  /** How often to poll while visible. */
  intervalMs: number;
  /**
   * Whether the app is currently in the foreground. Injected so this stays
   * free of DOM concerns (visibility lives in the platform shell) — an
   * interval tick is skipped entirely while this returns false.
   */
  isVisible: () => boolean;
  /**
   * Injected by the caller: invoke the given `wake` callback whenever the
   * app should sync right away rather than wait for the next interval tick
   * (e.g. the tab regains focus or the browser comes back online). Returns
   * an unsubscribe function.
   */
  subscribe: (wake: () => void) => () => void;
}

export interface ContinuousSyncHandle {
  stop: () => void;
}

/**
 * Starts polling `run` on an interval, plus immediately and on every wake
 * signal — but only while `isVisible`, and never overlapping a run still in
 * flight.
 */
export function startContinuousSync(options: ContinuousSyncOptions): ContinuousSyncHandle {
  const { run, intervalMs, isVisible, subscribe } = options;

  let inFlight = false;
  let stopped = false;
  const attempt = () => {
    if (stopped || !isVisible() || inFlight) {
      return;
    }
    inFlight = true;
    void run().finally(() => {
      inFlight = false;
    });
  };

  const timer = setInterval(attempt, intervalMs);
  const unsubscribe = subscribe(attempt);
  attempt();

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
      unsubscribe();
    },
  };
}
