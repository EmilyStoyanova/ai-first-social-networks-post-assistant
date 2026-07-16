import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { LlmProvider } from "@prisma/client";
import {
  setLlmProviderStateCore,
  type SetLlmProviderStateDb,
} from "./set-llm-provider-state.service";
import { listLlmProvidersCore, type ListLlmProvidersDb } from "./list-llm-providers.service";

// ─── Env control (availability derives purely from env) ────────────────────────

const ENV_KEYS = [
  "GROQ_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "TEXT_WORKER_URL",
  "TEXT_WORKER_API_KEY",
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

// ─── In-memory runtime-state store ─────────────────────────────────────────────

type Row = { provider: LlmProvider; isActive: boolean; isDefault: boolean };

function makeDb(initial: Row[] = []) {
  const rows = new Map<LlmProvider, Row>(initial.map((r) => [r.provider, { ...r }]));
  const db: SetLlmProviderStateDb & ListLlmProvidersDb = {
    llmConfig: {
      findUnique: async ({ where }) => {
        const r = rows.get(where.provider);
        return r ? { isActive: r.isActive, isDefault: r.isDefault } : null;
      },
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const [provider, r] of rows) {
          if (provider === where.provider.not) continue;
          r.isDefault = data.isDefault;
          count++;
        }
        return { count };
      },
      upsert: async ({ where, create, update }) => {
        const existing = rows.get(where.provider);
        if (existing) {
          existing.isActive = update.isActive;
          existing.isDefault = update.isDefault;
          return { isActive: existing.isActive, isDefault: existing.isDefault };
        }
        const row: Row = {
          provider: create.provider,
          isActive: create.isActive,
          isDefault: create.isDefault,
        };
        rows.set(where.provider, row);
        return { isActive: row.isActive, isDefault: row.isDefault };
      },
      findMany: async () => [...rows.values()],
    },
  };
  return { db, rows };
}

// ─── setLlmProviderStateCore ───────────────────────────────────────────────────

describe("setLlmProviderStateCore — availability gating", () => {
  it("activates an available provider", async () => {
    process.env.GROQ_API_KEY = "k";
    const { db, rows } = makeDb();

    const result = await setLlmProviderStateCore(true, "grok", { isActive: true }, db);

    assert.ok(result.success);
    assert.equal(result.provider.isActive, true);
    assert.equal(rows.get("grok")!.isActive, true);
  });

  it("refuses to activate an unavailable provider and writes nothing", async () => {
    // No TEXT_WORKER_URL/KEY → text_worker is not available.
    const { db, rows } = makeDb();

    const result = await setLlmProviderStateCore(true, "text_worker", { isActive: true }, db);

    assert.equal(result.success, false);
    if (!result.success) assert.equal(result.code, "PROVIDER_NOT_AVAILABLE");
    assert.equal(rows.has("text_worker"), false, "no runtime-state row is created");
  });

  it("rejects non-admins", async () => {
    process.env.GROQ_API_KEY = "k";
    const { db } = makeDb();
    const result = await setLlmProviderStateCore(false, "grok", { isActive: true }, db);
    assert.equal(result.success, false);
    if (!result.success) assert.equal(result.code, "FORBIDDEN");
  });
});

describe("setLlmProviderStateCore — activation is not exclusive", () => {
  it("keeps multiple providers active at once", async () => {
    process.env.GROQ_API_KEY = "k";
    process.env.ANTHROPIC_API_KEY = "k";
    const { db, rows } = makeDb();

    await setLlmProviderStateCore(true, "grok", { isActive: true }, db);
    await setLlmProviderStateCore(true, "claude", { isActive: true }, db);

    assert.equal(rows.get("grok")!.isActive, true);
    assert.equal(rows.get("claude")!.isActive, true, "activating claude must not deactivate grok");
  });
});

describe("setLlmProviderStateCore — single default", () => {
  it("promoting a default clears the previous default without deactivating it", async () => {
    process.env.GROQ_API_KEY = "k";
    process.env.OPENAI_API_KEY = "k";
    const { db, rows } = makeDb([
      { provider: "grok", isActive: true, isDefault: true },
      { provider: "openai", isActive: true, isDefault: false },
    ]);

    const result = await setLlmProviderStateCore(true, "openai", { isDefault: true }, db);

    assert.ok(result.success);
    assert.equal(rows.get("openai")!.isDefault, true);
    assert.equal(rows.get("openai")!.isActive, true, "a default is always active");
    assert.equal(rows.get("grok")!.isDefault, false, "previous default flag is cleared");
    assert.equal(rows.get("grok")!.isActive, true, "previous default stays active");
  });

  it("promoting a default forces the provider active", async () => {
    process.env.GROQ_API_KEY = "k";
    const { db, rows } = makeDb([{ provider: "grok", isActive: false, isDefault: false }]);

    await setLlmProviderStateCore(true, "grok", { isDefault: true }, db);

    assert.equal(rows.get("grok")!.isActive, true);
    assert.equal(rows.get("grok")!.isDefault, true);
  });

  it("deactivating a provider clears its default flag", async () => {
    process.env.GROQ_API_KEY = "k";
    const { db, rows } = makeDb([{ provider: "grok", isActive: true, isDefault: true }]);

    await setLlmProviderStateCore(true, "grok", { isActive: false }, db);

    assert.equal(rows.get("grok")!.isActive, false);
    assert.equal(rows.get("grok")!.isDefault, false);
  });
});

// ─── listLlmProvidersCore ──────────────────────────────────────────────────────

describe("listLlmProvidersCore", () => {
  it("lists every supported provider merged with runtime state and env status", async () => {
    process.env.GROQ_API_KEY = "k";
    const { db } = makeDb([{ provider: "grok", isActive: true, isDefault: true }]);

    const result = await listLlmProvidersCore(true, db);

    assert.ok(result.success);
    const grok = result.providers.find((p) => p.provider === "grok")!;
    assert.equal(grok.isActive, true);
    assert.equal(grok.isDefault, true);
    assert.equal(grok.status, "available");

    // A provider with no row and no env → inactive + not_configured.
    const openai = result.providers.find((p) => p.provider === "openai")!;
    assert.equal(openai.isActive, false);
    assert.equal(openai.status, "not_configured");
  });

  it("rejects non-admins", async () => {
    const { db } = makeDb();
    const result = await listLlmProvidersCore(false, db);
    assert.equal(result.success, false);
    if (!result.success) assert.equal(result.code, "FORBIDDEN");
  });
});
