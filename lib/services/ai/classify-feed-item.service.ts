import { prisma } from "@/lib/db/client";
import type { ILlmProvider } from "@/lib/ai/types";
import { resolveFeedItemContent } from "@/lib/ai/feed-item-translation";
import {
  buildClassificationRepairPrompt,
  buildClassificationSystemPrompt,
  buildClassificationUserPrompt,
  classificationMode,
  classifyInput,
  fitsSingleClassificationCall,
  ClassificationParseError,
  computeClassificationHash,
  hasCompanyContext,
  parseClassificationResponse,
  CLASSIFICATION_ATTEMPT_TIMEOUT_MS,
  CLASSIFICATION_ITEM_TIMEOUT_MS,
  CLASSIFICATION_JSON_SCHEMA,
  CLASSIFICATION_LEASE_MS,
  MAX_CLASSIFICATION_ATTEMPTS,
  MAX_CLASSIFICATION_OUTPUT_TOKENS,
  MAX_CLASSIFICATION_REPAIR_ATTEMPTS,
  type ClassifiableText,
  type ClassificationContext,
  type ClassificationOutcome,
} from "@/lib/ai/feed-item-classification";
import {
  understandArticle,
  ArticleUnderstandingTimeoutError,
  UNDERSTANDING_ATTEMPT_TIMEOUT_MS,
} from "./understand-article.service";
import { resolveLlmSelection } from "./resolve-llm-selection.service";
import {
  buildSupportedProvider,
  ProviderNotAvailableError,
} from "@/lib/ai/llm/supported-providers";
import { GenerationTracer } from "@/lib/generation-trace/tracer";

/**
 * Classifies ONE feed item against its company's topic priorities.
 *
 * Invariants, all mirroring translation and extraction for the same reasons:
 *   • `title`/`content` are never written here. The verdict is derived from them
 *     and stored beside them, so the input a verdict was made from stays
 *     auditable and a re-run always starts from the article rather than from its
 *     own last answer.
 *   • The provider is the admin default. Classification is system work and never
 *     passes a per-generation llmConfigId; an unavailable provider is reported,
 *     never silently swapped.
 *   • Failures are recorded, not thrown, so one bad article cannot stall a drain.
 *
 * The one rule that is specific to this step, and the most important line in the
 * file: **a failure is never a rejection**. `no_provider`, a timeout, a dead
 * transport, and a reply that could not be trusted all leave `classification`
 * NULL. Writing REJECTED for any of them would quietly discard an article the
 * company asked for because a model was briefly unavailable — and, unlike a
 * translation failure, nothing downstream would ever look at it again.
 *
 * ── Two steps, one flow ──────────────────────────────────────────────────────
 *
 * Every article — short or long — goes through exactly two calls' worth of work:
 *
 *   1. `understandArticle` (`understand-article.service.ts`, reusing
 *      `lib/ai/article-understanding.ts`) reads the ENTIRE article once and
 *      produces one `ArticleUnderstanding`: its real subject, thesis, conflict,
 *      type, secondary/incidental topics, entities, confidence, and evidence.
 *      For a long article this is where chunking happens — ONCE, entirely
 *      inside `understandArticle`. This service does not chunk, does not read
 *      raw article text past this point, and does not bank per-chunk progress
 *      of its own; see that module's own comment for why.
 *   2. The verdict call (`askVerdictUntilUsable` below) answers a narrower
 *      question against that already-settled understanding: does the MAIN
 *      SUBJECT match one of the company's configured topics, and if so which
 *      one? It never re-reads the article and is not allowed to invent a
 *      different subject — `mainSubject` stored on the FeedItem always comes
 *      from `understanding.mainSubject`, never from this call's own reply
 *      (see `feed-item-classification.ts`'s `ClassificationVerdict` comment).
 *
 * This REPLACES the whole-article chunk-analysis pipeline classification used
 * to run itself (`classification-chunk-analysis.ts`'s per-chunk prompt/parser
 * are still there and still used — by `understandArticle`, not duplicated here).
 * One consequence: a long article's chunk analysis has no cross-run banking of
 * its own any more (`understandArticle` has none — see its module comment). A
 * process restart mid-run re-reads the whole article on the next attempt,
 * rather than resuming from a banked chunk. That trade is deliberate — see the
 * module comment on `understand-article.service.ts`.
 */

export type ClassifyFeedItemOutcome =
  | {
      status: "classified";
      classification: "HIGH" | "MEDIUM" | "REJECTED";
      rejectionReason: "BLACKLIST" | "OUT_OF_SCOPE" | null;
      matchedTopics: string[];
      provider: string;
      model: string;
    }
  /**
   * Settled with no model call:
   *   • "unchanged"      — the stored verdict already matches this text + config;
   *   • "not_configured" — the company has configured no topics at all;
   *   • "no_content"     — the item has neither a title nor a body to judge;
   *   • "max_attempts"   — the retry budget is spent;
   *   • "claimed"        — a concurrent run holds the item.
   */
  | {
      status: "skipped";
      reason: "unchanged" | "not_configured" | "no_content" | "max_attempts" | "claimed";
    }
  /** No admin default provider configured; deliberately does NOT count an attempt. */
  | { status: "no_provider" }
  /** Article understanding failed, the model or the transport broke, or the reply could not be trusted. */
  | { status: "failed"; error: string };

/** The FeedItem fields classification reads. */
export interface ClassifiableItem {
  id: string;
  /**
   * Which company this article belongs to. Read only so the trace run can be
   * filed under it — nothing in classification branches on it, and it is
   * optional so a caller assembled before tracing existed stays valid.
   */
  companyId?: string;
  title: string | null;
  content: string | null;
  url: string;
  translatedTitle?: string | null;
  translatedContent?: string | null;
  translationStatus?: string | null;
  classificationStatus: string | null;
  classificationHash: string | null;
  classificationAttemptCount: number;
}

/** Narrow DB surface — real Prisma satisfies it; tests inject a fake. */
export interface ClassifyFeedItemDb {
  feedItem: {
    update: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown>;
    updateMany: (args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => Promise<{ count: number }>;
  };
}

export interface ClassifyFeedItemDeps {
  db?: ClassifyFeedItemDb;
  resolveProvider?: () => Promise<
    { ok: true; instance: ILlmProvider; provider: string; model: string } | { ok: false }
  >;
  now?: () => Date;
  /** Wall-clock cap for ONE model call (understanding or verdict). Overridable so tests need not wait. */
  attemptTimeoutMs?: number;
  /**
   * ABSOLUTE wall-clock cap for the whole item, overriding whichever
   * path-appropriate default would otherwise apply. For tests — production
   * never sets this; it lets `remainingRunBudgetMs` decide instead. Set,
   * this wins outright (it is not additionally capped by the path default).
   */
  itemTimeoutMs?: number;
  /**
   * How much of the RUN's own budget is left, per `classify-feed-items.service.ts`'s
   * `remainingMs`. The item's actual budget becomes
   * `min(pathDefault, remainingRunBudgetMs)` — the path default being
   * {@link CLASSIFICATION_ITEM_TIMEOUT_MS} or the larger
   * {@link CLASSIFICATION_CHUNKED_ITEM_TIMEOUT_MS}, decided only once this
   * function has resolved the text and knows whether the article needs
   * chunking. Kept separate from `itemTimeoutMs` because the caller cannot
   * know which default applies without duplicating that decision itself.
   */
  remainingRunBudgetMs?: number;
  maxRepairAttempts?: number;
  /**
   * The trace recorder for this classification. Injected in tests; production
   * starts its own run. Observation only — nothing here branches on it.
   */
  tracer?: GenerationTracer;
}

/**
 * A reply that arrived, parsed, and still could not be trusted — after its repair
 * call. An Error so it joins the existing failure path (claim-guarded write,
 * attempt counter, retry on the next drain), which is exactly what an untrustworthy
 * verdict needs.
 */
export class UntrustworthyClassificationError extends Error {
  readonly code = "UNTRUSTWORTHY_CLASSIFICATION" as const;
  constructor(problem: string) {
    super(`The classification could not be trusted and was not stored. ${problem}`);
    this.name = "UntrustworthyClassificationError";
  }
}

export class ClassificationTimeoutError extends Error {
  readonly code = "CLASSIFICATION_TIMEOUT" as const;
  constructor(ms: number, scope: "attempt" | "item") {
    super(`Article classification ${scope} exceeded its ${ms}ms budget.`);
    this.name = "ClassificationTimeoutError";
  }
}

/**
 * A reply that arrived from `understandArticle` but was not `status: "ok"` —
 * turned into an Error so it joins the same generic failure path as any other
 * problem (claim-guarded write, attempt counter, retry on the next drain).
 */
export class ArticleUnderstandingFailedError extends Error {
  readonly code = "ARTICLE_UNDERSTANDING_FAILED" as const;
  constructor(problem: string) {
    super(`Could not understand the article: ${problem}`);
    this.name = "ArticleUnderstandingFailedError";
  }
}

/**
 * Wall-clock cap for the whole item on the CHUNKED path — larger than the
 * short path's {@link CLASSIFICATION_ITEM_TIMEOUT_MS} because a long article's
 * understanding step costs several model calls (one per chunk, plus one
 * synthesis call) before the verdict call even starts. Sized like
 * translation's own item budget (`TRANSLATION_ITEM_TIMEOUT_MS`), which pays
 * for the same kind of multi-call article processing on the same worker.
 */
export const CLASSIFICATION_CHUNKED_ITEM_TIMEOUT_MS = 210_000;

/**
 * Rejects with {@link ClassificationTimeoutError} if `work` has not settled in
 * `ms`. The underlying request is NOT cancelled — the provider owns its own much
 * longer transport cap. This bound exists so a hung article stops occupying the
 * drain, not to manage the socket. Wraps `understandArticle` exactly as it wraps
 * the verdict call: `understandArticle` has no item-level deadline of its own
 * (see its module comment), so this is the only thing standing between a
 * pathological article and an item that never gives the drain back.
 */
function withTimeout<T>(work: Promise<T>, ms: number, scope: "attempt" | "item"): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ClassificationTimeoutError(ms, scope)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

async function defaultResolveProvider(): Promise<
  { ok: true; instance: ILlmProvider; provider: string; model: string } | { ok: false }
> {
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
    if (err instanceof ProviderNotAvailableError) return { ok: false };
    throw err;
  }
}

export async function classifyFeedItem(
  item: ClassifiableItem,
  context: ClassificationContext,
  deps: ClassifyFeedItemDeps = {}
): Promise<ClassifyFeedItemOutcome> {
  const db = deps.db ?? prisma;
  const now = deps.now ?? (() => new Date());
  const resolveProvider = deps.resolveProvider ?? defaultResolveProvider;
  const { priorities } = context;

  // The single resolver every other step reads through: a completed translation
  // is what gets judged, so a Bulgarian topic list is compared against Bulgarian
  // text rather than against the original English.
  const resolved = resolveFeedItemContent(item);
  const text: ClassifiableText = { title: resolved.title, body: resolved.content };
  const mode = classificationMode(priorities);
  const inputKind = classifyInput(text);

  // ── Settled without a model ────────────────────────────────────────────────

  // No configuration at all. The backwards-compatibility contract: nothing is
  // rejected, and `classification` stays null so candidate selection sees an
  // article with no signal rather than a discarded one.
  if (mode === "none") {
    await db.feedItem.update({
      where: { id: item.id },
      data: {
        classificationStatus: "skipped",
        classification: null,
        classificationRejectionReason: null,
        classificationMatchedTopics: [],
        classificationReason: null,
        // Cleared with the rest of the verdict: a settled non-answer has no
        // subject and no deciding topic, and a stale one read as if it did.
        classificationMainSubject: null,
        classificationPrimaryTopic: null,
        classificationHash: computeClassificationHash(text, context),
        classificationError: null,
        classifiedAt: now(),
        classificationLeaseExpiresAt: null,
      },
    });
    return { status: "skipped", reason: "not_configured" };
  }

  // Nothing to read. Settled rather than failed: retrying re-asks a question only
  // a re-ingest can change, and a re-ingest changes the hash and reopens it.
  if (inputKind === "empty") {
    await db.feedItem.update({
      where: { id: item.id },
      data: {
        classificationStatus: "skipped",
        classification: null,
        classificationRejectionReason: null,
        classificationMatchedTopics: [],
        classificationReason: null,
        // Cleared with the rest of the verdict: a settled non-answer has no
        // subject and no deciding topic, and a stale one read as if it did.
        classificationMainSubject: null,
        classificationPrimaryTopic: null,
        classificationHash: computeClassificationHash(text, context),
        classificationError: "The article has no readable title or body to classify.",
        classifiedAt: now(),
        classificationLeaseExpiresAt: null,
      },
    });
    return { status: "skipped", reason: "no_content" };
  }

  const hash = computeClassificationHash(text, context);

  // Neither the article nor the configuration has changed since the stored
  // verdict. Settle the row back to `completed` WITHOUT a model call — this is
  // what makes reclassification idempotent and lets a settings save reopen items
  // bluntly: anything whose inputs did not really change costs one write.
  if (item.classificationHash === hash) {
    if (item.classificationStatus !== "completed" && item.classificationStatus !== "skipped") {
      await db.feedItem.updateMany({
        where: { id: item.id, classificationHash: hash },
        data: {
          classificationStatus: "completed",
          classificationError: null,
          classificationLeaseExpiresAt: null,
        },
      });
    }
    return { status: "skipped", reason: "unchanged" };
  }

  if (item.classificationAttemptCount >= MAX_CLASSIFICATION_ATTEMPTS) {
    return { status: "skipped", reason: "max_attempts" };
  }

  const provider = await resolveProvider();
  if (!provider.ok) {
    // An operator problem, not an article problem: leave the item pending at its
    // current attempt count so it classifies once a provider is configured.
    return { status: "no_provider" };
  }

  // Decided BEFORE the claim, purely from the text — never truncated, never
  // sampled. Kept ONLY to size the item's timeout budget below; the actual
  // decision to chunk (or not) is made again, identically, inside
  // `understandArticle` itself — see that function's own comment for why this
  // is not a duplicated decision so much as a shared, pure threshold check.
  const needsChunking = inputKind === "full" && !fitsSingleClassificationCall(text.body);

  const attempt = item.classificationAttemptCount + 1;
  const leaseExpiresAt = new Date(now().getTime() + CLASSIFICATION_LEASE_MS);

  // Atomic claim. Candidates are selected without locking, so the scheduled drain
  // and a continuation can both hold this item — only one wins this conditional
  // write, and the loser skips WITHOUT calling the model. A crashed run leaves the
  // row `classifying` with a lease in the past, which the selector reclaims.
  const claim = await db.feedItem.updateMany({
    where: {
      id: item.id,
      OR: [
        { classificationStatus: { in: ["pending", "failed"] } },
        { classificationStatus: "classifying", classificationLeaseExpiresAt: { lt: now() } },
      ],
    },
    data: {
      classificationStatus: "classifying",
      classificationAttemptCount: attempt,
      classificationError: null,
      classificationLeaseExpiresAt: leaseExpiresAt,
    },
  });
  if (claim.count === 0) return { status: "skipped", reason: "claimed" };

  // ── Trace ─────────────────────────────────────────────────────────────────
  // Started after the claim, for the reason translation's is: everything above
  // settles without a model call, and a run for "nothing to do" would stand in
  // front of the real verdict as the most recent one.
  const tracer =
    deps.tracer ??
    GenerationTracer.start({
      kind: "classification",
      trigger: "system",
      companyId: item.companyId ?? null,
      feedItemId: item.id,
      options: {
        mode,
        inputKind,
        attempt,
        maxAttempts: MAX_CLASSIFICATION_ATTEMPTS,
        needsChunking,
      },
    });
  // Set explicitly rather than only through the init above, so an injected
  // tracer is filed under the same company and model as one started here.
  tracer.setCompany(item.companyId);
  tracer.setLlm(provider.provider, provider.model);
  tracer.step({
    type: "request",
    label: `Classify article against topic priorities (${mode})`,
    input: { feedItemId: item.id, url: item.url, mode, inputKind, attempt },
    metadata: {
      classificationHash: hash,
      usedTranslation: resolved.usedTranslation,
      articleChars: (text.body ?? "").length,
      needsChunking,
    },
  });
  tracer.step({
    type: "context",
    label: "Topic configuration",
    output: {
      // The topic lists AS THEY STOOD. Editing them tomorrow reopens the article
      // for a fresh verdict and writes a new run; this one keeps the old lists,
      // which is the only way "why was this rejected in March" stays answerable.
      highPriorityTopics: priorities.high,
      mediumPriorityTopics: priorities.medium,
      avoidedTopics: priorities.avoided,
      companyDescription: context.companyDescription,
      targetAudience: context.targetAudience,
    },
    metadata: { mode, withCompanyContext: hasCompanyContext(context) },
  });

  // Diagnostics carry sizes and counts, never the article body or the topic lists.
  const diag = {
    feedItemId: item.id,
    url: item.url,
    mode,
    inputKind,
    usedTranslation: resolved.usedTranslation,
    bodyLength: (text.body ?? "").length,
    // Whether the prompt carried brand copy — never the copy itself. Enough to
    // tell "this company's verdicts were made blind" from "they were not".
    withCompanyContext: hasCompanyContext(context),
    attempt,
    needsChunking,
  };
  const startedAtMs = now().getTime();
  const attemptTimeoutMs =
    deps.attemptTimeoutMs ??
    Math.min(CLASSIFICATION_ATTEMPT_TIMEOUT_MS, UNDERSTANDING_ATTEMPT_TIMEOUT_MS);
  const pathDefaultTimeoutMs = needsChunking
    ? CLASSIFICATION_CHUNKED_ITEM_TIMEOUT_MS
    : CLASSIFICATION_ITEM_TIMEOUT_MS;
  const itemTimeoutMs =
    deps.itemTimeoutMs ??
    (deps.remainingRunBudgetMs === undefined
      ? pathDefaultTimeoutMs
      : Math.min(pathDefaultTimeoutMs, deps.remainingRunBudgetMs));
  const itemDeadlineMs = startedAtMs + itemTimeoutMs;
  const maxRepairs = deps.maxRepairAttempts ?? MAX_CLASSIFICATION_REPAIR_ATTEMPTS;
  console.info("[classification] classifying", diag);

  /**
   * Asks the verdict model once, vets the reply, and — for a reply that is
   * merely the wrong shape or internally inconsistent — asks once more with
   * the exact problem named.
   *
   * A THROWN error (a timeout, a dead transport) deliberately does not repair:
   * nothing about the reply was wrong, so there is nothing to tell the model.
   */
  const askVerdictUntilUsable = async (
    userPrompt: string,
    systemPrompt: string,
    understandingConfidence: number
  ): Promise<{ outcome: ClassificationOutcome; calls: number }> => {
    let prompt = userPrompt;
    let last: ClassificationOutcome | null = null;

    for (let call = 1; call <= maxRepairs + 1; call++) {
      tracer.step({
        type: "prompt",
        label: call > 1 ? `Call ${call} — repair prompt` : `Call ${call}`,
        attempt: call,
        input: { systemPrompt, userPrompt: prompt },
        metadata: {
          temperature: 0,
          maxTokens: MAX_CLASSIFICATION_OUTPUT_TOKENS,
          isRepair: call > 1,
        },
      });

      const callStartedAt = new Date();
      const response = await withTimeout(
        provider.instance.generate({
          systemPrompt,
          userPrompt: prompt,
          // Deterministic: the same article and the same configuration must not
          // produce a different verdict on a re-run.
          temperature: 0,
          maxTokens: MAX_CLASSIFICATION_OUTPUT_TOKENS,
          format: CLASSIFICATION_JSON_SCHEMA,
        }),
        attemptTimeoutMs,
        "attempt"
      );
      tracer.setAttempts(call);
      tracer.step({
        type: "llm_call",
        label: `Call ${call}`,
        attempt: call,
        startedAt: callStartedAt,
        completedAt: new Date(),
        input: { request: { temperature: 0, maxTokens: MAX_CLASSIFICATION_OUTPUT_TOKENS } },
        metadata: { providerPayload: response.raw ?? null },
      });
      tracer.step({
        type: "raw_response",
        label: `Call ${call}`,
        attempt: call,
        output: { text: response.text },
        metadata: { chars: response.text?.length ?? 0 },
      });

      const parsed = parseClassificationResponse(
        response.text,
        priorities,
        understandingConfidence
      );
      if (parsed.status === "ok") {
        tracer.step({
          type: "parsed_result",
          label: `Call ${call} accepted`,
          attempt: call,
          output: {
            classification: parsed.classification,
            rejectionReason: parsed.rejectionReason,
            matchedTopics: parsed.matchedTopics,
            primaryTopic: parsed.primaryTopic,
            reason: parsed.reason,
          },
        });
        return { outcome: parsed, calls: call };
      }

      last = parsed;
      const willRepair = call <= maxRepairs;
      tracer.step({
        type: "retry",
        label: willRepair
          ? `Call ${call} rejected — repairing`
          : `Call ${call} rejected — untrusted`,
        attempt: call,
        status: "failed",
        output: { problem: parsed.problem, willRepair },
      });
      if (!willRepair) break;

      console.warn("[classification] reply rejected — repairing", {
        ...diag,
        call,
        problem: parsed.problem,
      });
      prompt = buildClassificationRepairPrompt(userPrompt, response.text ?? "", parsed.feedback);
    }

    return { outcome: last!, calls: maxRepairs + 1 };
  };

  /**
   * Persists a verdict that survived `parseClassificationResponse`, guarded by
   * the lease this run stamped — the same fencing the pre-chunking code always
   * used. `mainSubject` comes from the `ArticleUnderstanding` this run produced,
   * NEVER from the verdict reply — see `ClassificationVerdict`'s own comment for
   * why the verdict call is not even asked for one.
   */
  const persistVerdict = async (
    outcome: Extract<ClassificationOutcome, { status: "ok" }>,
    mainSubject: string
  ) => {
    return db.feedItem.updateMany({
      where: {
        id: item.id,
        classificationStatus: "classifying",
        classificationLeaseExpiresAt: leaseExpiresAt,
      },
      data: {
        classification: outcome.classification,
        classificationRejectionReason: outcome.rejectionReason,
        classificationMatchedTopics: outcome.matchedTopics,
        classificationReason: outcome.reason,
        classificationMainSubject: mainSubject,
        classificationPrimaryTopic: outcome.primaryTopic,
        classificationStatus: "completed",
        classificationHash: hash,
        classificationError: null,
        classifiedAt: now(),
        classificationProvider: provider.provider,
        classificationModel: provider.model,
        classificationLeaseExpiresAt: null,
      },
    });
  };

  try {
    // ── Step 1: understand the whole article, once ────────────────────────
    // `title_only` has no body to read at all — the title is the only text
    // this article has, so it is what `understandArticle` reads. Every other
    // "full" article reads its real body; chunking (if needed) happens
    // entirely inside `understandArticle`.
    const understandingBody = inputKind === "full" ? (text.body as string) : (text.title as string);

    const understandingOutcome = await withTimeout(
      understandArticle(
        { title: text.title, body: understandingBody },
        {
          provider: provider.instance,
          providerLabel: provider.provider,
          model: provider.model,
          now,
          attemptTimeoutMs,
          maxRepairAttempts: maxRepairs,
        }
      ),
      Math.max(itemDeadlineMs - now().getTime(), 1),
      "item"
    );
    if (understandingOutcome.status !== "ok") {
      throw new ArticleUnderstandingFailedError(understandingOutcome.error);
    }
    const { understanding, chunkCount, usedChunking } = understandingOutcome;

    tracer.step({
      type: "parsed_result",
      label: "Article understood",
      output: {
        mainSubject: understanding.mainSubject,
        centralThesis: understanding.centralThesis,
        centralConflict: understanding.centralConflict,
        articleType: understanding.articleType,
        secondaryTopics: understanding.secondaryTopics,
        incidentalTopics: understanding.incidentalTopics,
        entities: understanding.entities,
        confidence: understanding.confidence,
        evidence: understanding.evidence,
      },
      metadata: { chunkCount, usedChunking },
    });
    console.info("[classification] article understood", {
      ...diag,
      mainSubject: understanding.mainSubject,
      articleType: understanding.articleType,
      confidence: understanding.confidence,
      evidenceChunks: understanding.evidence.map((e) => e.chunkIndex),
      chunkCount,
      usedChunking,
    });

    // ── Step 2: match that understanding against the company's topics ─────
    const systemPrompt = buildClassificationSystemPrompt(mode);
    const userPrompt = buildClassificationUserPrompt({ understanding, context });

    const { outcome, calls } = await withTimeout(
      askVerdictUntilUsable(userPrompt, systemPrompt, understanding.confidence),
      Math.max(itemDeadlineMs - now().getTime(), 1),
      "item"
    );

    if (outcome.status === "invalid") {
      throw new UntrustworthyClassificationError(outcome.problem);
    }

    // Guarded by the lease this run stamped: a concurrent run that reclaimed an
    // expired claim owns the item now, and a late verdict must not overwrite it.
    const written = await persistVerdict(outcome, understanding.mainSubject);
    if (written.count === 0) {
      tracer.skipped(
        "persistence",
        "A concurrent run reclaimed this article; the verdict was discarded."
      );
      return { status: "skipped", reason: "claimed" };
    }

    tracer.step({
      type: "persistence",
      label: `Verdict stored — ${outcome.classification}`,
      output: {
        classification: outcome.classification,
        rejectionReason: outcome.rejectionReason,
        matchedTopics: outcome.matchedTopics,
        primaryTopic: outcome.primaryTopic,
        mainSubject: understanding.mainSubject,
        reason: outcome.reason,
      },
      metadata: {
        provider: provider.provider,
        model: provider.model,
        modelCalls: calls,
        classificationHash: hash,
        needsChunking,
        chunkCount,
        usedChunking,
      },
    });

    console.info("[classification] classified", {
      ...diag,
      mainSubject: understanding.mainSubject,
      // The topic the verdict rests on, which is the one thing worth reading in
      // this line when a HIGH looks wrong. The article's own text stays out.
      primaryTopic: outcome.primaryTopic,
      matchedTopics: outcome.matchedTopics,
      classification: outcome.classification,
      rejectionReason: outcome.rejectionReason,
      modelCalls: calls,
      chunkCount,
      usedChunking,
      provider: provider.provider,
      model: provider.model,
    });

    return {
      status: "classified",
      classification: outcome.classification,
      rejectionReason: outcome.rejectionReason,
      matchedTopics: outcome.matchedTopics,
      provider: provider.provider,
      model: provider.model,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : "Unknown classification error.";
    tracer.fail(
      err instanceof ClassificationTimeoutError
        ? "CLASSIFICATION_TIMEOUT"
        : err instanceof UntrustworthyClassificationError
          ? "UNTRUSTWORTHY_CLASSIFICATION"
          : err instanceof ArticleUnderstandingFailedError
            ? "ARTICLE_UNDERSTANDING_FAILED"
            : "CLASSIFICATION_TRANSPORT_ERROR",
      error
    );

    console.warn("[classification] FAILED", {
      ...diag,
      elapsedMs: now().getTime() - startedAtMs,
      timedOut:
        err instanceof ClassificationTimeoutError ||
        err instanceof ArticleUnderstandingTimeoutError,
      emptyResponse: err instanceof ClassificationParseError,
      untrustworthy: err instanceof UntrustworthyClassificationError,
      understandingFailed: err instanceof ArticleUnderstandingFailedError,
      error,
    });

    // Guarded by this run's lease, for the same reason the success write is. The
    // verdict columns are deliberately NOT touched: a failure leaves whatever was
    // last known (usually nothing) rather than writing a rejection.
    const written = await db.feedItem.updateMany({
      where: {
        id: item.id,
        classificationStatus: "classifying",
        classificationLeaseExpiresAt: leaseExpiresAt,
      },
      data: {
        classificationStatus: "failed",
        classificationError: error,
        classificationLeaseExpiresAt: null,
      },
    });
    if (written.count === 0) return { status: "skipped", reason: "claimed" };

    return { status: "failed", error };
  } finally {
    // In a `finally` so a timeout or an untrusted reply is on the record exactly
    // as fully as a verdict — a failure here leaves `classification` NULL, and
    // "why has this article no verdict" is what the trace has to answer.
    await tracer.flush();
  }
}
