import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isNavItemActive, COMPANIES_HREF, COMPANY_MANAGEMENT_HREF } from "./nav-active";

/** Exactly one nav item may claim a pathname — asserted directly rather than
 *  left to the reader to infer from separate per-item cases. */
function activeItems(pathname: string): string[] {
  const items = [
    "/dashboard",
    COMPANIES_HREF,
    COMPANY_MANAGEMENT_HREF,
    "/competitive-analysis",
    "/admin",
  ];
  return items.filter((href) => isNavItemActive(pathname, href));
}

describe("isNavItemActive — plain prefix items are unchanged", () => {
  it("Dashboard", () => {
    assert.deepEqual(activeItems("/dashboard"), ["/dashboard"]);
  });

  it("Competitive Analysis, including sub-routes", () => {
    assert.deepEqual(activeItems("/competitive-analysis"), ["/competitive-analysis"]);
    assert.deepEqual(activeItems("/competitive-analysis/domestico/trends"), [
      "/competitive-analysis",
    ]);
  });

  it("Admin", () => {
    assert.deepEqual(activeItems("/admin"), ["/admin"]);
    assert.deepEqual(activeItems("/admin/users"), ["/admin"]);
  });
});

describe("isNavItemActive — Companies is the list, not a company", () => {
  it("the list page itself", () => {
    assert.deepEqual(activeItems("/companies"), [COMPANIES_HREF]);
  });

  it("the create-company form belongs to the list, not to Company Management", () => {
    // No company is being managed yet, and it is reached from the list.
    assert.deepEqual(activeItems("/companies/new"), [COMPANIES_HREF]);
  });

  it("does NOT claim a company's workspace", () => {
    assert.equal(isNavItemActive("/companies/domestico", COMPANIES_HREF), false);
    assert.equal(isNavItemActive("/companies/domestico/posts", COMPANIES_HREF), false);
  });
});

describe("isNavItemActive — Company Management follows its own redirect", () => {
  it("claims the shim route itself", () => {
    assert.deepEqual(activeItems("/create"), [COMPANY_MANAGEMENT_HREF]);
  });

  it("claims the legacy slugged route", () => {
    assert.deepEqual(activeItems("/create/domestico"), [COMPANY_MANAGEMENT_HREF]);
  });

  /**
   * The reason this module exists: `/create` redirects to
   * `/companies/{slug}`, so after clicking Company Management the pathname
   * contains no trace of `/create`. A plain prefix match would leave the
   * clicked item dark and light up Companies instead.
   */
  it("claims the company workspace it redirects into", () => {
    assert.deepEqual(activeItems("/companies/domestico"), [COMPANY_MANAGEMENT_HREF]);
  });

  it("claims every workspace tab, however deep", () => {
    for (const path of [
      "/companies/domestico/posts",
      "/companies/domestico/channels",
      "/companies/domestico/media",
      "/companies/domestico/sources",
      "/companies/domestico/activity",
      "/companies/domestico/settings",
      "/companies/domestico/settings/brand",
      "/companies/domestico/channels/facebook/calendar",
    ]) {
      assert.deepEqual(activeItems(path), [COMPANY_MANAGEMENT_HREF], `expected for ${path}`);
    }
  });

  it("a company whose slug merely starts with 'new' is still a workspace", () => {
    // Guards the exclusion against being a naive `startsWith("new")`.
    assert.deepEqual(activeItems("/companies/newsroom"), [COMPANY_MANAGEMENT_HREF]);
    assert.deepEqual(activeItems("/companies/newsroom/posts"), [COMPANY_MANAGEMENT_HREF]);
  });
});

describe("isNavItemActive — never two items at once", () => {
  it("no pathname lights up more than one nav item", () => {
    for (const path of [
      "/dashboard",
      "/companies",
      "/companies/new",
      "/companies/domestico",
      "/companies/domestico/settings/brand",
      "/create",
      "/create/domestico",
      "/competitive-analysis",
      "/competitive-analysis/domestico/content",
      "/admin",
    ]) {
      assert.equal(activeItems(path).length, 1, `expected exactly one active item for ${path}`);
    }
  });
});
