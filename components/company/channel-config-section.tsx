"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations, useLocale } from "next-intl";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { ChannelConfigCard } from "./channel-config-card";
import type { ChannelConfigItem } from "@/lib/services/company/list-channel-configs.service";

interface Props {
  slug: string;
  initialConfigs: ChannelConfigItem[];
  canManage: boolean;
  bufferConnected: boolean;
  lastSyncedAt: string | null;
  companyAutomationMode: "semi_automated" | "fully_automated";
}

function formatSyncDate(isoString: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(isoString));
}

export function ChannelConfigSection({
  slug,
  initialConfigs,
  canManage,
  bufferConnected,
  lastSyncedAt,
  companyAutomationMode,
}: Props) {
  const t = useTranslations("channels");
  const locale = useLocale();
  const router = useRouter();
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);
  const [displayedSyncedAt, setDisplayedSyncedAt] = useState<string | null>(lastSyncedAt);

  async function handleSync() {
    setSyncing(true);
    setSyncMessage(null);
    try {
      const res = await fetch(`/api/v1/companies/${slug}/buffer/sync-profiles`, { method: "POST" });
      if (!res.ok) {
        setSyncMessage({ type: "error", text: t("syncError") });
      } else {
        const json = (await res.json()) as { data?: { lastSyncedAt?: string } };
        if (json.data?.lastSyncedAt) setDisplayedSyncedAt(json.data.lastSyncedAt);
        setSyncMessage({ type: "success", text: t("syncSuccess") });
        router.refresh();
      }
    } catch {
      setSyncMessage({ type: "error", text: t("syncError") });
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="space-y-4">
      {!bufferConnected && <Alert variant="warning">{t("connectBufferFirst")}</Alert>}
      {bufferConnected && (
        <>
          {initialConfigs.length === 0 && <Alert variant="info">{t("noProfiles")}</Alert>}
          {canManage && (
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-0.5">
                <p className="text-fg-muted text-small">{t("syncHelperText")}</p>
                <p className="text-fg-faint text-xs">
                  {displayedSyncedAt
                    ? t("lastSynced", { date: formatSyncDate(displayedSyncedAt, locale) })
                    : t("neverSynced")}
                </p>
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={handleSync}
                disabled={syncing}
                className="shrink-0"
              >
                {syncing ? t("syncing") : t("syncProfiles")}
              </Button>
            </div>
          )}
        </>
      )}
      {syncMessage && (
        <Alert variant={syncMessage.type === "success" ? "success" : "error"}>
          {syncMessage.text}
        </Alert>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        {initialConfigs.map((config) => (
          <ChannelConfigCard
            key={config.id}
            slug={slug}
            initialConfig={config}
            canManage={canManage}
            companyAutomationMode={companyAutomationMode}
          />
        ))}
      </div>
    </div>
  );
}
