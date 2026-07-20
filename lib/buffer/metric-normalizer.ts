/**
 * Turns Buffer's `PostMetric[]` array into the flat shape we store.
 *
 * The whole reason this is its own module with its own tests: Buffer's `value` is
 * a non-null Float that DEFAULTS TO 0 when the network did not report a metric.
 * So `impressions: 0` is ambiguous in isolation — it could be a real zero or an
 * unsupported metric. The disambiguator is the metric type's PRESENCE in the
 * array, verified live 2026-07-20: Facebook responses never contain `reach`, and
 * Instagram responses never contain `impressions` or `clicks`.
 *
 * Therefore: absent type -> null ("not reported"), present type -> its value
 * (including a genuine 0). Never coalesce a missing metric to 0.
 */

/** A metric entry exactly as Buffer returns it. */
export interface BufferPostMetric {
  type: string;
  name: string;
  value: number;
  unit: string;
}

/** Metric columns we model. Every one is nullable — see the module comment. */
export interface NormalizedMetrics {
  reactions: number | null;
  comments: number | null;
  shares: number | null;
  impressions: number | null;
  clicks: number | null;
  reach: number | null;
  views: number | null;
  saves: number | null;
  follows: number | null;
  engagementRate: number | null;
  /**
   * Which denominator Buffer's native engagementRate is computed against, so the
   * UI can label it. Both Facebook and Instagram return a native rate, but on
   * different bases (FB: impressions, IG: reach), which makes the two numbers
   * non-comparable. Inferred from which denominator metric is present, not
   * hardcoded per channel — a channel we have never seen still resolves correctly.
   */
  engagementRateDenominator: "impressions" | "reach" | null;
}

/** Count-typed metrics, mapped straight from Buffer's type name to our column. */
const COUNT_METRICS = [
  "reactions",
  "comments",
  "shares",
  "impressions",
  "clicks",
  "reach",
  "views",
  "saves",
  "follows",
] as const;

type CountMetric = (typeof COUNT_METRICS)[number];

const EMPTY: NormalizedMetrics = {
  reactions: null,
  comments: null,
  shares: null,
  impressions: null,
  clicks: null,
  reach: null,
  views: null,
  saves: null,
  follows: null,
  engagementRate: null,
  engagementRateDenominator: null,
};

/**
 * Buffer counts are whole numbers delivered as Float. Round rather than trunc so
 * a float artefact like 2.9999999 does not become 2.
 */
function toCount(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  return Math.round(value);
}

export function normalizeMetrics(
  metrics: BufferPostMetric[] | null | undefined
): NormalizedMetrics {
  if (!metrics || metrics.length === 0) return { ...EMPTY };

  const byType = new Map<string, BufferPostMetric>();
  for (const m of metrics) {
    // Last wins — Buffer has never returned duplicates, but a duplicate must not
    // throw and silently lose the whole post's metrics.
    byType.set(m.type, m);
  }

  const result: NormalizedMetrics = { ...EMPTY };

  for (const type of COUNT_METRICS) {
    const entry = byType.get(type);
    if (entry !== undefined) {
      result[type satisfies CountMetric] = toCount(entry.value);
    }
  }

  const rate = byType.get("engagementRate");
  if (rate !== undefined && Number.isFinite(rate.value)) {
    result.engagementRate = rate.value;
    // Presence-based, matching observed behaviour: Facebook ships impressions,
    // Instagram ships reach, and neither ships both.
    if (byType.has("impressions")) result.engagementRateDenominator = "impressions";
    else if (byType.has("reach")) result.engagementRateDenominator = "reach";
  }

  return result;
}

/**
 * True when Buffer reported nothing usable. Distinguishes "ingested but empty"
 * from "has data", so the caller can record `no_data` rather than writing a row
 * of nulls that looks like a failed sync.
 */
export function isEmptyMetrics(metrics: BufferPostMetric[] | null | undefined): boolean {
  return !metrics || metrics.length === 0;
}
