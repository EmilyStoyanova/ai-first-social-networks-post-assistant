import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  decideLiveRefresh,
  initialLiveRefreshState,
  type LiveRefreshState,
} from "./live-refresh-scheduler";

const CONFIG = { intervalMs: 30_000, debounceMs: 2_000 };

/** Arbitrary epoch a test's clock starts at. */
const T0 = 1_700_000_000_000;

describe("decideLiveRefresh — the periodic tick", () => {
  it("refreshes on a tick while visible", () => {
    const state = initialLiveRefreshState(true);
    const decision = decideLiveRefresh(state, { type: "tick" }, T0, CONFIG);
    assert.equal(decision.refresh, true);
    assert.equal(decision.state.lastRunAt, T0);
  });

  it("does not refresh a tick that lands after the tab went hidden", () => {
    // The hook only arms a timer while visible, so this covers the race
    // between the timer firing and the hidden listener clearing it, not the
    // ordinary path.
    const state: LiveRefreshState = { lastRunAt: null, visible: false };
    const decision = decideLiveRefresh(state, { type: "tick" }, T0, CONFIG);
    assert.equal(decision.refresh, false);
  });
});

describe("decideLiveRefresh — the tab returning", () => {
  it("refreshes immediately when the tab becomes visible", () => {
    const state: LiveRefreshState = { lastRunAt: null, visible: false };
    const decision = decideLiveRefresh(state, { type: "visible" }, T0, CONFIG);
    assert.equal(decision.refresh, true);
    assert.equal(decision.state.visible, true);
    assert.equal(decision.state.lastRunAt, T0);
  });

  it("refreshes immediately on window focus, with no prior hidden state", () => {
    // Window focus/blur and tab visibility are different browser signals — a
    // window can lose and regain OS focus without its frontmost tab ever
    // reporting hidden. Focus alone must still refresh in that case.
    const state = initialLiveRefreshState(true);
    const decision = decideLiveRefresh(state, { type: "focus" }, T0, CONFIG);
    assert.equal(decision.refresh, true);
  });

  it("does not refresh a focus event for a tab that is not the active one", () => {
    // Defensive: browsers should not deliver `focus` to a hidden tab's
    // document at all, but the decision must not depend on that holding.
    const state: LiveRefreshState = { lastRunAt: null, visible: false };
    const decision = decideLiveRefresh(state, { type: "focus" }, T0, CONFIG);
    assert.equal(decision.refresh, false);
    assert.equal(decision.state.visible, false);
  });

  it("pauses on hidden and resumes with an immediate refresh on visible", () => {
    let state = initialLiveRefreshState(true);

    const hidden = decideLiveRefresh(state, { type: "hidden" }, T0, CONFIG);
    assert.equal(hidden.refresh, false);
    assert.equal(hidden.state.visible, false);
    state = hidden.state;

    const later = T0 + 5 * 60_000; // long past any debounce window
    const visible = decideLiveRefresh(state, { type: "visible" }, later, CONFIG);
    assert.equal(visible.refresh, true);
    assert.equal(visible.state.visible, true);
  });
});

describe("decideLiveRefresh — deduping visible + focus", () => {
  it("refreshes once for a visible+focus pair firing together", () => {
    let state = initialLiveRefreshState(false);

    const visible = decideLiveRefresh(state, { type: "visible" }, T0, CONFIG);
    assert.equal(visible.refresh, true);
    state = visible.state;

    // The same tab-return, a millisecond later — exactly how the two browser
    // events land in practice.
    const focus = decideLiveRefresh(state, { type: "focus" }, T0 + 1, CONFIG);
    assert.equal(focus.refresh, false);
  });

  it("refreshes once for a focus+visible pair firing in the other order", () => {
    let state = initialLiveRefreshState(false);

    const focus = decideLiveRefresh(state, { type: "focus" }, T0, CONFIG);
    // A hidden tab does not trust a lone focus, so this one is refused —
    // exactly requirement 6's point. `visible` is what actually resumes it.
    assert.equal(focus.refresh, false);
    state = focus.state;

    const visible = decideLiveRefresh(state, { type: "visible" }, T0 + 1, CONFIG);
    assert.equal(visible.refresh, true);
  });

  it("allows a second return refresh once the debounce window has passed", () => {
    let state = initialLiveRefreshState(true);

    const first = decideLiveRefresh(state, { type: "focus" }, T0, CONFIG);
    assert.equal(first.refresh, true);
    state = first.state;

    const tooSoon = decideLiveRefresh(state, { type: "focus" }, T0 + CONFIG.debounceMs - 1, CONFIG);
    assert.equal(tooSoon.refresh, false);

    const afterDebounce = decideLiveRefresh(
      state,
      { type: "focus" },
      T0 + CONFIG.debounceMs,
      CONFIG
    );
    assert.equal(afterDebounce.refresh, true);
  });
});

describe("decideLiveRefresh — a realistic sequence", () => {
  it("ticks every interval, pauses while hidden, and resumes on return", () => {
    let state = initialLiveRefreshState(true);
    const refreshedAt: number[] = [];

    function apply(event: Parameters<typeof decideLiveRefresh>[1], now: number) {
      const decision = decideLiveRefresh(state, event, now, CONFIG);
      state = decision.state;
      if (decision.refresh) refreshedAt.push(now);
      return decision;
    }

    apply({ type: "tick" }, T0 + 30_000);
    apply({ type: "tick" }, T0 + 60_000);
    // The user switches away mid-interval — no third tick would even be armed
    // by the hook, but the reducer refuses one anyway if it arrived.
    apply({ type: "hidden" }, T0 + 75_000);
    apply({ type: "tick" }, T0 + 90_000); // a race the hook's clearTimer should prevent
    // Ten minutes pass, then the user comes back.
    apply({ type: "visible" }, T0 + 675_000);
    apply({ type: "focus" }, T0 + 675_001); // fires alongside visibilitychange

    assert.deepEqual(refreshedAt, [T0 + 30_000, T0 + 60_000, T0 + 675_000]);
  });
});
