"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";
import type { MediaItem } from "@/lib/services/company/list-media.service";
import type { PostItem } from "@/lib/services/company/list-posts.service";

type BadgeVariant =
  "owner" | "editor" | "comingSoon" | "success" | "warning" | "danger" | "neutral" | "readonly";

const CHANNEL_META: Record<string, { label: string; variant: BadgeVariant }> = {
  FACEBOOK: { label: "Facebook", variant: "neutral" },
  LINKEDIN: { label: "LinkedIn", variant: "editor" },
  INSTAGRAM: { label: "Instagram", variant: "warning" },
  TIKTOK: { label: "TikTok", variant: "danger" },
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

interface Props {
  item: MediaItem;
  slug: string;
}

export function MediaCard({ item, slug }: Props) {
  const [reuseOpen, setReuseOpen] = useState(false);
  const [loadingPosts, setLoadingPosts] = useState(false);
  const [draftPosts, setDraftPosts] = useState<PostItem[]>([]);
  const [selectedPostId, setSelectedPostId] = useState("");
  const [attaching, setAttaching] = useState(false);
  const [attachError, setAttachError] = useState("");
  const [attachedSuccess, setAttachedSuccess] = useState(false);

  const channelMeta = item.post
    ? (CHANNEL_META[item.post.channel] ?? {
        label: item.post.channel,
        variant: "neutral" as BadgeVariant,
      })
    : null;

  async function handleOpenReuse() {
    setReuseOpen(true);
    setAttachError("");
    setAttachedSuccess(false);
    setLoadingPosts(true);
    try {
      const res = await fetch(`/api/v1/companies/${slug}/posts`);
      const json = (await res.json()) as { posts: PostItem[] };
      const drafts = json.posts.filter((p) => p.status === "DRAFT");
      setDraftPosts(drafts);
      setSelectedPostId(drafts[0]?.id ?? "");
    } catch {
      setAttachError("Failed to load posts.");
    } finally {
      setLoadingPosts(false);
    }
  }

  async function handleAttach() {
    if (!selectedPostId) return;
    setAttaching(true);
    setAttachError("");
    try {
      const res = await fetch(`/api/v1/posts/${selectedPostId}/attach-media`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mediaId: item.id }),
      });
      if (!res.ok) {
        const json = (await res.json()) as { error?: { message?: string } };
        throw new Error(json.error?.message ?? "Failed to attach image.");
      }
      setAttachedSuccess(true);
      setReuseOpen(false);
    } catch (err) {
      setAttachError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setAttaching(false);
    }
  }

  return (
    <div className="flex flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
      {/* Image */}
      <div className="relative aspect-video w-full overflow-hidden bg-gray-100">
        <Image
          src={item.url}
          alt={item.post ? `Image for ${item.post.channel} post` : "AI-generated image"}
          fill
          className="object-cover"
          unoptimized
          loading="lazy"
        />
      </div>

      {/* Content */}
      <div className="flex flex-1 flex-col px-4 py-4">
        {/* Badges row */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {channelMeta && <Badge variant={channelMeta.variant}>{channelMeta.label}</Badge>}
          <Badge variant="neutral">{item.provider}</Badge>
        </div>

        {/* Metadata */}
        <dl className="mb-4 space-y-1 text-xs text-gray-500">
          <div className="flex items-center justify-between gap-2">
            <dt className="font-medium text-gray-400">Created</dt>
            <dd>{formatDate(item.createdAt)}</dd>
          </div>
          {item.width && item.height && (
            <div className="flex items-center justify-between gap-2">
              <dt className="font-medium text-gray-400">Dimensions</dt>
              <dd>
                {item.width} × {item.height}
              </dd>
            </div>
          )}
          {item.post && (
            <div className="flex items-center justify-between gap-2">
              <dt className="font-medium text-gray-400">Status</dt>
              <dd>{item.post.status}</dd>
            </div>
          )}
        </dl>

        {/* Success banner */}
        {attachedSuccess && (
          <Alert variant="success" className="mb-3">
            Image attached successfully.
          </Alert>
        )}

        {/* Reuse panel */}
        {reuseOpen && (
          <div className="mb-3 rounded-lg border border-gray-200 bg-gray-50 px-3 py-3">
            <p className="mb-2 text-xs font-semibold text-gray-700">Attach to a draft post</p>
            {loadingPosts ? (
              <p className="text-xs text-gray-400">Loading posts…</p>
            ) : draftPosts.length === 0 ? (
              <p className="text-xs text-gray-400">No draft posts available.</p>
            ) : (
              <select
                value={selectedPostId}
                onChange={(e) => setSelectedPostId(e.target.value)}
                disabled={attaching}
                className="mb-2 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs outline-none focus:border-green-500 focus:ring-2 focus:ring-green-100"
              >
                {draftPosts.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.channel} — {p.text.slice(0, 50)}
                    {p.text.length > 50 ? "…" : ""}
                  </option>
                ))}
              </select>
            )}
            {attachError && (
              <Alert variant="error" className="mb-2">
                {attachError}
              </Alert>
            )}
            <div className="flex gap-2">
              <Button
                variant="primary"
                size="sm"
                loading={attaching}
                disabled={!selectedPostId || loadingPosts}
                onClick={handleAttach}
              >
                {attaching ? "Attaching…" : "Attach"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setReuseOpen(false);
                  setAttachError("");
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="mt-auto flex flex-wrap items-center gap-2">
          {item.post && (
            <Link
              href={`/companies/${slug}`}
              className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-semibold text-gray-600 transition-colors hover:bg-gray-100"
            >
              Open Post
            </Link>
          )}
          {!reuseOpen && (
            <Button variant="ghost" size="sm" onClick={handleOpenReuse}>
              Reuse Image
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
