# Version 2 Implementation Plan

> **Status:** Revised Draft · 2026-07-13
> **Codebase inspected:** Prisma schema, LLM factory, ingest service, generate-draft-post, generate-weekly-schedule, buffer-client, image providers, prompt-builder.

---

## Scope

Eight features shipped after all v1 milestones are production-stable. Each phase has a standalone phase document in [docs/v2/](docs/v2/).

---

## Existing Features to Reuse

| Asset                                                       | Used by                                               |
| ----------------------------------------------------------- | ----------------------------------------------------- |
| `TextWorkerProvider` (`lib/ai/llm/text-worker.provider.ts`) | v2-5 — Qwen/Ollama already implemented                |
| `ILlmProvider` interface + `getLlmProvider()`               | v2-5 — extend, not replace                            |
| `Post.llmProvider`, `Post.llmModel`, `Post.promptSnapshot`  | v2-5 — generation traceability already stored         |
| `buildImagePrompt()` + `channelDimensions()`                | v2-2 — extend with structured config                  |
| `MediaAsset.aiPrompt`                                       | v2-2 — extend to `generationConfig` JSON              |
| `CHANNEL_RULES` in `prompt-builder.ts`                      | v2-3 — refactor into policy model                     |
| `SocialChannel` enum (includes `tiktok`)                    | v2-3 — TikTok already supported                       |
| `FeedItem.enabled`, `FeedItem.usedInPost`                   | v2-4, v2-8 — reuse in translation batch and mix rules |
| `runSourceIngestion()`                                      | v2-4 — call translation step after ingest             |
| `generatePostFromContext()`                                 | v2-8 — already accepts `scheduleId`                   |
| `WeeklySchedule` model                                      | v2-8 — attach `ScheduleAllocation` to it              |
| `encryption.ts` AES-256 utilities                           | v2-7 — if analytics token needed post-spike           |
| `AuditLog` + `AUDIT_ACTIONS`                                | All phases — log new action types                     |

**Architecture notes (confirmed):**

- The LLM factory reads **environment variables**, not the `llm_configs` DB table at runtime.
- `text-worker` (Qwen/Ollama) is already implemented; do not re-implement from scratch.
- Buffer `BufferClient` currently has no analytics method; a spike is required before schema design.
- RSS `FeedItem.title` and `FeedItem.content` must never be overwritten by translations.

---

## Implementation Phases

### v2-1 — Source Link Resolution

[→ docs/v2/v2-1-source-links.md](docs/v2/v2-1-source-links.md)

**Goal:** Control whether the source article URL appears in generated posts. URL is appended programmatically by the service, never by the LLM.

**Main changes:**

- Add `includeSourceLink Boolean @default(false)` to `channel_configs`.
- Three-level resolution: manual override → content source config → channel default.
- If the post exceeds `maxTextLength` after appending the URL, shorten or regenerate the post text — **never truncate the URL** (a truncated URL is invalid).
- Store `sourceUrl` and `includeSourceLink` in `Post.promptSnapshot`.

**Dependencies:** None.

**Acceptance criteria:**

- URL appended by service, not LLM; appears at most once.
- `includeSourceLink = false` leaves LLM-generated CTAs untouched.
- Post exceeding platform limit returns a validation error or triggers text shortening; URL is never partial.

---

### v2-2 — Image Generation Style Options

[→ docs/v2/v2-2-image-options.md](docs/v2/v2-2-image-options.md)

**Goal:** Let users choose a visual style, mood, and constraints when generating images. Full config saved with `MediaAsset`.

**Main changes:**

- New `ImageGenerationConfig` type (visualStyle, mood, includesPeople, textInImage, useBrandColors, additionalInstructions).
- Extend `buildImagePrompt()` to accept structured config; convert unsupported options to prompt text.
- Add `generationConfig Json?` to `media_assets`.
- Style chip selector + mood dropdown in `ImagePickerModal` "AI Generate" tab.

**Dependencies:** None.

**Acceptance criteria:**

- Each visualStyle produces a distinct prompt prefix.
- `generationConfig` saved in `MediaAsset`.
- Existing generation path unchanged when no config provided.

---

### v2-3 — Channel Policy Model

[→ docs/v2/v2-3-channel-policies.md](docs/v2/v2-3-channel-policies.md)

**Goal:** Replace hardcoded platform claims in `CHANNEL_RULES` with a typed, maintainable policy model.

**Main changes:**

- New `lib/ai/channel-policy.ts` with `PlatformConstraint` (BLOCKING for verified publishing requirements) and `GenerationHint` (WARNING/SUGGESTION for best-practice recommendations).
- `prompt-builder.ts` reads hints from the policy model.
- `publish-post.service.ts` checks BLOCKING constraints before sending to Buffer.
- No database changes.

**Design rules:**

- BLOCKING = verified API behaviour (e.g., Instagram requires media).
- WARNING/SUGGESTION = informed recommendations, never stated as platform algorithm facts.
- TikTok is in scope (already in `SocialChannel`).

**Dependencies:** None.

**Acceptance criteria:**

- Instagram without media → BLOCKING prevents Buffer publish.
- `CHANNEL_POLICIES` is the single source of truth; no platform claims outside it.
- Existing `CHANNEL_RULES` strings removed.

---

### v2-4 — RSS Translation via LLM

[→ docs/v2/v2-4-rss-translation.md](docs/v2/v2-4-rss-translation.md)

**Goal:** Translate RSS feed content into the company's target language before generation. Original fields never overwritten.

**Main changes:**

- New nullable columns on `feed_items`: `translatedTitle`, `translatedContent`, `translationLanguage`, `translationStatus` (`pending | completed | failed | skipped`), `translationHash`, `translationError`, `translatedAt`, `translationProvider`, `translationModel`, `translationAttemptCount`, `translationLastAttemptAt`, `translationNextRetryAt`.
- Translation is asynchronous — ingest sets `translationStatus = 'pending'`; a bounded cron step (step 2b) runs translations.
- Skip re-translation when `sha256(title + content + targetLang)` hash is unchanged and status is `completed`.
- Failed translations are retryable with bounded backoff. Max attempt count enforced.
- Generation uses `translatedTitle`/`translatedContent` only when `translationStatus === 'completed'`; otherwise falls back to original `title`/`content`.

**Dependencies:** None (migration required).

**Acceptance criteria:**

- `title` and `content` unchanged after translation.
- Translation failure marks item `'failed'`, stores error, original used for generation.
- Fingerprint unchanged + completed → translation skipped.
- Failed items are retried on subsequent cron runs up to max attempts.

---

### v2-5 — Per-Generation LLM Model Selector

[→ docs/v2/v2-5-llm-selector.md](docs/v2/v2-5-llm-selector.md)

**Goal:** Let users select which configured LLM to use for a specific generation request.

**Main changes:**

- Add `text_worker` to `LlmProvider` Prisma enum.
- New `getLlmProviderFromConfig(config)` factory function — caller decrypts key before calling; factory never touches DB.
- New company-scoped safe endpoint `GET /api/v1/companies/[slug]/available-llms` returns only `{ id, displayName, provider, model, isDefault }` — no API keys, secrets, or internal URLs.
- Generation services accept optional `llmConfigId`; when set, load and use that config; otherwise use env-var default.
- Store `llmConfigId` in `Post.promptSnapshot`.
- Retries use the same provider instance; no provider switching mid-loop.

**Resolution order:** manual `llmConfigId` → env-var factory default.

**Dependencies:** None (enum migration required).

**Acceptance criteria:**

- `GET .../available-llms` exposes no sensitive fields.
- Generation with explicit `llmConfigId` uses that provider and model.
- Default generation path unchanged.

---

### v2-6 — Buffer Analytics Spike

[→ docs/v2/v2-6-buffer-analytics-spike.md](docs/v2/v2-6-buffer-analytics-spike.md)

**Goal:** Determine what analytics data Buffer provides before designing any schema.

**Deliverables:**

- Introspect Buffer GraphQL API with existing OAuth token.
- Document available metrics per channel, data types, aggregation windows, rate limits.
- Determine whether metrics are cumulative or point-in-time (affects snapshot aggregation strategy).
- Confirm whether historical post metrics are available.
- Determine whether current OAuth scope covers analytics or a separate token is required.
- Document findings before any v2-7 schema is applied.

**Dependencies:** None.

**Gate:** v2-7 cannot start until spike is documented.

---

### v2-7 — Engagement Analytics

[→ docs/v2/v2-7-buffer-analytics.md](docs/v2/v2-7-buffer-analytics.md)

**Goal:** Display per-post engagement metrics (reactions, comments, engagement rate) and aggregate weekly/monthly summaries.

**Main changes:**

- Two new tables: `post_metrics_current` (latest per post) and `post_metric_snapshots` (history for trends).
- Sync cron step (step 8, last, bounded) — updates `lastAttemptAt` on every attempt; updates `lastSuccessfulSyncAt` and clears `syncError` only on success; schedules `nextRetryAt` on failure using backoff.
- Engagement rate: use Buffer's native value when provided (`engagementRateSource = 'buffer_native'`); calculate only when valid denominator exists; store `engagementRateFormula` and `engagementRateDenominator`; return null when rate cannot be reliably calculated. Formula and denominator may differ per channel.
- Snapshot aggregation strategy (cumulative vs. per-period latest) determined by spike findings — do not sum snapshots blindly.
- New analytics tab in company workspace; metrics strip on published post cards.

**Dependencies:** v2-6 spike complete and documented.

**Acceptance criteria:**

- Spike documented before any migration applied.
- `lastSuccessfulSyncAt` updated only on success; `nextRetryAt` set on failure.
- `engagementRate = null` when denominator unavailable.
- Sync step bounded and non-blocking to publishing steps.

---

### v2-8 — Content Mix Scheduling Rules

[→ docs/v2/v2-8-content-mix.md](docs/v2/v2-8-content-mix.md)

**Goal:** Let owners define per-channel source allocations for the weekly post budget.

**Main changes:**

- Two new tables: `company_mix_rules` (owner template) and `schedule_allocations` (per `WeeklySchedule` instance).
- Unique constraint on allocations: partial unique indexes handle nullable `contentSourceId` (separate constraints for feed vs mission rows).
- Concurrency: atomic conditional update (`WHERE status = 'generating'`) prevents duplicate schedule generation in serverless environment — no session-level advisory locks.
- Fallback policies: `skip | use_another_source | use_company_profile | allow_reuse`.
- Reuse eligibility (when `allow_reuse`): must satisfy enabled state, same-schedule exclusion, cooldown, usage count, aspect similarity, and recent-post similarity. Full algorithm in phase doc.
- Each generated post stores `allocationId` and primary `feedItemId` in `promptSnapshot`.
- When no mix rules defined, existing source-pooling behaviour preserved.

**Dependencies:** v2-5 stable (shared generate path).

**Acceptance criteria:**

- Mix rule sum per channel must equal `channelConfig.postsPerWeek`; imbalanced rules rejected.
- Atomic status transition prevents duplicate generation.
- Partial unique indexes prevent duplicate mission allocations.
- `allow_reuse` items pass all eligibility checks before reuse.
- Default pooling behaviour unchanged when no rules defined.

---

## Database Change Summary

| Migration                           | Change                                                                                                | Phase |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------- | ----- |
| `add_channel_include_source_link`   | `channel_configs` + `include_source_link Boolean`                                                     | v2-1  |
| `add_media_asset_generation_config` | `media_assets` + `generation_config Json?`                                                            | v2-2  |
| `add_text_worker_llm_provider`      | `LlmProvider` enum + `text_worker` value                                                              | v2-5  |
| `add_feed_item_translation_fields`  | `feed_items` + 12 translation columns                                                                 | v2-4  |
| `add_analytics_tables`              | New tables: `post_metrics_current`, `post_metric_snapshots`                                           | v2-7  |
| `add_content_mix_tables`            | New tables: `company_mix_rules`, `schedule_allocations`; `feed_items` + `last_used_at`, `usage_count` | v2-8  |

All migrations are additive. No existing columns modified or dropped.

---

## Product Decisions Required

1. **v2-1** — When `includeSourceLink = false` at channel level but a manual override sets it `true`, should the UI show a confirmation?
2. **v2-3** — Should owners be able to disable individual generation hints (e.g., for a text-only brand)?
3. **v2-4** — Maximum translations per cron batch (token cost vs. latency trade-off; suggested default: 10).
4. **v2-5** — Should per-channel LLM defaults be added in v2, or is manual per-generation selection sufficient?
5. **v2-7** — Maximum metric sync posts per cron run (suggested default: 15).
6. **v2-7** — `PostMetricSnapshot` retention period (suggested: 90 days).
7. **v2-8** — Scheduling unit: per-channel posts (Model B, default) or unique content topics with per-channel variants (Model A)?
8. **v2-8** — Minimum reuse cooldown (suggested default: 30 days).

---

## Risks

| Risk                                                   | Impact | Mitigation                                                                              |
| ------------------------------------------------------ | ------ | --------------------------------------------------------------------------------------- |
| Buffer GraphQL has no analytics                        | High   | Spike first (v2-6); if unavailable, abandon or seek third-party                         |
| Translation LLM costs at scale                         | Medium | Fingerprint skip; bounded batch; max retry cap                                          |
| Cron 60s timeout with new steps                        | Medium | Translation (step 2b) and analytics (step 8) are bounded and last; skippable on timeout |
| Qwen/text-worker unavailable on Vercel                 | Medium | Missing env key → `NO_ACTIVE_PROVIDER`; falls back to default — no change from v1       |
| Duplicate schedule generation (serverless concurrency) | Low    | Atomic conditional update; unique constraint on allocations                             |

---

## Definition of Done

- [ ] `FeedItem.title` and `.content` unchanged after any translation
- [ ] Source URL appended by service exactly once; never truncated; post text shortened or error returned on length overflow
- [ ] Translation failures retried up to max attempts with backoff; original content used until `translationStatus === 'completed'`
- [ ] Channel BLOCKING constraints prevent Buffer publish for verified violations
- [ ] Platform policy constants are the single source of truth; no claims outside them
- [ ] `GET .../available-llms` exposes no API keys or sensitive config
- [ ] `promptSnapshot` stores `llmConfigId`, `llmProvider`, `llmModel`, `sourceUrl`, `allocationId`
- [ ] Analytics `lastSuccessfulSyncAt` updated only on success; `engagementRate = null` when denominator missing
- [ ] Buffer analytics spike documented before any analytics migration applied
- [ ] Mix rules: sum validation per channel; partial unique indexes; atomic concurrency guard
- [ ] All new fields have EN and BG translations in `i18n/messages/`
- [ ] `npm run typecheck && npm run lint && npm run build` pass with zero errors
