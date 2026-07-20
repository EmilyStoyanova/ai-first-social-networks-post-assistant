# v2-6 — Buffer Analytics Spike

> **Status: SUPERSEDED IN PART — 2026-07-20.** The ABANDON decision below was correct for the
> OAuth flow and is unchanged: `insights:read` is not obtainable by an OAuth App Client.
> But the spike's one explicitly-unverified question — _does a Personal API Key actually
> grant `insights:read`?_ — has now been answered **YES** by live probe.
> **v2-7 is unblocked and building.** Several per-channel claims below, drawn from Buffer's
> Help Center rather than observation, are contradicted by real data.
> **Read [Verified findings (2026-07-20)](#verified-findings-2026-07-20) before trusting any
> matrix in this document.**

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

See [Supported Metrics Matrix by Channel](#supported-metrics-matrix-by-channel) under Findings.
No metric could be **confirmed** live: the scope block (task 5) returns `null` for every
metric on every channel, so per-channel availability is documented from the schema and
Buffer's own docs, not from observation.

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

- [x] **CONFIRMED** — Metrics are available per post (not only per page/account): `Post.metrics: [PostMetric!]`
- [ ] **REJECTED** — Current OAuth scope is sufficient. `insights:read` is required and is **not obtainable** by an OAuth App Client.
- [ ] **REJECTED** — No personal API key required. A Personal API Key is currently the only documented way to read insights.
- [ ] **UNVERIFIABLE** — Per-channel metric availability cannot be observed while the scope is blocked.
- [ ] **UNVERIFIABLE** — 30-day availability cannot be observed. Posts aged 2.1d and 3.8d were blocked by scope, not by age.

## Gate

**v2-7 cannot start until all 7 spike tasks are documented here.**

If analytics are not available via the current Buffer OAuth token and GraphQL API:

- Option A: Abandon v2-7 for this release
- Option B: Evaluate Buffer Analyze product or a third-party analytics API
- Option C: Build a lightweight click-tracking system (no external dependency)

Decision required before v2-7 work begins.

---

## Findings

_Executed 2026-07-17 against the live Buffer API (`https://api.buffer.com`) using the real
OAuth tokens stored in `buffer_connections`. All probes were read-only: introspection,
`post`, `channels`, `account`, and `aggregatedPostMetrics` queries only. Nothing was
published, modified, or deleted. The one write performed was mandatory and unrelated to
Buffer content — persisting rotated refresh tokens back to `buffer_connections`, because
Buffer refresh tokens are single-use and consuming one without saving its replacement
would have broken the live connections._

### Decision: ABANDON (v2-7 as specified)

**Buffer's API has everything v2-7 needs, and our OAuth client is structurally unable to
read it.** The blocker is not a missing field, a plan tier, or a bug in our integration —
it is that the `insights:read` scope is not offered to OAuth App Clients at all. No amount
of implementation work on our side removes it.

The good news is that this was cheap to learn and the answer is unambiguous. The bad news
is that it is not a "try harder" problem: reopening v2-7 depends on an authentication model
change (see [Alternatives](#realistic-alternatives)), not on effort.

### 1. Summary of each spike task

| #   | Question                                           | Answer                                                                                                                     |
| --- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 1   | Can the existing OAuth token retrieve analytics?   | **No.** Every metrics field returns `null` with an `INSUFFICIENT_SCOPE` error. Requires `insights:read`; we cannot get it. |
| 2   | Which endpoint/query exists?                       | **Two, both scope-gated:** `post(input:{id}).metrics` (per-post) and `aggregatedPostMetrics(input:{...})` (roll-up).       |
| 3   | Which metrics per channel?                         | 16 metric types exist in `PostMetricType`; per-channel availability **not observable** while blocked. See matrix.          |
| 4   | Can metrics be fetched by stored `bufferUpdateId`? | **Yes — the ID model is a perfect fit.** `post(input:{id})` accepts our stored ID verbatim; 8/8 posts resolved.            |
| 5   | Extra scopes / API key / Buffer Analyze needed?    | **`insights:read` scope, unavailable to OAuth App Clients.** A Personal API Key is the documented alternative.             |
| 6   | Rate limits / retention?                           | 100/15min, 250/day, 3000/30day (Free). Metrics refresh **once daily** (~24h lag). No historical/time-series surface.       |
| 7   | All connected networks or only some?               | Metric _coverage_ differs sharply per network (TikTok thinnest, no reach/impressions). Unverifiable live.                  |
| 8   | Is v2-7 technically viable?                        | **Not on the current OAuth token flow.** Viable only via a different authentication model.                                 |

### 2. GraphQL introspection — analytics surfaces exist

Introspection is fully enabled. The schema has exactly two analytics entry points.

```graphql
query {
  __schema {
    queryType {
      fields {
        name
        args {
          name
        }
      }
    }
  }
}
```

Root query fields (11 total):

```
account(), dailyPostingLimits(input), channel(input), channels(input),
aggregatedPostMetrics(input),          # ← analytics roll-up
posts(input, first, after), post(input),  # ← post.metrics lives here
postTemplate(input), postTemplates(input, first, after), ideaGroups(input), ideas(input, first, after)
```

Analytics-adjacent types (of 228): `AggregatedPostMetrics`, `AggregatedPostMetricsInput`,
`PostMetric`, `PostMetricType`, `PostMetricUnit`.

**`Post` type — the relevant fields** (verbatim descriptions from introspection):

```graphql
metrics: [PostMetric!]
# Metrics for the sent post. If post is not yet sent, this field will be null

metricsUpdatedAt: DateTime
# Timestamp of when `metrics` were last refreshed from the network. Null
# until the daily ingestion job has processed the post. Buffer pulls
# fresh metrics once per day, so this can lag the network value by ~24h.
```

```graphql
type PostMetric {
  type: PostMetricType! # e.g. reactions
  name: String! # "Reactions"
  description: String! # human-readable
  value: Float! # "Defaults to 0 when the network did not report the metric."
  unit: PostMetricUnit! # count | percentage
}
```

`PostMetricType` (16 values), grouped per Buffer's own documentation:

- **Cross-network normalized:** `reactions`, `comments`, `shares`, `reposts`, `reach`,
  `impressions`, `views`, `clicks`, `engagementRate`
- **Network-specific:** `saves` (IG/Pinterest), `follows` (IG), `quotes` (Threads),
  `viewers` + `totalTimeWatched` (LinkedIn video), `likes` (**Facebook only** — the
  Like-subcount, deliberately distinct from `reactions`, which totals all reaction types)
- **Aggregation-only:** `postCount` (never emitted per-post)

`aggregatedPostMetrics` takes `organizationId!`, `startDateTime!`, `endDateTime!`, optional
`channelIds` and `tags`; the date range is **capped at 365 days**. Its `metrics` "always
includes a baseline trio (`postCount`, `reactions`, `comments`) … Beyond the baseline,
additional metric types are included only when **every** channel in the filter set supports
them" — a detail that would have quietly shaped any aggregate UI.

### 3. Per-post metrics by stored `bufferUpdateId` — tested, blocked

The ID model is exactly right: `post(input: { id })` accepts `Post.bufferUpdateId` as
stored, with no mapping layer. **All 8 posts carrying a `bufferUpdateId` resolved to a real
Buffer post**, and Buffer's `channelService` agreed with our `channel` column in 6 of 8 cases.

Request:

```graphql
query PostMetrics($id: PostId!) {
  post(input: { id: $id }) {
    id
    status
    channelService
    sentAt
    metricsUpdatedAt
    metrics {
      type
      name
      value
      unit
    }
  }
}
```

Result across all 8 posts (IDs truncated; ages as of 2026-07-17):

| Company    | Buffer post ID | Buffer service | Age  | `status` | `metricsUpdatedAt` | `metrics` |
| ---------- | -------------- | -------------- | ---- | -------- | ------------------ | --------- |
| TravelNest | `6a5723…`      | facebook       | 2.1d | sent     | `null`             | **NULL**  |
| TravelNest | `6a54ed…`      | facebook       | 3.8d | sent     | `null`             | **NULL**  |
| Strawberry | `6a4f8b…`      | facebook       | 7.9d | sent     | `null`             | **NULL**  |
| Strawberry | `6a4f85…`      | instagram      | 7.9d | sent     | `null`             | **NULL**  |
| AI         | `6a4d57…`      | facebook       | 9.6d | sent     | `null`             | **NULL**  |
| Strawberry | `6a4cf3…`      | facebook       | 9.9d | sent     | `null`             | **NULL**  |
| Strawberry | `6a4ceb…`      | facebook       | 9.9d | sent     | `null`             | **NULL**  |
| Strawberry | `6a4ce2…`      | instagram      | 9.9d | sent     | `null`             | **NULL**  |

Every post is `status: sent` and comfortably inside any retention window, yet every metric
is `null`.

> **Incidental finding — pre-existing data bug, out of scope for v2-6.** Two Strawberry posts
> (`6a4f85…`, `6a4ce2…`) are stored with `channel = facebook` while Buffer reports
> `channelService = instagram`; one even has an `instagram.com/p/…` value in
> `published_post_url`. So `Post.channel` is not reliably the channel a post was actually
> published to. This is unrelated to analytics and predates the spike, but it **would
> directly corrupt v2-7**, which keys metrics by `channel` — metrics would be attributed to
> the wrong network for those rows. Worth fixing on its own merits; not fixed here.

### 4. Why the nulls — scope, not missing data

A null could mean "Buffer hasn't ingested yet". It does not. Selecting `metrics` returns a
**partial success**: `data` is populated _and_ an `errors` entry explains the null.

Sanitized response (token redacted; this is the whole envelope):

```jsonc
{
  "errors": [
    {
      "message": "Insufficient scope. Required: insights:read. Granted: account:read, posts:read, posts:write, offline_access.",
      "path": ["post", "metrics"],
      "extensions": {
        "code": "INSUFFICIENT_SCOPE",
        "requiredScopes": ["insights:read"],
        "grantedScopes": ["account:read", "posts:read", "posts:write", "offline_access"],
      },
    },
    // …an identical error at path ["post", "metricsUpdatedAt"]
  ],
  "data": {
    "post": {
      "id": "6a5723…",
      "status": "sent",
      "sentAt": "2026-07-15T06:06:22.339Z",
      "metricsUpdatedAt": null,
      "metrics": null,
    },
  },
}
```

A control query for the same post **without** the `metrics` selection returns clean data and
no errors — isolating the scope as the sole cause.

`aggregatedPostMetrics` fails the same way, but as a top-level error with `"data": null`:

```jsonc
{
  "errors": [
    {
      "message": "Insufficient scope. Required: insights:read. Granted: account:read, posts:read, posts:write, offline_access.",
      "path": ["aggregatedPostMetrics"],
      "extensions": { "code": "INSUFFICIENT_SCOPE", "requiredScopes": ["insights:read"] },
    },
  ],
  "data": null,
}
```

**It is not an account-permission problem.** Both connected channels report `viewInsights`
in `allowedActions`, so the underlying Buffer account is entitled to insights — only our
token is not:

```
instagram  6a4621…  "lsocial.demo"         disconnected=false  viewInsights=YES
facebook   6a4622…  "Test Digital Studio"  disconnected=false  viewInsights=YES
```

### 5. The scope cannot be granted to our OAuth client

The obvious fix — add `insights:read` to `BUFFER_SCOPES` and have users re-authorize —
**does not work**. Buffer's authorization server rejects the request outright, before any
user consent:

```
GET https://auth.buffer.com/auth?client_id=…&scope=account:read posts:read posts:write insights:read offline_access&…

HTTP 303
location: …/api/v1/buffer/callback
          ?error=invalid_scope
          &error_description=requested+scope+is+not+allowed
          &scope=insights%3Aread
```

A scope-acceptance matrix run against our registered client proves this is deliberate
allowlisting rather than a typo or a bad client registration:

| Requested scope                                                | Result                         |
| -------------------------------------------------------------- | ------------------------------ |
| `account:read posts:read posts:write offline_access` (current) | **ACCEPTED** → login/consent   |
| `account:read`                                                 | **ACCEPTED** → login/consent   |
| `insights:read` (alone)                                        | **REJECTED — `invalid_scope`** |
| current + `insights:read`                                      | **REJECTED — `invalid_scope`** |
| `analytics:read` (invented name)                               | ACCEPTED (silently ignored)    |
| `insights` (invented name)                                     | ACCEPTED (silently ignored)    |
| `metrics:read` (invented name)                                 | ACCEPTED (silently ignored)    |

The asymmetry is the proof: Buffer **silently ignores unknown scope names** but
**explicitly rejects `insights:read`**. That is only consistent with `insights:read` being a
real, recognized scope that our client type is not permitted to request. The client ID
itself is valid (the control scopes reach the consent screen, and the redirect lands on our
registered callback), so this is neither the `invalid_client` failure mode previously
documented in `.wolf/cerebrum.md` nor a redirect-URI mismatch.

Buffer's [authentication guide](https://developers.buffer.com/guides/authentication.html)
corroborates the probe — the complete OAuth scope table contains **no insights scope at all**:

> `posts:read`, `posts:write`, `ideas:read`, `ideas:write`, `account:read`, `account:write`, `offline_access`

whereas a Personal API Key "acts on behalf of **your account only**". Buffer's developer
documentation states that the insights scope is available to Personal API Keys and MCP
clients but **not to third-party App Clients**, on the grounds that the social platforms'
terms of service permit a user to read only their _own_ metrics. That rationale is
consistent with everything observed, though we could not verify the exact sentence against a
first-party page (the referenced docs URL 404s); the empirical evidence above stands on its
own regardless.

**Buffer Analyze is not a separate API product to buy.** It is Buffer's own analytics UI,
fed by the same daily ingestion behind `insights:read`. There is no Analyze-specific
endpoint or key to purchase that would unblock an App Client.

### Supported Metrics Matrix by Channel

> **Read this table as "what Buffer could return if the scope existed", not as confirmed
> capability.** Nothing here was observed: the scope block returns `null` uniformly, so live
> confirmation is impossible. Sources: schema introspection (metric _catalog_, authoritative)
> and Buffer's Help Center (per-network _coverage_, describing the Publish dashboard, which
> is the same ingestion pipeline but not a contractual API guarantee).

| Metric             | Facebook  | Instagram | LinkedIn    | TikTok |
| ------------------ | --------- | --------- | ----------- | ------ |
| reactions / likes  | ✅ (both) | ✅        | ✅          | ✅     |
| comments           | ✅        | ✅        | ✅          | ✅     |
| shares / reposts   | ✅        | ✅        | ✅          | ✅     |
| clicks             | ⚠️        | ❌        | ❌          | ❌     |
| impressions        | ❌        | ✅        | ❌          | ❌     |
| reach              | ✅        | ✅        | ❌          | ❌     |
| engagementRate     | ❌        | ❌        | ✅ (native) | ❌     |
| saves / follows    | ❌        | ✅        | ❌          | ❌     |
| views / watch time | ❌        | ❌        | ✅ (video)  | ❌     |

⚠️ **Facebook `clicks` is contested.** Buffer's metrics table lists clicks for Facebook, but
other Buffer documentation states Meta stopped providing post clicks and organic impressions
for Pages. Unresolvable while scope-blocked; **do not design against Facebook clicks**.

Consequences for v2-7's design, which assumed a uniform metric set:

- **No single denominator exists across channels.** Facebook has reach but no impressions;
  Instagram has both; LinkedIn has neither. A cross-channel "engagement rate" is therefore
  **not computable on a common basis** — LinkedIn would have to use Buffer's native
  `engagementRate` while Facebook/Instagram compute from reach, so the numbers would not be
  comparable between channels even though the UI would present them side by side.
- **TikTok has no denominator at all** (no reach, impressions, or clicks) — only reactions,
  comments, and reposts. Any TikTok engagement rate would be fabricated.
- `value: Float!` "**defaults to 0** when the network did not report the metric" — so a
  genuine zero and an unsupported metric are indistinguishable in the value alone. Presence
  in the returned array, not the value, is the availability signal. Storing these into
  nullable `Int?` columns as v2-7 sketches would silently turn "unsupported" into "0
  engagement", which reads as a real result to a user.

### Authentication Requirements

| Requirement           | Status                                                                       |
| --------------------- | ---------------------------------------------------------------------------- |
| Existing OAuth token  | ❌ Insufficient — `insights:read` missing, and unobtainable for App Clients  |
| Extra OAuth scope     | ❌ `insights:read` rejected with `invalid_scope` at the authorization server |
| User re-authorization | ❌ Would not help — rejection precedes user consent                          |
| Separate API key      | ⚠️ Personal API Key is the documented path — **untested**, changes the model |
| Buffer Analyze        | ❌ Not a purchasable API product; same ingestion, same scope gate            |
| Channel permission    | ✅ Already satisfied (`viewInsights` present on all connected channels)      |

### Rate Limits

Observed live on a metrics request (`RateLimit` response header, sanitized):

```
ratelimit: "100-in-15min"; r=92; t=898,
           "250-in-1day";  r=242; t=86398,
           "3000-in-30days"; r=2852; t=1645899
```

Matching the [published limits](https://developers.buffer.com/guides/api-limits.html) (`r` =
remaining, `t` = seconds to reset). Our account is on the **Free** tier:

| Window | Free      | Essentials | Team   |
| ------ | --------- | ---------- | ------ |
| 15 min | 100       | 100        | 100    |
| 24 h   | **250**   | 250        | 500    |
| 30 day | **3,000** | 7,500      | 15,000 |

Also documented: query complexity ≤175,000 points, depth ≤25, ≤30 aliases; 429 responses
carry `Retry-After` and `extensions.window`.

**Feasibility of the spec's "~15 posts per run" cron step:** comfortable, but only if
batched. The **250/day** ceiling is the binding constraint — it is shared with publishing
and profile syncs, and `getProfiles()` already costs 1 + N requests per publish. Fetching
metrics one post at a time (15/run) would be wasteful; the `posts` query returns `metrics`
inline for a whole page, making a per-company sync **1–2 requests instead of 15**. The
30-day ceiling (3,000) is the one that would eventually bite at scale: ~4 companies × daily
sync is trivial, but per-post polling across many companies would not be.

Retention/freshness (from the schema's own descriptions):

- Metrics refresh **once per day**; values lag the network by up to ~24h. Syncing more than
  daily is pointless — it burns quota for identical data.
- `metricsUpdatedAt` is null until the daily ingestion job first processes a post.
- **No historical/time-series surface exists.** Introspection for
  `timeseries|history|snapshot|daily|trend|series|breakdown` matched only
  `DailyPostingLimitStatus`/`DailyPostingLimitsInput` — unrelated to analytics. `Post.metrics`
  is a flat list of **cumulative lifetime totals**. Day-over-day history is therefore only
  obtainable by snapshotting ourselves over time — it cannot be backfilled retroactively.
- `aggregatedPostMetrics` accepts an arbitrary window capped at 365 days, so aggregate
  history is available even though per-post history is not.

### Recommended Architecture

**Recommendation: build none of it now.** No table, migration, cron step, or UI should be
written while the data is unreachable — v2-7's schema would be speculative, and the matrix
above shows it would be speculative in ways that are already known to be wrong (uniform
metrics, a common denominator, `Int?` columns that conflate unsupported with zero).

If the scope question is resolved (via a Personal API Key or a future Buffer grant), the
findings point to a different design than v2-7 currently sketches:

1. **Batch through `posts`, not `post`.** `posts(input: { organizationId, filter: { channelIds, status } }, first, after)` returns `metrics` inline with pagination (`edges`/`pageInfo`), turning a
   per-company sync into 1–2 requests instead of one per post. Note `PostsFiltersInput`
   filters on `dueAt`/`createdAt` — **there is no `sentAt` filter**, so "recently published"
   must be derived client-side.
2. **Sync daily at most**, ideally right after Buffer's own ingestion. More frequent polling
   returns byte-identical data and burns the 250/day budget.
3. **Store metrics as a typed list, not fixed columns.** A `(postId, metricType, value, unit)`
   shape mirrors the API, survives Buffer adding metrics, and — critically — preserves the
   distinction between "network did not report this" (absent row) and "genuinely zero"
   (row with 0) that v2-7's `likes Int?`/`clicks Int?` columns would erase.
4. **Snapshot if history is wanted.** Lifetime totals are all Buffer returns; day-over-day
   requires storing our own daily rows going forward, and cannot be backfilled.
5. **Do not present a cross-channel engagement rate.** Denominators are not comparable
   (LinkedIn native vs Facebook/Instagram reach-derived) and TikTok has none. Per-channel
   figures with an explicit denominator label are honest; a single blended number is not.
6. **Fix `BufferClient.query()` before any metrics work.** It currently throws whenever
   `json.errors` is non-empty:

   ```ts
   if (json.errors?.length) { … throw new BufferApiError(message); }
   ```

   Metrics responses are **partial successes** — populated `data` _plus_ an `errors` entry.
   As written, the client would discard valid metrics and raise an opaque error instead of
   surfacing an actionable `INSUFFICIENT_SCOPE`. Any analytics path needs a query variant
   that tolerates field-level errors and inspects `extensions.code`.

### Realistic Alternatives

_Documented per the gate, **not implemented**._

**Option A — Abandon v2-7 for this release. ✅ Recommended.**
Nothing is reachable through the current OAuth flow, so there is no partial slice to ship.
This costs nothing and loses nothing; the work is deferred, not discarded.

**Option B — Per-company Personal API Key (the path that could reopen v2-7). ⚠️ Unverified.**
The documented way to obtain `insights:read`. Each company's Buffer admin generates a key at
`publish.buffer.com/settings/api` and pastes it into their company settings; we encrypt it
via `lib/security/encryption.ts` exactly as Buffer OAuth tokens are handled today, and use it
**only** for analytics reads while OAuth continues to own publishing.

Honest assessment of the cost, since this is the tempting option:

- **Unverified.** We hold no Personal API Key, so we could not confirm first-hand that one
  actually grants `insights:read`. This rests on documentation alone and **must be proven
  before any v2-7 commitment** — it is a ~15-minute check (generate a key, re-run the
  per-post metrics query), and it should gate the decision.
- It **abandons the multi-tenant premise of the OAuth flow** for analytics: a personal key is
  one human's credential over their own account, not a company's delegated grant. Buffer's
  stated rationale (platform ToS limit users to reading their own metrics) means using one
  human's key to read another company's metrics is likely a terms violation, not merely
  awkward — the same reason the scope is withheld from App Clients in the first place.
- It shifts a **manual, revocable, non-expiring secret** onto each customer, with no refresh
  path and a silent-breakage mode when rotated.
- Our current data makes this concrete: the four companies span three distinct Buffer
  accounts (two share one), so there is no single key that covers the estate.

**Option C — Lightweight click tracking (no external dependency).**
We already own `resolve-post-url.service.ts` and append source URLs (v2-1). A redirect
endpoint plus a `click_events` table would give click-through data with no Buffer dependency,
no scope, and no rate limit. It measures **only clicks** — never reactions, comments, or
shares — so it does not satisfy v2-7's goal, and it only counts links we control (not the
majority of engagement). Worth considering as its own smaller feature; it is not a substitute.

**Option D — Direct platform APIs (Meta Graph, LinkedIn, TikTok).**
Full metric fidelity, but each requires its own OAuth app, app review, and per-network
maintenance — replacing one integration with four, plus the review overhead Buffer exists to
absorb. Disproportionate for this release.

### Reproducing this spike

Probes were kept out of the repo deliberately (this is a spike; no product code should carry
it). They live in the session scratchpad and are read-only:

```
db-state.mjs            # what Buffer state exists (read-only)
probe1-introspect.mjs   # root query fields + analytics types
probe2-types.mjs        # Post / PostMetric / AggregatedPostMetrics shapes
probe3-post-metrics.mjs # per-post metrics by stored bufferUpdateId
probe5-insights.mjs     # channel viewInsights + aggregatedPostMetrics
probe6-scope-cause.mjs  # proves nulls are scope-caused, not missing data
probe7-scope-matrix.mjs # which scopes our client may request
probe8-history-batching.mjs # history surfaces + posts filters
```

Run from the project root with `node --env-file=.env <probe>`; they decrypt the stored
connection via `DATABASE_URL` + `LLM_ENCRYPTION_KEY`. **Any probe that refreshes a token must
persist the rotated refresh token** — Buffer's are single-use, and dropping one breaks the
live connection (`.wolf/cerebrum.md`).

### Decision record

| Gate option                           | Verdict                                                   |
| ------------------------------------- | --------------------------------------------------------- |
| **Option A — Abandon v2-7**           | ✅ **Chosen** for this release                            |
| Option B — Buffer Analyze / 3rd-party | ❌ Analyze is not a separate API product; same scope gate |
| Option C — Click tracking             | ➖ Viable but different scope; not a v2-7 substitute      |

**FINAL: ABANDON** — v2-7 cannot be built on the current Buffer OAuth token flow. The gate's
blocking question ("are analytics available via the current Buffer OAuth token and GraphQL
API?") is answered **no**, on evidence that is external to our code and not addressable by
implementation.

**The single question that could reopen it:** does a Personal API Key actually grant
`insights:read` (Option B), and is per-company key entry acceptable given the ToS concern? If
yes, v2-7 becomes viable with the revised architecture above. That check is cheap and should
precede any further v2-7 planning.

---

## Verified findings (2026-07-20)

_Executed against the live Buffer API with a **Personal API Key**, read-only, over the 9 posts
carrying a `bufferUpdateId`. This section answers the question the original spike left open and
**overrides the Help-Center-derived matrix above** wherever the two disagree._

### The gating question: answered

**A Personal API Key grants `insights:read`.** Every `post.metrics` selection that previously
returned `null` + `INSUFFICIENT_SCOPE` now returns populated metric arrays. `aggregatedPostMetrics`
also succeeds. The OAuth finding is unchanged — the key is a _separate_ credential used only for
analytics reads; publishing continues through OAuth untouched.

### Observed metric availability — supersedes the matrix above

Derived from metric types actually present in the response arrays, not from documentation:

| Metric           | Facebook | Instagram | Note                                             |
| ---------------- | -------- | --------- | ------------------------------------------------ |
| `reactions`      | ✅       | ✅        |                                                  |
| `comments`       | ✅       | ✅        |                                                  |
| `shares`         | ✅       | ✅        |                                                  |
| `engagementRate` | ✅       | ✅        | **native on both** — spike claimed LinkedIn-only |
| `impressions`    | ✅       | ❌        | **reverse of the spike's matrix**                |
| `reach`          | ❌       | ✅        | **reverse of the spike's matrix**                |
| `clicks`         | ✅       | ❌        | works — spike called it contested                |
| `views`          | ❌       | ✅        |                                                  |
| `saves`          | ❌       | ✅        |                                                  |
| `follows`        | ❌       | ✅        |                                                  |

LinkedIn and TikTok remain unobserved — no post has been published to either.

### Engagement rate is native, but the denominators still differ

Both networks return a native `engagementRate`, so nothing needs deriving. They are **not
computed on the same basis**, so the spike's non-comparability warning stands:

- Facebook `6a54ed64`: `clicks 1 / impressions 8` = **12.5%** → denominator is impressions
- Instagram `6a4f855f`: `reactions 1 / reach 1` = **100%** → denominator is reach

Present the native value with an explicit denominator label. Do not blend across channels.

### Three failure modes, all distinct

1. **`FORBIDDEN`** — `"Account is not allowed to perform this action"` at path `["post"]`,
   `data.post = null`. Observed for both "AI за стартиращ бизнес" posts: they belong to a Buffer
   account this key does not cover. **Keys are per-company and one key cannot span the estate** —
   the 4 companies span 3 Buffer accounts. This is a first-class UI state, not an error.
2. **`metrics: null` with no error** — post `6a4ce2b8` (Instagram) has `metricsUpdatedAt`
   set to 2026-07-07 yet returns no metrics. Ingested but nothing reported. Treat as "no data",
   never as zeros.
3. **Genuine zeros** — most posts report `reactions: 0`. Indistinguishable from "unsupported" by
   value alone, which is why **presence in the array is the availability signal**. Facebook arrays
   never contain `reach`; Instagram arrays never contain `impressions`.

### `Post.channel` is confirmed unreliable

All 9 posts are stored `channel = facebook`; Buffer reports `channelService = instagram` for two
(`6a4f855f`, `6a4ce2b8`). The spike flagged this as incidental — it is now load-bearing. Metrics
must be attributed using Buffer's `channelService`.

### Aggregation surface for weekly/monthly rollups

`aggregatedPostMetrics` works and returned, for a 30-day window: `postCount 8`, `reactions 1`,
`comments 0`, `engagementRate 5.66%`, `impressions 104`, `shares 0`. It is **organization**-scoped;
per-company rollups require passing that company's `channelIds` in the filter. Note the baseline
trio caveat above still applies — metrics beyond `postCount`/`reactions`/`comments` appear only
when every channel in the filter supports them.

### Rate limits

Unchanged and comfortable: `100-in-15min`, `250-in-1day`, `3000-in-30days`. The 9-post probe cost
~11 requests. Metrics refresh once daily (several Facebook posts share the ingestion timestamp
`2026-07-19T14:37:19Z`), so syncing more than daily returns identical data.
