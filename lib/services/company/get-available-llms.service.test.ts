import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { LlmProvider } from "@prisma/client";
import { getAvailableLlmsCore, type AvailableLlmsDb } from "./get-available-llms.service";

// ─── Fake DB ───────────────────────────────────────────────────────────────────
// The membership/company lookups always succeed; llmConfig.findMany honours the
// { isActive: true } filter so we can prove inactive configs are excluded.

type ConfigSeed = {
  id: string;
  provider: LlmProvider;
  // Model comes from the registry now; kept optional here only so existing seed
  // literals stay valid. It is not read.
  modelName?: string;
  isActive: boolean;
  isDefault: boolean;
};

function makeDb(
  configs: ConfigSeed[],
  preferredLlmConfigId: string | null = null
): AvailableLlmsDb {
  return {
    company: { findUnique: async () => ({ id: "co-1" }) },
    companyMember: { findFirst: async () => ({ companyId: "co-1" }) },
    user: { findUnique: async () => ({ preferredLlmConfigId }) },
    llmConfig: {
      findMany: async ({ where }) =>
        configs
          .filter((c) => c.isActive === where.isActive)
          .map((c) => ({ id: c.id, provider: c.provider, isDefault: c.isDefault })),
    },
  };
}

describe("getAvailableLlmsCore", () => {
  it("returns all active configs (Grok and Text Worker together)", async () => {
    const db = makeDb([
      { id: "grok", provider: "grok", modelName: "grok-4", isActive: true, isDefault: true },
      {
        id: "tw",
        provider: "text_worker",
        modelName: "qwen3:8b",
        isActive: true,
        isDefault: false,
      },
    ]);

    const result = await getAvailableLlmsCore("acme", "u-1", false, db);

    assert.ok(result.success);
    assert.equal(result.llms.length, 2);
    const ids = result.llms.map((l) => l.id).sort();
    assert.deepEqual(ids, ["grok", "tw"]);
  });

  it("marks only the single default config as isDefault", async () => {
    const db = makeDb([
      { id: "grok", provider: "grok", modelName: "grok-4", isActive: true, isDefault: true },
      {
        id: "tw",
        provider: "text_worker",
        modelName: "qwen3:8b",
        isActive: true,
        isDefault: false,
      },
    ]);

    const result = await getAvailableLlmsCore("acme", "u-1", false, db);

    assert.ok(result.success);
    const defaults = result.llms.filter((l) => l.isDefault);
    assert.equal(defaults.length, 1);
    assert.equal(defaults[0].id, "grok");
  });

  it("excludes inactive configs", async () => {
    const db = makeDb([
      { id: "grok", provider: "grok", modelName: "grok-4", isActive: true, isDefault: true },
      { id: "openai", provider: "openai", modelName: "gpt-4o", isActive: false, isDefault: false },
    ]);

    const result = await getAvailableLlmsCore("acme", "u-1", false, db);

    assert.ok(result.success);
    assert.equal(result.llms.length, 1);
    assert.equal(result.llms[0].id, "grok");
  });

  it("flags the caller's active saved preference as isPreferred", async () => {
    const db = makeDb(
      [
        { id: "grok", provider: "grok", modelName: "grok-4", isActive: true, isDefault: true },
        {
          id: "tw",
          provider: "text_worker",
          modelName: "qwen3:8b",
          isActive: true,
          isDefault: false,
        },
      ],
      "tw"
    );

    const result = await getAvailableLlmsCore("acme", "u-1", false, db);

    assert.ok(result.success);
    const preferred = result.llms.filter((l) => l.isPreferred);
    assert.equal(preferred.length, 1);
    assert.equal(preferred[0].id, "tw");
  });

  it("marks nothing preferred when the saved preference is inactive (effective fallback)", async () => {
    // The stored preference points at an inactive config, so it never appears in
    // the active list and nothing is flagged — the form shows the system default.
    const db = makeDb(
      [{ id: "grok", provider: "grok", modelName: "grok-4", isActive: true, isDefault: true }],
      "openai-inactive"
    );

    const result = await getAvailableLlmsCore("acme", "u-1", false, db);

    assert.ok(result.success);
    assert.equal(
      result.llms.some((l) => l.isPreferred),
      false
    );
  });

  it("returns NOT_FOUND when a non-member requests the list", async () => {
    const db: AvailableLlmsDb = {
      company: { findUnique: async () => null },
      companyMember: { findFirst: async () => null },
      user: { findUnique: async () => null },
      llmConfig: { findMany: async () => [] },
    };

    const result = await getAvailableLlmsCore("acme", "u-1", false, db);

    assert.ok(!result.success);
    assert.equal(result.code, "NOT_FOUND");
  });
});
