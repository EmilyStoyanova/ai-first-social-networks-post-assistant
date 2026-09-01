"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { CheckCircle2 } from "lucide-react";
import { GeneratePostForm } from "./generate-post-form";
import { Card } from "@/components/ui/Card";
import { channelLabel } from "@/lib/posts/channel-selection";
import type { PostItem } from "@/lib/services/company/list-posts.service";
import type { GenerationSourceOption } from "@/lib/services/company/list-generation-sources.service";
import type { GenerationChannelOption } from "@/lib/posts/generation-channels";
import type { ContentMixDTO } from "@/lib/services/company/get-content-mix.service";

interface Props {
  slug: string;
  hasRssFeedItems: boolean;
  contentSources: GenerationSourceOption[];
  availableChannels: GenerationChannelOption[];
  companyDefaultLang: "en" | "bg";
  contentMix: ContentMixDTO | null;
}

/**
 * Hosts `GeneratePostForm` on its own, task-oriented page — generation used
 * to share this component tree (and a posts array) with the management grid
 * in `generated-posts-section.tsx`; now it stands alone, so a result is
 * reported locally instead of being prepended into a shared list that no
 * longer exists here.
 *
 * `GeneratePostForm` itself already renders its own run-in-progress and
 * bulk-completion detail (`BulkJobProgress`, `TopicJobProgress`,
 * `BulkResultSummary`) — this panel only adds the cross-link into post
 * management, plus a lightweight confirmation for single/topic mode, which
 * previously had no feedback of its own beyond a card appearing in the grid.
 */
export function ContentCreationPanel({
  slug,
  hasRssFeedItems,
  contentSources,
  availableChannels,
  companyDefaultLang,
  contentMix,
}: Props) {
  const t = useTranslations("contentCreation");
  const [justGenerated, setJustGenerated] = useState<PostItem[]>([]);
  const [bulkCompleted, setBulkCompleted] = useState(false);

  /** Mirrors the old `handleGenerated`'s dedupe — the same post can be reported twice by a resumed topic poll. */
  function handleGenerated(posts: PostItem[]) {
    setJustGenerated((prev) => {
      const known = new Set(prev.map((p) => p.id));
      const fresh = posts.filter((p) => !known.has(p.id));
      return fresh.length > 0 ? [...prev, ...fresh] : prev;
    });
  }

  function handleBulkGenerated() {
    setBulkCompleted(true);
  }

  const hasResult = justGenerated.length > 0 || bulkCompleted;
  // Every newly generated post lands in `draft` — the same value the Posts
  // filter bar itself writes via `buildPostStatusQuery` — so this is the real
  // filter, not an invented query param.
  const postsHref = `/companies/${slug}/posts?status=draft`;

  return (
    <div className="space-y-4">
      <GeneratePostForm
        slug={slug}
        onGenerated={handleGenerated}
        onBulkGenerated={handleBulkGenerated}
        hasRssFeedItems={hasRssFeedItems}
        contentSources={contentSources}
        availableChannels={availableChannels}
        companyDefaultLang={companyDefaultLang}
        contentMix={contentMix}
      />

      {hasResult && (
        <Card className="px-5 py-4">
          <div className="flex items-start gap-3">
            <CheckCircle2
              className="text-status-success-fg mt-0.5 h-5 w-5 shrink-0"
              aria-hidden="true"
            />
            <div className="min-w-0 flex-1">
              <p className="text-fg text-sm font-semibold">{t("resultTitle")}</p>
              {justGenerated.length > 0 && (
                <ul className="text-fg-muted mt-1.5 space-y-1 text-xs">
                  {justGenerated.map((post) => (
                    <li key={post.id} className="truncate">
                      <span className="font-medium">{channelLabel(post.channel)}</span> —{" "}
                      {post.text.slice(0, 80)}
                      {post.text.length > 80 ? "…" : ""}
                    </li>
                  ))}
                </ul>
              )}
              <Link
                href={postsHref}
                className="text-accent hover:text-fg mt-2 inline-block text-sm font-medium transition-colors"
              >
                {t("viewPosts")} →
              </Link>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
