# v2-5 — Per-Generation LLM Model Selector

> **Superseded — historical record.** This document describes the design as
> planned. The shipped architecture diverges in three ways:
>
> 1. **There is no env-var provider selection.** `LLM_PROVIDER` and
>    `getLlmProvider()` are gone. Every provider is resolved from `LlmConfig`
>    rows via `lib/services/ai/resolve-llm-selection.service.ts`; env supplies
>    only credentials, model names, and worker URLs.
> 2. **`LlmConfig` stores runtime state only** (`isActive`, `isDefault`). API
>    keys, model names, and `baseUrl` are no longer stored in the DB.
> 3. **`isDefault` is an admin choice**, not a mirror of an env var.
>
> The `grok` enum value below is a historical misnomer retained for DB
> compatibility: the provider is **Groq** (`api.groq.com`), never xAI's Grok.

## Goal

Let users select which configured LLM to use for a specific generation request. The LLM factory remains env-var driven at its core; per-generation selection layers on top without modifying the factory's primary path.

## Architecture (Confirmed)

- `getLlmProvider()` reads `process.env.LLM_PROVIDER` — this is the env-var default path.
- `lib/ai/llm/text-worker.provider.ts` (Qwen/Ollama) already exists. Do not re-implement.
- `LlmConfig` DB table stores admin-configured providers (API keys encrypted, `baseUrl` optional).
- The factory does **not** read `LlmConfig` at runtime — this phase adds a parallel resolution path.

## Schema Change

```prisma
enum LlmProvider {
  claude
  openai
  grok
  text_worker   // ← ADD
}
```

Migration: `add_text_worker_llm_provider`

No other schema changes. `LlmConfig.provider` uses this enum, so adding `text_worker` allows admins to create `text_worker` configs via the admin UI.

## New Factory Function

### `lib/ai/llm/llm-provider-factory.ts` — add `getLlmProviderFromConfig()`

```typescript
/**
 * Instantiate an LLM provider from a decrypted LlmConfig.
 * The caller is responsible for decrypting apiKeyEnc before calling this.
 * This function never touches the database.
 */
export function getLlmProviderFromConfig(config: {
  provider: LlmProvider;
  modelName: string;
  apiKey: string; // already decrypted
  baseUrl?: string | null;
}): ILlmProvider {
  switch (config.provider) {
    case "claude":
      return new ClaudeProvider(config.apiKey, config.modelName);
    case "openai":
      return new OpenAIProvider(config.apiKey, config.modelName);
    case "grok":
      return new GroqProvider(config.apiKey, config.modelName);
    case "text_worker":
      return new TextWorkerProvider(
        config.baseUrl ?? process.env.TEXT_WORKER_URL!,
        config.apiKey,
        config.modelName
      );
    default:
      throw new Error(`Unsupported provider: ${config.provider}`);
  }
}
```

## Resolution Order

```
1. Request includes llmConfigId
   → Load LlmConfig from DB (isActive check)
   → Decrypt apiKeyEnc
   → getLlmProviderFromConfig(decryptedConfig)

2. No llmConfigId
   → getLlmProvider()  // reads LLM_PROVIDER env var (existing path, unchanged)
```

Retries always use the same provider instance resolved at step 1 or 2. No provider switching mid-generation loop.

## New Company-Scoped Endpoint

### `GET /api/v1/companies/[slug]/available-llms`

**Auth:** any company member (owner or editor)

**Response:**

```typescript
{
  data: Array<{
    id: string;
    displayName: string;
    provider: LlmProvider;
    model: string;
    isDefault: boolean; // true = matches current LLM_PROVIDER env var
  }>;
}
```

**Never expose:** `apiKeyEnc`, `baseUrl`, `createdBy`, raw provider names with secrets.

**Service:** `lib/services/company/get-available-llms.service.ts`

- Queries `prisma.llmConfig.findMany({ where: { isActive: true }, select: { id, provider, modelName } })`
- Builds display name from provider + model
- Marks `isDefault` by comparing provider to `process.env.LLM_PROVIDER`

## Generation Service Changes

### `generate-draft-post.service.ts`

Add `llmConfigId?: string` to the generation options parameter:

```typescript
let llmProvider: ILlmProvider;
let resolvedProvider: string;
let resolvedModel: string;

if (options.llmConfigId) {
  const config = await prisma.llmConfig.findUnique({
    where: { id: options.llmConfigId, isActive: true },
    select: { provider: true, modelName: true, apiKeyEnc: true, baseUrl: true },
  });
  if (!config) return { success: false, code: "LLM_CONFIG_NOT_FOUND" };
  const apiKey = decrypt(config.apiKeyEnc);
  llmProvider = getLlmProviderFromConfig({ ...config, apiKey });
  resolvedProvider = config.provider;
  resolvedModel = config.modelName;
} else {
  llmProvider = getLlmProvider();
  const info = getLlmProviderInfo();
  resolvedProvider = info.provider;
  resolvedModel = info.model;
}
```

Store in `promptSnapshot`:

```typescript
promptSnapshot: {
  // ... existing fields ...
  llmConfigId: options.llmConfigId ?? null,
  llmProvider: resolvedProvider,
  llmModel: resolvedModel,
}
```

## UI Changes

### Post Generation Modal

Add an **LLM** dropdown (optional, defaults to system default):

- Options populated from `GET .../available-llms`
- Default option: "System default (auto)"
- Each option shows: provider name + model name

### Post Detail / Debug View

Show which LLM was used (from `Post.llmProvider` + `Post.llmModel`). Already stored by existing code; just surface it.

## Acceptance Criteria

- [ ] `GET .../available-llms` returns no API keys, `baseUrl`, or encrypted fields
- [ ] `text_worker` added to `LlmProvider` enum; migration applied
- [ ] Generation with explicit `llmConfigId` uses that config's provider and model
- [ ] Generation without `llmConfigId` uses `getLlmProvider()` (env-var path, unchanged)
- [ ] Invalid or inactive `llmConfigId` returns `LLM_CONFIG_NOT_FOUND` error
- [ ] `promptSnapshot.llmConfigId` populated when config was explicitly selected; null otherwise
- [ ] Retries use the same provider instance — no mid-loop switching
- [ ] `TextWorkerProvider` not re-implemented; existing class reused
- [ ] EN and BG i18n for dropdown labels
- [ ] `npm run typecheck && npm run lint` clean

## Edge Cases

- `TextWorkerProvider` requires `TEXT_WORKER_URL` env var; if missing when `text_worker` config is selected, throw `PROVIDER_CONFIG_MISSING` before any API call
- `isActive = false` on `LlmConfig` at generation time → treat as not found (same as deleted)
- Admin deletes `LlmConfig` that was used in a past generation: `promptSnapshot` still records the original `provider` and `model` strings (not a FK — safe)
- Two concurrent generations for the same company using different `llmConfigId` values: independent factory calls, no shared state
