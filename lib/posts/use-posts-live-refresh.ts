"use client";

import { useEffect, useRef } from "react";
import {
  decideLiveRefresh,
  initialLiveRefreshState,
  type LiveRefreshState,
} from "./live-refresh-scheduler";

/**
 * Keeping a posts view in step with statuses that change in the background —
 * the publishing sweep moving a post `approved` → `sent_to_buffer` →
 * `published`, or cron writing new drafts — without the person watching it
 * having to reload the page.
 *
 * Used identically by every page that renders a grid of posts (the Posts tab,
 * a channel's own posts, the calendar), each passing its own `router.refresh()`
 * as `refresh`. That is the app's existing posts-refresh mechanism — every one
 * of those pages already calls it after an explicit action (Save, Approve,
 * Reschedule) — so this hook adds no second way of loading posts, only a
 * second REASON to call the one that exists. `router.refresh()` re-fetches the
 * server component's data without remounting the client tree beneath it, which
 * is what keeps an open edit modal, an in-progress schedule pick, or unsaved
 * text exactly as the user left them; see `GeneratedPostCardBody`'s own
 * reconciliation effect for the other half of that guarantee — syncing the
 * server-owned fields (status, schedule, published info) once the fresh props
 * arrive, without touching anything a person is mid-typing.
 *
 * WHEN to refresh — every branch of "tick vs. tab-return, debounced,
 * hidden-aware" — is decided by the pure `decideLiveRefresh` reducer, tested
 * on its own. This file is only the wiring: a real `setTimeout`, the real
 * `visibilitychange`/`focus` listeners, and feeding what they report into that
 * reducer.
 *
 * A self-scheduling `setTimeout`, not `setInterval` — the same choice
 * generate-post-form.tsx's bulk-job poll makes, and for the same reason: a
 * fixed interval cannot tell a refresh has not returned yet and would stack a
 * second request on top of it. Every refresh, whichever event caused it, rearms
 * the SAME timer, which is what keeps exactly one countdown alive rather than
 * a periodic one racing an event-driven one.
 */

/** How often the view refreshes while the tab is visible and idle. */
const REFRESH_INTERVAL_MS = 30_000;

/**
 * The shortest gap allowed between two refreshes triggered by the "tab
 * returned" path (`visibilitychange` and `focus`), so a pair firing for the
 * same return does not become a pair of requests.
 */
const REFRESH_DEBOUNCE_MS = 2_000;

/**
 * Refreshes `refresh` roughly every 30 seconds while the tab is visible, and
 * immediately whenever the tab becomes visible or the window regains focus.
 * Paused — no timer, no request — while the tab is hidden.
 *
 * `refresh` is read through a ref rather than listed as a dependency, so a new
 * function identity on every render (an inline arrow at the call site, or
 * `router.refresh` if its identity is not guaranteed stable across renders)
 * never tears down and rebuilds the timer or the listeners — the effect below
 * runs its setup exactly once per mount, including under React Strict Mode's
 * mount → cleanup → mount, which leaves this same one-timer state behind
 * either way.
 */
export function usePostsLiveRefresh(refresh: () => void): void {
  const refreshRef = useRef(refresh);

  // Keeps the ref pointed at the latest closure without writing to it during
  // render (not allowed — refs are for effects and event handlers). No
  // dependency array, so this runs after every render, same as the ref itself
  // being read only from inside the other effect below and from event/timer
  // callbacks, never during render.
  useEffect(() => {
    refreshRef.current = refresh;
  });

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let state: LiveRefreshState = initialLiveRefreshState(document.visibilityState === "visible");

    function clearTimer() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    }

    function armTimer() {
      clearTimer();
      timer = setTimeout(() => handle({ type: "tick" }), REFRESH_INTERVAL_MS);
    }

    function handle(event: Parameters<typeof decideLiveRefresh>[1]) {
      const decision = decideLiveRefresh(state, event, Date.now(), {
        intervalMs: REFRESH_INTERVAL_MS,
        debounceMs: REFRESH_DEBOUNCE_MS,
      });
      state = decision.state;

      if (decision.refresh) {
        refreshRef.current();
        armTimer();
      } else if (event.type === "hidden") {
        clearTimer();
      }
    }

    if (state.visible) armTimer();

    function onVisibilityChange() {
      handle({ type: document.visibilityState === "visible" ? "visible" : "hidden" });
    }

    function onFocus() {
      handle({ type: "focus" });
    }

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onFocus);

    return () => {
      clearTimer();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onFocus);
    };
    // Deliberately empty: `refresh` is read through the ref above so this
    // effect's setup and teardown run exactly once per mount, not once per
    // render.
  }, []);
}
