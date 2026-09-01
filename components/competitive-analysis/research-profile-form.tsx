"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useApiErrorMessage } from "@/lib/i18n/api-error";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Select } from "@/components/ui/Select";
import { TagInput } from "@/components/ui/TagInput";
import { ANALYSIS_PERIOD_DAYS } from "@/lib/validators/research-profile.schema";
import type { ResearchProfileDTO } from "@/lib/services/competitive-analysis/get-research-profile-or-defaults.service";

interface Props {
  slug: string;
  initialProfile: ResearchProfileDTO;
  isOwner: boolean;
}

const MAX_TOPICS = 50;

function normalize(raw: string): string {
  return raw.trim();
}

export function ResearchProfileForm({ slug, initialProfile, isOwner }: Props) {
  const t = useTranslations("competitiveAnalysis.researchProfile");
  const tCommon = useTranslations("common");
  const apiError = useApiErrorMessage();

  const [profile, setProfile] = useState(initialProfile);
  const [researchTopics, setResearchTopics] = useState(initialProfile.researchTopics);
  const [markets, setMarkets] = useState(initialProfile.markets);
  const [analysisPeriodDays, setAnalysisPeriodDays] = useState(initialProfile.analysisPeriodDays);
  const [status, setStatus] = useState<"idle" | "saving" | "success" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState("");

  const disabled = !isOwner || status === "saving";

  function validateTopic(candidate: string): string | null {
    if (!candidate) return t("errors.empty");
    if (candidate.length > 200) return t("errors.tooLong");
    return null;
  }

  function limitedValidate(values: string[]) {
    return (candidate: string): string | null => {
      const base = validateTopic(candidate);
      if (base) return base;
      if (values.length >= MAX_TOPICS) return t("errors.limitReached", { max: MAX_TOPICS });
      if (values.some((v) => v.toLowerCase() === candidate.toLowerCase())) {
        return t("errors.duplicate");
      }
      return null;
    };
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("saving");
    try {
      const res = await fetch(`/api/v1/companies/${slug}/competitive-analysis/research-profile`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ researchTopics, markets, analysisPeriodDays }),
      });
      if (!res.ok) {
        const json = (await res.json()) as { error?: { message?: string } };
        throw new Error(apiError(json.error));
      }
      const json = (await res.json()) as { profile: ResearchProfileDTO };
      setProfile(json.profile);
      setStatus("success");
    } catch (err) {
      setStatus("error");
      setErrorMessage(err instanceof Error ? err.message : tCommon("somethingWentWrong"));
    }
  }

  return (
    <Card className="px-6 py-6">
      <div className="mb-5 flex items-center justify-between">
        <h2 className="text-fg text-sm font-semibold">{t("title")}</h2>
        {!isOwner && <Badge variant="neutral">{tCommon("readOnly")}</Badge>}
      </div>

      {!profile.persisted && (
        <Alert variant="info" className="mb-5">
          {t("usingDefaults")}
        </Alert>
      )}
      {status === "success" && (
        <Alert variant="success" className="mb-5">
          {t("savedSuccess")}
        </Alert>
      )}
      {status === "error" && (
        <Alert variant="error" className="mb-5">
          {errorMessage}
        </Alert>
      )}

      <form onSubmit={handleSubmit} noValidate>
        <div className="mb-5">
          <TagInput
            id="rp-topics"
            label={t("topics")}
            hint={t("topicsHint")}
            values={researchTopics}
            onChange={(next) => {
              setResearchTopics(next);
              if (status !== "idle") setStatus("idle");
            }}
            placeholder={t("topicsPlaceholder")}
            disabled={disabled}
            validate={limitedValidate(researchTopics)}
            normalize={normalize}
            addLabel={t("add")}
            removeLabel={(topic) => t("remove", { topic })}
            emptyText={t("emptyTopics")}
          />
        </div>

        <div className="mb-5">
          <TagInput
            id="rp-markets"
            label={t("markets")}
            hint={t("marketsHint")}
            values={markets}
            onChange={(next) => {
              setMarkets(next);
              if (status !== "idle") setStatus("idle");
            }}
            placeholder={t("marketsPlaceholder")}
            disabled={disabled}
            validate={limitedValidate(markets)}
            normalize={normalize}
            addLabel={t("add")}
            removeLabel={(market) => t("remove", { topic: market })}
            emptyText={t("emptyMarkets")}
          />
        </div>

        <div className="mb-6 max-w-xs">
          <Select
            id="rp-period"
            label={t("period")}
            value={String(analysisPeriodDays)}
            onChange={(e) => {
              setAnalysisPeriodDays(Number(e.target.value) as 30 | 90 | 180);
              if (status !== "idle") setStatus("idle");
            }}
            disabled={disabled}
            helperText={t("periodHelp")}
          >
            {ANALYSIS_PERIOD_DAYS.map((days) => (
              <option key={days} value={days}>
                {t("periodDays", { days })}
              </option>
            ))}
          </Select>
        </div>

        {isOwner && (
          <Button type="submit" variant="primary" disabled={status === "saving"}>
            {status === "saving" ? tCommon("saving") : tCommon("save")}
          </Button>
        )}
      </form>
    </Card>
  );
}
