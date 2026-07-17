# v2-8 — Content Mix Scheduling Rules

> **⚠️ Superseded in part — implemented 2026-07-16.** Two product decisions taken at
> implementation time override this document. It is kept for the reasoning behind
> the deferred parts; **`lib/scheduling/content-mix.ts` is the source of truth**
> for what actually ships.
>
> 1. **Scheduling unit: "one shared recipe", not Model B.** Quotas are company-wide
>    (`ContentSource.postsPerWeek`, `Company.companyContentPostsPerWeek`) and the same
>    distribution is applied to every enabled channel — so all enabled channels must
>    share one `postsPerWeek`. The `company_mix_rules` / `schedule_allocations` tables
>    below were **not** created; four additive columns cover it. This resolves open
>    Product Decision #7 in the v2 plan.
> 2. **Fallback policies: "skip now, policies later".** `ContentSource.fallbackPolicy`
>    carries the full vocabulary below so a later phase needs no migration, but only
>    `skip` is implemented and validation **rejects** the others rather than silently
>    treating them as skip. The reuse-eligibility algorithm and the
>    `FeedItem.lastUsedAt` / `usageCount` columns are **deferred**.
>
> Still accurate below: the sum-validation rule, and the reuse algorithm as a spec for
> whoever implements `allow_reuse`.

## Goal

Let owners define per-channel source allocations for the weekly post budget. When rules are defined, the scheduler draws from specific sources in defined proportions. When no rules exist, existing source-pooling behaviour is preserved unchanged.

## Scheduling Unit

> **Superseded — see the banner above. Shipped as one company-wide recipe applied to every channel.**

**Model B (default):** Rules are defined per channel. Each allocation specifies "N posts from source X on channel Y per week."

This means the same article may generate separate posts for Facebook and LinkedIn. Model B is simpler to implement with the existing per-channel generation path.

_(Model A — unique content topics with per-channel variants — deferred unless product explicitly requests it.)_

## Schema Changes

> **Superseded — not implemented.** What actually shipped (migration
> `20260716040000_add_content_mix_distribution`) is four additive fields:
>
> ```prisma
> model Company       { companyContentPostsPerWeek Int? @map("company_content_posts_per_week") }
> model ContentSource { postsPerWeek Int? @map("posts_per_week")
>                       fallbackPolicy String @default("skip") @map("fallback_policy") }
> model Post          { contentSourceId String? @map("content_source_id") } // null = company content
> ```
>
> `Post.contentSourceId` is not in the original design but is required: evergreen and
> mission posts both leave `primaryFeedItemId` null, so source attribution cannot
> otherwise be derived. NULL vs 0 is meaningful in both quota columns — NULL means "no
> mix", which is what preserves the legacy pooling path.

```prisma
model CompanyMixRule {
  id              String        @id @default(uuid())
  companyId       String        @map("company_id")
  channel         SocialChannel
  contentSourceId String?       @map("content_source_id")  // null = company mission/profile
  postsPerWeek    Int           @map("posts_per_week")
  priority        Int           @default(0)                // higher = higher fill priority
  fallbackPolicy  String        @map("fallback_policy")    // skip|use_another_source|use_company_profile|allow_reuse
  createdAt       DateTime      @default(now()) @map("created_at")
  updatedAt       DateTime      @updatedAt @map("updated_at")

  company       Company       @relation(fields: [companyId], references: [id], onDelete: Cascade)
  contentSource ContentSource? @relation(fields: [contentSourceId], references: [id])

  @@index([companyId, channel])
  @@map("company_mix_rules")
}

model ScheduleAllocation {
  id              String         @id @default(uuid())
  scheduleId      String         @map("schedule_id")
  mixRuleId       String         @map("mix_rule_id")
  channel         SocialChannel
  contentSourceId String?        @map("content_source_id")  // null = mission post
  targetCount     Int            @map("target_count")
  generatedCount  Int            @default(0) @map("generated_count")
  status          String         @default("pending")         // pending|generating|completed|failed
  createdAt       DateTime       @default(now()) @map("created_at")

  schedule  WeeklySchedule @relation(fields: [scheduleId], references: [id], onDelete: Cascade)
  mixRule   CompanyMixRule @relation(fields: [mixRuleId], references: [id])

  @@index([scheduleId])
  @@map("schedule_allocations")
}
```

### FeedItem additions

```prisma
model FeedItem {
  // ... existing fields ...
  lastUsedAt  DateTime? @map("last_used_at")
  usageCount  Int       @default(0) @map("usage_count")
}
```

### Partial Unique Indexes

PostgreSQL `NULL != NULL`, so a regular unique constraint on nullable `contentSourceId` will not prevent duplicate mission allocations. Use partial indexes instead:

```sql
-- One mission allocation per schedule per channel
CREATE UNIQUE INDEX schedule_alloc_mission_unique
  ON schedule_allocations (schedule_id, channel)
  WHERE content_source_id IS NULL;

-- One feed allocation per schedule per channel per source
CREATE UNIQUE INDEX schedule_alloc_feed_unique
  ON schedule_allocations (schedule_id, channel, content_source_id)
  WHERE content_source_id IS NOT NULL;
```

Add these as raw SQL in the Prisma migration file (not expressible in Prisma schema DSL).

Migration: `add_content_mix_tables`

## Concurrency Guard

### Problem

In a serverless environment, two simultaneous cron invocations could both read `WeeklySchedule.status = 'generating'` and attempt to generate posts for the same schedule.

### Solution: Atomic Conditional Update

No advisory locks. Use a single atomic `UPDATE ... WHERE status = 'pending'`:

```typescript
const result = await prisma.weeklySchedule.updateMany({
  where: { id: scheduleId, status: "generating" },
  data: { status: "generating" }, // no-op field change; we just need the WHERE
});

// Actually: transition from pending → generating atomically
const claimed = await prisma.weeklySchedule.updateMany({
  where: { id: scheduleId, status: "pending" },
  data: { status: "generating" },
});
if (claimed.count === 0) return; // another invocation claimed it
```

Only the invocation that successfully transitions `status = 'pending' → 'generating'` proceeds. All others return immediately.

## Mix Rule Validation

Before saving or applying rules, validate:

```typescript
function validateMixRules(rules: CompanyMixRule[], channelConfig: ChannelConfig): ValidationResult {
  const channelRules = rules.filter((r) => r.channel === channelConfig.channel);
  const totalAllocated = channelRules.reduce((sum, r) => sum + r.postsPerWeek, 0);
  if (totalAllocated !== channelConfig.postsPerWeek) {
    return {
      valid: false,
      error: `Rules sum to ${totalAllocated} posts but channel budget is ${channelConfig.postsPerWeek}`,
    };
  }
  return { valid: true };
}
```

Rules that do not sum to `postsPerWeek` are rejected at save time. API returns `422 UNPROCESSABLE_ENTITY`.

## Fallback Policies

> **Only `skip` is implemented.** The column accepts the vocabulary below so a later
> phase needs no migration; anything other than `skip` is rejected at validation with
> `MIX_UNSUPPORTED_FALLBACK`. Note `use_another_source` conflicts with the shipped
> requirement that quotas are never reassigned — revisit that tension before
> implementing it.

| Policy                | Behaviour when source runs out of eligible items                          |
| --------------------- | ------------------------------------------------------------------------- |
| `skip`                | Do not generate a post for this slot; leave budget unfilled               |
| `use_another_source`  | Draw from any other enabled source for this channel                       |
| `use_company_profile` | Generate a mission/brand post using `BrandGuidelines` context             |
| `allow_reuse`         | Reuse an eligible previously-used feed item (see reuse eligibility below) |

## Reuse Eligibility (when `allow_reuse`)

> **Deferred — not implemented.** Retained as the spec for whoever adds `allow_reuse`.
> Requires the `FeedItem.lastUsedAt` / `usageCount` columns above, which were also
> deferred.

An item is eligible for reuse only if it passes **all** of the following:

1. **Enabled:** `FeedItem.enabled = true`
2. **Same-schedule exclusion:** not already used in the current `WeeklySchedule`
3. **Cooldown:** `lastUsedAt < now() - REUSE_COOLDOWN_DAYS` (default: 30 days, product decision)
4. **Usage count cap:** `usageCount < MAX_REUSE_COUNT` (default: 3; prevent perpetual recycling)
5. **Aspect similarity:** if the schedule already has a post with the same `contentAngle` and `contentPattern`, prefer a different item
6. **Recent-post similarity:** compare embedding or keyword overlap against posts generated in the past 14 days; exclude items too similar to recent output

Items failing any check are excluded. If no eligible items remain after all checks, fall through to `use_company_profile`.

## Scheduler Integration

### `generate-weekly-schedule.service.ts`

```typescript
async function generateWithMixRules(
  companyId: string,
  schedule: WeeklySchedule,
  channels: ChannelConfig[]
): Promise<void> {
  const mixRules = await prisma.companyMixRule.findMany({ where: { companyId } });

  if (mixRules.length === 0) {
    // No rules — use existing source-pooling behaviour (unchanged)
    return generateWithSourcePooling(companyId, schedule, channels);
  }

  // Create allocations
  const allocations = buildAllocations(mixRules, schedule.id);
  await prisma.scheduleAllocation.createMany({ data: allocations, skipDuplicates: true });

  // Process allocations in priority order
  for (const allocation of prioritizedAllocations) {
    await generatePostsForAllocation(allocation, schedule, companyId);
  }
}
```

Each generated post stores `allocationId` in `promptSnapshot`. `FeedItem.usageCount` incremented and `lastUsedAt` stamped after successful generation.

## UI Changes

### Company Settings — Content Mix tab

- Per-channel rule builder: source selector + posts-per-week counter
- Sum validation shown live (must equal `postsPerWeek`)
- Fallback policy dropdown per rule
- Save blocked until sum is valid

## Acceptance Criteria

- [ ] Rules summing to ≠ `postsPerWeek` rejected at API level with 422
- [ ] `status = 'pending' → 'generating'` atomic conditional update; duplicate invocations return immediately
- [ ] Partial unique indexes prevent duplicate mission and feed allocations per schedule
- [ ] `allow_reuse` items pass all 6 eligibility checks before selection
- [ ] `FeedItem.usageCount` incremented; `lastUsedAt` stamped on successful post generation
- [ ] `promptSnapshot.allocationId` populated for all mix-rule-generated posts
- [ ] When no mix rules defined: existing `MAX_GENERATIONS_PER_RUN = 3` pooling path runs unchanged
- [ ] EN and BG i18n for all new UI labels
- [ ] `npm run typecheck && npm run lint` clean

## Edge Cases

- Channel has mix rules but all sources are disabled: all allocations fall through to fallback policy
- `postsPerWeek` changed after rules saved: rules become invalid (sum mismatch); UI should show warning and require re-save
- `WeeklySchedule` already in `completed` status when cron runs: skip entirely (don't downgrade to `generating`)
- Source deleted after mix rule created: `contentSourceId` FK cascade deletes the mix rule; company receives notification (or rule becomes orphaned — define behaviour)
- Aspect similarity check requires `promptSnapshot.contentAngle` field: ensure it is stored by generation service (already in existing `promptSnapshot` structure per `generate-draft-post.service.ts`)
