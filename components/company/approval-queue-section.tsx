"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { CheckSquare2 } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { GeneratedPostCard } from "./generated-post-card";
import type { PostItem } from "@/lib/services/company/list-posts.service";
import type { PostRole } from "@/lib/posts/post-actions";

const CHANNELS = ["FACEBOOK", "LINKEDIN", "INSTAGRAM", "TIKTOK"] as const;

interface Props {
  slug: string;
  initialPosts: PostItem[];
  role: PostRole;
  bufferConnected: boolean;
}

export function ApprovalQueueSection({ slug, initialPosts, role, bufferConnected }: Props) {
  const t = useTranslations("approval");
  const [posts, setPosts] = useState<PostItem[]>(initialPosts);
  const [channelFilter, setChannelFilter] = useState<string>("ALL");

  function handleStatusChange(id: string) {
    setPosts((prev) => prev.filter((p) => p.id !== id));
  }

  const visible =
    channelFilter === "ALL" ? posts : posts.filter((p) => p.channel === channelFilter);

  const activeChannels = Array.from(new Set(posts.map((p) => p.channel)));

  return (
    <div className="space-y-4">
      {/* Channel filter */}
      {posts.length > 0 && (
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setChannelFilter("ALL")}
            className={[
              "rounded-full px-3 py-1 text-xs font-semibold transition-colors",
              channelFilter === "ALL"
                ? "bg-fg text-white"
                : "bg-surface-subtle text-fg-muted hover:bg-surface-subtle",
            ].join(" ")}
          >
            {t("all")} ({posts.length})
          </button>
          {CHANNELS.filter((ch) => activeChannels.includes(ch)).map((ch) => {
            const count = posts.filter((p) => p.channel === ch).length;
            return (
              <button
                key={ch}
                onClick={() => setChannelFilter(ch)}
                className={[
                  "rounded-full px-3 py-1 text-xs font-semibold transition-colors",
                  channelFilter === ch
                    ? "bg-fg text-white"
                    : "bg-surface-subtle text-fg-muted hover:bg-surface-subtle",
                ].join(" ")}
              >
                {ch.charAt(0) + ch.slice(1).toLowerCase()} ({count})
              </button>
            );
          })}
        </div>
      )}

      {visible.length === 0 ? (
        <EmptyState
          icon={<CheckSquare2 className="h-5 w-5" />}
          title={posts.length === 0 ? t("noPending") : t("noFilter")}
          description={posts.length === 0 ? t("noPendingDesc") : t("noFilterDesc")}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {visible.map((post) => (
            <GeneratedPostCard
              key={post.id}
              slug={slug}
              post={post}
              canDelete={false}
              role={role}
              bufferConnected={bufferConnected}
              onDelete={() => {}}
              onStatusChange={handleStatusChange}
            />
          ))}
        </div>
      )}
    </div>
  );
}
