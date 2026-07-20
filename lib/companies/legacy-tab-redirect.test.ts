import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveLegacyTabRedirect } from "./legacy-tab-redirect";

/**
 * These tests stand in for links this project cannot see: bookmarks, browser
 * history, and mail already sent. Phase 4a can only claim the old URLs still
 * work if every retired `?tab=` value resolves, so each one is asserted by name
 * rather than by sampling.
 */

describe("resolveLegacyTabRedirect — retired ?tab= values", () => {
  it("sends each retired tab to its route", () => {
    const cases: Record<string, string> = {
      posts: "/companies/acme/posts",
      sources: "/companies/acme/sources",
      settings: "/companies/acme/settings",
      team: "/companies/acme/settings/team",
    };

    for (const [tab, expected] of Object.entries(cases)) {
      assert.equal(resolveLegacyTabRedirect("acme", { tab }), expected);
    }
  });

  it("drops the parameter for the overview, which is this page", () => {
    // Redirecting to the bare company URL is what stops the loop: the next
    // request carries no `tab`, so it renders instead of redirecting again.
    assert.equal(resolveLegacyTabRedirect("acme", { tab: "overview" }), "/companies/acme");
  });

  it("renders the overview for an unrecognized tab instead of 404ing", () => {
    // Matches the old resolveTab fallback — a typo or a retired value showed
    // the overview, and a stale link should not become a dead end.
    assert.equal(resolveLegacyTabRedirect("acme", { tab: "analytics" }), null);
    assert.equal(resolveLegacyTabRedirect("acme", { tab: "" }), null);
  });

  it("renders normally when there is no tab at all", () => {
    assert.equal(resolveLegacyTabRedirect("acme", {}), null);
    assert.equal(resolveLegacyTabRedirect("acme", { status: "draft" }), null);
  });
});

describe("resolveLegacyTabRedirect — carrying the rest of the URL", () => {
  it("keeps the Buffer OAuth result attached to the settings page", () => {
    // The highest-cost regression this function prevents: a user authorizes
    // Buffer, the callback lands on a legacy URL, and the outcome is silently
    // dropped on the way to the new route.
    assert.equal(
      resolveLegacyTabRedirect("acme", { tab: "settings", buffer: "connected" }),
      "/companies/acme/settings?buffer=connected"
    );
  });

  it("keeps a post status filter attached to the posts page", () => {
    assert.equal(
      resolveLegacyTabRedirect("acme", { tab: "posts", status: "published" }),
      "/companies/acme/posts?status=published"
    );
  });

  it("preserves a repeated parameter rather than collapsing it", () => {
    assert.equal(
      resolveLegacyTabRedirect("acme", { tab: "posts", channel: ["facebook", "linkedin"] }),
      "/companies/acme/posts?channel=facebook&channel=linkedin"
    );
  });

  it("takes the first value when the tab itself is repeated", () => {
    assert.equal(
      resolveLegacyTabRedirect("acme", { tab: ["posts", "settings"] }),
      "/companies/acme/posts"
    );
  });

  it("matches a tab regardless of case or stray whitespace", () => {
    assert.equal(
      resolveLegacyTabRedirect("acme", { tab: " Settings " }),
      "/companies/acme/settings"
    );
  });

  it("escapes values so a parameter cannot forge extra query keys", () => {
    const destination = resolveLegacyTabRedirect("acme", { tab: "posts", note: "a&b=c" });
    assert.equal(destination, "/companies/acme/posts?note=a%26b%3Dc");
    // Parsed back, it is still one parameter with its original value.
    const parsed = new URLSearchParams(destination!.split("?")[1]);
    assert.equal(parsed.get("note"), "a&b=c");
    assert.equal(parsed.get("b"), null);
  });
});
