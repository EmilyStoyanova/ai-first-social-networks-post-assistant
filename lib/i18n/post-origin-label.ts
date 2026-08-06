"use client";

import { useCallback } from "react";
import { useTranslations } from "next-intl";
import type { PostOriginView } from "@/lib/posts/post-origin";

/**
 * Renders a post's origin as one line: the KIND of source, then its name.
 *
 *   RSS · TechPowerUp
 *   Product Page · Apple
 *   Manual Prompt · Weekly tips
 *   Brand Setup
 *
 * The type always comes from the stored ContentSource type, never from reading
 * the name — "Apple" says nothing about whether it is a feed or a product page.
 *
 * Each half degrades independently, because they can be missing for different
 * reasons: a legacy post has a name from the relation but no frozen type, and a
 * post whose article vanished before the type migration has a name and no type.
 * Whatever survives is shown; only a source post with neither falls back to the
 * generic label.
 *
 * Shared by the post card and the activity modal so the two can never disagree
 * about how the same origin reads.
 */
export function usePostOriginLabel(): (origin: PostOriginView) => string {
  const t = useTranslations("posts.origin");

  return useCallback(
    (origin: PostOriginView) => {
      if (origin.kind === "brand_setup") return t("brandSetup");

      const type = origin.sourceType ? t(`types.${origin.sourceType}`) : null;
      const name = origin.sourceName;

      if (type && name) return `${type} · ${name}`;
      return type ?? name ?? t("sourceUnknown");
    },
    [t]
  );
}
