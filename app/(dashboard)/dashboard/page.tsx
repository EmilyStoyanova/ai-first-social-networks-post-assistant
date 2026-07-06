import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { BarChart2, Image, Pencil, Settings } from "lucide-react";
import { auth } from "@/lib/auth";
import { DashboardLayout } from "@/components/dashboard/dashboard-layout";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Section } from "@/components/ui/Section";

export const metadata: Metadata = {
  title: "Dashboard – AI-First Post Assistant",
};

export default async function DashboardPage() {
  const session = await auth();

  if (!session) {
    redirect("/login");
  }

  const t = await getTranslations("dashboard");
  const tNav = await getTranslations("navigation");

  const { user } = session;
  const greeting = user?.name ? `, ${user.name}` : "";

  const COMING_SOON = [
    { icon: Pencil, label: tNav("posts") },
    { icon: Image, label: tNav("mediaGallery") },
    { icon: BarChart2, label: tNav("analytics") },
    { icon: Settings, label: tNav("settings") },
  ];

  return (
    <DashboardLayout
      user={{ name: user?.name, email: user?.email, isGlobalAdmin: user?.isGlobalAdmin }}
    >
      <div className="space-y-6">
        {/* Welcome card */}
        <Card className="px-8 py-10">
          <h1 className="text-fg text-2xl font-bold tracking-tight">
            {t("welcome", { greeting })}
          </h1>
          <p className="text-fg-muted mt-2 text-sm">{t("tagline")}</p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Button href="/companies" variant="primary">
              {t("goToCompanies")}
            </Button>
          </div>
        </Card>

        {/* Coming soon modules */}
        <Section title={t("comingSoon")}>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {COMING_SOON.map(({ icon: Icon, label }) => (
              <Card key={label} className="px-5 py-4">
                <Icon className="text-fg-faint h-5 w-5" aria-hidden />
                <p className="text-fg-muted mt-2 text-sm font-medium">{label}</p>
              </Card>
            ))}
          </div>
        </Section>
      </div>
    </DashboardLayout>
  );
}
