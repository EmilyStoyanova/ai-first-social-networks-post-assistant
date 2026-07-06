import { getTranslations } from "next-intl/server";
import { Card } from "@/components/ui/Card";

interface Props {
  userCount: number;
  companyCount: number;
  adminCount: number;
}

export async function AdminOverview({ userCount, companyCount, adminCount }: Props) {
  const t = await getTranslations("admin");

  const stats = [
    { label: t("totalUsers"), value: userCount },
    { label: t("totalCompanies"), value: companyCount },
    { label: t("globalAdmins"), value: adminCount },
  ];

  return (
    <div className="grid gap-4 sm:grid-cols-3">
      {stats.map((s) => (
        <Card key={s.label} className="px-6 py-5">
          <p className="text-fg-faint text-xs font-semibold tracking-widest uppercase">{s.label}</p>
          <p className="text-fg mt-2 text-3xl font-bold tracking-tight">{s.value}</p>
        </Card>
      ))}
    </div>
  );
}
