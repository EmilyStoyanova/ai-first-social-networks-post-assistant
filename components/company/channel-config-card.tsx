"use client";

import { useState } from "react";
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
}

const CHANNEL_META: Record<string, { label: string; bg: string; text: string; abbr: string }> = {
  facebook: { label: "Facebook", bg: "bg-blue-600", text: "text-white", abbr: "f" },
  linkedin: { label: "LinkedIn", bg: "bg-sky-700", text: "text-white", abbr: "in" },
  instagram: { label: "Instagram", bg: "bg-pink-600", text: "text-white", abbr: "ig" },
  tiktok: { label: "TikTok", bg: "bg-gray-900", text: "text-white", abbr: "tt" },
};

const AUTOMATION_LABELS: Record<string, string> = {
  semi_automated: "Semi-automated",
  fully_automated: "Fully automated",
};

export function ChannelConfigCard({ slug, initialConfig, canManage }: Props) {
  const [config, setConfig] = useState(initialConfig);
  const [isEditing, setIsEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  const meta = CHANNEL_META[config.channel] ?? {
    label: config.channel,
    bg: "bg-gray-400",
    text: "text-white",
    abbr: "?",
  };

  async function handleSave(data: ChannelFormPayload) {
    setSaving(true);
    setErrorMessage("");

    try {
      const res = await fetch(`/api/v1/companies/${slug}/channels/${config.channel}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: data.enabled,
          bufferProfileId: data.bufferProfileId,
          postsPerDay: data.postsPerDay,
          postsPerWeek: data.postsPerWeek,
          language: data.language,
          imageRequired: data.imageRequired,
          automationModeOverride: data.automationModeOverride,
          postingWindows: data.postingWindows,
        }),
      });

      if (!res.ok) {
        const json = (await res.json()) as { error?: { message?: string } };
        throw new Error(json.error?.message ?? "Failed to save.");
      }

      const json = (await res.json()) as { channel: ChannelConfigItem };
      setConfig(json.channel);
      setIsEditing(false);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="px-5 py-5">
      {/* Header — always visible */}
      <div className="mb-4 flex items-center gap-3">
        <span
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-xs font-bold ${meta.bg} ${meta.text}`}
          aria-hidden="true"
        >
          {meta.abbr}
        </span>
        <div className="flex flex-1 items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-gray-900">{meta.label}</h3>
          <Badge variant={config.enabled ? "success" : "neutral"}>
            {config.enabled ? "Enabled" : "Disabled"}
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
        />
      ) : (
        <>
          {/* Summary */}
          <dl className="mb-4 space-y-1.5 text-sm">
            <div className="flex items-center justify-between">
              <dt className="text-gray-500">Language</dt>
              <dd className="font-medium text-gray-900">{config.postingLanguage.toUpperCase()}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-gray-500">Posts / day</dt>
              <dd className="font-medium text-gray-900">{config.postsPerDay}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-gray-500">Posts / week</dt>
              <dd className="font-medium text-gray-900">{config.postsPerWeek}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-gray-500">Image required</dt>
              <dd className="font-medium text-gray-900">{config.imageRequired ? "Yes" : "No"}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-gray-500">Automation</dt>
              <dd className="font-medium text-gray-900">
                {config.automationModeOverride
                  ? (AUTOMATION_LABELS[config.automationModeOverride] ??
                    config.automationModeOverride)
                  : "Company default"}
              </dd>
            </div>
            {config.bufferProfileId && (
              <div className="flex items-center justify-between">
                <dt className="text-gray-500">Buffer Profile ID</dt>
                <dd className="truncate font-medium text-gray-900">{config.bufferProfileId}</dd>
              </div>
            )}
          </dl>

          {canManage ? (
            <Button variant="secondary" size="sm" onClick={() => setIsEditing(true)}>
              Edit
            </Button>
          ) : (
            <p className="text-xs text-gray-400">Only company owners can edit channel settings.</p>
          )}
        </>
      )}
    </Card>
  );
}
