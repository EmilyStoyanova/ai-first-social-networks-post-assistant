/**
 * The decision behind `usePostsLiveRefresh` — when a browser signal (a timer
 * tick, the tab becoming visible or hidden, the window gaining focus) should
 * actually trigger a refresh — pulled out as a pure function of state and
 * event so it is testable without a DOM, a browser, or a React renderer. This
 * repo has none of the three (no React Testing Library), which is exactly why
 * every other piece of scheduling logic here — `bulk-schedule.ts`,
 * `time-slots.ts` — is a plain module with a thin UI wrapper; this follows the
 * same shape.
 *
 * The hook (`use-posts-live-refresh.ts`) is that thin wrapper: it owns the
 * real `setTimeout`, the real `document`/`window` listeners, and calling the
 * caller's `refresh`. Everything about WHETHER to refresh lives here instead.
 */

/** How the caller learned something might have changed. */
export type LiveRefreshEvent =
  /** The armed timer fired — the ordinary 30-second heartbeat. */
  | { type: "tick" }
  /** `document.visibilityState` became `"visible"`. */
  | { type: "visible" }
  /** `document.visibilityState` became `"hidden"`. */
  | { type: "hidden" }
  /** The window gained focus. */
  | { type: "focus" };

export interface LiveRefreshConfig {
  /** How long a periodic tick waits. Only read by the hook's own arming logic;
   *  kept here too so the debounce below can be reasoned about against it. */
  intervalMs: number;
  /**
   * The shortest gap allowed between two refreshes both caused by "the user
   * is looking again" — `visible` and `focus` reliably fire together when
   * switching back to a tab inside one window, and this is what keeps that
   * pair from becoming two requests.
   */
  debounceMs: number;
}

export interface LiveRefreshState {
  /** `now` (ms) of the last refresh this reducer decided on, or null before the first. */
  lastRunAt: number | null;
  /** Mirrors `document.visibilityState === "visible"`, tracked so a stray
   *  `focus` arriving for a tab that is not the active one is not trusted. */
  visible: boolean;
}

export interface LiveRefreshDecision {
  /** The state to carry into the next event. */
  state: LiveRefreshState;
  /** Whether THIS event should cause the caller to refresh right now. */
  refresh: boolean;
}

/** The state a freshly mounted scheduler starts from. */
export function initialLiveRefreshState(visible: boolean): LiveRefreshState {
  return { lastRunAt: null, visible };
}

/**
 * One event in, one decision out. No side effects, no clock of its own — the
 * caller supplies `now` so a test can name it exactly and the production hook
 * can pass `Date.now()`.
 */
export function decideLiveRefresh(
  state: LiveRefreshState,
  event: LiveRefreshEvent,
  now: number,
  config: LiveRefreshConfig
): LiveRefreshDecision {
  switch (event.type) {
    // Nothing to refresh for while nobody can see it — the hook clears its
    // armed timer on exactly this decision.
    case "hidden":
      return { state: { ...state, visible: false }, refresh: false };

    case "tick":
      // The hook only arms a timer while visible, so this is a safety net
      // rather than the normal path — a tick that lands after the tab went
      // hidden (a race between the timer firing and the listener clearing it)
      // must not refresh a page nobody is looking at.
      if (!state.visible) return { state, refresh: false };
      return { state: { ...state, lastRunAt: now }, refresh: true };

    case "visible":
    case "focus": {
      // A `focus` event for a tab that is not the active one is not trusted
      // on its own — `visibilitychange` is the authority on whether anything
      // is actually on screen, and a background tab should not start
      // refreshing itself because of an event that, in practice, browsers do
      // not deliver to it anyway. Defensive rather than load-bearing.
      if (event.type === "focus" && !state.visible) {
        return { state, refresh: false };
      }

      const withinDebounce = state.lastRunAt !== null && now - state.lastRunAt < config.debounceMs;
      if (withinDebounce) return { state: { ...state, visible: true }, refresh: false };

      return { state: { ...state, visible: true, lastRunAt: now }, refresh: true };
    }
  }
}
