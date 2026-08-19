/**
 * Which content source a published post is credited to.
 *
 * Two facts on the row can answer this and they answer it at different times:
 *
 *   • `contentSourceId` — the live relation. Accurate while the source exists,
 *     and SetNull the moment somebody deletes it.
 *   • the origin snapshot (`originSourceName` and friends) — copied in at
 *     generation time and never updated, so it survives the deletion.
 *
 * Reading only the relation would make a year of history collapse into "Company
 * content" as soon as an owner tidies up their RSS list; reading only the
 * snapshot would miss nothing, but the relation is the one that follows a
 * rename. So: the live name first, the frozen one second — the same order
 * `resolvePostOrigin` already establishes for the rest of the product, and it is
 * reused here rather than restated.
 *
 * Keyed by source id where there is one and by name otherwise, so a live source
 * and its own orphaned historical posts land in ONE row rather than in two rows
 * carrying the same label.
 *
 * Pure, so both halves of the rule are testable without a database.
 */

import { resolvePostOrigin, toOriginSourceType } from "@/lib/posts/post-origin";
import type { PrimaryFeedItemRow } from "@/lib/posts/post-origin";

/** The columns and relations the attribution reads, exactly as the query selects them. */
export interface AttributableSourcePost {
  contentSourceId: string | null;
  /** The live source, when it still exists. */
  contentSource: { name: string } | null;
  originType: string | null;
  originSourceType: string | null;
  originSourceName: string | null;
  originSourceTitle: string | null;
  originSourceUrl: string | null;
  primaryFeedItem: PrimaryFeedItemRow | null;
}

export interface SourceAttribution {
  /** Stable grouping key. Never shown. */
  key: string;
  /** Null means the company's own brand/mission content, which has no source. */
  name: string | null;
}

export function attributeSource(post: AttributableSourcePost): SourceAttribution {
  // The live relation first, as the requirement states. It is also the only one
  // that follows a rename, so a source renamed yesterday labels its whole
  // history under the new name rather than splitting into old and new rows.
  const liveName = post.contentSource?.name;
  if (post.contentSourceId && liveName) {
    return { key: `id:${post.contentSourceId}`, name: liveName };
  }

  const origin = resolvePostOrigin(
    {
      originType:
        post.originType === "brand_setup" || post.originType === "content_source"
          ? post.originType
          : null,
      originSourceType: toOriginSourceType(post.originSourceType),
      originSourceName: post.originSourceName,
      originSourceTitle: post.originSourceTitle,
      originSourceUrl: post.originSourceUrl,
    },
    post.primaryFeedItem
  );

  // The frozen snapshot second: a post whose source was deleted keeps its own
  // history. A brand_setup post has no source by definition, and neither does a
  // source post whose name was never captured.
  if (origin.kind === "brand_setup" || !origin.sourceName) return { key: "company", name: null };

  return { key: `name:${origin.sourceName.toLowerCase()}`, name: origin.sourceName };
}
