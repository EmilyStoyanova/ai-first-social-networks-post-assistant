/**
 * THE deterministic gates, evaluated on one candidate.
 *
 * Extracted verbatim out of `generate-with-retry.ts` — every gate, in the same
 * order, with the same diagnostics and the same `needsRetry` / `rejectionReason`
 * derivation. The extraction is a pure refactor and nothing about single-agent
 * generation changed: `generateWithRetry` calls this and re-exports the types it
 * used to own, so every existing caller and every existing test is untouched.
 *
 * ── Why it is its own module ────────────────────────────────────────────────
 *
 * A second generation strategy (multi-agent, see `generate-multi-agent.ts`)
 * needs the SAME gates to have the last word on its candidates. There were two
 * ways to arrange that: hand the second loop its own copy of the six checks, or
 * give both loops one implementation. A copy would be wrong within a release —
 * the gates are edited often (four of the six were added or changed in 2026
 * alone) and a divergence would show up as "the multi-agent arm accepts posts
 * the single-agent arm refuses", which is precisely the confound that would
 * invalidate an A/B experiment about ORCHESTRATION.
 *
 * So this module is the single source of truth for "is this candidate
 * acceptable", and it is deliberately pure: no provider, no database, no
 * Prisma, no trace. The semantic gate arrives as an injected function for the
 * same reason it always did — the embedding provider and the store live in the
 * service layer.
 */

import {
  checkDuplicatePost,
  SIMILARITY_THRESHOLD,
  type DuplicateCheckResult,
  type RecentPost,
} from "./duplicate-detection";
import { type SemanticDecision } from "./semantic-duplicate";
import { checkOpeningDiversity, type OpeningDiversityResult } from "./opening-diversity";
import { assessCoreMessage } from "./core-message-quality";
import {
  validateGenerationCompliance,
  NO_COMPLIANCE_CHECK,
  type ComplianceResult,
  type ComplianceDimension,
} from "./generation-compliance";
import { isTopicRepeated } from "../topic-memory";
import type { ParsedLlmPost } from "../parse-llm-post";
import type { AttemptRejectionReason } from "@/lib/generation-trace/attempt-record";

// ─── Semantic duplicate gate (Phase 1.4) ──────────────────────────────────────
// The gate embeds a candidate's coreMessage and compares it against recent
// accepted embeddings. It is injected (the DB + embedding provider live in the
// service layer) so this module stays pure and testable.

export interface SemanticGateResult {
  decision: SemanticDecision;
  /** Cosine similarity to the closest neighbor; null when there is no history. */
  topSimilarity: number | null;
  matchedPostId: string | null;
  /** The repeated central claim — fed back to the LLM on a semantic retry. */
  matchedCoreMessage: string | null;
  /**
   * True when the gate could not run (no provider, embedding or lookup failed).
   * Fail-open: the candidate is accepted and the skip is surfaced for logging.
   */
  skipped: boolean;
}

export type SemanticGate = (candidate: {
  coreMessage: string | null;
  /** The candidate's declared topic — enriches the embedded document when present. */
  topic?: string | null;
  /** The aspect focus used for this candidate — enriches the embedded document. */
  aspectFocus?: string | null;
}) => Promise<SemanticGateResult>;

/** Neutral result when no gate is wired — treated as "gate did not evaluate". */
export const NO_SEMANTIC_GATE: SemanticGateResult = {
  decision: "accept",
  topSimilarity: null,
  matchedPostId: null,
  matchedCoreMessage: null,
  skipped: true,
};

/** Neutral opening-diversity verdict for a run that never evaluated one. */
export const NO_OPENING_CHECK: OpeningDiversityResult = {
  flagged: false,
  matchType: null,
  matchedPostId: null,
  similarity: null,
  candidateForm: "statement",
  matchedOpening: null,
};

/** Neutral duplicate verdict for a run that never evaluated one. */
export const NO_DUPLICATE_CHECK: DuplicateCheckResult = {
  flagged: false,
  similarityScore: null,
  matchedPostId: null,
};

export { NO_COMPLIANCE_CHECK };

/**
 * What this generation IS, for `[jaccard_duplicate]` diagnostics only — never
 * read by the comparison itself. Lets a flagged match be classified against
 * the candidate it was flagged for (same article? same content group? a
 * genuinely unrelated historical post?) without a second DB lookup.
 */
export interface DuplicateCandidateContext {
  channel: string;
  feedItemId: string | null;
  contentGroupId: string | null;
}

// ─── Diagnostics ──────────────────────────────────────────────────────────────

/**
 * Logs everything needed to answer "what existing post did this get flagged
 * against, and was it a legitimate sibling or a real duplicate" — without
 * needing to re-query the database. `recentPosts` already carries the metadata
 * (see `RecentPost`); this only looks up the one that matched and classifies it.
 */
function logJaccardDuplicate(
  result: DuplicateCheckResult,
  recentPosts: readonly RecentPost[],
  candidateContext?: DuplicateCandidateContext
): void {
  const matched = recentPosts.find((p) => p.id === result.matchedPostId);
  const candidateChannel = candidateContext?.channel ?? null;
  const candidateFeedItemId = candidateContext?.feedItemId ?? null;
  const candidateContentGroupId = candidateContext?.contentGroupId ?? null;
  const matchedChannel = matched?.channel ?? null;
  const matchedFeedItemId = matched?.feedItemId ?? null;
  const matchedContentGroupId = matched?.contentGroupId ?? null;

  const sameArticleSibling =
    candidateFeedItemId !== null && matchedFeedItemId !== null
      ? matchedFeedItemId === candidateFeedItemId
      : false;
  const sameContentGroupSibling =
    !sameArticleSibling &&
    candidateContentGroupId !== null &&
    matchedContentGroupId !== null &&
    matchedContentGroupId === candidateContentGroupId;
  const sameChannel =
    candidateChannel !== null && matchedChannel !== null && matchedChannel === candidateChannel;

  const matchKind = sameArticleSibling
    ? "same_article_sibling"
    : sameContentGroupSibling
      ? "same_content_group_sibling"
      : "historical_post";
  const matchLabel = sameArticleSibling
    ? "same-article sibling"
    : sameContentGroupSibling
      ? "same-content-group sibling"
      : `historical ${matchedChannel ?? "unknown"}`;

  console.warn(
    `[jaccard_duplicate] candidate ${candidateChannel ?? "unknown"} matched ${matchLabel} post ${
      result.matchedPostId
    } similarity ${result.similarityScore} threshold ${SIMILARITY_THRESHOLD}`,
    {
      candidateChannel,
      candidateFeedItemId,
      candidateContentGroupId,
      similarity: result.similarityScore,
      threshold: SIMILARITY_THRESHOLD,
      matchedPostId: result.matchedPostId,
      matchedPostChannel: matchedChannel,
      matchedFeedItemId,
      matchedContentGroupId,
      matchedCreatedAt: matched?.createdAt ?? null,
      matchKind,
      sameChannel,
      differentChannel: candidateChannel !== null && matchedChannel !== null && !sameChannel,
    }
  );
}

/**
 * Concise, and deliberately so: the opening excerpt is capped at 120 characters
 * by the signature extractor, so this can never spill a historical post into the
 * logs the way a full-text diff would.
 */
function logOpeningConflict(result: OpeningDiversityResult, attempt: number): void {
  console.warn(
    `[generation-diversity] opening conflict: attempt=${attempt} matchType=${result.matchType} ` +
      `candidateShape=${result.candidateForm} matchedPostId=${result.matchedPostId} ` +
      `similarity=${result.similarity ?? "n/a"} matchedOpening="${result.matchedOpening ?? ""}"`
  );
}

// ─── The evaluation ───────────────────────────────────────────────────────────

export interface EvaluateCandidateParams {
  /** The parsed candidate under judgement. */
  parsed: ParsedLlmPost;
  /** The recent-post window — company+channel scoped by the caller. */
  recentPosts: readonly RecentPost[];
  /** Injected semantic gate; omitted leaves the gate reported as skipped. */
  semanticGate?: SemanticGate;
  /**
   * Normalized topics from recent posts. Empty for a sibling channel, which was
   * ORDERED to repeat its topic — see `loopTopicMemory` in the generation
   * service for why the prompt and the judge must agree about that.
   */
  recentTopics?: readonly string[];
  /**
   * The language the post was required to be in ("BG" / "EN"). Enables the
   * compliance gate's language dimension; omitted, that dimension is reported as
   * unchecked rather than as a pass.
   */
  contentLanguage?: string | null;
  /** The aspect focus this candidate was written under — enriches the embedding. */
  aspectFocus?: string | null;
  /** 1-based attempt number, for the diagnostics only. */
  attempt: number;
  /** Identifies THIS generation for `[jaccard_duplicate]` diagnostics only. */
  candidateContext?: DuplicateCandidateContext;
}

export interface CandidateVerdict {
  duplicateResult: DuplicateCheckResult;
  semanticResult: SemanticGateResult;
  coreMessageGeneric: boolean;
  topicRepeated: boolean;
  complianceResult: ComplianceResult;
  openingResult: OpeningDiversityResult;
  /** True when at least one gate wants another attempt. */
  needsRetry: boolean;
  /** Which gate had the last word, or null when the candidate is acceptable. */
  rejectionReason: AttemptRejectionReason | null;
}

/**
 * Runs every deterministic gate on one candidate and derives the retry verdict.
 *
 * The ORDER of the `rejectionReason` ladder is load-bearing and is preserved
 * exactly as the single-agent loop had it: Jaccard, then semantic, then generic
 * coreMessage, then repeated topic, then repeated opening, then compliance. It
 * decides which reason a retry prompt is built from when several gates fire at
 * once, and existing tests assert specific reasons for specific fixtures.
 *
 * This function never throws and never aborts: it REPORTS. Which verdicts are
 * fatal is the caller's decision — the generation service aborts on an
 * unresolved duplicate (`CANNOT_GENERATE_UNIQUE_POST`) and on unresolved
 * noncompliance (`POST_FAILED_COMPLIANCE`), and never on a repeated opening.
 */
export async function evaluateCandidate(
  params: EvaluateCandidateParams
): Promise<CandidateVerdict> {
  const { parsed, recentPosts, semanticGate, attempt, candidateContext } = params;

  const duplicateResult = checkDuplicatePost({
    candidateText: parsed.text,
    recentPosts: recentPosts as RecentPost[],
  });
  if (duplicateResult.flagged) {
    logJaccardDuplicate(duplicateResult, recentPosts, candidateContext);
  }

  const semanticResult = semanticGate
    ? await semanticGate({
        coreMessage: parsed.coreMessage,
        topic: parsed.topic,
        aspectFocus: params.aspectFocus ?? undefined,
      })
    : NO_SEMANTIC_GATE;

  const coreMessageGeneric = assessCoreMessage(parsed.coreMessage).generic;

  // Topic Memory: reject a candidate whose normalized topic was already used.
  const topicRepeated = isTopicRepeated(parsed.topic, params.recentTopics ?? []);

  // Post-generation compliance gate: is the text free of banned terms? The
  // angle/hook/structure/CTA it was generated under are NOT re-verified here —
  // they are generation guidance and never a gate (see generation-compliance.ts).
  const complianceResult = validateGenerationCompliance({
    text: parsed.text,
    language: params.contentLanguage,
  });

  // Realised-opening diversity: does the first line this candidate ACTUALLY
  // wrote repeat a recent post's first line? Deterministic, no extra LLM call,
  // and it reuses the recent-post window already loaded for Jaccard — which is
  // why it inherits that window's company+channel scoping for free.
  const openingResult = checkOpeningDiversity({
    candidateText: parsed.text,
    recentPosts: recentPosts as RecentPost[],
  });
  if (openingResult.flagged) {
    logOpeningConflict(openingResult, attempt);
  }

  // Diagnostic compliance logging. `enforced` names the dimensions that can
  // actually block; everything absent from it (angle/hook/structure/CTA) is
  // prompt guidance that is never verified after generation, so it can never
  // appear as a failure here.
  if (complianceResult.evaluated) {
    const enforcedDimensions = (
      Object.entries(complianceResult.checked) as Array<[ComplianceDimension, boolean]>
    )
      .filter(([, isEnforced]) => isEnforced)
      .map(([dim]) => dim)
      .join(",");
    const failedDimensions =
      complianceResult.failures.length > 0
        ? complianceResult.failures.map((f) => f.dimension).join(",")
        : "none";
    console.info(
      `[generation-compliance] attempt=${attempt} enforced=${enforcedDimensions || "none"} failed=${failedDimensions} (stylistic dimensions are guidance only)`
    );
    if (complianceResult.failures.length > 0) {
      complianceResult.failures.forEach((failure) => {
        console.info(`  ${failure.dimension}: ${failure.reason}`);
      });
    }
  }

  // Retry on a near-verbatim (Jaccard) hit, a semantic-duplicate "regenerate",
  // a generic coreMessage (broad praise hides real repetition), a repeated
  // conceptual topic, a repeated OPENING, OR a failed compliance check.
  //
  // Opening diversity is its own trigger on purpose. It is not semantic
  // duplication (the claims differ), not Jaccard (the posts differ), and not
  // compliance (nothing is prohibited) — it is the same sentence shape twice
  // running, which every other gate is blind to by construction.
  const needsRetry =
    duplicateResult.flagged ||
    semanticResult.decision === "regenerate" ||
    coreMessageGeneric ||
    topicRepeated ||
    openingResult.flagged ||
    complianceResult.status === "failed";

  const rejectionReason: AttemptRejectionReason | null = !needsRetry
    ? null
    : duplicateResult.flagged
      ? "jaccard_duplicate"
      : semanticResult.decision === "regenerate"
        ? "semantic_duplicate"
        : coreMessageGeneric
          ? "generic_core_message"
          : topicRepeated
            ? "repeated_topic"
            : openingResult.flagged
              ? "opening_repeated"
              : "compliance_failed";

  return {
    duplicateResult,
    semanticResult,
    coreMessageGeneric,
    topicRepeated,
    complianceResult,
    openingResult,
    needsRetry,
    rejectionReason,
  };
}
