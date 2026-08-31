import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { resolveActiveCompany } from "./resolve-active-company.service";
import type { CompanyDetails } from "./get-company.service";
import type { CompanyListItem } from "./list-companies.service";

const OWNER_COMPANY: CompanyDetails = {
  id: "co-1",
  name: "Domestico",
  slug: "domestico",
  website: null,
  automationMode: "semi_automated",
  defaultLang: "en",
  createdAt: new Date(),
  role: "OWNER",
};

const OWNER_COMPANY_LIST_ITEM: CompanyListItem = {
  id: "co-1",
  name: "Domestico",
  slug: "domestico",
  website: null,
  role: "OWNER",
  draftCount: 0,
};

function deps(overrides?: {
  getCompany?: (slug: string) => Promise<CompanyDetails | null>;
  companies?: CompanyListItem[];
}) {
  return {
    getCompany: mock.fn(async (slug: string) => {
      if (overrides?.getCompany) return overrides.getCompany(slug);
      return slug === OWNER_COMPANY.slug ? OWNER_COMPANY : null;
    }),
    listCompanies: mock.fn(async () => overrides?.companies ?? [OWNER_COMPANY_LIST_ITEM]),
  };
}

describe("resolveActiveCompany", () => {
  it("prefers the route slug when present and it is accessible", async () => {
    const d = deps();
    const result = await resolveActiveCompany(
      { routeSlug: "domestico", userId: "u1", isGlobalAdmin: false },
      d
    );
    assert.equal(result?.slug, "domestico");
    assert.equal(d.getCompany.mock.callCount(), 1);
    assert.equal(d.listCompanies.mock.callCount(), 0);
  });

  it("returns null for a route slug the user cannot access — never falls back silently", async () => {
    const d = deps({ getCompany: async () => null });
    const result = await resolveActiveCompany(
      { routeSlug: "someone-elses-company", userId: "u1", isGlobalAdmin: false },
      d
    );
    assert.equal(result, null);
    // Must not fall through to the cookie or first-accessible company — a
    // bad route slug is a 404 for that page, not a silent redirect.
    assert.equal(d.listCompanies.mock.callCount(), 0);
  });

  it("uses the persisted cookie when there is no route slug", async () => {
    const d = deps();
    const result = await resolveActiveCompany(
      { cookieSlug: "domestico", userId: "u1", isGlobalAdmin: false },
      d
    );
    assert.equal(result?.slug, "domestico");
  });

  it("ignores a stale/foreign cookie slug and falls back to the first accessible company", async () => {
    const d = deps({ getCompany: async () => null });
    const result = await resolveActiveCompany(
      { cookieSlug: "not-a-member-here", userId: "u1", isGlobalAdmin: false },
      d
    );
    assert.equal(result?.slug, "domestico");
    assert.equal(d.listCompanies.mock.callCount(), 1);
  });

  it("falls back to the first accessible company when there is no route slug or cookie", async () => {
    const d = deps();
    const result = await resolveActiveCompany({ userId: "u1", isGlobalAdmin: false }, d);
    assert.equal(result?.slug, "domestico");
  });

  it("returns null when the user has no accessible companies at all", async () => {
    const d = deps({ companies: [] });
    const result = await resolveActiveCompany({ userId: "u1", isGlobalAdmin: false }, d);
    assert.equal(result, null);
  });

  it("never trusts a slug without re-validating access, even for a global admin", async () => {
    const d = deps({ getCompany: async () => null, companies: [] });
    const result = await resolveActiveCompany(
      { routeSlug: "ghost-company", userId: "admin", isGlobalAdmin: true },
      d
    );
    assert.equal(result, null);
  });
});
