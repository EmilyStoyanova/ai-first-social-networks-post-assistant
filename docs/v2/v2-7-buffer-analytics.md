# v2-7 — Engagement Analytics

> **UNBLOCKED 2026-07-20 — building on a per-company Buffer Personal API Key.**
> The v2-6 spike's one open question was answered by live probe: a Personal API Key **does**
> grant `insights:read`. OAuth still owns publishing; the key is analytics-read only.
> The `insights:read` OAuth scope remains unobtainable — that finding is unchanged.
>
> **The provisional schema below is superseded.** It is kept for history only. Live data
> contradicts the spike's per-channel matrix (see
> [Verified findings](./v2-6-buffer-analytics-spike.md#verified-findings-2026-07-20)), and
> `Int?` columns still conflate "unsupported" with zero. The shipped design stores a metric
> only when its type is present in Buffer's response array, keys channel off Buffer's
> `channelService` rather than `Post.channel`, and preserves the raw array in a `Json`
> column.

> **Prerequisite:** v2-6 spike must be completed and findings documented before any schema or code work begins.

## Goal

Display per-post engagement metrics (reactions/likes, comments, shares, engagement rate) and aggregate weekly/monthly summaries across channels.

## Schema Changes

> **Note:** Exact field selection depends on v2-6 spike findings. The structure below is provisional and must be reconciled with actual Buffer API capabilities.

```prisma
model PostMetricCurrent {
  id              String    @id @default(uuid())
  postId          String    @unique @map("post_id")
  channel         SocialChannel
  likes           Int?
  comments        Int?
  shares          Int?
  clicks          Int?
  reach           Int?
  impressions     Int?
  engagementRate          Float?  @map("engagement_rate")
  engagementRateSource    String? @map("engagement_rate_source")    // 'buffer_native' | 'calculated'
  engagementRateFormula   String? @map("engagement_rate_formula")   // e.g. "(likes+comments)/reach"
  engagementRateDenominator String? @map("engagement_rate_denominator") // e.g. "reach"
  lastAttemptAt           DateTime? @map("last_attempt_at")         // updated on every sync attempt
  lastSuccessfulSyncAt    DateTime? @map("last_successful_sync_at") // updated only on success
  nextRetryAt             DateTime? @map("next_retry_at")           // set on failure
  syncError               String?   @map("sync_error")              // cleared on success
  syncedAt                DateTime? @map("synced_at")               // alias for lastSuccessfulSyncAt (UI display)
  createdAt               DateTime  @default(now()) @map("created_at")
  updatedAt               DateTime  @updatedAt @map("updated_at")

  post Post @relation(fields: [postId], references: [id], onDelete: Cascade)

  @@map("post_metrics_current")
}

model PostMetricSnapshot {
  id          String    @id @default(uuid())
  postId      String    @map("post_id")
  channel     SocialChannel
  snapshotAt  DateTime  @map("snapshot_at")
  likes       Int?
  comments    Int?
  shares      Int?
  clicks      Int?
  reach       Int?
  impressions Int?
  engagementRate Float?  @map("engagement_rate")
  createdAt   DateTime  @default(now()) @map("created_at")

  post Post @relation(fields: [postId], references: [id], onDelete: Cascade)

  @@index([postId, snapshotAt(sort: Desc)])
  @@map("post_metric_snapshots")
}
```

Migration: `add_analytics_tables`

## Sync Architecture

### Cron Step 8 (last, bounded) — SUPERSEDED

> **As built, this is no longer a step of the generation cron.** The sync is its own queue job
> (`ANALYTICS_SYNC_JOB_TYPE` → `runAnalyticsCron`), enqueued by the generation cron tick and
> also triggerable at `/api/v1/internal/cron/analytics`. It is never executed inline inside the
> generation run. Batch sizes are `PER_COMPANY_RUN_LIMIT` (100/company/run) under a
> `DAILY_REQUEST_BUDGET` (200/company/day), not 15, and selection is stalest-first rather than
> the ordering sketched below. There is also no manual "refresh" button — the daily job is the
> only refresh path. See [v2-9-split-cron.md](./v2-9-split-cron.md#buffer-analytics--a-fourth-job-on-the-third-schedule).

- Runs after all other cron steps; skippable on 60s timeout
- Processes up to `METRIC_SYNC_BATCH_SIZE` posts per run (default: 15, product decision required)
- Eligible posts: `status = 'published'`, `bufferUpdateId IS NOT NULL`

**Eligibility ordering:**

```sql
ORDER BY
  COALESCE(m.next_retry_at, '1970-01-01') ASC,
  COALESCE(m.last_successful_sync_at, '1970-01-01') ASC
LIMIT METRIC_SYNC_BATCH_SIZE
```

**On each sync attempt:**

1. Update `lastAttemptAt = now()` immediately (even before API call)
2. Call Buffer API for metrics
3. **On success:**
   - Update `PostMetricCurrent` with fresh values
   - Update `lastSuccessfulSyncAt = now()`, `syncError = null`, `nextRetryAt = null`
   - Insert `PostMetricSnapshot` row
4. **On failure:**
   - Update `syncError = error.message`
   - Set `nextRetryAt` using backoff schedule
   - Do NOT update `lastSuccessfulSyncAt`

**Never update `lastSuccessfulSyncAt` on failure** — the field must accurately reflect the last known-good sync.

### Backoff Schedule

| Attempt | Delay                                      |
| ------- | ------------------------------------------ |
| 1       | 10 min                                     |
| 2       | 1 h                                        |
| 3       | 6 h                                        |
| 4+      | 24 h (repeat; no cap on analytics retries) |

## Engagement Rate

**Resolution order:**

1. Use Buffer's native `engagementRate` if provided → set `engagementRateSource = 'buffer_native'`
2. Calculate if a reliable denominator exists for this channel:
   - Facebook/Instagram: `(likes + comments + shares) / reach` (if reach > 0)
   - LinkedIn: `(likes + comments + clicks) / impressions` (if impressions > 0)
   - TikTok: per spike findings
3. If denominator is 0 or null → `engagementRate = null`

Always store `engagementRateFormula` and `engagementRateDenominator` for transparency. Return `null` rather than a misleading rate when the denominator is unavailable.

## Snapshot Aggregation

Aggregation strategy depends on whether Buffer returns cumulative or point-in-time values — determined by spike:

- **Cumulative (lifetime totals):** Use the latest snapshot value for the period. Do not sum snapshots.
- **Point-in-time (delta):** Sum snapshots within the period to get total engagement.

Weekly/monthly summary queries must use the correct strategy per metric based on spike findings.

## Snapshot Retention

`PostMetricSnapshot` rows older than `METRIC_SNAPSHOT_RETENTION_DAYS` (default: 90, product decision required) should be pruned by a maintenance cron step to control table growth.

## Buffer Client Extension

### `lib/buffer/buffer-client.ts`

Add `getPostMetrics(updateId: string)` method based on spike-confirmed query:

```typescript
async getPostMetrics(updateId: string): Promise<RawBufferMetrics | null> {
  // GraphQL query determined by v2-6 spike
}
```

`RawBufferMetrics` shape defined after spike findings are documented.

## UI Changes

### Analytics tab — company workspace

- Per-channel metric summary cards: total reactions, comments, engagement rate (30-day period)
- Published posts list with metric columns: likes, comments, eng. rate, last sync time
- Sync status indicator: synced / syncing / failed (with error summary)

### Post cards (published status)

Metrics strip below post content: 👍 reactions · 💬 comments · 📊 engagement rate

### Post Detail / Approval view

Full metric breakdown with sync timestamp and source indicator (`Buffer native` / `Calculated`).

## Acceptance Criteria

- [ ] v2-6 spike is documented before any migration is applied
- [ ] `lastAttemptAt` updated on every sync attempt (success or failure)
- [ ] `lastSuccessfulSyncAt` updated only on success; never on failure
- [ ] `nextRetryAt` set with backoff on failure; cleared on success
- [ ] `syncError` cleared on success; populated with message on failure
- [ ] `engagementRate = null` when denominator is 0 or unavailable
- [ ] `engagementRateSource` distinguishes `buffer_native` from `calculated`
- [ ] Aggregation strategy (cumulative vs delta) matches spike findings
- [ ] `METRIC_SYNC_BATCH_SIZE` enforced; cron step does not exceed limit
- [ ] Snapshot retention pruning scheduled or documented
- [ ] EN and BG i18n for all UI labels
- [ ] `npm run typecheck && npm run lint` clean

## Edge Cases

- `bufferUpdateId` null (draft post promoted without Buffer send): skip sync; no metric row created
- Buffer returns HTTP 404 for old post: mark `syncError = 'post_not_found'`; set long `nextRetryAt` (7 days) to avoid burn
- All metric fields null from Buffer: store row with all nulls; do not treat as failure
- Post deleted from Buffer but still in our DB: mark `syncError = 'post_deleted_on_buffer'`; no further retries
