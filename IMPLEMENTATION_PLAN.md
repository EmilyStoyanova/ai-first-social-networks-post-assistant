# AI-First Social Networks Post Assistant — Implementation Plan

> **Status:** v1.1 · 2026-06-30 · Ready for Development  
> **Stack:** Next.js 16 (App Router) · TypeScript · PostgreSQL (Neon) · Prisma · Buffer API · Vercel (Hobby)

---

## Project Overview

An AI-powered tool that automates social media post creation, scheduling, and publication for companies and brands. It generates channel-specific content using an LLM, respects brand guidelines, and integrates with Buffer for publishing to Facebook, LinkedIn, Instagram, and TikTok.

**Target users:** Solo creators, small business owners, and marketing agencies managing one or more brands.

**Outcome:** Users spend under 15 minutes per week reviewing AI-generated posts. Brand voice is preserved. A full audit trail covers every generated, approved, and published post.

---

## Technology Stack

| Layer | Technology |
|---|---|
| **Frontend** | Next.js 16 (App Router), React (RSC + Client Components), Tailwind CSS, ShadCN/UI, TanStack Query, next-intl (i18n: EN / BG) |
| **Backend** | Next.js Route Handlers, TypeScript (strict), Zod (validation), Prisma ORM |
| **Database** | PostgreSQL — Neon (serverless, free tier) |
| **Authentication** | Auth.js v5 (Credentials provider), JWT sessions, bcrypt |
| **AI — Text** | Multi-LLM with runtime switching: Claude (Anthropic), OpenAI GPT-4o, Grok (xAI). Grok recommended for local development (free tier). Active provider configured by global admin and stored in DB. |
| **AI — Images** | Leonardo.ai API |
| **Storage** | Cloudinary (media assets, CDN, free tier) — required in v1 for logo uploads, user gallery, and AI-generated images; no persistent file system on Vercel serverless |
| **Deployment** | Vercel (Hobby plan) |
| **External APIs** | Buffer API (publishing, analytics), Cloudinary API, Leonardo.ai API |
| **Dev tooling** | ESLint, Prettier, Husky, lint-staged, Sentry (error tracking) |

---

## MVP Scope

### Included in v1

- User registration and authentication
- Multi-company management with `owner` / `editor` roles and a global admin
- Brand guidelines per company (logo, colors, fonts, tone, forbidden words, audience, competitors)
- Buffer OAuth integration; per-channel configuration (schedule, posting windows, language, image rules)
- Content sources: RSS feeds, user prompts, product page URLs, calendar events
- AI-generated weekly post schedules with channel-specific formatting
- Duplicate detection and content safety checks
- Media gallery with user uploads and AI image generation (Leonardo.ai)
- Semi-automated and fully automated approval modes (per company)
- Post lifecycle management and version history
- Audit log for all significant actions
- Basic analytics via Buffer API
- Vercel Cron as the automation backbone

### Excluded from v1

- Post preview rendered as it will appear on each network
- Per-channel tone customization (all channels share the company tone in v1)
- Learning from existing or high-performing posts
- Video, Reels, and carousel post support
- Approval notifications (email / Slack)
- Sensitive topic warnings before publishing
- Plagiarism detection
- White-labelling or custom domains

---

## Assumptions

- **Buffer account required** — each company must have an active Buffer account; our application does not manage social network credentials directly
- **Vercel Hobby plan** — deployment targets the free Hobby plan; one cron job available with a 60-second function execution limit
- **Neon free tier** — 512 MB database storage is sufficient for v1 user volumes
- **Cloudinary free tier** — 25 GB monthly bandwidth is sufficient; per-company gallery capped at 50 assets to stay within limits
- **LLM API access** — at least one LLM provider API key (Claude, OpenAI, or Grok) is configured by the global admin; Grok's free tier is suitable for local development; token costs in production are absorbed by the operator
- **Leonardo.ai API access** — a valid API key is provided; free-tier credits are sufficient for v1 usage
- **UI language** — the application interface supports English (EN) and Bulgarian (BG) via `next-intl`; the user selects their preferred language in profile settings
- **Content language** — generated posts can be produced in EN or BG as configured per company or per channel; the LLM is instructed to generate in the target language
- **Buffer handles retries at the social network level** — our application only retries failed Buffer API calls, not individual social network delivery failures
- **No existing data migration** — v1 is a greenfield deployment; no import of historical posts or existing social accounts beyond Buffer OAuth

---

## Out of Scope

The following capabilities are explicitly **not** part of v1 and should not be designed for or partially implemented:

- **Post preview UI** — rendering a pixel-accurate preview per social network. Links to third-party preview tools (Hootsuite, Publer) may be surfaced in the UI as a stopgap.
- **AI learning from post history** — the generation engine uses brand guidelines and source material only; no feedback loop from published post performance.
- **Document ingestion** — PDFs, presentations, and uploaded brand documents as generation context are deferred to v2.
- **Video and rich media** — only static images are supported; no Reels, Stories, carousels, or video uploads.
- **Notification system** — no in-app, email, or Slack notifications for pending approvals or publish failures; users must check the dashboard.
- **Multi-tenant data isolation** — row-level security and per-company DB schemas are v2 concerns; v1 relies on application-level RBAC.
- **External project webhook subscriptions** — the `/api/v1/webhooks` route is scaffolded but not fully implemented in v1.
- **Advanced analytics** — follower growth, best-time-to-post recommendations, and trend analysis are v2 features.

---

## Main Features

- **Multi-company management** — one user can belong to multiple companies with role-based access (`owner`, `editor`); a global admin sees all users and companies
- **Brand guidelines** — logo, colors, fonts, tone, forbidden words, target audience, competitors (all optional)
- **Buffer integration** — OAuth connection to Buffer; Buffer handles social network connections and publishing
- **Channel configuration** — per-company, per-channel settings: posting schedule, posting windows, language, image rules, hashtag style
- **Content sources** — RSS feeds, user prompts, product page URLs, calendar events
- **AI content generation** — weekly post schedule generated automatically; channel-specific formatting, hashtags, emojis, CTAs; duplicate detection; content safety check
- **Media gallery** — user uploads + AI image generation (Leonardo.ai); brand-aware image prompts
- **Approval workflow** — semi-automated (user approves before publish) or fully automated (posts sent to Buffer automatically); configurable per company
- **Post lifecycle** — `draft → pending_approval → approved / rejected → sent_to_buffer → published / failed`
- **Audit log** — every generate, edit, approve, reject, and publish action is recorded
- **Analytics** — basic post performance data fetched from Buffer API

---

## Architecture Overview

```
Browser (Next.js App Router)
        │
        ▼
Next.js Server (Vercel)
  ├── React pages (RSC + Client Components)
  ├── /api/v1/**  — REST API (Route Handlers)
  │       ├── Auth middleware (JWT + RBAC)
  │       └── Service layer (business logic)
  └── /api/v1/internal/cron  ← Vercel Cron (single job)
        │
        ├──► PostgreSQL via Prisma (Neon free tier)
        ├──► Buffer API (OAuth, drafts, analytics)
        ├──► LLM Router → Claude / GPT-4o / Grok (active provider from DB)
        ├──► Leonardo.ai (image generation)
        └──► Cloudinary (media storage + CDN)
```

**Key decisions:**
- Single Next.js project for frontend and backend — reduced operational overhead on Vercel Hobby
- All API routes under `/api/v1/` from day one — consumable externally without restructuring
- M2M access via `X-API-Key` header for future two-way integration with an external project
- Vercel Cron (single job) acts as a lightweight coordinator: reads DB flags, processes one company per run — stays within the 60-second function timeout
- Media on Cloudinary CDN, not Vercel filesystem; DB on Neon (serverless PostgreSQL)

---

## Project Dependencies

| Dependency | Purpose | If Unavailable |
|---|---|---|
| **Buffer API** | Social network OAuth, post scheduling, publishing, and analytics | Core publishing is non-functional; no viable v1 fallback — must monitor Buffer's status page |
| **LLM Provider (Claude / OpenAI / Grok)** | Text generation for posts, hashtags, safety checks. Active provider is stored in DB and switchable by global admin at runtime. | If the active provider is unavailable, the admin switches to another in the admin panel — no code change required; all providers share a common interface |
| **Leonardo.ai API** | AI image generation | Users fall back to manual gallery uploads; generation feature is disabled gracefully in UI |
| **Cloudinary** | Media asset storage and CDN delivery | Image uploads and delivery are blocked; no local file storage on Vercel serverless |
| **Neon PostgreSQL** | Primary data store for all application data | Entire application is non-functional; Neon provides automatic failover within its free tier |
| **Vercel** | Hosting, serverless function execution, and cron scheduling | Application is offline; the codebase can be deployed to any Node.js-compatible platform with minimal changes |

---

## Folder Structure

```
├── app/
│   ├── (auth)/               # Login, register, reset password
│   ├── (dashboard)/          # Protected app shell
│   │   ├── companies/[id]/   # Brand, channels, posts, media, schedule, analytics
│   │   └── admin/            # Global admin: users + companies
│   └── api/v1/
│       ├── auth/
│       ├── companies/[id]/   # Brand, channels, sources, media, posts, schedules, members
│       ├── buffer/           # OAuth connect + callback
│       ├── internal/         # cron + health endpoints
│       └── webhooks/         # Future: external project integration
├── components/               # UI primitives (ShadCN), forms, posts, layout
├── i18n/
│   ├── messages/
│   │   ├── en.json           # English translations
│   │   └── bg.json           # Bulgarian translations
│   └── config.ts             # next-intl configuration
├── lib/
│   ├── services/             # Business logic (company, post, generation, buffer, audit)
│   ├── ai/
│   │   ├── llm-router.ts     # Reads active provider from DB, delegates to correct client
│   │   ├── providers/
│   │   │   ├── claude.ts
│   │   │   ├── openai.ts
│   │   │   └── grok.ts
│   │   └── image-generator.ts  # Leonardo.ai client
│   ├── buffer/               # Buffer API wrapper
│   ├── cloudinary/           # Cloudinary client
│   ├── jobs/                 # Cron dispatcher
│   ├── auth/                 # Auth.js config + RBAC middleware
│   ├── db/                   # Prisma client singleton
│   └── validators/           # Zod schemas
├── prisma/                   # schema.prisma + migrations
├── types/
├── middleware.ts             # Route protection + locale detection
└── vercel.json              # Cron job definition
```

---

## Database Design

### Tables & Relationships

```
users
  ├── id, email, password_hash, name, is_global_admin, preferred_language
  └── preferred_language: 'en' | 'bg'

companies
  ├── id, name, slug, automation_mode, default_language, created_by → users.id
  └── automation_mode: 'semi_automated' | 'fully_automated'

company_members                              (many users ↔ many companies)
  ├── id, company_id → companies.id, user_id → users.id
  ├── role: 'owner' | 'editor'
  └── UNIQUE(company_id, user_id)

brand_guidelines                             (one-to-one with companies)
  ├── id, company_id → companies.id (UNIQUE)
  └── logo_url, colors (JSONB), fonts (JSONB), tones (TEXT[]),
      forbidden_words (TEXT[]), target_audience, competitors (TEXT[])

channel_configs                              (one per channel per company)
  ├── id, company_id → companies.id, channel: 'facebook'|'linkedin'|'instagram'|'tiktok'
  ├── enabled, image_required, max_text_length, hashtag_style
  ├── posting_language ('en'|'bg'), posts_per_day, posts_per_week
  ├── posting_windows (JSONB: [{ days, start, end }])
  ├── automation_mode_override — overrides company.automation_mode if set
  ├── buffer_profile_id
  └── UNIQUE(company_id, channel)

buffer_connections                           (one per company)
  ├── id, company_id → companies.id
  └── buffer_user_id, access_token_enc, refresh_token_enc, token_expires_at

llm_configs                                  (global — managed by admin)
  ├── id, provider: 'claude'|'openai'|'grok'
  ├── model_name, api_key_enc, base_url
  └── is_active — only one row is true at a time (enforced in service layer)

content_sources
  ├── id, company_id → companies.id
  ├── type: 'rss'|'prompt'|'product_page'|'calendar_event'
  ├── name, config (JSONB), enabled, last_fetched_at
  └── config shape varies by type: { url } for rss, { text } for prompt, etc.

feed_items
  ├── id, source_id → content_sources.id, company_id → companies.id
  ├── title, content, url, published_at, used_in_post
  └── UNIQUE(source_id, url)  — prevents duplicate ingestion

media_assets
  ├── id, company_id → companies.id
  ├── cloudinary_id, url, thumbnail_url, width, height
  ├── generated_by: 'user_upload'|'ai'
  ├── ai_prompt  — populated when generated_by = 'ai'
  └── uploaded_by → users.id

weekly_schedules
  ├── id, company_id → companies.id
  ├── week_start (DATE — always Monday), status: 'generating'|'ready'|'completed'
  └── UNIQUE(company_id, week_start)

posts
  ├── id, company_id → companies.id, schedule_id → weekly_schedules.id (nullable)
  ├── channel, content, language ('en'|'bg'), hashtags (TEXT[])
  ├── media_asset_id → media_assets.id (nullable)
  ├── status: 'draft'|'pending_approval'|'approved'|'rejected'|
  │          'sent_to_buffer'|'published'|'failed'
  ├── buffer_update_id, scheduled_for, published_at
  ├── safety_flagged, safety_flag_reason
  ├── retry_count (max 3), last_error
  └── generated_by, approved_by, approved_at,
      rejected_by, rejected_at, rejection_notes  → users.id

post_versions                                (audit trail for edits)
  ├── id, post_id → posts.id
  ├── version (INT, monotonically increasing per post)
  ├── content, changed_by → users.id
  └── UNIQUE(post_id, version)

audit_logs
  ├── id, user_id → users.id (nullable for system actions)
  ├── company_id → companies.id (nullable)
  ├── action (e.g. 'post.approved', 'company.created')
  ├── entity_type, entity_id
  └── metadata (JSONB)

cron_runs
  ├── id, started_at, completed_at
  ├── status: 'running'|'completed'|'failed'
  └── actions_taken (JSONB), error

api_keys                                     (M2M — future external project)
  ├── id, name, key_hash (SHA-256), created_by → users.id
  └── last_used_at, expires_at
```

### Key Relationships Diagram

```
users ──< company_members >── companies
                                  │
              ┌───────────────────┼─────────────────────┐
              │                   │                     │
        brand_guidelines   channel_configs      buffer_connections
                                  │
                           content_sources
                                  │
                            feed_items
                                  │
                        weekly_schedules
                                  │
                               posts ──── media_assets
                                  │
                           post_versions
```

### Key Indexes

- `company_members(user_id)` — fast lookup of "which companies does this user belong to"
- `posts(company_id, status)` — approval queue and cron queries
- `posts(scheduled_for)` WHERE `status IN ('approved', 'sent_to_buffer')` — cron scheduling
- `posts(retry_count, status)` WHERE `status = 'failed'` — retry queue
- `feed_items(source_id, published_at DESC)` — latest articles per source
- `audit_logs(company_id, created_at DESC)` — recent activity per company
- `weekly_schedules(company_id, week_start DESC)` — current week lookup

---

## Coding Standards

- **TypeScript strict mode** — enabled in `tsconfig.json`; `any` is disallowed in production code
- **ESLint** — Next.js recommended ruleset; runs in CI on every pull request
- **Prettier** — enforced via Husky pre-commit hook; no manual formatting debates
- **Conventional Commits** — all commit messages follow `type(scope): description` (e.g., `feat(posts): add approval endpoint`)
- **Service layer architecture** — all business logic lives in `lib/services/`; Route Handlers are thin wrappers responsible only for parsing requests and formatting responses
- **React components** — small and single-responsibility; Client Components are used only where interactivity or browser APIs are required; prefer Server Components
- **Zod validation** — every API route validates its input with a Zod schema co-located in the route file; schemas are the source of truth for TypeScript types via `z.infer<>`
- **Error handling** — service functions throw typed errors; Route Handlers catch and return a consistent `{ error: { code, message } }` envelope
- **Logging** — structured JSON logs in server code; sensitive data (tokens, passwords, PII) is never logged
- **Naming conventions** — `PascalCase` for components and types; `camelCase` for functions and variables; `kebab-case` for file names; `SCREAMING_SNAKE_CASE` for environment-variable-derived constants
- **No magic strings** — enums and string literals are defined in `types/` and referenced consistently across the codebase

---

## Security Considerations

- **Authentication** — Auth.js v5 with bcrypt (cost factor ≥ 12); sessions use short-lived JWTs stored in HttpOnly, SameSite=Strict cookies; tokens never stored in `localStorage`
- **Authorization (RBAC)** — three roles (`global_admin`, `owner`, `editor`) enforced server-side on every API route; role is never trusted from the client
- **JWT** — refresh token rotation invalidates old tokens on use; revocation tracked in the database
- **Secret management** — all secrets and API keys stored in environment variables; never committed to version control; `.env.example` documents required variables with placeholder values
- **Buffer token encryption** — OAuth access and refresh tokens are encrypted with AES-256 before being stored in the database
- **Input validation** — every API route validates input with a Zod schema before data reaches the service layer or database; invalid payloads are rejected with a structured error
- **Rate limiting** — authentication endpoints (login, register, password reset) are rate-limited to prevent brute force and credential stuffing
- **HTTPS** — enforced by Vercel for all traffic; HTTP requests are redirected
- **SQL injection** — prevented by Prisma's parameterized query builder; no raw SQL in application code
- **XSS** — Next.js escapes React output by default; any user-generated content rendered as HTML is sanitized before display
- **CSRF** — mitigated by SameSite=Strict cookies and Next.js Route Handler origin validation
- **Secure file uploads** — file type and size validated server-side before upload; Cloudinary signed uploads prevent unauthorized direct uploads
- **Audit logging** — every write operation (create, update, approve, reject, delete, publish) is recorded in `audit_logs` with user ID, timestamp, and entity reference

---

## Implementation Phases

| Phase | Focus | Weeks | Complexity |
|---|---|---|---|
| 1 | **Project Initialization** — Next.js 16 setup, Prisma + Neon, Auth.js, EN/BG i18n, CI pipeline, Vercel deploy | 1–2 | Medium |
| 2 | **Company & Brand Management** — multi-company CRUD, team invitations, brand guidelines, global admin, LLM config UI | 3–4 | Medium |
| 3 | **Buffer Integration & Channel Configuration** — OAuth flow, AES-256 token storage, per-channel settings (schedule, windows, language, image rules, automation override) | 5–6 | High |
| 4 | **Content Sources & Feed Ingestion** — RSS parser, product URL crawler, manual prompts, calendar events, per-source deduplication | 7–8 | Medium |
| 5 | **AI Content Generation Engine** — LLM router (Claude/GPT-4o/Grok), weekly schedule generation, channel-specific prompt builder, duplicate detection, content safety check | 9–10 | Very High |
| 6 | **Media Gallery & Image Generation** — Cloudinary signed uploads, Leonardo.ai integration, image picker (gallery + generate tabs), brand-aware generation prompts | 11–12 | Medium |
| 7 | **Post Approval Workflow** — approval queue driven by company/channel automation mode, post editor with inline image picker, version history, rejection with notes, audit log page, weekly calendar view | 13–14 | Medium |
| 8 | **Scheduling, Automation & Reliability** — Vercel Cron dispatcher, Buffer send with retry logic, health endpoint | 15 | Medium |
| 9 | **Analytics Integration** — Buffer analytics fetch, per-post metrics, analytics page, dashboard summary cards | 16 | Low–Medium |
| 10 | **Security Hardening & Production Readiness** — Sentry, rate limiting on auth, full security audit, mobile layout, performance review | 17–18 | Medium |

### Phase 5 — AI Content Generation Engine (detail)

The LLM router reads the active provider from `llm_configs` at request time and delegates to the corresponding client (`claude.ts`, `openai.ts`, `grok.ts`). All providers implement the same interface so switching is a DB change with no code deployment.

The prompt builder assembles context in layers:
1. **System prompt** — role definition, output format rules, channel character limits
2. **Brand context** — tone, forbidden words, target audience, competitors from `brand_guidelines`
3. **Channel rules** — hashtag style, emoji policy, image requirement, language for this channel
4. **Source material** — summarised feed items or user-provided prompt text
5. **Deduplication guard** — last 10 post texts for this company/channel are appended to prevent repetition

Generated posts are checked for content safety (keyword filter + LLM classification) before being written to the database. Flagged posts enter the queue with `safety_flagged = true` and a highlighted warning in the approval UI.

### Phase 6 — Media Gallery & Image Selection (detail)

When a reviewer attaches an image to a post, an **image picker modal** opens with two tabs:

- **Company Gallery** — displays all `media_assets` for the company (`generated_by: user_upload | ai`), ordered by most recent. User clicks to select.
- **AI Generate** — user enters a prompt pre-filled with brand colors and tone from `brand_guidelines`. On submit, Leonardo.ai is called, the result is saved to `media_assets` with `generated_by = 'ai'`, and automatically selected for the current post.

The selected asset's `id` is stored in `posts.media_asset_id`. When the post is sent to Buffer, `media_assets.url` (Cloudinary CDN) is included in the Buffer API payload where `image_required = true` for the channel.

### Phase 7 — Post Approval Workflow (detail)

The approval path for each post is determined in this order:

1. **Channel override** (`channel_configs.automation_mode_override`) — takes priority if set
2. **Company default** (`companies.automation_mode`)

| Effective mode | Post status after generation | Next step |
|---|---|---|
| `semi_automated` | `pending_approval` | Appears in approval queue; owner or editor must act |
| `fully_automated` | `approved` (immediately) | Cron picks it up and sends to Buffer without human interaction |

The approval queue page supports filtering by channel, status, and date. Inline editing saves a new `post_versions` row before updating `posts.content`. Rejection moves the post back to `draft` with optional notes visible to whoever regenerates it.

### Phase 8 — Scheduling, Automation & Reliability (detail)

A single Vercel Cron job calls `POST /api/v1/internal/cron` (protected by `CRON_SECRET`) on a configurable interval (default: every 6 hours). Each execution is designed to complete within the 60-second function timeout by processing **one company at a time**, selected by the oldest `last_cron_processed_at` timestamp (round-robin).

Each cron run executes the following steps in order:

1. **Record start** — insert row in `cron_runs` with `status = 'running'`
2. **Fetch feeds** — for the selected company, fetch new items from all enabled `content_sources` where `last_fetched_at` is stale; deduplicate against existing `feed_items`
3. **Generate weekly schedule** — if the company has no `weekly_schedules` row for next week, trigger AI generation and create `posts` rows with appropriate initial status
4. **Auto-approve** — for companies/channels in `fully_automated` mode, transition all `pending_approval` posts to `approved`
5. **Send to Buffer** — for all `approved` posts with `scheduled_for` within the next 48 hours, call the Buffer API, store `buffer_update_id`, update status to `sent_to_buffer`
6. **Retry failed** — for `failed` posts with `retry_count < 3`, retry Buffer send with exponential backoff (`retry_count * 10` minutes); increment `retry_count` on each attempt
7. **Record completion** — update `cron_runs` row with `status = 'completed'` and `actions_taken` summary

If a step throws, the run is marked `failed` and the error is stored; the next run picks up where the round-robin left off. The `/api/v1/internal/health` endpoint surfaces the last run's status and timestamp for operational monitoring.

---

## Initial Milestones

| Milestone | Scope | Phases |
|---|---|---|
| **M1 — Project Bootstrap** | Repository initialized, CI pipeline running, Vercel deployment live, authentication working | 1 |
| **M2 — Company Foundation** | Multi-company management, brand guidelines, team roles, and global admin fully operational | 2 |
| **M3 — Buffer Integration** | Buffer OAuth connected, social channels configured, test post successfully sent to Buffer | 3 |
| **M4 — Content Pipeline** | Content sources ingesting, AI generation producing weekly post schedules with safety checks | 4–5 |
| **M5 — Publishing Workflow** | Media gallery live, full approval workflow operational in both semi-automated and fully automated modes | 6–7 |
| **M6 — Automation & Observability** | Cron dispatcher running in production, Buffer send with retry working, analytics displayed | 8–9 |
| **M7 — Production Release** | Security hardened, Sentry active, all Definition of Done criteria met, performance reviewed | 10 |

---

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Vercel Hobby: 1 cron job, 60s timeout | High | Cron as lightweight coordinator; process one company per run; escape hatch via GitHub Actions cron |
| Buffer API rate limits or plan restrictions | High | Abstract behind service layer; idempotent retries; pin to stable API version |
| LLM token costs | Medium | Track usage per company; soft cap with user notification; don't regenerate on minor edits |
| LLM output quality | Medium | Semi-automated mode is the default; iterate on system prompts; safety check before approval queue |
| Cross-company data access | Critical | RBAC middleware validates company membership server-side on every request; cover in integration tests |
| Cloudinary free tier bandwidth | Low–Medium | Per-company gallery limit (50 assets v1); serve thumbnails in grid; document limits in UI |

---

## Success Metrics

| Metric | Target |
|---|---|
| **Company onboarding time** | < 10 minutes from registration to first Buffer channel connected |
| **Weekly generation success rate** | ≥ 95% of scheduled cron runs complete without error |
| **Buffer publish success rate** | ≥ 98% of approved posts successfully sent to Buffer within one retry cycle |
| **API response time** | p95 < 500ms for standard CRUD endpoints; < 2s for generation trigger |
| **Post approval time** | Median < 5 minutes from generation to approval in semi-automated mode |
| **Availability** | ≥ 99.5% uptime measured over any 30-day window |
| **Security** | Zero critical vulnerabilities in production; all secrets rotatable within 24 hours of a suspected compromise |
| **Error rate** | < 1% of API requests returning 5xx within one week of production launch |

---

## Definition of Done

- [ ] Register, create company, set brand guidelines, connect Buffer
- [ ] Add content sources; weekly schedule generated by cron
- [ ] Semi-automated: posts appear in approval queue; approve / edit / reject works
- [ ] Fully-automated: approved posts sent to Buffer without user action
- [ ] Media gallery: upload and AI-generate images; attach to posts
- [ ] Global admin views users and companies; audit log is populated
- [ ] Analytics data from Buffer displayed per post
- [ ] TypeScript strict mode; no `any` in production code
- [ ] All API routes protected by auth + RBAC (code-audited)
- [ ] Buffer tokens encrypted at rest; no secrets in client bundle
- [ ] Cron running in production; `cron_runs` table shows healthy history
- [ ] Sentry wired; p95 CRUD response < 500ms; no N+1 queries in list views
- [ ] Mobile-usable layout; loading and empty states on all list pages

---

## Future Improvements (v2+)

- Post preview rendered as it will appear on each network
- Per-channel tone settings (different voice for LinkedIn vs TikTok)
- Learning from existing / high-performing posts
- Document and PDF upload as brand context
- Approval notifications via email or Slack
- Video, Reels, and carousel support
- Advanced analytics: trends, follower growth, best-time-to-post suggestions
- Webhook subscriptions for two-way external project integration
- Upgrade to Vercel Pro for multiple crons and longer function timeouts
- Background job queue (BullMQ + Upstash Redis) to replace single cron
