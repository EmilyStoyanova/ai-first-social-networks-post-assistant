import Link from "next/link";
import { useTranslations } from "next-intl";
import type { LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";

interface Props {
  icon: LucideIcon;
  title: string;
  description: string;
  href?: string;
}

export function CompanySectionCard({ icon: Icon, title, description, href }: Props) {
  const t = useTranslations("dashboard");
  const inner = (
    <Card variant="hover" className="px-6 py-5">
      <div className="mb-3 flex items-center justify-between gap-4">
        <Icon className="text-fg-faint h-5 w-5" aria-hidden />
        {!href && <Badge variant="comingSoon">{t("comingSoon")}</Badge>}
      </div>
      <h3 className="text-fg text-sm font-semibold">{title}</h3>
      <p className="text-fg-muted mt-1 text-sm leading-relaxed">{description}</p>
    </Card>
  );

  if (href) {
    return <Link href={href}>{inner}</Link>;
  }

  return inner;
}
