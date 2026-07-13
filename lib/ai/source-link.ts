/**
 * Source-link resolution and application (v2-1).
 *
 * The source article URL is always appended programmatically by the service
 * layer — never left to the LLM. The URL is used verbatim: never shortened,
 * truncated, or otherwise modified.
 */

import type { FeedItemContext } from "./types";
import { selectPrimaryFeedItem } from "./primary-feed-item";

export type SourceLinkLevel = "manual" | "source" | "channel";

export interface ResolvedSourceLink {
  include: boolean;
  level: SourceLinkLevel;
}

/**
 * Three-level precedence: manual generation override → content source
 * preference → channel default. The first *defined* level wins, so an
 * explicit `false` at a higher level overrides `true` below it.
 */
export function resolveIncludeSourceLink(
  manualOverride: boolean | undefined,
  sourceConfig: boolean | undefined,
  channelDefault: boolean
): ResolvedSourceLink {
  if (manualOverride !== undefined) return { include: manualOverride, level: "manual" };
  if (sourceConfig !== undefined) return { include: sourceConfig, level: "source" };
  return { include: channelDefault, level: "channel" };
}

export type ApplySourceLinkResult =
  | { ok: true; content: string; appended: boolean }
  | { ok: false; reason: "POST_TOO_LONG_WITH_URL" };

/**
 * Applies the resolved source-link decision to the generated post text.
 *
 * - `include === true`: appends `sourceUrl` exactly once at the end (skipped
 *   when the content already contains it). If the result would exceed
 *   `maxTextLength`, fails with POST_TOO_LONG_WITH_URL — the URL is never
 *   truncated.
 * - `include === false`: ensures the known source URL is not present in the
 *   content. Other URLs (company website, CTA links) are left untouched.
 * - No valid `sourceUrl` (null/empty): content is returned unchanged.
 */
export function applySourceLink(
  content: string,
  sourceUrl: string | null,
  include: boolean,
  maxTextLength: number | null
): ApplySourceLinkResult {
  const url = sourceUrl?.trim();
  if (!url) return { ok: true, content, appended: false };

  if (!include) {
    return { ok: true, content: removeUrl(content, url), appended: false };
  }

  if (content.includes(url)) {
    return { ok: true, content, appended: false };
  }

  const separator = content.includes("\n") ? "\n\n" : " ";
  const candidate = `${content}${separator}${url}`;

  if (maxTextLength !== null && candidate.length > maxTextLength) {
    return { ok: false, reason: "POST_TOO_LONG_WITH_URL" };
  }

  return { ok: true, content: candidate, appended: true };
}

/**
 * Post-level source link resolution: selects the single primary feed item, then
 * derives the appended URL, the recorded title/id, and the source-link decision
 * from that SAME item. This is the single point that couples the primary source
 * to the appended URL — the generated post text (built around the same primary
 * item, see prompt-builder) and the URL can therefore never refer to different
 * articles.
 */
export interface PostSourceLink {
  finalContent: string;
  sourceUrl: string | null;
  primaryFeedItemId: string | null;
  sourceTitle: string | null;
  includeSourceLink: boolean;
  includeSourceLinkLevel: SourceLinkLevel;
}

export type ResolvePostSourceLinkResult =
  { ok: true; data: PostSourceLink } | { ok: false; reason: "POST_TOO_LONG_WITH_URL" };

export function resolvePostSourceLink(params: {
  feedItems: readonly FeedItemContext[];
  text: string;
  manualOverride: boolean | undefined;
  channelDefault: boolean;
  maxTextLength: number | null;
}): ResolvePostSourceLinkResult {
  const { feedItems, text, manualOverride, channelDefault, maxTextLength } = params;

  const primary = selectPrimaryFeedItem(feedItems);
  const sourceUrl = primary?.url ?? null;

  const { include, level } = resolveIncludeSourceLink(
    manualOverride,
    primary?.sourceLinkPreference,
    channelDefault
  );

  const applied = applySourceLink(text, sourceUrl, include, maxTextLength);
  if (!applied.ok) return { ok: false, reason: "POST_TOO_LONG_WITH_URL" };

  return {
    ok: true,
    data: {
      finalContent: applied.content,
      sourceUrl,
      primaryFeedItemId: primary?.id ?? null,
      sourceTitle: primary?.title ?? null,
      includeSourceLink: include,
      includeSourceLinkLevel: level,
    },
  };
}

/** Removes every occurrence of exactly `url`, collapsing leftover whitespace. */
function removeUrl(content: string, url: string): string {
  if (!content.includes(url)) return content;

  return content
    .split(url)
    .join(" ")
    .replace(/[^\S\n]{2,}/g, " ")
    .replace(/[^\S\n]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
