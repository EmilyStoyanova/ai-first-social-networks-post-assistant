"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Modal } from "@/components/ui/Modal";
import { AuditLogEntries } from "./audit-log-timeline";
import type { AuditLogItem } from "@/lib/services/audit/audit-log.service";
import { usePostOriginLabel } from "@/lib/i18n/post-origin-label";
import type { PostOriginView } from "@/lib/posts/post-origin";

interface Props {
  postId: string;
  /** Where the post was written from. Passed down from the card, never refetched. */
  origin: PostOriginView;
  open: boolean;
  onClose: () => void;
}

export function PostActivityModal({ postId, origin, open, onClose }: Props) {
  const t = useTranslations("postActivity");
  const tCommon = useTranslations("common");
  // Shared with the post card, so the badge and this row read identically.
  const originLabelFor = usePostOriginLabel();
  const [logs, setLogs] = useState<AuditLogItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;

    let cancelled = false;

    async function load() {
      setLoading(true);
      setError("");
      try {
        const res = await fetch(`/api/v1/posts/${postId}/audit-logs`);
        if (cancelled) return;
        if (!res.ok) throw new Error(tCommon("somethingWentWrong"));
        const json = (await res.json()) as { logs: AuditLogItem[] };
        if (!cancelled) setLogs(json.logs ?? []);
      } catch (err: unknown) {
        if (!cancelled)
          setError(err instanceof Error ? err.message : tCommon("somethingWentWrong"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [open, postId, tCommon]);

  return (
    <Modal open={open} onClose={onClose} title={t("title")} maxWidth="md">
      {/* Origin sits above the timeline: it is the one fact about the post that
          predates every entry below it. Rendered from props, so it is there
          immediately rather than after the audit-log fetch resolves. */}
      <dl className="border-border mb-5 grid gap-2 border-b pb-5 text-sm">
        <div className="flex gap-3">
          <dt className="text-fg-muted w-32 shrink-0">{t("origin.label")}</dt>
          <dd className="text-fg font-medium">{originLabelFor(origin)}</dd>
        </div>

        {origin.kind === "source" && (
          <div className="flex gap-3">
            <dt className="text-fg-muted w-32 shrink-0">{t("origin.article")}</dt>
            <dd className="text-fg min-w-0">
              {/* The URL is what identifies the article; the headline is a label
                  for it and may be missing on a feed that ships none. */}
              {origin.articleUrl ? (
                <a
                  href={origin.articleUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-accent break-words underline underline-offset-2"
                >
                  {origin.articleTitle ?? origin.articleUrl}
                </a>
              ) : (
                (origin.articleTitle ?? t("origin.articleUnknown"))
              )}
            </dd>
          </div>
        )}

        {origin.kind === "brand_setup" && (
          <p className="text-fg-faint text-xs">{t("origin.brandSetupHint")}</p>
        )}
      </dl>

      {loading ? (
        <p className="text-fg-faint py-8 text-center text-sm">{t("loading")}</p>
      ) : error ? (
        <p className="text-status-danger-dot py-8 text-center text-sm">{error}</p>
      ) : (
        <AuditLogEntries logs={logs} />
      )}
    </Modal>
  );
}
