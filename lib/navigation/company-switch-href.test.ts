import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { companySwitchHref } from "./company-switch-href";

describe("companySwitchHref", () => {
  it("swaps the slug for a bare module page", () => {
    assert.equal(companySwitchHref("/create/domestico", "travelnest"), "/create/travelnest");
  });

  it("preserves a sub-route under Competitive Analysis", () => {
    assert.equal(
      companySwitchHref("/competitive-analysis/domestico/trends", "travelnest"),
      "/competitive-analysis/travelnest/trends"
    );
  });

  it("preserves a sub-route under company management", () => {
    assert.equal(
      companySwitchHref("/companies/domestico/sources", "travelnest"),
      "/companies/travelnest/sources"
    );
  });

  it("preserves a deeper sub-route", () => {
    assert.equal(
      companySwitchHref("/companies/domestico/settings/brand", "travelnest"),
      "/companies/travelnest/settings/brand"
    );
  });

  it("returns null for Dashboard", () => {
    assert.equal(companySwitchHref("/dashboard", "travelnest"), null);
  });

  it("returns null for Admin", () => {
    assert.equal(companySwitchHref("/admin", "travelnest"), null);
  });

  it("returns null for a bare module root with no slug", () => {
    assert.equal(companySwitchHref("/create", "travelnest"), null);
    assert.equal(companySwitchHref("/competitive-analysis", "travelnest"), null);
  });

  it("returns null for the bare companies list page", () => {
    assert.equal(companySwitchHref("/companies", "travelnest"), null);
  });

  it("returns null for the create-company form — 'new' is not a slug to swap", () => {
    // Swapping would navigate to /companies/travelnest and silently discard a
    // half-filled form. The preference is still updated; the page stays.
    assert.equal(companySwitchHref("/companies/new", "travelnest"), null);
  });
});
