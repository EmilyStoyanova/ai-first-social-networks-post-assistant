/**
 * Normalized competitor-content DTO (Part 3B §15) — one shape across both
 * origins (`FeedItem` via `competitor_rss` ingestion, and
 * `CompetitorManualEntry`). Never leaks internal Prisma objects; every
 * consumer (the list read, the detail read) maps through this.
 */

import {
  extractionRetryRemains,
  resolveAnalysisError,
  type ResolvedAnalysisError,
} from "./analysis-error";

export type CompetitorContentOrigin = "feed_item" | "manual_entry";

export interface CompetitorContentItem {
  /** The `CompetitorIntelligence` row id — the stable identity for this piece
   *  of observed content, regardless of origin. */
  id: string;
  competitorId: string;
  competitorName: string;
  origin: CompetitorContentOrigin;
  /** "rss" for a FeedItem; the manual entry's own sourceType otherwise
   *  (facebook/instagram/.../website/other). */
  platform: string;
  /** organic | ad — manual entries only; null for RSS (there is no ad/organic
   *  distinction for an article). */
  postType: string | null;
  title: string | null;
  excerpt: string | null;
  sourceUrl: string | null;
  /** ISO date, when known. */
  date: string | null;
  /** False for an RSS item with no publishedAt, or a manual entry with no
   *  capturedAt — the UI must show "Unknown date", never substitute another
   *  timestamp (§6). */
  dateKnown: boolean;
  topic: string | null;
  contentType: string | null;
  hookType: string | null;
  structurePattern: string | null;
  angleCategory: string | null;
  relevance: string;
  /** Present on a row that FAILED to settle a genuine verdict (an exhausted
   *  retry streak — see `recompute-stale-relevance.service.ts`'s 2026-09
   *  relevance-retry fix) while `relevance` is still `pending`. The list
   *  needs this (not just the detail view) to render a truthful "Relevance
   *  failed" state instead of a bare, unexplained "Not evaluated yet" —
   *  see `relevance-display-state.ts`. */
  relevanceReason: string | null;
  matchedResearchTopics: string[];
  /** pending | analyzing | completed | failed — the EXTRACTION pipeline's
   *  status, never relevance's (relevance has no status column of its own —
   *  see CompetitorIntelligence's schema comment). */
  status: string;
  /** CLASSIFIED, never raw (2026-09-02 analysis-error UX cleanup). The column
   *  holds two very different things — two deterministic conditions this
   *  pipeline writes on purpose, and arbitrary provider/internal failure text
   *  — and only the first kind is user-facing copy. Resolving here rather than
   *  in the component means the raw message never crosses the API boundary at
   *  all, so it cannot leak into the normal Content UI even by accident. The
   *  detail stays in the column and in the worker's logs, where a diagnostic
   *  belongs. See `analysis-error.ts`. */
  analysisError: ResolvedAnalysisError | null;
}

export interface CompetitorContentDetail extends CompetitorContentItem {
  subtopic: string | null;
  summary: string | null;
  angle: string | null;
  targetAudience: string | null;
  problemAddressed: string | null;
  keyMessage: string | null;
  tone: string | null;
  ctaText: string | null;
  commercialIntent: string | null;
  ctaType: string | null;
  productsServicesMentioned: string[];
  originalLanguage: string | null;
  /** Null until a genuine relevance verdict has been reached (see
   *  `CompetitorIntelligence.relevanceProfileVersion`'s own schema comment) —
   *  the Research Profile version this row's CURRENT `relevance` was scored
   *  against. Never set by a failed attempt or an exhausted-retries settle. */
  relevanceProfileVersion: number | null;
  /** Null until a genuine relevance verdict has been reached — never set on
   *  a failed attempt (see `recompute-stale-relevance.service.ts`'s 2026-09
   *  relevance-retry fix). Truthfully answers "when was this last actually
   *  scored," not "when was this last touched." */
  relevanceEvaluatedAt: string | null;
  /** The full observed text (RSS article body or the pasted manual content) —
   *  never truncated, unlike the list DTO's `excerpt`. */
  content: string | null;
}

const EXCERPT_MAX_CHARS = 240;

function excerptOf(text: string | null | undefined): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (trimmed === "") return null;
  return trimmed.length > EXCERPT_MAX_CHARS
    ? `${trimmed.slice(0, EXCERPT_MAX_CHARS).trim()}…`
    : trimmed;
}

/** The Prisma `select` shared by the list and detail reads. */
export const COMPETITOR_CONTENT_SELECT = {
  id: true,
  competitorId: true,
  status: true,
  analysisError: true,
  // Read only to decide whether the generic failure message may promise an
  // automatic retry — never surfaced as a number. See `extractionRetryRemains`.
  attemptCount: true,
  topic: true,
  subtopic: true,
  summary: true,
  angle: true,
  targetAudience: true,
  problemAddressed: true,
  keyMessage: true,
  tone: true,
  ctaText: true,
  contentType: true,
  commercialIntent: true,
  ctaType: true,
  angleCategory: true,
  hookType: true,
  structurePattern: true,
  productsServicesMentioned: true,
  originalLanguage: true,
  relevance: true,
  relevanceReason: true,
  matchedResearchTopics: true,
  relevanceProfileVersion: true,
  relevanceEvaluatedAt: true,
  // `archivedAt` rides the relation select that already runs — an archived
  // competitor's rows are excluded by the drain, so they will not be retried
  // either, and the list DOES still show them.
  competitor: { select: { name: true, archivedAt: true } },
  feedItem: { select: { title: true, content: true, url: true, publishedAt: true } },
  manualEntry: {
    select: { content: true, url: true, capturedAt: true, sourceType: true, postType: true },
  },
} as const;

export interface CompetitorContentRow {
  id: string;
  competitorId: string;
  status: string;
  analysisError: string | null;
  attemptCount: number;
  topic: string | null;
  subtopic: string | null;
  summary: string | null;
  angle: string | null;
  targetAudience: string | null;
  problemAddressed: string | null;
  keyMessage: string | null;
  tone: string | null;
  ctaText: string | null;
  contentType: string | null;
  commercialIntent: string | null;
  ctaType: string | null;
  angleCategory: string | null;
  hookType: string | null;
  structurePattern: string | null;
  productsServicesMentioned: string[];
  originalLanguage: string | null;
  relevance: string;
  relevanceReason: string | null;
  matchedResearchTopics: string[];
  relevanceProfileVersion: number | null;
  relevanceEvaluatedAt: Date | null;
  competitor: { name: string; archivedAt: Date | null };
  feedItem: {
    title: string | null;
    content: string | null;
    url: string;
    publishedAt: Date | null;
  } | null;
  manualEntry: {
    content: string;
    url: string | null;
    capturedAt: Date | null;
    sourceType: string;
    postType: string;
  } | null;
}

function origin(row: CompetitorContentRow): CompetitorContentOrigin {
  return row.feedItem ? "feed_item" : "manual_entry";
}

export function toCompetitorContentItem(row: CompetitorContentRow): CompetitorContentItem {
  const base = {
    id: row.id,
    competitorId: row.competitorId,
    competitorName: row.competitor.name,
    origin: origin(row),
    topic: row.topic,
    contentType: row.contentType,
    hookType: row.hookType,
    structurePattern: row.structurePattern,
    angleCategory: row.angleCategory,
    relevance: row.relevance,
    relevanceReason: row.relevanceReason,
    matchedResearchTopics: row.matchedResearchTopics,
    status: row.status,
    analysisError: resolveAnalysisError(
      row.analysisError,
      extractionRetryRemains({
        attemptCount: row.attemptCount,
        competitorArchived: row.competitor.archivedAt !== null,
      })
    ),
  };

  if (row.feedItem) {
    return {
      ...base,
      platform: "rss",
      postType: null,
      title: row.feedItem.title,
      excerpt: excerptOf(row.feedItem.content),
      sourceUrl: row.feedItem.url,
      date: row.feedItem.publishedAt?.toISOString() ?? null,
      dateKnown: row.feedItem.publishedAt !== null,
    };
  }

  const manual = row.manualEntry!;
  return {
    ...base,
    platform: manual.sourceType,
    postType: manual.postType,
    title: null,
    excerpt: excerptOf(manual.content),
    sourceUrl: manual.url,
    date: manual.capturedAt?.toISOString() ?? null,
    dateKnown: manual.capturedAt !== null,
  };
}

export function toCompetitorContentDetail(row: CompetitorContentRow): CompetitorContentDetail {
  const item = toCompetitorContentItem(row);
  const fullContent = row.feedItem ? row.feedItem.content : (row.manualEntry?.content ?? null);

  return {
    ...item,
    subtopic: row.subtopic,
    summary: row.summary,
    angle: row.angle,
    targetAudience: row.targetAudience,
    problemAddressed: row.problemAddressed,
    keyMessage: row.keyMessage,
    tone: row.tone,
    ctaText: row.ctaText,
    commercialIntent: row.commercialIntent,
    ctaType: row.ctaType,
    productsServicesMentioned: row.productsServicesMentioned,
    originalLanguage: row.originalLanguage,
    relevanceProfileVersion: row.relevanceProfileVersion,
    relevanceEvaluatedAt: row.relevanceEvaluatedAt?.toISOString() ?? null,
    content: fullContent,
  };
}
