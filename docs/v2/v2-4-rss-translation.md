# v2-4 — RSS Translation via LLM

## Goal

Translate RSS feed item content into the company's target language before post generation. Original `title` and `content` fields are **never modified**. Translation is asynchronous and retryable.

## Schema Change

```prisma
model FeedItem {
  // ... existing fields (title, content, url, publishedAt, enabled, usedInPost) unchanged ...

  // Translation fields — all nullable; only populated for RSS sources when translation enabled
  translatedTitle          String?   @map("translated_title")
  translatedContent        String?   @map("translated_content")
  translationLanguage      String?   @map("translation_language")       // ISO 639-1, e.g. "bg"
  translationStatus        String?   @map("translation_status")         // pending|completed|failed|skipped
  translationHash          String?   @map("translation_hash")           // sha256(title+content+targetLang)
  translationError         String?   @map("translation_error")
  translatedAt             DateTime? @map("translated_at")
  translationProvider      String?   @map("translation_provider")
  translationModel         String?   @map("translation_model")
  translationAttemptCount  Int       @default(0) @map("translation_attempt_count")
  translationLastAttemptAt DateTime? @map("translation_last_attempt_at")
  translationNextRetryAt   DateTime? @map("translation_next_retry_at")
}
```

Migration: `add_feed_item_translation_fields`

## Configuration

Translation is opt-in per content source. Add `translateEnabled: boolean` and `translateToLanguage: string` to `ContentSource.config` JSON (no schema change needed — `config` is already `Json`).

## Architecture

### Step 2b — Translation Cron Step

Runs after RSS ingest (step 2a), before generation (step 3). Bounded: max `TRANSLATION_BATCH_SIZE` items per run (default: 10, product decision required).

```
Eligible items:
  translationStatus IN ('pending', 'failed')
  AND (translationNextRetryAt IS NULL OR translationNextRetryAt <= now())
  AND translationAttemptCount < MAX_TRANSLATION_ATTEMPTS   // default: 5
  AND source.config.translateEnabled = true
  ORDER BY translationNextRetryAt ASC NULLS FIRST
  LIMIT TRANSLATION_BATCH_SIZE
```

### Translation Service: `lib/services/ai/translate-feed-item.service.ts`

```typescript
async function translateFeedItem(item: FeedItem, targetLang: string): Promise<void> {
  const hash = sha256(`${item.title ?? ""}${item.content ?? ""}${targetLang}`);

  // Skip if content unchanged and already completed
  if (item.translationHash === hash && item.translationStatus === "completed") return;

  await prisma.feedItem.update({
    where: { id: item.id },
    data: {
      translationLastAttemptAt: new Date(),
      translationAttemptCount: { increment: 1 },
      translationStatus: "pending",
    },
  });

  try {
    const provider = getLlmProvider();
    const { translatedTitle, translatedContent } = await callTranslationPrompt(
      provider,
      item.title,
      item.content,
      targetLang
    );

    await prisma.feedItem.update({
      where: { id: item.id },
      data: {
        translatedTitle,
        translatedContent,
        translationLanguage: targetLang,
        translationStatus: "completed",
        translationHash: hash,
        translatedAt: new Date(),
        translationProvider: provider.providerName,
        translationModel: provider.modelName,
        translationError: null,
        translationNextRetryAt: null,
      },
    });
  } catch (err) {
    const nextRetry = computeBackoff(item.translationAttemptCount + 1); // exponential, max 24h
    await prisma.feedItem.update({
      where: { id: item.id },
      data: {
        translationStatus: "failed",
        translationError: err instanceof Error ? err.message : "Unknown error",
        translationNextRetryAt: nextRetry,
      },
    });
  }
}
```

### Backoff Schedule

| Attempt | Delay                                               |
| ------- | --------------------------------------------------- |
| 1       | 5 min                                               |
| 2       | 30 min                                              |
| 3       | 2 h                                                 |
| 4       | 8 h                                                 |
| 5       | 24 h (max; item stays `failed`, no further retries) |

### Translation Prompt Structure

```
System: You are a professional translator. Translate the following article title and body into {targetLang}.
Preserve meaning exactly. Return JSON: {"title": "...", "content": "..."}
Do not add commentary, summaries, or any additional text.

User:
Title: {item.title}
Content: {item.content}
```

## Generation Integration

In `generate-draft-post.service.ts`, when selecting content for a feed item:

```typescript
function resolveItemContent(item: FeedItem): { title: string | null; content: string | null } {
  if (
    item.translationStatus === "completed" &&
    item.translatedTitle !== null &&
    item.translatedContent !== null
  ) {
    return { title: item.translatedTitle, content: item.translatedContent };
  }
  // Fall back to original — translation pending, failed, or skipped
  return { title: item.title, content: item.content };
}
```

The generation service **only uses translation when `translationStatus === 'completed'`**. Any other status — `pending`, `failed`, `skipped`, or `null` — falls back to original fields.

## UI Changes

### Content Source Settings

- Toggle: **Translate content** (requires translation language selection)
- Language selector: target language for this source
- Status indicator per feed item: Translated / Pending / Failed / Skipped / Original

### Feed Items list

Show translation status badge. Failed items show error summary. No manual re-trigger needed — cron handles retries.

## Acceptance Criteria

- [ ] `FeedItem.title` and `FeedItem.content` unchanged after any translation operation
- [ ] `sha256(title + content + targetLang)` match + `translationStatus === 'completed'` → skip re-translation
- [ ] Translation failure: `translationStatus = 'failed'`, `translationError` populated, `translationNextRetryAt` set
- [ ] Generation uses `translatedTitle`/`translatedContent` only when `translationStatus === 'completed'`
- [ ] Items fail after `MAX_TRANSLATION_ATTEMPTS`; no further retries attempted
- [ ] Backoff schedule respected: `translationNextRetryAt` not in the past before item is eligible
- [ ] `translationLastAttemptAt` updated on every attempt; `translatedAt` updated only on success
- [ ] `TRANSLATION_BATCH_SIZE` enforced; cron step does not exceed limit
- [ ] EN and BG i18n for all new UI labels
- [ ] `npm run typecheck && npm run lint` clean

## Edge Cases

- Non-RSS source types (`prompt`, `product_page`, `calendar_event`): `translateEnabled` ignored; no translation attempted
- `item.title` is null: translate only `content`; store `translatedTitle = null`
- Translation response JSON malformed: treat as failure; increment attempt count
- Target language same as source language: still translate (LLM gracefully returns same-language text); or add `skipped` status for this case (product decision)
- `translationAttemptCount` already at max when cron runs: item excluded from batch; stays `failed`
