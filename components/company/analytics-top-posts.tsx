import Image from "next/image";
import { getLocale, getTranslations } from "next-intl/server";
import { ImageOff } from "lucide-react";
import { channelLabel } from "@/lib/posts/channel-selection";
import { compactCount, formatRate } from "@/lib/analytics/analytics-format";
import { dateLocaleFor, formatDate } from "@/lib/i18n/format-date";
import type { TopPostView } from "@/lib/services/analytics/get-channel-analytics.service";

interface Props {
  posts: TopPostView[];
}

/**
 * The best-performing posts of the period.
 *
 * Ranked server-side by engagement ACTIONS — reactions + comments + shares — in
 * every scope. Those three count the same human gesture on every network, which
 * makes the ordering meaningful in All Channels without ever putting a Facebook
 * engagement rate next to an Instagram one (they use different denominators, so
 * the comparison would be meaningless). The rate is shown on each row, because
 * within one post it is a real figure; it is simply never the sort key.
 *
 * Posts the metrics sync has not reached do not appear at all. A post with no
 * measurements has not scored zero, and ranking it last would say that it had.
 */
export async function AnalyticsTopPosts({ posts }: Props) {
  const t = await getTranslations("planner.analytics");
  const tMetric = await getTranslations("analytics");
  const locale = dateLocaleFor(await getLocale());

  return (
    <div>
      <ul className="space-y-2">
        {posts.map((post) => (
          <li
            key={post.id}
            className="rounded-card border-border bg-surface shadow-card flex gap-3 border p-3 sm:gap-4 sm:p-4"
          >
            <div className="rounded-control bg-surface-subtle relative h-16 w-16 shrink-0 overflow-hidden sm:h-20 sm:w-20">
              {post.mediaUrl ? (
                <Image
                  src={post.mediaUrl}
                  alt=""
                  width={160}
                  height={160}
                  className="h-full w-full object-cover"
                  unoptimized
                />
              ) : (
                <span className="text-fg-faint flex h-full w-full items-center justify-center">
                  <ImageOff className="h-5 w-5" aria-hidden="true" />
                </span>
              )}
            </div>

            <div className="min-w-0 flex-1">
              <div className="text-fg-faint flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                <span className="text-fg-muted font-medium">{channelLabel(post.channel)}</span>
                <span aria-hidden="true">·</span>
                <span>{formatDate(post.publishedAt, locale)}</span>
              </div>

              <p className="text-fg mt-1 line-clamp-2 text-sm leading-snug">
                {post.postUrl ? (
                  <a
                    href={post.postUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:underline hover:underline-offset-2"
                  >
                    {post.preview}
                  </a>
                ) : (
                  post.preview
                )}
              </p>

              <div className="text-fg-muted mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs">
                {post.metrics.map((metric) => (
                  <span key={metric.metric} className="tabular-nums">
                    <span className="text-fg font-semibold">{compactCount(metric.value)}</span>{" "}
                    {tMetric(metric.metric)}
                  </span>
                ))}

                {/* Only ever populated inside a single channel — see the note above. */}
                {post.engagementRate !== null && (
                  <span className="tabular-nums">
                    <span className="text-fg font-semibold">{formatRate(post.engagementRate)}</span>{" "}
                    {tMetric("engagementRate")}
                    {post.engagementRateBasis && (
                      <span className="text-fg-faint"> ({tMetric(post.engagementRateBasis)})</span>
                    )}
                  </span>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>

      <p className="text-fg-faint mt-2 px-1 text-xs leading-relaxed">{t("topPosts.rankedBy")}</p>
    </div>
  );
}
