# AI-First Social Networks Post Assistant — Implementation Plan

> **Status:** v1.0 · 2026-06-26 · Ready for Development  
> **Stack:** Next.js 14+ (App Router) · TypeScript · PostgreSQL (Neon) · Prisma · Buffer API · Vercel (Hobby)

---

## Project Overview

An AI-powered tool that automates social media post creation, scheduling, and publication for companies and brands. It generates channel-specific content using an LLM, respects brand guidelines, and integrates with Buffer for publishing to Facebook, LinkedIn, Instagram, and TikTok.

**Target users:** Solo creators, small business owners, and marketing agencies managing one or more brands.

**Outcome:** Users spend under 15 minutes per week reviewing AI-generated posts. Brand voice is preserved. A full audit trail covers every generated, approved, and published post.

---

## Technology Stack

| Layer | Technology |
|---|---|
| **Frontend** | Next.js 14+ (App Router), React (RSC + Client Components), Tailwind CSS, ShadCN/UI, TanStack Query |
| **Backend** | Next.js Route Handlers, TypeScript (strict), Zod (validation), Prisma ORM |
| **Database** | PostgreSQL — Neon (serverless, free tier) |
| **Authentication** | Auth.js v5 (Credentials provider), JWT sessions, bcrypt |
| **AI — Text** | Claude API (Anthropic) or OpenAI GPT-4o |
| **AI — Images** | Leonardo.ai API |
| **Storage** | Cloudinary (media assets, CDN, free tier) |
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
- **LLM API access** — a valid API key for Claude or OpenAI GPT-4o is provided; token costs are absorbed by the operator
- **Leonardo.ai API access** — a valid API key is provided; free-tier credits are sufficient for v1 usage
- **Users are comfortable with English UI** — the application interface is in English; generated post content supports multiple languages as configured per company
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
        ├──► LLM API — Claude / GPT-4o (text generation)
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
| **Claude / OpenAI API** | LLM text generation for posts, hashtags, safety checks | Post generation halts; both providers are abstracted behind a single interface so switching requires a config change only |
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
├── lib/
│   ├── services/             # Business logic (company, post, generation, buffer, audit)
│   ├── ai/                   # LLM + image generator clients
│   ├── buffer/               # Buffer API wrapper
│   ├── cloudinary/           # Cloudinary client
│   ├── jobs/                 # Cron dispatcher
│   ├── auth/                 # Auth.js config + RBAC middleware
│   ├── db/                   # Prisma client singleton
│   └── validators/           # Zod schemas
├── prisma/                   # schema.prisma + migrations
├── types/
├── middleware.ts             # Route protection
└── vercel.json              # Cron job definition
```

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
| 1 | **Project Initialization** — Next.js setup, DB, Auth.js, CI pipeline, Vercel deploy | 1–2 | Medium |
| 2 | **Company & Brand Management** — multi-company CRUD, team roles, brand guidelines, global admin | 3–4 | Medium |
| 3 | **Buffer Integration & Channel Configuration** — OAuth flow, encrypted token storage, per-channel settings UI | 5–6 | High |
| 4 | **Content Sources & Feed Ingestion** — RSS, product URL crawling, manual prompts, calendar events | 7–8 | Medium |
| 5 | **AI Content Generation Engine** — weekly schedule generation, channel formatting, safety check, duplicate detection | 9–10 | Very High |
| 6 | **Media Gallery & Image Generation** — Cloudinary uploads, Leonardo.ai integration, image picker | 11–12 | Medium |
| 7 | **Post Approval Workflow** — approval queue UI, post editor, version history, audit log page, weekly calendar | 13–14 | Medium |
| 8 | **Scheduling, Automation & Reliability** — Vercel Cron dispatcher, Buffer send with retry, health endpoint | 15 | Medium |
| 9 | **Analytics Integration** — Buffer analytics fetch, analytics page, dashboard summary | 16 | Low–Medium |
| 10 | **Security Hardening & Production Readiness** — Sentry, rate limiting, security audit, mobile layout, performance review | 17–18 | Medium |

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
