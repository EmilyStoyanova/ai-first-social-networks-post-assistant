import { getTranslations } from "next-intl/server";
import { CheckCircle2, Circle } from "lucide-react";
import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";

interface Props {
  slug: string;
  brandDescribed: boolean;
  bufferConnected: boolean;
  profilesSynced: boolean;
  hasEnabledChannel: boolean;
}

export async function SetupChecklist({
  slug,
  brandDescribed,
  bufferConnected,
  profilesSynced,
  hasEnabledChannel,
}: Props) {
  const t = await getTranslations("setupChecklist");
  const base = `/companies/${slug}?tab=settings`;

  const allRequiredDone = bufferConnected && profilesSynced && hasEnabledChannel;

  if (allRequiredDone) {
    return (
      <Card className="px-6 py-5">
        <p className="text-fg text-sm">{t("readyTitle")}</p>
        <div className="mt-3">
          <Button href={`/companies/${slug}?tab=posts`} size="sm">
            {t("generateFirst")}
          </Button>
        </div>
      </Card>
    );
  }

  const steps = [
    {
      label: t("item1Label"),
      hint: t("item1Hint"),
      href: `${base}#brand`,
      linkLabel: t("item1Link"),
      done: brandDescribed,
      required: false,
    },
    {
      label: t("item2Label"),
      hint: t("item2Hint"),
      href: `${base}#buffer`,
      linkLabel: t("item2Link"),
      done: bufferConnected,
      required: true,
    },
    {
      label: t("item3Label"),
      hint: t("item3Hint"),
      href: `${base}#channels`,
      linkLabel: t("item3Link"),
      done: profilesSynced,
      required: true,
    },
    {
      label: t("item4Label"),
      hint: t("item4Hint"),
      href: `${base}#channels`,
      linkLabel: t("item4Link"),
      done: hasEnabledChannel,
      required: true,
    },
  ];

  return (
    <Card className="px-6 py-5">
      <h2 className="text-fg mb-4 text-sm font-semibold">{t("title")}</h2>
      <ul className="space-y-4">
        {steps.map((step) => (
          <li key={step.label} className="flex gap-3">
            {step.done ? (
              <CheckCircle2 className="text-fg mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            ) : (
              <Circle className="text-fg-faint mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            )}
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span
                  className={`text-sm font-medium ${step.done ? "text-fg-muted line-through" : "text-fg"}`}
                >
                  {step.label}
                </span>
                <span className="text-micro text-fg-faint">
                  {step.required ? t("required") : t("recommended")}
                </span>
              </div>
              {!step.done && (
                <>
                  <p className="text-fg-faint mt-0.5 text-xs">{step.hint}</p>
                  <Link
                    href={step.href}
                    className="text-accent hover:text-fg mt-1 inline-block text-xs transition-colors"
                  >
                    {step.linkLabel} →
                  </Link>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
