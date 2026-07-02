"use client";

import { useState } from "react";
import { EmptyState } from "@/components/ui/EmptyState";
import { GeneratedPostCard } from "./generated-post-card";
import type { PostItem } from "@/lib/services/company/list-posts.service";

const CHANNELS = ["FACEBOOK", "LINKEDIN", "INSTAGRAM", "TIKTOK"] as const;

interface Props {
  slug: string;
  initialPosts: PostItem[];
  canApprove: boolean;
  canPublish: boolean;
  bufferConnected: boolean;
}

export function ApprovalQueueSection({
  slug,
  initialPosts,
  canApprove,
  canPublish,
  bufferConnected,
}: Props) {
  const [posts, setPosts] = useState<PostItem[]>(initialPosts);
  const [channelFilter, setChannelFilter] = useState<string>("ALL");

  function handleStatusChange(id: string) {
    // Remove from queue once approved or rejected — no longer pending
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
                ? "bg-green-500 text-white"
                : "bg-gray-100 text-gray-600 hover:bg-gray-200",
            ].join(" ")}
          >
            All ({posts.length})
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
                    ? "bg-green-500 text-white"
                    : "bg-gray-100 text-gray-600 hover:bg-gray-200",
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
          icon="✅"
          title={posts.length === 0 ? "No posts pending approval" : "No posts match the filter"}
          description={
            posts.length === 0
              ? "When posts are submitted for approval they will appear here."
              : "Try selecting a different channel."
          }
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {visible.map((post) => (
            <GeneratedPostCard
              key={post.id}
              slug={slug}
              post={post}
              canDelete={false}
              canPublish={canPublish}
              canApprove={canApprove}
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
