import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { updatePreferredLlmCore, type UpdatePreferredLlmDb } from "./update-preferred-llm.service";

// A fake that treats a fixed set of ids as active and records the user.update call.
function makeDb(activeIds: string[]) {
  const calls: Array<{ userId: string; preferredLlmConfigId: string | null }> = [];
  const db: UpdatePreferredLlmDb = {
    llmConfig: {
      findFirst: async ({ where }) => (activeIds.includes(where.id) ? { id: where.id } : null),
    },
    user: {
      update: async ({ where, data }) => {
        calls.push({ userId: where.id, preferredLlmConfigId: data.preferredLlmConfigId });
        return { preferredLlmConfigId: data.preferredLlmConfigId };
      },
    },
  };
  return { db, calls };
}

describe("updatePreferredLlmCore", () => {
  it("saves an active config as the preference for that user only", async () => {
    const { db, calls } = makeDb(["cfg-active"]);

    const result = await updatePreferredLlmCore("u-1", "cfg-active", db);

    assert.ok(result.success);
    assert.equal(result.preferredLlmConfigId, "cfg-active");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { userId: "u-1", preferredLlmConfigId: "cfg-active" });
  });

  it("rejects an inactive or unknown config and writes nothing", async () => {
    const { db, calls } = makeDb(["cfg-active"]);

    const result = await updatePreferredLlmCore("u-1", "cfg-inactive", db);

    assert.equal(result.success, false);
    if (!result.success) assert.equal(result.code, "INVALID_CONFIG");
    assert.equal(calls.length, 0, "no write happens for an invalid preference");
  });

  it("clears the preference when given null (use system default)", async () => {
    const { db, calls } = makeDb(["cfg-active"]);

    const result = await updatePreferredLlmCore("u-1", null, db);

    assert.ok(result.success);
    assert.equal(result.preferredLlmConfigId, null);
    assert.deepEqual(calls[0], { userId: "u-1", preferredLlmConfigId: null });
  });
});
