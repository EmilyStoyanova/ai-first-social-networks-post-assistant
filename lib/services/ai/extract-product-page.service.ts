import { prisma } from "@/lib/db/client";
import type { ILlmProvider } from "@/lib/ai/types";
import {
  buildExtractionPrompts,
  buildExtractionRepairPrompt,
  ExtractionParseError,
  EXTRACTION_ATTEMPT_TIMEOUT_MS,
  EXTRACTION_ITEM_TIMEOUT_MS,
  MAX_EXTRACTION_ATTEMPTS,
  MAX_EXTRACTION_OUTPUT_TOKENS,
  MAX_EXTRACTION_REPAIR_ATTEMPTS,
  parseExtractionResponse,
  type ExtractionOutcome,
} from "@/lib/ai/product-page-extraction";
import { pageTextWasTruncated } from "@/lib/integrations/product-page/scraper";
import { resolveLlmSelection } from "./resolve-llm-selection.service";
import {
  buildSupportedProvider,
  ProviderNotAvailableError,
} from "@/lib/ai/llm/supported-providers";
import { GenerationTracer } from "@/lib/generation-trace/tracer";

/**
 * Runs the extraction instruction of ONE product-page feed item.
 *
 * Invariants, all mirroring translation for the same reasons:
 *   • `content` is never written here. It holds the raw scraped page, which is
 *     the input this result was derived from; overwriting it would make the next
 *     run extract from an extraction.
 *   • The provider is the admin default. Extraction is system work and never
 *     passes a per-generation llmConfigId, and an unavailable provider is
 *     reported — never silently swapped for another one.
 *   • Failures are recorded with a capped backoff rather than thrown, so one bad
 *     page cannot stall a drain.
 *
 * The one thing that is NOT like translation: an answer of "the page does not
 * contain this" is a SUCCESS, recorded as `not_found`. It is the correct outcome
 * for an instruction asking for next week's events against a page that lists this
 * week's, and retrying it would only invite the model to invent something.
 *
 * A reply that is the wrong SHAPE — prose instead of JSON, an item short of a
 * field its siblings have, fewer items than the page's own printed count — is
 * neither of those. It gets one repair call that names the exact problem, and if
 * that does not fix it the item is recorded `failed` with the problem in
 * `extractionError`, so the next ingest tries again within the attempt budget.
 * Storing it instead would be the original bug in a new place: a short list,
 * indistinguishable from a complete one, treated as the authoritative facts for
 * every channel.
 */

export type ExtractProductPageOutcome =
  | {
      status: "extracted";
      provider: string;
      model: string;
      contentLength: number;
      /** How many things the page turned out to list. Counted, never quoted. */
      itemCount: number;
    }
  | { status: "not_found"; reason: string }
  /**
   * No model call was made:
   *   • "unchanged"    — the stored result already matches this page + instruction;
   *   • "max_attempts" — the retry budget is spent;
   *   • "claimed"      — a concurrent run holds the item;
   *   • "no_page_text" — the scrape produced nothing to extract from.
   */
  | {
      status: "skipped";
      reason: "unchanged" | "max_attempts" | "claimed" | "no_page_text";
    }
  /** No admin default provider configured; deliberately does NOT count an attempt. */
  | { status: "no_provider" }
  /**
   * The model or the transport broke. No backoff timestamp: a failed item is
   * retried by the NEXT ingest of its source — which is also the only event that
   * can change the answer — and `extractionAttemptCount` caps that at
   * MAX_EXTRACTION_ATTEMPTS. A separate retry clock would be a schedule nothing
   * reads.
   */
  | { status: "failed"; error: string };

/** The FeedItem fields extraction reads. */
export interface ExtractableItem {
  id: string;
  /**
   * Which company this page belongs to. Read only so the trace run can be filed
   * under it — nothing in extraction branches on it, and it is optional so a
   * caller assembled before tracing existed stays valid.
   */
  companyId?: string;
  title: string | null;
  /** The RAW stored page JSON — `{title, description, image, instructions, pageText}`. */
  content: string | null;
  url: string;
  extractionStatus: string | null;
  extractionHash: string | null;
  extractionAttemptCount: number;
}

/** Narrow DB surface — real Prisma satisfies it; tests inject a fake. */
export interface ExtractProductPageDb {
  feedItem: {
    update: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown>;
    updateMany: (args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => Promise<{ count: number }>;
  };
}

export interface ExtractProductPageDeps {
  db?: ExtractProductPageDb;
  resolveProvider?: () => Promise<
    { ok: true; instance: ILlmProvider; provider: string; model: string } | { ok: false }
  >;
  now?: () => Date;
  /** Wall-clock cap for ONE model call. Overridable so tests need not wait. */
  attemptTimeoutMs?: number;
  /** Wall-clock cap for the whole item, across its repair calls. */
  itemTimeoutMs?: number;
  /** Extra calls spent repairing an unusable reply. Defaults to the module bound. */
  maxRepairAttempts?: number;
  /**
   * The trace recorder for this extraction. Injected in tests; production starts
   * its own run. Observation only — nothing here branches on it.
   */
  tracer?: GenerationTracer;
}

/**
 * A reply that arrived, parsed, and still could not be trusted as the complete
 * answer — after its repair call.
 *
 * An Error rather than a return value so it joins the existing failure path: the
 * claim-guarded write, the attempt counter, and the retry on the next ingest are
 * all exactly what an incomplete extraction needs, and it is a failure in the one
 * sense that matters here — nothing may be stored.
 */
export class IncompleteExtractionError extends Error {
  readonly code = "INCOMPLETE_EXTRACTION" as const;
  constructor(problem: string) {
    super(`The extraction was incomplete and was not stored. ${problem}`);
    this.name = "IncompleteExtractionError";
  }
}

export class ExtractionTimeoutError extends Error {
  readonly code = "EXTRACTION_TIMEOUT" as const;
  constructor(ms: number, scope: "attempt" | "item") {
    super(`Product-page extraction ${scope} exceeded its ${ms}ms budget.`);
    this.name = "ExtractionTimeoutError";
  }
}

/**
 * Rejects with {@link ExtractionTimeoutError} if `work` has not settled in `ms`.
 * The underlying request is NOT cancelled — the provider owns its own (much
 * longer) transport cap. This bound exists so a hung page stops occupying the
 * drain, not to manage the socket.
 */
function withTimeout<T>(work: Promise<T>, ms: number, scope: "attempt" | "item"): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ExtractionTimeoutError(ms, scope)), ms);
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

/** The raw page fields extraction needs out of the stored JSON. */
export interface StoredProductPage {
  instructions: string | null;
  pageText: string | null;
  title: string | null;
}

export function readStoredProductPage(content: string | null): StoredProductPage {
  const raw = content?.trim() ?? "";
  if (!raw.startsWith("{")) return { instructions: null, pageText: null, title: null };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { instructions: null, pageText: null, title: null };
    }
    const obj = parsed as Record<string, unknown>;
    const str = (key: string): string | null => {
      const value = obj[key];
      return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
    };
    return { instructions: str("instructions"), pageText: str("pageText"), title: str("title") };
  } catch {
    return { instructions: null, pageText: null, title: null };
  }
}

export async function extractProductPage(
  item: ExtractableItem,
  deps: ExtractProductPageDeps = {}
): Promise<ExtractProductPageOutcome> {
  const db = deps.db ?? prisma;
  const now = deps.now ?? (() => new Date());
  const resolveProvider = deps.resolveProvider ?? defaultResolveProvider;

  const stored = readStoredProductPage(item.content);

  // Nothing to extract from. Recorded as `not_found` rather than failed: it is a
  // settled answer about this page (its text could not be read), and retrying it
  // would re-ask a question only a re-scrape can change.
  if (!stored.instructions || !stored.pageText) {
    await db.feedItem.update({
      where: { id: item.id },
      data: {
        extractionStatus: "not_found",
        extractedContent: null,
        extractionError: "The page text could not be read, so there was nothing to extract from.",
        extractedAt: now(),
      },
    });
    return { status: "skipped", reason: "no_page_text" };
  }

  if (item.extractionAttemptCount >= MAX_EXTRACTION_ATTEMPTS) {
    return { status: "skipped", reason: "max_attempts" };
  }

  const resolved = await resolveProvider();
  if (!resolved.ok) {
    // An operator problem, not a page problem: leave the item pending at its
    // current attempt count so it extracts once a provider is configured.
    return { status: "no_provider" };
  }

  const attempt = item.extractionAttemptCount + 1;

  // Atomic claim. The drain selects candidates without locking, so the manual
  // follow-up job and a later run can both hold this item — only one wins this
  // conditional write. The loser skips WITHOUT calling the model.
  const claim = await db.feedItem.updateMany({
    where: { id: item.id, extractionStatus: { in: ["pending", "failed"] } },
    data: {
      extractionStatus: "extracting",
      extractionAttemptCount: attempt,
      extractionError: null,
    },
  });
  if (claim.count === 0) return { status: "skipped", reason: "claimed" };

  const { systemPrompt, userPrompt } = buildExtractionPrompts({
    instructions: stored.instructions,
    pageText: stored.pageText,
    pageTitle: stored.title ?? item.title,
    pageUrl: item.url,
    today: now(),
  });

  const truncated = pageTextWasTruncated(stored.pageText);

  // ── Trace ─────────────────────────────────────────────────────────────────
  // Started after the claim, for the reason translation's and classification's
  // are: everything above settles without a model call.
  const tracer =
    deps.tracer ??
    GenerationTracer.start({
      kind: "extraction",
      trigger: "system",
      companyId: item.companyId ?? null,
      feedItemId: item.id,
      options: { attempt, maxAttempts: MAX_EXTRACTION_ATTEMPTS },
    });
  // Set explicitly rather than only through the init above, so an injected
  // tracer is filed under the same company and model as one started here.
  tracer.setCompany(item.companyId);
  tracer.setLlm(resolved.provider, resolved.model);
  tracer.step({
    type: "request",
    label: "Extract the instructed facts from the page",
    input: { feedItemId: item.id, url: item.url, attempt },
    metadata: { storedExtractionHash: item.extractionHash },
  });
  tracer.step({
    type: "source",
    label: "Raw scraped page",
    output: {
      pageTitle: stored.title ?? item.title,
      // The owner's own description of what a post from this page must be built
      // from — the single most useful thing to read when an extraction is wrong.
      instructions: stored.instructions,
      pageText: stored.pageText,
    },
    metadata: {
      pageTextChars: stored.pageText.length,
      instructionChars: stored.instructions.length,
      pageTextTruncated: truncated,
    },
  });

  // Diagnostics carry sizes, never the page body or the instruction text.
  const diag = {
    feedItemId: item.id,
    sourceUrl: item.url,
    pageTextLength: stored.pageText.length,
    pageTextTruncated: truncated,
    instructionLength: stored.instructions.length,
    attempt,
  };
  const startedAtMs = now().getTime();
  const attemptTimeoutMs = deps.attemptTimeoutMs ?? EXTRACTION_ATTEMPT_TIMEOUT_MS;
  const itemTimeoutMs = deps.itemTimeoutMs ?? EXTRACTION_ITEM_TIMEOUT_MS;
  const maxRepairs = deps.maxRepairAttempts ?? MAX_EXTRACTION_REPAIR_ATTEMPTS;
  console.info("[product-page-extraction] extracting", diag);

  const ask = (prompt: string) =>
    withTimeout(
      resolved.instance.generate({
        systemPrompt,
        userPrompt: prompt,
        // Deterministic: this is fact-gathering, and a second sample must not
        // produce a different number of events.
        temperature: 0,
        // Bounded so a runaway generation cannot outlive the deadline. The
        // ceiling is deliberately generous — see MAX_EXTRACTION_OUTPUT_TOKENS.
        maxTokens: MAX_EXTRACTION_OUTPUT_TOKENS,
      }),
      attemptTimeoutMs,
      "attempt"
    );

  /**
   * Asks, checks, and — for a reply that is merely the wrong shape — asks once
   * more with the exact problem named. Bounded by `maxRepairs` AND by the item
   * timeout wrapping it, so a slow model cannot turn a repair into a second wait.
   *
   * A THROWN error (a timeout, a dead transport) deliberately does not repair:
   * nothing about the reply was wrong, so there is nothing to tell the model, and
   * the retry that helps there is the next ingest rather than the next second.
   */
  const askUntilUsable = async (): Promise<{ outcome: ExtractionOutcome; calls: number }> => {
    let prompt = userPrompt;
    let last: ExtractionOutcome | null = null;

    for (let call = 1; call <= maxRepairs + 1; call++) {
      tracer.step({
        type: "prompt",
        label: call > 1 ? `Call ${call} — repair prompt` : `Call ${call}`,
        attempt: call,
        input: { systemPrompt, userPrompt: prompt },
        metadata: { temperature: 0, maxTokens: MAX_EXTRACTION_OUTPUT_TOKENS, isRepair: call > 1 },
      });

      const callStartedAt = new Date();
      const response = await ask(prompt);
      tracer.setAttempts(call);
      tracer.step({
        type: "llm_call",
        label: `Call ${call}`,
        attempt: call,
        startedAt: callStartedAt,
        completedAt: new Date(),
        input: { request: { temperature: 0, maxTokens: MAX_EXTRACTION_OUTPUT_TOKENS } },
        metadata: { providerPayload: response.raw ?? null },
      });
      tracer.step({
        type: "raw_response",
        label: `Call ${call}`,
        attempt: call,
        output: { text: response.text },
        metadata: { chars: response.text?.length ?? 0 },
      });

      const parsed = parseExtractionResponse(response.text, { pageTextTruncated: truncated });
      if (parsed.status !== "invalid") {
        tracer.step({
          type: "parsed_result",
          label: `Call ${call} accepted — ${parsed.status}`,
          attempt: call,
          output:
            parsed.status === "completed"
              ? { content: parsed.content, data: parsed.data }
              : { notFoundReason: parsed.reason },
        });
        return { outcome: parsed, calls: call };
      }

      last = parsed;
      tracer.step({
        type: "retry",
        label:
          call <= maxRepairs
            ? `Call ${call} rejected — repairing`
            : `Call ${call} rejected — incomplete`,
        attempt: call,
        status: "failed",
        output: { problem: parsed.problem, willRepair: call <= maxRepairs },
      });
      if (call > maxRepairs) break;

      console.warn("[product-page-extraction] reply rejected — repairing", {
        ...diag,
        call,
        problem: parsed.problem,
      });
      prompt = buildExtractionRepairPrompt(userPrompt, response.text ?? "", parsed.feedback);
    }

    return { outcome: last!, calls: maxRepairs + 1 };
  };

  try {
    const { outcome, calls } = await withTimeout(askUntilUsable(), itemTimeoutMs, "item");

    // Checked and rejected, twice. Recorded as a failure rather than stored: an
    // extraction that cannot be shown to be complete must not become the
    // authoritative fact set that three channels then write posts from.
    if (outcome.status === "invalid") {
      throw new IncompleteExtractionError(outcome.problem);
    }

    if (outcome.status === "not_found") {
      // A successful run whose answer is "not on this page". Stored as the
      // reason, with no extracted content, so generation can say so instead of
      // writing from an empty result — and so nothing retries it.
      await db.feedItem.update({
        where: { id: item.id },
        data: {
          extractionStatus: "not_found",
          extractedContent: null,
          extractionError: outcome.reason,
          extractedAt: now(),
        },
      });
      tracer.step({
        type: "persistence",
        label: "Nothing on the page matched the instruction",
        status: "skipped",
        output: { extractionStatus: "not_found", reason: outcome.reason },
      });
      console.info("[product-page-extraction] nothing on the page matched the instruction", {
        ...diag,
        reason: outcome.reason,
        elapsedMs: now().getTime() - startedAtMs,
      });
      return { status: "not_found", reason: outcome.reason };
    }

    await db.feedItem.update({
      where: { id: item.id },
      data: {
        extractedContent: outcome.content,
        extractionStatus: "completed",
        extractionError: null,
        extractedAt: now(),
      },
    });

    tracer.step({
      type: "persistence",
      label: "Extraction stored",
      output: { extractedContent: outcome.content, data: outcome.data },
      metadata: {
        provider: resolved.provider,
        model: resolved.model,
        modelCalls: calls,
        extractedChars: outcome.content.length,
        itemCount: outcome.data.items.length,
      },
    });

    console.info("[product-page-extraction] extracted", {
      ...diag,
      elapsedMs: now().getTime() - startedAtMs,
      extractedLength: outcome.content.length,
      itemCount: outcome.data.items.length,
      fields: outcome.data.requestedFields,
      modelCalls: calls,
      provider: resolved.provider,
      model: resolved.model,
    });

    return {
      status: "extracted",
      provider: resolved.provider,
      model: resolved.model,
      contentLength: outcome.content.length,
      itemCount: outcome.data.items.length,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : "Unknown extraction error.";
    tracer.fail(
      err instanceof ExtractionTimeoutError
        ? "EXTRACTION_TIMEOUT"
        : err instanceof IncompleteExtractionError
          ? "INCOMPLETE_EXTRACTION"
          : "EXTRACTION_TRANSPORT_ERROR",
      error
    );

    console.warn("[product-page-extraction] FAILED", {
      ...diag,
      elapsedMs: now().getTime() - startedAtMs,
      timedOut: err instanceof ExtractionTimeoutError,
      emptyResponse: err instanceof ExtractionParseError,
      incomplete: err instanceof IncompleteExtractionError,
      error,
    });

    // Guarded by the claim this run took: a concurrent run that has since
    // completed the item owns its state, and a stale "failed" must not clobber a
    // real result.
    const written = await db.feedItem.updateMany({
      where: { id: item.id, extractionStatus: "extracting" },
      data: { extractionStatus: "failed", extractionError: error },
    });
    if (written.count === 0) return { status: "skipped", reason: "claimed" };

    return { status: "failed", error };
  } finally {
    await tracer.flush();
  }
}
