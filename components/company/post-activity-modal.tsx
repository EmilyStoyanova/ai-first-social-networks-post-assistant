"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Modal } from "@/components/ui/Modal";
import { AuditLogEntries } from "./audit-log-timeline";
import type { AuditLogItem } from "@/lib/services/audit/audit-log.service";

interface Props {
  postId: string;
  open: boolean;
  onClose: () => void;
}

export function PostActivityModal({ postId, open, onClose }: Props) {
  const t = useTranslations("postActivity");
  const tCommon = useTranslations("common");
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
