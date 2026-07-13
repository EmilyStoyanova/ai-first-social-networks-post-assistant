# v2-1 — Source Link Resolution

## Goal

Control whether the RSS source article URL is appended to a generated post. The URL is always appended programmatically by the service layer — never left to the LLM to include or exclude.

## Schema Change

```prisma
model ChannelConfig {
  // ... existing fields ...
  includeSourceLink Boolean @default(false) @map("include_source_link")
}
```

Migration: `add_channel_include_source_link`

## Resolution Logic (3 levels)

1. **Manual override** — `Post.promptSnapshot.includeSourceLinkOverride` (set by user at generation time)
2. **Content source config** — `ContentSource.config.includeSourceLink` (set per RSS source)
3. **Channel default** — `ChannelConfig.includeSourceLink` (fallback, default `false`)

The first truthy level wins. `false` at any level is an explicit opt-out.

## Service Changes

### `generate-draft-post.service.ts`

After the LLM returns the post body, resolve the link decision and append if needed:

```typescript
function resolveIncludeSourceLink(
  manualOverride: boolean | undefined,
  sourceConfig: boolean | undefined,
  channelDefault: boolean
): boolean {
  if (manualOverride !== undefined) return manualOverride;
  if (sourceConfig !== undefined) return sourceConfig;
  return channelDefault;
}

function appendSourceUrl(content: string, url: string, maxLength: number | null): AppendResult {
  const separator = content.includes("\n") ? "\n\n" : " ";
  const candidate = `${content}${separator}${url}`;
  if (maxLength && candidate.length > maxLength) {
    return { ok: false, reason: "POST_TOO_LONG_WITH_URL" };
  }
  return { ok: true, content: candidate };
}
```

**Length overflow handling:** if appending the URL would exceed `channelConfig.maxTextLength`, the service either:

- Requests a shorter regeneration (preferred — truncate post text, not URL), or
- Returns `{ success: false, code: 'POST_TOO_LONG_WITH_URL' }` and the caller surfaces a validation error.

**Never truncate the URL.** A truncated URL is non-functional.

### `promptSnapshot` additions

```typescript
promptSnapshot: {
  // ... existing fields ...
  sourceUrl: string | null,
  includeSourceLink: boolean,
  includeSourceLinkLevel: 'manual' | 'source' | 'channel',
}
```

## UI Changes

### Channel Settings page

Add a toggle: **Include source link by default** under each channel's posting preferences. Off by default.

### Content Source Settings

Add a toggle per RSS source: **Override channel link setting** (three-state: inherit / always include / always exclude).

### Post Generation Modal

Optional per-generation override checkbox: **Append source URL to this post** (shows resolved default value; user can flip).

## Acceptance Criteria

- [ ] URL is appended at most once per post
- [ ] URL is the unmodified `FeedItem.url` value
- [ ] When `includeSourceLink` resolves to `false`, LLM-generated CTAs are preserved unchanged
- [ ] If `candidate.length > maxTextLength`: post text shortened or `POST_TOO_LONG_WITH_URL` error — never partial URL
- [ ] `promptSnapshot` records `sourceUrl`, `includeSourceLink`, `includeSourceLinkLevel`
- [ ] Non-RSS posts (prompt, product_page) ignore source link config (no URL to append)
- [ ] EN and BG i18n strings for all new UI labels
- [ ] `npm run typecheck && npm run lint` clean

## Edge Cases

- `FeedItem.url` is always present (unique constraint `[sourceId, url]`); safe to use directly
- Post generated from a prompt-type source: `includeSourceLink` has no effect (no source URL)
- Channel has `maxTextLength = null`: no length check needed, URL always appended when enabled
