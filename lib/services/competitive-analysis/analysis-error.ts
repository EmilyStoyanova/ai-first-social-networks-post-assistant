/**
 * `CompetitorIntelligence.analysisError` — canonical storage, localized
 * display (2026-09-02 analysis-error UX cleanup).
 *
 * ── The two problems this closes ─────────────────────────────────────────
 * 1. The column held English PROSE written by this repo's own code ("No
 *    readable content to analyze."), and the Content drawer rendered it
 *    verbatim — so a Bulgarian UI showed an English sentence. Same shape as
 *    the `relevanceReason` leak, same fix: store a canonical code, localize
 *    at display. See [[relevance-reason.ts]], which this mirrors exactly.
 * 2. The column ALSO holds arbitrary provider/internal text — a thrown model
 *    error, a timeout message, a JSON-repair failure. That is diagnostic
 *    material, not user-facing copy: it cannot be localized, it is written
 *    for whoever is reading the logs, and it can carry provider or internal
 *    detail that has no business in a normal user's Content view.
 *
 * So the vocabulary is deliberately NOT open. There are exactly two
 * deterministic conditions this pipeline produces on purpose; everything else
 * is `unknown` and renders as one honest generic line. The raw text is not
 * translated, not shown, and not thrown away — it stays in the column and in
 * the worker's structured logs, which is where a diagnostic belongs.
 *
 * ── Existing rows ────────────────────────────────────────────────────────
 * The legacy table below recognizes the exact sentences written BEFORE this
 * split, so every row already in the database localizes with no migration, no
 * backfill and no re-analysis. Anything it does not recognize degrades to
 * `unknown` — which is the correct, safe answer for the arbitrary-provider-
 * text case that motivated half of this module.
 */

// The drain's own attempt cap — imported, never restated, so the UI's "will be
// retried automatically" promise cannot drift from what the pipeline does.
import { MAX_EXTRACTION_ATTEMPTS } from "@/lib/ai/competitor-intelligence-extraction";

/** The conditions the extractor decides on its own, deterministically. Both
 *  are content problems, not provider problems — which is exactly why they are
 *  worth naming and the rest are not. */
export const ANALYSIS_ERROR_CODES = ["no_readable_content", "content_too_short"] as const;
export type AnalysisErrorCode = (typeof ANALYSIS_ERROR_CODES)[number];

/** Same `code:` marker `relevance-reason.ts` uses, for the same reason: it
 *  cannot collide with a natural-language error message, and it makes a stored
 *  value's kind obvious when read straight off the database. */
export const ANALYSIS_ERROR_CODE_PREFIX = "code:";

/**
 * The canonical value to STORE. `content_too_short` carries its two numbers so
 * the localized message can stay as specific as the English sentence it
 * replaces — dropping them would have been a quiet regression in what the row
 * actually records.
 */
export function analysisErrorCodeValue(
  code: AnalysisErrorCode,
  params?: { chars: number; minimum: number }
): string {
  const base = `${ANALYSIS_ERROR_CODE_PREFIX}${code}`;
  if (code === "content_too_short" && params) {
    return `${base}:${params.chars}:${params.minimum}`;
  }
  return base;
}

export type ResolvedAnalysisError =
  | { kind: "no_readable_content" }
  /** `chars`/`minimum` are null for a legacy or malformed value that named the
   *  condition without its numbers — the UI falls back to the generic wording
   *  rather than printing "null characters". */
  | { kind: "content_too_short"; chars: number | null; minimum: number | null }
  /**
   * A provider/internal failure. Carries NO text on purpose: this type is what
   * crosses the API boundary, so the raw message cannot reach the client even
   * by accident.
   *
   * `retryable` is the ONLY retry-state information exposed — a plain boolean,
   * already decided server-side. Deliberately not `attemptCount`/`maxAttempts`:
   * the UI's question is "will this be picked up again on its own?", and
   * shipping the raw counters would invite a client to re-derive that rule and
   * drift from `selectableWhere`. It exists because the generic message
   * promises an automatic retry, and that promise is FALSE once the attempt
   * budget is spent — see `extractionRetryRemains`.
   */
  | { kind: "unknown"; retryable: boolean };

/**
 * Will the extraction drain pick this row up again on its own?
 *
 * Mirrors the two clauses of `selectableWhere` that can settle permanently —
 * the spent attempt budget, and an archived competitor (whose rows the drain
 * excludes at selection, and whose extraction the per-item processor releases
 * without spending an attempt). Deliberately does NOT restate the status
 * clause: this is only ever asked about a row that already carries an
 * `analysisError`, which the pipeline writes with `status: "failed"`.
 *
 * A restored competitor becomes retryable again, which is correct — the
 * message is a snapshot of the row as it stands, not a prediction.
 */
export function extractionRetryRemains(row: {
  attemptCount: number;
  competitorArchived: boolean;
}): boolean {
  return !row.competitorArchived && row.attemptCount < MAX_EXTRACTION_ATTEMPTS;
}

/** Exactly the sentences this repo wrote before the split. Anchored matches,
 *  never substring searches — a provider error that happens to mention short
 *  content must stay `unknown`. */
const LEGACY_NO_READABLE_CONTENT = "No readable content to analyze.";
const LEGACY_CONTENT_TOO_SHORT = /^Content too short to analyze \((\d+) chars, minimum (\d+)\)\.$/;

function parseCount(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Turn whatever is stored into something renderable. Returns `null` only when
 * there is no error at all — an empty column is not an `unknown` error, and
 * conflating the two would put a red alert on every healthy row.
 *
 * `retryable` is consumed ONLY by the `unknown` branch. The two deterministic
 * conditions keep their existing wording unchanged: they describe what is
 * wrong with the content, which stays equally true whether or not another
 * attempt is coming, so qualifying them would add noise, not truth.
 */
export function resolveAnalysisError(
  stored: string | null | undefined,
  retryable: boolean
): ResolvedAnalysisError | null {
  const value = (stored ?? "").trim();
  if (value === "") return null;

  if (value.startsWith(ANALYSIS_ERROR_CODE_PREFIX)) {
    const [code, chars, minimum] = value.slice(ANALYSIS_ERROR_CODE_PREFIX.length).split(":");
    if (code === "no_readable_content") return { kind: "no_readable_content" };
    if (code === "content_too_short") {
      return {
        kind: "content_too_short",
        chars: parseCount(chars),
        minimum: parseCount(minimum),
      };
    }
    // A code written by a future version this build does not know about. It is
    // still an internal token, so showing it raw would be the exact leak this
    // module exists to prevent — the generic message is the honest answer.
    return { kind: "unknown", retryable };
  }

  if (value === LEGACY_NO_READABLE_CONTENT) return { kind: "no_readable_content" };

  const legacyShort = LEGACY_CONTENT_TOO_SHORT.exec(value);
  if (legacyShort) {
    return {
      kind: "content_too_short",
      chars: parseCount(legacyShort[1]),
      minimum: parseCount(legacyShort[2]),
    };
  }

  return { kind: "unknown", retryable };
}
