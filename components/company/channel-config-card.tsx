"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useApiErrorMessage } from "@/lib/i18n/api-error";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ChannelConfigForm } from "./channel-config-form";
import type { ChannelConfigItem } from "@/lib/services/company/list-channel-configs.service";
import type { ChannelFormPayload } from "./channel-config-form";

interface Props {
  slug: string;
  initialConfig: ChannelConfigItem;
  canManage: boolean;
  companyAutomationMode: "semi_automated" | "fully_automated";
}

interface ChannelMeta {
  label: string;
  containerClass: string;
  containerStyle?: React.CSSProperties;
  icon: React.ReactNode;
}

const CHANNEL_META: Record<string, ChannelMeta> = {
  facebook: {
    label: "Facebook",
    containerClass: "bg-[#1877F2] text-white",
    icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" className="h-[18px] w-[18px]">
        <path d="M9.198 21.5h4v-8.01h3.604l.396-3.98h-4V7.5a1 1 0 0 1 1-1h3v-4h-3a5 5 0 0 0-5 5v2.01h-2l-.396 3.98h2.396v8.01z" />
      </svg>
    ),
  },
  linkedin: {
    label: "LinkedIn",
    containerClass: "bg-[#0A66C2] text-white",
    icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" className="h-[18px] w-[18px]">
        <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452z" />
      </svg>
    ),
  },
  instagram: {
    label: "Instagram",
    containerClass: "text-white",
    containerStyle: {
      background:
        "radial-gradient(circle at 30% 107%, #fdf497 0%, #fdf497 5%, #fd5949 45%, #d6249f 60%, #285AEB 90%)",
    },
    icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" className="h-[18px] w-[18px]">
        <path d="M8 3C5.239 3 3 5.239 3 8v8c0 2.761 2.239 5 5 5h8c2.761 0 5-2.239 5-5V8c0-2.761-2.239-5-5-5H8zm0 1.5h8A3.5 3.5 0 0 1 19.5 8v8a3.5 3.5 0 0 1-3.5 3.5H8A3.5 3.5 0 0 1 4.5 16V8A3.5 3.5 0 0 1 8 4.5zM12 7.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zm0 1.5a3 3 0 1 1 0 6 3 3 0 0 1 0-6zm4.75-2.25a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5z" />
      </svg>
    ),
  },
  tiktok: {
    label: "TikTok",
    containerClass: "bg-black text-white",
    icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" className="h-[18px] w-[18px]">
        <path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-2.88 2.5 2.89 2.89 0 0 1-2.89-2.89 2.89 2.89 0 0 1 2.89-2.89c.28 0 .54.04.79.1V9.01a6.33 6.33 0 0 0-.79-.05 6.34 6.34 0 0 0-6.34 6.34 6.34 6.34 0 0 0 6.34 6.34 6.34 6.34 0 0 0 6.33-6.34V8.67a8.25 8.25 0 0 0 4.82 1.54V6.75a4.85 4.85 0 0 1-1.05-.06z" />
      </svg>
    ),
  },
};

export function ChannelConfigCard({
  slug,
  initialConfig,
  canManage,
  companyAutomationMode,
}: Props) {
  const t = useTranslations("channels");
  const tCommon = useTranslations("common");
  const apiError = useApiErrorMessage();
  const [config, setConfig] = useState(initialConfig);
  const [isEditing, setIsEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  const AUTOMATION_LABELS: Record<string, string> = {
    semi_automated: t("semiAutomated"),
    fully_automated: t("fullyAutomated"),
  };

  const meta = CHANNEL_META[config.channel] ?? {
    label: config.channel,
    containerClass: "bg-fg-muted text-bg",
    icon: <span className="text-xs font-bold">?</span>,
  };

  // Card title is the Buffer profile name (e.g. "FBN Bulgaria"); platform is secondary.
  const cardTitle = config.bufferProfileName ?? meta.label;

  async function handleSave(data: ChannelFormPayload) {
    setSaving(true);
    setErrorMessage("");

    try {
      const res = await fetch(`/api/v1/companies/${slug}/channels/${config.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: data.enabled,
          postsPerDay: data.postsPerDay,
          postsPerWeek: data.postsPerWeek,
          language: data.language,
          imageRequired: data.imageRequired,
          includeSourceLink: data.includeSourceLink,
          automationModeOverride: data.automationModeOverride,
          postingWindows: data.postingWindows,
        }),
      });

      if (!res.ok) {
        const json = (await res.json()) as { error?: { message?: string } };
        throw new Error(apiError(json.error, t("saveError")));
      }

      const json = (await res.json()) as { channel: ChannelConfigItem };
      setConfig(json.channel);
      setIsEditing(false);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : tCommon("somethingWentWrong"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="px-5 py-5">
      {/* Header — always visible */}
      <div className="mb-4 flex items-center gap-3">
        <span
          className={`rounded-control flex h-8 w-8 shrink-0 items-center justify-center ${meta.containerClass}`}
          style={meta.containerStyle}
          aria-hidden="true"
        >
          {meta.icon}
        </span>
        <div className="flex min-w-0 flex-1 items-center justify-between gap-2">
          <div className="min-w-0">
            <h3 className="text-fg truncate text-sm font-semibold">{cardTitle}</h3>
            {config.bufferProfileName && <p className="text-fg-faint text-xs">{meta.label}</p>}
          </div>
          <Badge variant={config.enabled ? "success" : "neutral"} className="shrink-0">
            {config.enabled ? t("enabled") : t("disabled")}
          </Badge>
        </div>
      </div>

      {errorMessage && (
        <Alert variant="error" className="mb-4">
          {errorMessage}
        </Alert>
      )}

      {isEditing ? (
        <ChannelConfigForm
          initialConfig={config}
          saving={saving}
          onSave={handleSave}
          onCancel={() => {
            setIsEditing(false);
            setErrorMessage("");
          }}
          companyAutomationMode={companyAutomationMode}
        />
      ) : (
        <>
          {/* Summary */}
          <dl className="mb-4 space-y-1.5 text-sm">
            <div className="flex items-center justify-between">
              <dt className="text-fg-muted">{t("language")}</dt>
              <dd className="text-fg font-medium">{config.postingLanguage.toUpperCase()}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-fg-muted">{t("postsPerDay")}</dt>
              <dd className="text-fg font-medium">{config.postsPerDay}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-fg-muted">{t("postsPerWeek")}</dt>
              <dd className="text-fg font-medium">{config.postsPerWeek}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-fg-muted">{t("imageRequired")}</dt>
              <dd className="text-fg font-medium">{config.imageRequired ? t("yes") : t("no")}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-fg-muted">{t("includeSourceLink")}</dt>
              <dd className="text-fg font-medium">
                {config.includeSourceLink ? t("yes") : t("no")}
              </dd>
            </div>
            <div className="flex items-start justify-between">
              <dt className="text-fg-muted">{t("automation")}</dt>
              <dd className="text-fg text-right font-medium">
                {config.automationModeOverride ? (
                  (AUTOMATION_LABELS[config.automationModeOverride] ??
                  config.automationModeOverride)
                ) : (
                  <>
                    {t("companyDefault")}
                    <span className="text-fg-faint mt-0.5 block text-xs font-normal">
                      {AUTOMATION_LABELS[companyAutomationMode]}
                    </span>
                  </>
                )}
              </dd>
            </div>
          </dl>

          {canManage ? (
            <Button variant="secondary" size="sm" onClick={() => setIsEditing(true)}>
              {tCommon("edit")}
            </Button>
          ) : (
            <p className="text-fg-faint text-xs">{t("ownersOnly")}</p>
          )}
        </>
      )}
    </Card>
  );
}
