import Image from "next/image";
import { getTranslations } from "next-intl/server";
import { CalendarClock } from "lucide-react";
import { StatusBadge, type PostStatusValue } from "@/components/ui/StatusBadge";
import { formatDateTime } from "@/lib/i18n/format-date";
import type { PostItem } from "@/lib/services/company/list-posts.service";
import { ChannelMonogram } from "./channel-monogram";
import { OverviewPanel } from "./overview-panel";

interface Props {
  slug: string;
  posts: PostItem[];
}

const CHANNEL_LABELS: Record<string, string> = {
  FACEBOOK: "Facebook",
  LINKEDIN: "LinkedIn",
  INSTAGRAM: "Instagram",
  TIKTOK: "TikTok",
};

/** First line of the post — the list is for recognising a post, not reading it. */
function toTitle(text: string): string {
  const firstLine = text.split("\n").find((l) => l.trim().length > 0) ?? text;
  return firstLine.trim();
}

export async function OverviewUpcoming({ slug, posts }: Props) {
  const t = await getTranslations("overview.upcoming");

  return (
    <OverviewPanel
      icon={CalendarClock}
      title={t("title")}
      footerHref={`/companies/${slug}/posts`}
      footerLabel={t("viewAll")}
    >
      {posts.length === 0 ? (
        <p className="text-fg-faint py-8 text-center text-sm">{t("empty")}</p>
      ) : (
        <ul role="list" className="divide-border divide-y">
          {posts.map((post) => (
            <li key={post.id} className="flex items-center gap-3 py-3 first:pt-0">
              {post.mediaUrl ? (
                <Image
                  src={post.mediaUrl}
                  alt=""
                  width={80}
                  height={80}
                  unoptimized
                  className="rounded-control h-11 w-11 shrink-0 object-cover"
                />
              ) : (
                /* A neutral placeholder keeps every row the same height, so the
                   list scans as a column rather than a ragged stack. */
                <div className="rounded-control bg-surface-subtle h-11 w-11 shrink-0" />
              )}

              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <ChannelMonogram channel={post.channel} />
                  <span className="text-fg-muted text-xs font-medium">
                    {CHANNEL_LABELS[post.channel] ?? post.channel}
                  </span>
                </div>
                <p className="text-fg mt-1 truncate text-sm">{toTitle(post.text)}</p>
              </div>

              <div className="flex shrink-0 flex-col items-end gap-1.5">
                <span className="text-fg-faint text-xs tabular-nums">
                  {/* An unscheduled post is upcoming work with no date yet —
                      saying so beats printing its creation date as if it were one. */}
                  {post.scheduledFor ? formatDateTime(post.scheduledFor) : t("notScheduled")}
                </span>
                <StatusBadge status={post.status.toLowerCase() as PostStatusValue} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </OverviewPanel>
  );
}
