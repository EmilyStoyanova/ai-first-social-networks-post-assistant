import { Card } from "@/components/ui/Card";

interface Props {
  userCount: number;
  companyCount: number;
  adminCount: number;
}

export function AdminOverview({ userCount, companyCount, adminCount }: Props) {
  const stats = [
    { label: "Total Users", value: userCount },
    { label: "Total Companies", value: companyCount },
    { label: "Global Admins", value: adminCount },
  ];

  return (
    <div className="grid gap-4 sm:grid-cols-3">
      {stats.map((s) => (
        <Card key={s.label} className="px-6 py-5">
          <p className="text-xs font-semibold tracking-widest text-gray-400 uppercase">{s.label}</p>
          <p className="mt-2 text-3xl font-bold tracking-tight text-gray-900">{s.value}</p>
        </Card>
      ))}
    </div>
  );
}
