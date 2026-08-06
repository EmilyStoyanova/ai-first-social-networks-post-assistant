import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { metricsStateFor } from "./get-post-metrics.service";

/**
 * The card's side of the "keep the previous statistics" rule.
 *
 * Preserving the figures in the database is only half the requirement — if the
 * read side still switched on the latest attempt's status, a post with perfectly
 * good numbers would render "waiting for the first metrics sync" after a single
 * failed nightly read.
 */

describe("metricsStateFor", () => {
  it("shows a successful read as ready", () => {
    assert.equal(metricsStateFor({ syncStatus: "ok", hasFigures: true }), "ready");
  });

  it("keeps showing stored figures after a failed refresh", () => {
    assert.equal(metricsStateFor({ syncStatus: "error", hasFigures: true }), "ready");
  });

  it("falls back to pending when a failed read has nothing stored", () => {
    // Transient and retried by the next daily run — "analytics failed" would be
    // noise to an owner who can do nothing about it.
    assert.equal(metricsStateFor({ syncStatus: "error", hasFigures: false }), "pending");
  });

  it("reports no_data only when there is genuinely nothing to show", () => {
    assert.equal(metricsStateFor({ syncStatus: "no_data", hasFigures: false }), "no_data");
    // Buffer reporting nothing today does not retract what it reported before.
    assert.equal(metricsStateFor({ syncStatus: "no_data", hasFigures: true }), "ready");
  });

  it("reports forbidden only when there is genuinely nothing to show", () => {
    assert.equal(metricsStateFor({ syncStatus: "forbidden", hasFigures: false }), "forbidden");
    assert.equal(metricsStateFor({ syncStatus: "forbidden", hasFigures: true }), "ready");
  });

  it("treats an unsynced post as pending", () => {
    assert.equal(metricsStateFor({ syncStatus: "not_found", hasFigures: false }), "pending");
  });
});
