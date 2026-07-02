"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { AuditLogEntries } from "./audit-log-timeline";
import type { AuditLogItem } from "@/lib/services/audit/audit-log.service";

interface Props {
  postId: string;
  open: boolean;
  onClose: () => void;
}

export function PostActivityModal({ postId, open, onClose }: Props) {
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
        if (!res.ok) throw new Error("Failed to load activity.");
        const json = (await res.json()) as { logs: AuditLogItem[] };
        if (!cancelled) setLogs(json.logs ?? []);
      } catch (err: unknown) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load activity.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [open, postId]);

  return (
    <Modal open={open} onClose={onClose} title="Post Activity" maxWidth="md">
      {loading ? (
        <p className="py-8 text-center text-sm text-gray-400">Loading…</p>
      ) : error ? (
        <p className="py-8 text-center text-sm text-red-500">{error}</p>
      ) : (
        <AuditLogEntries logs={logs} />
      )}
    </Modal>
  );
}
