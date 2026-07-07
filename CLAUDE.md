# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

---

## Commands

```bash
# Development
npm run dev           # Next.js dev server with Turbopack

# Build & Type checking
npm run build         # Production build
npm run typecheck     # tsc --noEmit (run before every commit)

# Linting & formatting
npm run lint          # ESLint
npm run lint:fix      # ESLint with auto-fix
npm run format        # Prettier write
npm run format:check  # Prettier check

# Database
npm run db:generate   # prisma generate (after schema changes)
npm run db:migrate    # prisma migrate dev (creates and applies migration)
npm run db:push       # prisma db push (no migration, dev only)
npm run db:studio     # Prisma Studio GUI

# Seeding
npm run seed:editor   # Seed an editor user
npm run seed:admin    # Seed a global admin user
```

There are no automated tests. Validate changes with `npm run typecheck && npm run lint`.

---

## Architecture Overview

**Stack:** Next.js 16 (App Router) · React 19 · TypeScript strict · Tailwind CSS 4 · Prisma 7 + Neon PostgreSQL · Auth.js v5 · TanStack React Query · next-intl (i18n: `en`, `bg`) · Zod · Husky + lint-staged

### Route Layout

```
app/
├── (auth)/            # Login, register — no layout wrapper
├── (dashboard)/       # All protected pages — uses DashboardLayout
│   ├── dashboard/
│   ├── companies/[slug]/   # Company pages (overview, approval, media)
│   └── admin/
└── api/v1/            # All API routes
    ├── auth/          # Login, register
    ├── admin/         # LLM configs, users, companies (global admin only)
    ├── companies/[slug]/   # Company-scoped resources
    ├── posts/[id]/    # Post actions: approve, reject, submit, edit, publish, restore
    ├── buffer/        # OAuth callback
    └── internal/      # Cron, health (API key protected)
```

### Service Layer

All business logic lives in `lib/services/` — route handlers never touch Prisma directly.

**Service result type convention:**

```typescript
type Result<T> =
  | { success: true; data: T }
  | { success: false; code: "NOT_FOUND" | "FORBIDDEN" | "INVALID_TRANSITION" | ...; message?: string };
```

**Access control pattern** inside every mutating service:

```typescript
async function resolveContext(postId, userId, isGlobalAdmin) {
  const post = await prisma.post.findUnique({ where: { id: postId }, select: { companyId, status } });
  if (!post) return { ok: false, code: "NOT_FOUND" };
  if (isGlobalAdmin) return { ok: true, ..., isOwner: true };
  const membership = await prisma.companyMember.findFirst({ where: { companyId: post.companyId, userId } });
  if (!membership) return { ok: false, code: "NOT_FOUND" };
  return { ok: true, ..., isOwner: membership.role === "owner" };
}
```

Services are grouped by domain: `admin/`, `ai/`, `auth/`, `buffer/`, `company/`, `posts/`.

### API Route Handler Pattern

```typescript
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: { code: "UNAUTHORIZED" } }, { status: 401 });

  const { id } = await params;
  const result = await someService(id, session.user.id, session.user.isGlobalAdmin);

  if (!result.success) {
    switch (result.code) {
      case "NOT_FOUND":
        return NextResponse.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
      case "FORBIDDEN":
        return NextResponse.json({ error: { code: "FORBIDDEN" } }, { status: 403 });
    }
  }
  return NextResponse.json({ data: result.data });
}
```

### Auth & RBAC

- **Framework:** Auth.js v5 (`lib/auth/index.ts`) — Credentials provider, JWT session
- **Session:** `{ user: { id, email, name, isGlobalAdmin, preferredLanguage } }`
- **Roles:** `owner` / `editor` per company (via `CompanyMember.role`)
- **Global admin:** `User.isGlobalAdmin` bypasses all company-level checks
- **Import:** `import { auth } from "@/lib/auth"`

### Database Models (key relationships)

- `User` → many `CompanyMember` (role: owner | editor) → many `Company`
- `Company` → `BrandGuidelines` (1:1), `ChannelConfig[]`, `BufferConnection` (1:1), `Post[]`, `AuditLog[]`
- `Post` → `PostVersion[]` (version history), optional `MediaAsset`
- `AuditLog` → optional `User`, optional `Company` — `action` is a plain string; no enum

Prisma uses `@map()` everywhere: camelCase in code, snake_case in DB. Enums exist for `Role`, `PostStatus`, `SocialChannel`, `LlmProvider`, etc. — prefer using the enum values when interacting with those fields.

After any schema change: `npm run db:migrate` then `npm run db:generate`.

### UI Components

Shared primitives in `components/ui/`: `Card`, `Button`, `Modal`, `Alert`, `Badge`, `Input`, `PageHeader`, `EmptyState`, `Section`.

- `"use client"` is required for any component using hooks or event handlers
- Server Components are preferred for data-fetching pages
- Company-scoped pages use `DashboardLayout` + call services directly (no client fetching for initial load)
- Interactive sections (post cards, approval queue) use TanStack React Query for mutations

### Navigation

`components/dashboard/navigation.tsx` — static `NAV_ITEMS` array. Add new top-level items here. Company-scoped navigation lives within individual company pages/layouts.

### Security

Sensitive tokens (Buffer OAuth) are AES-256 encrypted at rest via `lib/security/encryption.ts`. Never store raw tokens in the DB.

Internal cron routes (`/api/v1/internal/`) are protected by API key, not session.

### i18n

`next-intl` with locale files in `i18n/messages/en.json` and `i18n/messages/bg.json`. Locale detection in `middleware.ts`.

## Project Workflow

UI_REDESIGN_SPEC.md is the authoritative source for all UI/UX decisions.

When implementing redesign phases:

- Read UI_REDESIGN_SPEC.md first.
- Follow the specification exactly.
- Do not improvise UX decisions.
- Preserve existing functionality unless explicitly instructed.
- Run lint, typecheck and build before committing.
- Create one logical commit per completed phase.
