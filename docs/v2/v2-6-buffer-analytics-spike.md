# v2-6 — Buffer Analytics Spike

## Goal

Determine what engagement metrics Buffer's GraphQL API provides before designing any analytics schema. v2-7 cannot begin until this spike is documented.

## Why a Spike First

`BufferClient` currently has four methods: `getProfiles()`, `publishUpdate()`, `getPostLink()`, `validateConnection()`. No analytics method exists. The data model, available metrics, and rate limits are unknown. Schema design before the spike risks building the wrong tables.

## Spike Tasks

### 1. GraphQL Introspection

Using the existing OAuth token stored in `BufferConnection.accessTokenEnc` (decrypt via `lib/security/encryption.ts`):

- Introspect the Buffer GraphQL schema: `{ __schema { queryType { fields { name } } } }`
- Find analytics-adjacent query fields (look for: `analytics`, `metrics`, `insights`, `post`, `update`, `stats`)
- Document all found fields with their argument signatures and return types

### 2. Per-Post Metrics

For a known published post (use `Post.bufferUpdateId`):

- Query available engagement fields: `likes`, `reactions`, `comments`, `shares`, `clicks`, `reach`, `impressions`, `engagementRate`
- Note which fields are null vs populated for each channel type
- Determine if values are cumulative lifetime totals or point-in-time snapshots

### 3. Aggregation and History

- Determine if historical metrics are available (e.g., day-over-day snapshots)
- Check if there is a date range or period filter on metric queries
- Determine if metrics are available for posts older than 28 days

### 4. Rate Limits

- Check for rate limit headers on analytics queries
- Document request budget: requests/minute, requests/day, or cost-per-query
- Assess feasibility of a cron step syncing ~15 posts per run

### 5. OAuth Scope

- Determine if current `access_token` covers analytics queries
- If a separate token or scope is required, document what OAuth permission is needed
- Check if users must re-authorize Buffer to grant analytics access

### 6. Per-Channel Availability

| Channel   | Confirmed available metrics |
| --------- | --------------------------- |
| Facebook  | (to be filled)              |
| Instagram | (to be filled)              |
| LinkedIn  | (to be filled)              |
| TikTok    | (to be filled)              |

### 7. Engagement Rate

- Does Buffer provide a native `engagementRate` field?
- If calculated manually: what is the denominator per channel (reach, impressions, followers)?
- Is the denominator always available, or can it be null?

## Output Format

Document findings in this file under a `## Findings` section. Include:

- Raw GraphQL query used
- Sample response (redact token values)
- Conclusions for each of the 7 areas above

Confirm or reject these v2-7 design assumptions:

- [ ] Metrics are available per post (not only per page/account)
- [ ] Current OAuth scope is sufficient
- [ ] No personal API key required (beyond existing OAuth token)
- [ ] At least: reactions/likes, comments, and one denominator field available per channel
- [ ] Data is available for posts published in the past 30 days

## Gate

**v2-7 cannot start until all 7 spike tasks are documented here.**

If analytics are not available via the current Buffer OAuth token and GraphQL API:

- Option A: Abandon v2-7 for this release
- Option B: Evaluate Buffer Analyze product or a third-party analytics API
- Option C: Build a lightweight click-tracking system (no external dependency)

Decision required before v2-7 work begins.

---

## Findings

_(To be filled in after spike is executed)_
