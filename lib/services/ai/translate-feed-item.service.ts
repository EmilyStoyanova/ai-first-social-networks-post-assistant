import { prisma } from "@/lib/db/client";
import type { ILlmProvider } from "@/lib/ai/types";
import {
  buildTranslationPrompts,
  computeTranslationBackoff,
  computeTranslationHash,
  parseTranslationResponse,
  MAX_TRANSLATION_ATTEMPTS,
} from "@/lib/ai/feed-item-translation";
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
  /** Input hash unchanged and already completed — no LLM call made. */
  | { status: "skipped"; reason: "unchanged" | "max_attempts" }
  /** No admin default provider configured; deliberately does NOT count an attempt. */
  | { status: "no_provider" }
  | { status: "failed"; error: string; nextRetryAt: Date };

/** The FeedItem fields translation reads. */
export interface TranslatableItem {
  id: string;
  title: string | null;
  content: string | null;
  translationStatus: string | null;
  translationHash: string | null;
  translationAttemptCount: number;
}

/** Narrow DB surface — real Prisma satisfies it; tests inject a fake. */
export interface TranslateFeedItemDb {
  feedItem: {
    update: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown>;
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

  // Record the attempt before calling out, so a crash mid-call still counts.
  // The hash is stored here (not only on success) so ingestion can tell "this
  // exact input was already attempted" from "the article changed".
  await db.feedItem.update({
    where: { id: item.id },
    data: {
      translationStatus: "pending",
      translationHash: hash,
      translationLanguage: targetLang,
      translationLastAttemptAt: now(),
      translationAttemptCount: { increment: 1 },
    },
  });

  try {
    const { systemPrompt, userPrompt } = buildTranslationPrompts(
      item.title,
      item.content,
      targetLang
    );
    const response = await resolved.instance.generate({
      systemPrompt,
      userPrompt,
      temperature: 0.2,
    });
    const { translatedTitle, translatedContent } = parseTranslationResponse(response.text);

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
      },
    });

    return { status: "translated", provider: resolved.provider, model: resolved.model };
  } catch (err) {
    const error = err instanceof Error ? err.message : "Unknown translation error.";
    const nextRetryAt = computeTranslationBackoff(attempt, now());

    await db.feedItem.update({
      where: { id: item.id },
      data: {
        translationStatus: "failed",
        translationError: error,
        translationNextRetryAt: nextRetryAt,
      },
    });

    return { status: "failed", error, nextRetryAt };
  }
}
