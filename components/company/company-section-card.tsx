import Link from "next/link";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";

interface Props {
  icon: string;
  title: string;
  description: string;
  href?: string;
}

export function CompanySectionCard({ icon, title, description, href }: Props) {
  const t = useTranslations("dashboard");
  const inner = (
    <Card variant="hover" className="px-6 py-5">
      <div className="mb-3 flex items-center justify-between gap-4">
        <span className="text-2xl leading-none" aria-hidden="true">
          {icon}
        </span>
        {!href && <Badge variant="comingSoon">{t("comingSoon")}</Badge>}
      </div>
      <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
      <p className="mt-1 text-sm leading-relaxed text-gray-500">{description}</p>
    </Card>
  );

  if (href) {
    return <Link href={href}>{inner}</Link>;
  }

  return inner;
}
