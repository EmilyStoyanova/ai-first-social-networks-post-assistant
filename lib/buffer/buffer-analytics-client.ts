import {
  AnalyticsKeyInvalidError,
  AnalyticsRateLimitError,
  AnalyticsScopeError,
} from "./buffer-analytics-errors";
import type { BufferPostMetric } from "./metric-normalizer";

const API_URL = "https://api.buffer.com";
const LOG_LIMIT = 500;

/**
 * Read-only Buffer client for engagement metrics, authenticated with a company's
 * **Personal API Key**.
 *
 * Deliberately a separate class from BufferClient rather than extra methods on
 * it, for two reasons:
 *
 *  1. Different credential. Publishing uses the OAuth token; Buffer refuses the
 *     `insights:read` scope to OAuth App Clients, so metrics can only be read
 *     with a Personal API Key. Sharing a class would invite passing the wrong one.
 *  2. Different error contract. BufferClient.query() throws whenever `errors[]`
 *     is non-empty — correct for a mutation, fatal here: Buffer answers metrics
 *     queries with PARTIAL SUCCESSES (populated `data` *and* an `errors` entry).
 *     Reusing it would discard valid metrics and raise an opaque error instead of
 *     an actionable FORBIDDEN.
 *
 * This class never writes to Buffer.
 */

/** A per-post result. The union mirrors the three outcomes observed live. */
export type PostMetricsResult =
  | {
      status: "ok";
      bufferPostId: string;
      /** Buffer's own view of the network — authoritative over Post.channel. */
      channelService: string | null;
      metrics: BufferPostMetric[];
      /** When Buffer last refreshed from the network (it ingests once daily). */
      metricsUpdatedAt: string | null;
    }
  /** Buffer answered, but reported no metrics. Not zeros — genuinely nothing. */
  | {
      status: "no_data";
      bufferPostId: string;
      channelService: string | null;
      metricsUpdatedAt: string | null;
    }
  /** The key's Buffer organization does not own this post. */
  | { status: "forbidden"; bufferPostId: string }
  /** Buffer does not recognise the ID (deleted post, or wrong organization). */
  | { status: "not_found"; bufferPostId: string };

interface GqlError {
  message: string;
  path?: (string | number)[];
  extensions?: { code?: string; requiredScopes?: string[] };
}

interface GqlEnvelope<T> {
  data?: T | null;
  errors?: GqlError[];
}

interface RawPost {
  id: string;
  status?: string | null;
  channelService?: string | null;
  metricsUpdatedAt?: string | null;
  metrics?: BufferPostMetric[] | null;
}

export interface AggregatedMetrics {
  postCount: number | null;
  metrics: BufferPostMetric[];
}

export class BufferAnalyticsClient {
  constructor(private readonly personalApiKey: string) {}

  /**
   * Tolerant GraphQL call: returns the FULL envelope instead of throwing on
   * `errors[]`, because a populated `data` alongside an error is the normal shape
   * for metrics. Only conditions that make the whole response unusable throw.
   */
  private async query<T>(
    query: string,
    variables?: Record<string, unknown>
  ): Promise<GqlEnvelope<T>> {
    let res: Response;
    try {
      res = await fetch(API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.personalApiKey}`,
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch (err) {
      // Network-level failure. Surfaced as a rate-limit-shaped retryable error so
      // the cron treats it as "try next run" rather than poisoning the key state.
      const message = err instanceof Error ? err.message : "network error";
      throw new AnalyticsRateLimitError(`Could not reach Buffer: ${message}`);
    }

    if (res.status === 401 || res.status === 403) throw new AnalyticsKeyInvalidError();
    if (res.status === 429) throw new AnalyticsRateLimitError();
    if (!res.ok) {
      const body = await res.text().catch(() => res.statusText);
      // Bodies never contain the key — safe to log truncated.
      console.error(`[buffer-analytics] HTTP ${res.status}: ${body.slice(0, LOG_LIMIT)}`);
      throw new AnalyticsRateLimitError(`Buffer API error ${res.status}.`);
    }

    const json = (await res.json()) as GqlEnvelope<T>;

    // A top-level auth/scope failure is fatal for the whole request regardless of
    // which path it is attached to, so it is checked before per-field handling.
    for (const e of json.errors ?? []) {
      const code = e.extensions?.code;
      if (code === "INSUFFICIENT_SCOPE") throw new AnalyticsScopeError(e.message);
      if (code === "UNAUTHENTICATED") throw new AnalyticsKeyInvalidError(e.message);
      if (code === "RATE_LIMITED") throw new AnalyticsRateLimitError(e.message);
    }

    return json;
  }

  /**
   * Confirms the key works AND actually grants insights access.
   *
   * Authentication alone is not enough to accept a key: a key that authenticates
   * but cannot read insights would save cleanly and then fail silently on every
   * sync. So this also issues a real `aggregatedPostMetrics` read, which is the
   * cheapest scope-exercising query available (1 request, no post ID needed).
   */
  async validateKey(): Promise<{ organizationId: string; organizationName: string }> {
    const account = await this.query<{
      account: { id: string; organizations: Array<{ id: string; name: string }> } | null;
    }>(`query ValidateKey { account { id organizations { id name } } }`);

    const org = account.data?.account?.organizations?.[0];
    if (!org) throw new AnalyticsKeyInvalidError("This Buffer key has no accessible organization.");

    // Exercises insights:read. Throws AnalyticsScopeError if the key lacks it.
    const end = new Date();
    const start = new Date(end.getTime() - 24 * 3600 * 1000);
    await this.query<{ aggregatedPostMetrics: { metrics: BufferPostMetric[] } | null }>(
      `query ValidateScope($o: OrganizationId!, $s: DateTime!, $e: DateTime!) {
         aggregatedPostMetrics(input: { organizationId: $o, startDateTime: $s, endDateTime: $e }) {
           metrics { type value }
         }
       }`,
      { o: org.id, s: start.toISOString(), e: end.toISOString() }
    );

    return { organizationId: org.id, organizationName: org.name };
  }

  /** Metrics for one published post, addressed by its stored `bufferUpdateId`. */
  async getPostMetrics(bufferPostId: string): Promise<PostMetricsResult> {
    const r = await this.query<{ post: RawPost | null }>(
      `query PostMetrics($id: PostId!) {
         post(input: { id: $id }) {
           id
           status
           channelService
           metricsUpdatedAt
           metrics { type name value unit }
         }
       }`,
      { id: bufferPostId }
    );

    for (const e of r.errors ?? []) {
      const code = e.extensions?.code;
      if (code === "FORBIDDEN") return { status: "forbidden", bufferPostId };
      if (code === "NOT_FOUND") return { status: "not_found", bufferPostId };
    }

    const post = r.data?.post;
    if (!post) return { status: "not_found", bufferPostId };

    const channelService = post.channelService ?? null;
    const metricsUpdatedAt = post.metricsUpdatedAt ?? null;

    // Observed live: a post can carry metricsUpdatedAt and still return no
    // metrics. That is "nothing reported", not a row of zeros.
    if (!post.metrics || post.metrics.length === 0) {
      return { status: "no_data", bufferPostId, channelService, metricsUpdatedAt };
    }

    return { status: "ok", bufferPostId, channelService, metrics: post.metrics, metricsUpdatedAt };
  }

  /**
   * Organization-wide roll-up over a window — the surface the upcoming weekly and
   * monthly company aggregation will use. Optionally narrowed to one company's
   * channels, since a Buffer organization can span several of our companies.
   *
   * Caveat carried from the spike: beyond the baseline trio (postCount,
   * reactions, comments), a metric appears only when EVERY channel in the filter
   * supports it — so a mixed Facebook+Instagram filter drops impressions and reach.
   */
  async getAggregatedMetrics(
    organizationId: string,
    start: Date,
    end: Date,
    channelIds?: string[]
  ): Promise<AggregatedMetrics> {
    const r = await this.query<{
      aggregatedPostMetrics: { metrics: BufferPostMetric[] } | null;
    }>(
      `query Aggregated($o: OrganizationId!, $s: DateTime!, $e: DateTime!, $c: [ChannelId!]) {
         aggregatedPostMetrics(
           input: { organizationId: $o, startDateTime: $s, endDateTime: $e, channelIds: $c }
         ) {
           metrics { type name value unit }
         }
       }`,
      {
        o: organizationId,
        s: start.toISOString(),
        e: end.toISOString(),
        c: channelIds && channelIds.length > 0 ? channelIds : undefined,
      }
    );

    const metrics = r.data?.aggregatedPostMetrics?.metrics ?? [];
    const postCount = metrics.find((m) => m.type === "postCount");

    return {
      postCount: postCount ? Math.round(postCount.value) : null,
      metrics: metrics.filter((m) => m.type !== "postCount"),
    };
  }
}
