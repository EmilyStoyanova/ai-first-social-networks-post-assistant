import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { LlmProvider } from "@prisma/client";
import { getUserLlmSettingsCore, type UserLlmSettingsDb } from "./get-user-llm-settings.service";

type Seed = { id: string; provider: LlmProvider; isDefault: boolean };

function makeDb(active: Seed[], preferredLlmConfigId: string | null): UserLlmSettingsDb {
  return {
    user: { findUnique: async () => ({ preferredLlmConfigId }) },
    llmConfig: { findMany: async () => active },
  };
}

describe("getUserLlmSettingsCore", () => {
  const CONFIGS: Seed[] = [
    { id: "grok", provider: "grok", isDefault: true },
    { id: "openai", provider: "openai", isDefault: false },
  ];

  it("returns every active model and the effective preference when it is active", async () => {
    const settings = await getUserLlmSettingsCore("u-1", makeDb(CONFIGS, "openai"));

    assert.equal(settings.llms.length, 2);
    assert.equal(settings.preferredLlmConfigId, "openai");
    assert.equal(settings.llms.find((l) => l.id === "openai")!.isPreferred, true);
    assert.equal(settings.llms.find((l) => l.id === "grok")!.isPreferred, false);
  });

  it("falls back to system default when the saved preference is no longer active", async () => {
    // The stored id is not among the active configs → effective preference is null.
    const settings = await getUserLlmSettingsCore("u-1", makeDb(CONFIGS, "deleted-cfg"));

    assert.equal(settings.preferredLlmConfigId, null);
    assert.equal(
      settings.llms.some((l) => l.isPreferred),
      false
    );
  });

  it("returns null preference when the user has none set", async () => {
    const settings = await getUserLlmSettingsCore("u-1", makeDb(CONFIGS, null));

    assert.equal(settings.preferredLlmConfigId, null);
  });
});
