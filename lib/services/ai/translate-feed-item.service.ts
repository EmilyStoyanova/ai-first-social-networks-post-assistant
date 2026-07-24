import { prisma } from "@/lib/db/client";
import type { ILlmProvider } from "@/lib/ai/types";
import {
  buildTranslationPrompts,
  computeTranslationBackoff,
  computeTranslationHash,
  parseTranslationResponse,
  MAX_TRANSLATION_ATTEMPTS,
} from "@/lib/ai/feed-item-translation";
import { claimFeedItemForTranslation } from "@/lib/ai/feed-item-translation-claim";
import { resolveLlmSelection } from "./resolve-llm-selection.service";
import {
  buildSupportedProvider,
  ProviderNotAvailableError,
} from "@/lib/ai/llm/supported-providers";

/**
 * Translates one feed item into the source's target language (v2-4).
 *
 * Invariants:
 *   • `title`/`content` are never written here — the original article is source
 *     data. Output goes to the translated* columns only.
 *   • The provider is the admin default (see resolve-llm-selection.service.ts).
 *     Translation never passes a per-generation llmConfigId, and a provider that
 *     cannot be built is an error — never a silent swap to another provider.
 *   • Failures are recorded with a capped backoff rather than thrown, so one bad
 *     article cannot stall a cron run.
 */

export type TranslateFeedItemOutcome =
  | { status: "translated"; provider: string; model: string }
  /**
   * No LLM call was made because another run owns the item:
   *   • "unchanged"    — hash matches an already-completed translation;
   *   • "max_attempts" — the retry budget is exhausted;
   *   • "claimed"      — a concurrent run holds the atomic claim (in flight);
   *   • "superseded"   — a concurrent run finished/reclaimed it after this attempt started.
   */
  | { status: "skipped"; reason: "unchanged" | "max_attempts" | "claimed" | "superseded" }
  /** No admin default provider configured; deliberately does NOT count an attempt. */
  | { status: "no_provider" }
  | { status: "failed"; error: string; nextRetryAt: Date };

/** The FeedItem fields translation reads. */
export interface TranslatableItem {
  id: string;
  title: string | null;
  content: string | null;
  /** The article's own URL — logged for diagnostics so a hang/timeout is traceable. */
  url: string;
  translationStatus: string | null;
  translationHash: string | null;
  translationAttemptCount: number;
}

/** Narrow DB surface — real Prisma satisfies it; tests inject a fake. */
export interface TranslateFeedItemDb {
  feedItem: {
    update: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown>;
    /**
     * Conditional write used for BOTH the atomic claim and the guarded failure write.
     * Each is an `UPDATE ... WHERE <still-eligible>` returning the number of rows
     * actually changed, so a run can tell whether it still owns the item (count 1) or
     * a concurrent run took it (count 0).
     */
    updateMany: (args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => Promise<{ count: number }>;
  };
}

export interface TranslateFeedItemDeps {
  db?: TranslateFeedItemDb;
  /** Resolves the provider instance + provenance. Defaults to the admin default. */
  resolveProvider?: () => Promise<
    { ok: true; instance: ILlmProvider; provider: string; model: string } | { ok: false }
  >;
  now?: () => Date;
}

async function defaultResolveProvider(): Promise<
  { ok: true; instance: ILlmProvider; provider: string; model: string } | { ok: false }
> {
  // No llmConfigId/preference: translation is system work, so it uses the admin
  // default exactly like cron generation does.
  const selection = await resolveLlmSelection({});
  if (!selection.success) return { ok: false };

  try {
    const built = buildSupportedProvider(selection.selection.provider);
    return {
      ok: true,
      instance: built.instance,
      provider: selection.selection.providerLabel,
      model: built.model,
    };
  } catch (err) {
    // Active provider whose env config is absent — report unavailable rather
    // than falling back to a different provider.
    if (err instanceof ProviderNotAvailableError) return { ok: false };
    throw err;
  }
}

export async function translateFeedItem(
  item: TranslatableItem,
  targetLang: string,
  deps: TranslateFeedItemDeps = {}
): Promise<TranslateFeedItemOutcome> {
  const db = deps.db ?? prisma;
  const now = deps.now ?? (() => new Date());
  const resolveProvider = deps.resolveProvider ?? defaultResolveProvider;

  const hash = computeTranslationHash(item.title, item.content, targetLang);

  // Nothing changed since the last successful translation — no LLM call.
  if (item.translationHash === hash && item.translationStatus === "completed") {
    return { status: "skipped", reason: "unchanged" };
  }

  // Exhausted its budget: stays failed, never retried again.
  if (item.translationAttemptCount >= MAX_TRANSLATION_ATTEMPTS) {
    return { status: "skipped", reason: "max_attempts" };
  }

  const resolved = await resolveProvider();
  if (!resolved.ok) {
    // A missing admin default is an operator problem, not an article problem:
    // leave the item queued at its current attempt count so it translates
    // normally once a provider is configured.
    return { status: "no_provider" };
  }

  const attempt = item.translationAttemptCount + 1;

  // Atomically CLAIM the item before calling out. This is the single point that makes
  // translation safe under concurrency: the scheduled cron and a continuation job select
  // candidates with no lock, so both can hold this same item — but only one wins the
  // conditional write below. The winner flips the row to `translating`, stamps a lease,
  // stores the input hash, and counts the attempt exactly once; the loser matches no row
  // and skips WITHOUT calling the LLM. This eliminates duplicate calls, double attempt
  // increments, and the racing writes at their source. A crashed claim self-recovers once
  // its lease expires (see feed-item-translation-claim.ts). The lease is reused below as a
  // fencing token so a stale attempt can never clobber a fresher claim or a completion.
  const claimAt = now();
  const { claimed, leaseExpiresAt } = await claimFeedItemForTranslation(db, {
    id: item.id,
    hash,
    targetLang,
    now: claimAt,
  });
  if (!claimed) {
    console.info("[rss-translation] item already claimed by another run — skipping", {
      feedItemId: item.id,
      sourceUrl: item.url,
    });
    return { status: "skipped", reason: "claimed" };
  }

  const { systemPrompt, userPrompt } = buildTranslationPrompts(item.title, item.content, targetLang);

  // Per-translation diagnostics. The article BODY is never logged — only its length —
  // so a request that hangs or times out can be tied to an exact feed item (id, title,
  // source URL) and correlated with prompt/article size, without dumping content.
  const diag = {
    feedItemId: item.id,
    title: item.title ?? "(untitled)",
    sourceUrl: item.url,
    promptLength: systemPrompt.length + userPrompt.length,
    articleTextLength: item.content?.length ?? 0,
  };
  const startedAtMs = now().getTime();
  // Logged BEFORE the call so an item whose request hangs and never returns (e.g. process
  // killed or lease reaped) still leaves a line naming the exact in-flight feed item.
  console.info("[rss-translation] translating item", diag);

  try {
    const response = await resolved.instance.generate({
      systemPrompt,
      userPrompt,
      temperature: 0.2,
    });

    let translatedTitle: string | null;
    let translatedContent: string;
    try {
      ({ translatedTitle, translatedContent } = parseTranslationResponse(response.text));
    } catch (parseErr) {
      // The transport succeeded (HTTP 200) but the reply could not be parsed. Log the SHAPE
      // of the raw model output — first/last 200 chars and total length only, never the full
      // body — so the exact failure pattern (truncation, prose, wrong format) is diagnosable.
      const text = response.text ?? "";
      console.warn("[rss-translation] unparseable model response", {
        ...diag,
        responseLength: text.length,
        responseFirst200: text.slice(0, 200),
        responseLast200: text.length > 200 ? text.slice(-200) : "",
        error: parseErr instanceof Error ? parseErr.message : String(parseErr),
      });
      throw parseErr;
    }

    // Success is written UNCONDITIONALLY by id and always wins: a genuine, completed
    // translation is the outcome we most want to keep, even if a lease-expiry hand-off
    // means a second run is also working on the item. Clearing the lease marks the claim
    // released.
    await db.feedItem.update({
      where: { id: item.id },
      data: {
        translatedTitle,
        translatedContent,
        translationLanguage: targetLang,
        translationStatus: "completed",
        translationHash: hash,
        translatedAt: now(),
        translationProvider: resolved.provider,
        translationModel: resolved.model,
        translationError: null,
        translationNextRetryAt: null,
        translationLeaseExpiresAt: null,
      },
    });

    console.info("[rss-translation] item translated", {
      ...diag,
      elapsedMs: now().getTime() - startedAtMs,
      provider: resolved.provider,
      model: resolved.model,
    });

    return { status: "translated", provider: resolved.provider, model: resolved.model };
  } catch (err) {
    const error = err instanceof Error ? err.message : "Unknown translation error.";
    const nextRetryAt = computeTranslationBackoff(attempt, now());

    // Names the exact feed item that failed (e.g. a >300s text-worker timeout) with how
    // long it ran and the error, so a hang is pinned to one article, not the whole batch.
    console.warn("[rss-translation] item translation FAILED", {
      ...diag,
      elapsedMs: now().getTime() - startedAtMs,
      error,
    });

    // Guarded write (defense in depth on top of the claim): only record the failure while
    // this run still holds ITS claim — the row is `translating` AND carries the exact lease
    // this attempt stamped. The lease acts as a fencing token, so the failure lands only if
    // nothing displaced us. It matches no row when a concurrent run has since completed the
    // item (status → completed) or reclaimed an expired lease (a different lease value); in
    // either case we must NOT overwrite their state with a stale "failed", which is precisely
    // the bug where the UI showed "Translation failed" for an item that was actually translated.
    const written = await db.feedItem.updateMany({
      where: {
        id: item.id,
        translationStatus: "translating",
        translationLeaseExpiresAt: leaseExpiresAt,
      },
      data: {
        translationStatus: "failed",
        translationError: error,
        translationNextRetryAt: nextRetryAt,
        translationLeaseExpiresAt: null,
      },
    });

    if (written.count === 0) {
      // Another run finished or reclaimed this item after our attempt started — its state
      // stands. Report skipped (not failed): this run translated nothing, and the run that
      // owns the item now is the one that counts its outcome.
      console.info("[rss-translation] failure superseded by a concurrent run", { ...diag });
      return { status: "skipped", reason: "superseded" };
    }

    return { status: "failed", error, nextRetryAt };
  }
}
