import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import {
  resolveCompetitiveAnalysisContext,
  type ResolveCompetitiveAnalysisContextDeps,
} from "./resolve-competitor-context";

function deps(overrides?: {
  company?: { id: string } | null;
  membership?: { companyId: string; role: "owner" | "editor" } | null;
}) {
  // `?? default` is wrong here: an override explicitly passing `null` (e.g. "no
  // membership found") is nullish too, so `??` would silently replace it with
  // the default instead of honouring it. `in` distinguishes "key omitted" from
  // "key explicitly set to null".
  const company =
    overrides && "company" in overrides ? (overrides.company ?? null) : { id: "co-1" };
  const membership =
    overrides && "membership" in overrides
      ? (overrides.membership ?? null)
      : { companyId: "co-1", role: "owner" as const };

  return {
    findCompanyBySlug: mock.fn(async (_slug: string) => company),
    findMembership: mock.fn(async (_slug: string, _userId: string) => membership),
  } satisfies ResolveCompetitiveAnalysisContextDeps;
}

describe("resolveCompetitiveAnalysisContext", () => {
  it("global admin: resolves via company lookup alone, never membership, and is always owner", async () => {
    const d = deps({ company: { id: "co-1" } });
    const result = await resolveCompetitiveAnalysisContext("acme", "admin-1", true, true, d);
    assert.deepEqual(result, { ok: true, context: { companyId: "co-1", isOwner: true } });
    assert.equal(d.findMembership.mock.callCount(), 0);
  });

  it("global admin: NOT_FOUND for a slug with no company", async () => {
    const d = deps({ company: null });
    const result = await resolveCompetitiveAnalysisContext("ghost", "admin-1", true, false, d);
    assert.deepEqual(result, { ok: false, code: "NOT_FOUND" });
  });

  it("non-member: NOT_FOUND, never FORBIDDEN — existence is not leaked", async () => {
    const d = deps({ membership: null });
    const result = await resolveCompetitiveAnalysisContext("acme", "u1", false, false, d);
    assert.deepEqual(result, { ok: false, code: "NOT_FOUND" });
  });

  it("editor: may read (requireOwner: false)", async () => {
    const d = deps({ membership: { companyId: "co-1", role: "editor" } });
    const result = await resolveCompetitiveAnalysisContext("acme", "u1", false, false, d);
    assert.deepEqual(result, { ok: true, context: { companyId: "co-1", isOwner: false } });
  });

  it("editor: FORBIDDEN on an owner-only mutation (requireOwner: true)", async () => {
    const d = deps({ membership: { companyId: "co-1", role: "editor" } });
    const result = await resolveCompetitiveAnalysisContext("acme", "u1", false, true, d);
    assert.deepEqual(result, { ok: false, code: "FORBIDDEN" });
  });

  it("owner: may mutate (requireOwner: true)", async () => {
    const d = deps({ membership: { companyId: "co-1", role: "owner" } });
    const result = await resolveCompetitiveAnalysisContext("acme", "u1", false, true, d);
    assert.deepEqual(result, { ok: true, context: { companyId: "co-1", isOwner: true } });
  });

  it("cross-company isolation: a membership in a DIFFERENT company never leaks this company's id", async () => {
    // `findMembership` is scoped by slug at the query level (WHERE company.slug
    // = :slug AND userId = :userId) — a caller with no membership in THIS
    // company's slug always resolves through the null branch, regardless of
    // memberships they hold elsewhere. Modelled here by a membership dep that
    // simply returns null for an unrecognized company.
    const d: ResolveCompetitiveAnalysisContextDeps = {
      findCompanyBySlug: mock.fn(async () => ({ id: "co-1" })),
      findMembership: mock.fn(async (slug: string) =>
        slug === "acme" ? { companyId: "co-1", role: "owner" as const } : null
      ),
    };
    const result = await resolveCompetitiveAnalysisContext(
      "someone-elses-company",
      "u1",
      false,
      false,
      d
    );
    assert.deepEqual(result, { ok: false, code: "NOT_FOUND" });
  });
});
