import type { GenerationTrigger } from "@prisma/client";
import type { FeedItemContext } from "@/lib/ai/types";
import type { ComplianceResult } from "@/lib/ai/quality/generation-compliance";
import type { GenerationAttemptRecord } from "./attempt-record";
import type { FeedItemArtifacts } from "./feed-item-artifacts";
import type { ImageGenerationRecord } from "./image-record";
import { excerpt } from "./redact";
import type { GenerationTracer } from "./tracer";

/**
 * Turning what the pipeline did into the steps a reader sees.
 *
 * All of this could live inline in `generatePostFromContext`, and that is exactly
 * why it does not: the generation service is already the longest file in the
 * project and its job is to generate. Everything here is shape-mapping with no
 * decisions of its own, so it is kept where it can be read — and tested —
 * separately from the pipeline it describes.
 */

/**
 * Who asked for this generation, as the caller knows it.
 *
 * Passed rather than inferred wherever a caller has better information than the
 * options can express. `generatePostFromContext` receives the same options for a
 * cron post and a bulk post, and the difference between them is not reliably
 * recoverable from those options alone — a bulk run sets a batch id, cron sets a
 * schedule id, and a multi-channel manual run sets a group id, but a caller that
 * knows which it is should simply say so.
 */
export interface PostGenerationTraceOrigin {
  trigger?: GenerationTrigger;
  /** The queue job executing this generation, when one is. */
  jobId?: string | null;
  /**
   * How the article window was chosen and what it withheld — the diagnostic
   * `buildGenerationContext` already produces. Undefined for a window that drew
   * from no articles at all.
   */
  priority?: unknown;
  /** The manual "Content source" pick, as it came off the wire. */
  contentSourceRef?: unknown;
}

/**
 * Derives the trigger when the caller did not name one.
 *
 * Order matters and reflects which fact is most specific: cron is the only
 * caller that owns a schedule, bulk is the only one that owns a batch, and a
 * group id without a batch is a manual multi-channel run.
 */
export function deriveTrigger(options: {
  scheduleId?: string | null;
  generationBatchId?: string | null;
  contentGroupId?: string | null;
  generatedById?: string | null;
}): GenerationTrigger {
  if (options.scheduleId) return "cron";
  if (options.generationBatchId) return "bulk";
  if (options.contentGroupId) return "manual_multi_channel";
  return options.generatedById ? "manual" : "system";
}

/**
 * The compliance dimensions this run did not verify.
 *
 * Named explicitly rather than left as `false`s to read past: an unmeasured
 * requirement is not evidence of compliance, and the trace has to say which
 * requirements those were. In practice this is always the four stylistic
 * dimensions — they are generation guidance and are deliberately not gated.
 */
function unmeasuredDimensions(checked: ComplianceResult["checked"]): string[] {
  return (Object.keys(checked) as (keyof ComplianceResult["checked"])[]).filter(
    (dimension) => !checked[dimension]
  );
}

/**
 * One attempt, as up to six steps.
 *
 * Six rather than one because they are genuinely different questions with
 * different shapes — what was sent, what the call cost, what came back verbatim,
 * what that parsed to, what the gates said, and what the next attempt was told to
 * change — and the UI's per-step Copy action is only useful when a prompt and a
 * raw reply are not in the same blob.
 */
export function recordAttemptSteps(
  tracer: GenerationTracer,
  record: GenerationAttemptRecord
): void {
  const { attempt, maxAttempts } = record;
  const label = maxAttempts > 1 ? `Attempt ${attempt} of ${maxAttempts}` : null;

  tracer.setAttempts(attempt);

  // ── What was sent ─────────────────────────────────────────────────────────
  // The exact prompts, per attempt. A retry's user prompt is the base prompt
  // plus a correction naming what was wrong, so storing only the first would
  // misrepresent every attempt after it.
  tracer.step({
    type: "prompt",
    label: attempt > 1 ? `${label} — corrected prompt` : label,
    attempt,
    input: {
      systemPrompt: record.systemPrompt,
      userPrompt: record.userPrompt,
    },
    metadata: {
      systemPromptChars: record.systemPrompt.length,
      userPromptChars: record.userPrompt.length,
      isRetryPrompt: attempt > 1,
      angle: record.angle ?? null,
      pattern: record.pattern ?? null,
      aspect: record.aspect ?? null,
    },
  });

  // ── What the call cost ────────────────────────────────────────────────────
  tracer.step({
    type: "llm_call",
    label,
    attempt,
    status: record.error ? "failed" : "success",
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    durationMs: record.durationMs,
    input: { request: record.request },
    metadata: {
      responseChars: record.rawResponse?.length ?? null,
      // Whatever the provider forwarded alongside the text: Ollama's token
      // counts and durations, or an OpenAI-style usage block. Sanitized like
      // everything else, so a provider that echoes a header cannot leak one.
      providerPayload: record.rawProviderPayload ?? null,
    },
    error: record.error ? `${record.error.name}: ${record.error.message}` : undefined,
  });

  // ── What came back, verbatim ──────────────────────────────────────────────
  if (record.rawResponse !== null) {
    tracer.step({
      type: "raw_response",
      label,
      attempt,
      output: { text: record.rawResponse },
      metadata: { chars: record.rawResponse.length },
    });
  }

  // ── What it parsed to ─────────────────────────────────────────────────────
  if (record.parsed) {
    tracer.step({
      type: "parsed_result",
      label,
      attempt,
      output: {
        text: record.parsed.text,
        hashtags: record.parsed.hashtags,
        coreMessage: record.parsed.coreMessage,
        topic: record.parsed.topic ?? null,
        imagePrompt: record.parsed.imagePrompt ?? null,
        notes: record.parsed.notes ?? null,
      },
      metadata: { textChars: record.parsed.text.length },
    });
  } else if (record.error) {
    tracer.step({
      type: "parsed_result",
      label,
      attempt,
      status: "failed",
      metadata: { category: record.error.category ?? null },
      error: record.error.message,
    });
  }

  // ── What the gates said ───────────────────────────────────────────────────
  // One step per gate, because each has its own score, its own threshold and its
  // own comparison target, and folding them together is what makes a validation
  // section unreadable.
  if (record.duplicate) {
    tracer.step({
      type: "validation",
      label: "Near-verbatim duplicate (Jaccard)",
      attempt,
      status: record.duplicate.flagged ? "failed" : "success",
      output: {
        passed: !record.duplicate.flagged,
        similarityScore: record.duplicate.similarityScore,
        matchedPostId: record.duplicate.matchedPostId,
      },
    });
  }

  if (record.semantic) {
    tracer.step({
      type: "validation",
      label: "Semantic duplicate (core message)",
      attempt,
      status: record.semantic.skipped
        ? "skipped"
        : record.semantic.decision === "regenerate"
          ? "failed"
          : "success",
      output: {
        passed: record.semantic.decision !== "regenerate",
        decision: record.semantic.decision,
        topSimilarity: record.semantic.topSimilarity,
        matchedPostId: record.semantic.matchedPostId,
        matchedCoreMessage: record.semantic.matchedCoreMessage,
      },
      metadata: {
        // Fail-open is a real outcome and must not read as a pass: the gate did
        // not run, so it certified nothing.
        skipped: record.semantic.skipped,
        skipReason: record.semantic.skipped ? "embedding or lookup unavailable" : null,
      },
    });
  }

  if (record.coreMessageGeneric !== undefined) {
    tracer.step({
      type: "validation",
      label: "Core message specificity",
      attempt,
      status: record.coreMessageGeneric ? "failed" : "success",
      output: { passed: !record.coreMessageGeneric, generic: record.coreMessageGeneric },
    });
  }

  if (record.topicRepeated !== undefined) {
    tracer.step({
      type: "validation",
      label: "Topic memory",
      attempt,
      status: record.topicRepeated ? "failed" : "success",
      output: {
        passed: !record.topicRepeated,
        repeated: record.topicRepeated,
        topic: record.parsed?.topic ?? null,
      },
    });
  }

  // The counterpart to the pattern the attempt was GIVEN: what it actually
  // opened with, and whether that repeats the channel's recent output. Recorded
  // separately from `contentPattern` on purpose — the whole defect this closes
  // was a trace that showed perfect hook rotation above eleven identical
  // openings, because only the request was ever written down.
  if (record.openingDiversity) {
    const opening = record.openingDiversity;
    tracer.step({
      type: "validation",
      label: "Opening diversity (realised first line)",
      attempt,
      status: opening.flagged ? "failed" : "success",
      output: {
        passed: !opening.flagged,
        candidateShape: opening.candidateForm,
        matchType: opening.matchType,
        matchedRecentPostId: opening.matchedPostId,
        similarity: opening.similarity,
        retryTriggered: opening.flagged,
      },
      metadata: {
        requestedHook: record.pattern?.hookType ?? null,
        note: "A retry trigger only — never blocks the save. Compare requestedHook against candidateShape.",
      },
    });
  }

  if (record.compliance) {
    const compliance = record.compliance;
    // A run that checked nothing certified nothing. It must read as "not
    // checked", never as a pass — the whole point of `status`. `passed` is
    // omitted entirely in that case so no reader can mistake the neutral
    // non-blocking `true` for a verdict.
    tracer.step({
      type: "validation",
      label: "Generation compliance",
      attempt,
      status:
        compliance.status === "passed"
          ? "success"
          : compliance.status === "failed"
            ? "failed"
            : "skipped",
      output: {
        status: compliance.status,
        ...(compliance.evaluated ? { passed: compliance.passed } : {}),
        angle: record.angle ?? null,
        angleChecked: compliance.checked.angle,
        hook: record.pattern?.hookType ?? null,
        hookChecked: compliance.checked.hook,
        structure: record.pattern?.structure ?? null,
        structureChecked: compliance.checked.structure,
        cta: record.pattern?.ctaType ?? null,
        ctaChecked: compliance.checked.cta,
        reasons: compliance.reasons,
      },
      metadata: {
        evaluated: compliance.evaluated,
        // Which dimensions were not verified — a documented limitation, not a
        // silent pass. See lib/ai/quality/generation-compliance.ts.
        notChecked: unmeasuredDimensions(compliance.checked),
        note: compliance.evaluated
          ? "Dimensions listed in notChecked were not verified. The angle, hook, structure and CTA are generation guidance only — a post is never rejected for missing one."
          : "Nothing was measured — compliance was NOT verified.",
      },
    });
  }

  // ── What the next attempt was told to change ──────────────────────────────
  if (!record.accepted) {
    tracer.step({
      type: "retry",
      label: record.willRetry
        ? `Attempt ${attempt} rejected — retrying`
        : `Attempt ${attempt} rejected — no retries left`,
      attempt,
      status: "failed",
      output: {
        rejectionReason: record.rejectionReason,
        willRetry: record.willRetry,
        attemptsRemaining: Math.max(0, maxAttempts - attempt),
      },
    });
  }
}

/**
 * The article-level steps: what the post's source had already been through.
 *
 * Only steps that ACTUALLY happened are created. A manually entered prompt has no
 * translation, so no translation step is written — not a skipped one, not an
 * empty one. A step that says "skipped" is reserved for a stage that was
 * genuinely reached and declined (a translation that was configured and settled
 * as `skipped`, an image suppressed by an override), which is a different fact.
 */
export function recordFeedItemArtifactSteps(
  tracer: GenerationTracer,
  item: FeedItemContext,
  artifacts: FeedItemArtifacts | null
): void {
  if (!artifacts) return;

  if (artifacts.extraction) {
    const { extraction } = artifacts;
    tracer.step({
      type: "extraction",
      label: `Product-page extraction — ${extraction.status ?? "unknown"}`,
      status:
        extraction.status === "completed" ? "success" : extraction.error ? "failed" : "skipped",
      linkedRunId: artifacts.runIds.extraction,
      input: { rawPageChars: extraction.rawChars },
      output: {
        status: extraction.status,
        extractedChars: extraction.extractedChars,
        // The extracted text IS what the prompt was built from, and the prompt
        // step already holds it verbatim. An excerpt here keeps the timeline
        // readable without storing the same paragraphs twice.
        extractedExcerpt: excerpt(item.extractedContent ?? null),
        extractedAt: extraction.extractedAt,
      },
      metadata: { linkedRunAvailable: artifacts.runIds.extraction !== null },
      error: extraction.error ?? undefined,
    });
  }

  if (artifacts.translation) {
    const { translation } = artifacts;
    tracer.step({
      type: "translation",
      label: `Article translation — ${translation.status ?? "unknown"}`,
      status:
        translation.status === "completed"
          ? "success"
          : translation.status === "failed"
            ? "failed"
            : "skipped",
      linkedRunId: artifacts.runIds.translation,
      output: {
        status: translation.status,
        targetLanguage: translation.language,
        provider: translation.provider,
        model: translation.model,
        translatedAt: translation.translatedAt,
        titleChars: translation.titleChars,
        contentChars: translation.contentChars,
        // Whether the TEXT THIS POST WAS BUILT FROM is the translation or the
        // original. Not the same question as "did a translation complete": an
        // item translated after generation would answer yes to one and no to the
        // other, and only this one is about the post.
        usedByThisPost: item.usedTranslation === true,
        translatedTitleUsed: item.usedTranslation ? item.title : null,
        // The FULL translated text, not a preview. This is the exact copy the
        // prompt was built from, and the question an admin opens this step to
        // answer — "is the translation any good?" — cannot be answered from the
        // first 600 characters. Unlike the extraction step above, there is no
        // second copy of it anywhere in the trace to defer to: the linked
        // translation run holds the provider's raw reply, not the stored text.
        // Secrets are redacted and a 40k safety cap applied by sanitizeForTrace
        // on the way to the database, the same as for any prompt.
        translatedContent: item.usedTranslation ? (item.content ?? null) : null,
      },
      metadata: {
        linkedRunAvailable: artifacts.runIds.translation !== null,
        detail:
          artifacts.runIds.translation === null
            ? "The full prompts and raw reply were not traced for this article."
            : "Prompts and raw reply are in the linked translation run.",
      },
      error: translation.error ?? undefined,
    });
  }

  if (artifacts.classification) {
    const { classification } = artifacts;
    tracer.step({
      type: "classification",
      label: `Topic classification — ${classification.classification ?? "no verdict"}`,
      status:
        classification.status === "completed"
          ? "success"
          : classification.status === "failed"
            ? "failed"
            : "skipped",
      linkedRunId: artifacts.runIds.classification,
      output: {
        status: classification.status,
        classification: classification.classification,
        rejectionReason: classification.rejectionReason,
        matchedTopics: classification.matchedTopics,
        primaryTopic: classification.primaryTopic,
        mainSubject: classification.mainSubject,
        reason: classification.reason,
        provider: classification.provider,
        model: classification.model,
        classifiedAt: classification.classifiedAt,
      },
      metadata: { linkedRunAvailable: artifacts.runIds.classification !== null },
      error: classification.error ?? undefined,
    });
  }
}

/** One image generation, as a step. */
export function recordImageStep(
  tracer: GenerationTracer,
  label: string,
  record: ImageGenerationRecord
): void {
  tracer.step({
    type: "image",
    label,
    status: record.error ? "failed" : "success",
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    durationMs: record.durationMs,
    input: {
      basePrompt: record.basePrompt,
      prompt: record.prompt,
      negativePrompt: record.negativePrompt,
    },
    output: record.result ?? null,
    metadata: {
      provider: record.provider,
      model: record.model,
      style: record.style,
      width: record.width,
      height: record.height,
    },
    error: record.error
      ? `${record.error.code}${record.error.message ? `: ${record.error.message}` : ""}`
      : undefined,
  });
}
