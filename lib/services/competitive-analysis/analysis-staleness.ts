/**
 * Is a COMPLETED `CompetitorIntelligence` row's analysis still current?
 * (2026-09-02 stale-analysis recovery.)
 *
 * ── The gap this closes ──────────────────────────────────────────────────
 * The mixed-language fix made extraction produce free-form analysis in the
 * company's own language and bumped `EXTRACTION_SEMANTIC_VERSION` to 2. That
 * fixes every row analyzed from then on. It does nothing for the rows already
 * sitting at `status: "completed"` with English `topic`/`summary`/`tone`,
 * because nothing in the pipeline ever re-opens a completed row: the drain's
 * `selectableWhere` matches only pending/failed/lease-expired rows, so a
 * completed row is, by construction, finished forever.
 *
 * `analysisHash` was already being WRITTEN on every successful extraction and
 * never read back by anything. This module is its first reader, and that is
 * the whole mechanism: because the hash covers title + body + analysis
 * language + semantic version, recomputing it from the row's own stored
 * content and comparing answers exactly one question — "was this row produced
 * under the same input and the same extractor semantics we would use now?" A
 * mismatch is precisely "analyzed under v1, or in a different language, or
 * from content that has since changed".
 *
 * ── Why this is a separate, pure, Prisma-free module ──────────────────────
 * The recovery sweep and the extractor MUST agree, byte for byte, on what
 * "the input" is. If they ever disagree — if the sweep hashed the raw body
 * while the extractor hashed the trimmed one, say — then every row would look
 * stale immediately after being re-analyzed, and the sweep would re-open the
 * same rows on every single worker start, forever, spending a model call each
 * time. That is the one genuinely dangerous failure mode here, so the shared
 * step (`extractableContentOf`) lives in ONE place that both import, rather
 * than being written out twice and trusted to stay identical.
 * `extract-competitor-intelligence.service.ts` imports it too — it is not a
 * copy of that function, it IS that function.
 */

import {
  computeExtractionHash,
  type ExtractableContent,
} from "@/lib/ai/competitor-intelligence-extraction";
import type { AnalysisLanguage } from "@/lib/i18n/analysis-language";

/** The two origins extraction can currently read content from. A
 *  `CompetitorSocialItem` origin exists in the schema but has no extraction
 *  path yet (Part 3C), so it is deliberately absent here — see
 *  `unanalyzable` below for how such a row is treated. */
export interface AnalysisOrigin {
  feedItem: { title: string | null; content: string | null } | null;
  manualEntry: { content: string } | null;
}

/**
 * The exact `ExtractableContent` the extractor derives for an item — the
 * single definition both the extractor and the staleness check use. See the
 * module comment for why this is shared rather than duplicated.
 */
export function extractableContentOf(origin: AnalysisOrigin): ExtractableContent | null {
  if (origin.feedItem) return { title: origin.feedItem.title, body: origin.feedItem.content ?? "" };
  if (origin.manualEntry) return { title: null, body: origin.manualEntry.content };
  return null;
}

export interface StaleAnalysisCandidate extends AnalysisOrigin {
  analysisHash: string | null;
}

/**
 * Why a completed row is (or is not) due for re-analysis. A verdict rather
 * than a boolean because the sweep reports these counts as diagnostics and the
 * three "yes" cases have genuinely different causes an operator would want to
 * tell apart.
 */
export type AnalysisStaleness =
  /** Hash recomputes to exactly what is stored — same content, same language,
   *  same extractor semantics. Never re-opened. */
  | "current"
  /** Analyzed under different content, a different analysis language, or an
   *  older `EXTRACTION_SEMANTIC_VERSION`. This is what a v1 English row looks
   *  like once the company's language is Bulgarian. */
  | "stale_hash"
  /** Completed, but with no fingerprint at all. Cannot be PROVEN current, and
   *  a row that completed without a hash necessarily predates the current
   *  write path — so it is treated as stale. Bounded like any other: once
   *  re-analyzed it gets a hash and never qualifies again. */
  | "missing_hash"
  /** No content to re-derive the input from (no feed item and no manual
   *  entry). Re-opening it could not produce a better answer than the one
   *  already stored — the extractor would claim it, find nothing to send, and
   *  burn attempt budget writing `missing_origin`. Left alone. */
  | "unanalyzable";

export function analysisStaleness(
  row: StaleAnalysisCandidate,
  language: AnalysisLanguage
): AnalysisStaleness {
  const content = extractableContentOf(row);
  if (!content) return "unanalyzable";
  if (row.analysisHash === null || row.analysisHash.trim() === "") return "missing_hash";
  return computeExtractionHash(content, language) === row.analysisHash ? "current" : "stale_hash";
}

/** The verdicts that warrant re-opening. Exported so the sweep and its tests
 *  share one definition of "stale" instead of each listing the strings. */
export function isStaleAnalysis(staleness: AnalysisStaleness): boolean {
  return staleness === "stale_hash" || staleness === "missing_hash";
}
