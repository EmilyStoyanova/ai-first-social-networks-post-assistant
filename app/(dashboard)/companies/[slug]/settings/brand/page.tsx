import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { auth } from "@/lib/auth";
import { getCompany } from "@/lib/services/company/get-company.service";
import { getBrandGuidelines } from "@/lib/services/company/get-brand-guidelines.service";
import { DashboardLayout } from "@/components/dashboard/dashboard-layout";
import { CompanyWorkspaceHeader } from "@/components/company/company-workspace-header";
import { BrandGuidelinesForm } from "@/components/company/brand-guidelines-form";
import { Section } from "@/components/ui/Section";

interface Props {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return { title: `Brand – ${slug} – AI-First Post Assistant` };
}

export default async function BrandSettingsPage({ params }: Props) {
  const session = await auth();
  if (!session) redirect("/login");

  const { slug } = await params;

  const company = await getCompany(slug, session.user.id, session.user.isGlobalAdmin);
  if (!company) notFound();

  const t = await getTranslations("companyPage");
  const brandGuidelines = await getBrandGuidelines(company.id);

  return (
    <DashboardLayout
      user={{
        name: session.user.name,
        email: session.user.email,
        isGlobalAdmin: session.user.isGlobalAdmin,
      }}
      activeCompany={{ slug: company.slug, name: company.name }}
    >
      <div>
        <CompanyWorkspaceHeader company={company} activeTab="brand" />

        <div className="mt-8 lg:max-w-[640px]">
          <Section id="brand" title={t("sections.brand")}>
            <BrandGuidelinesForm
              slug={slug}
              initialValues={brandGuidelines}
              initialAutomationMode={company.automationMode ?? "semi_automated"}
              initialDefaultLang={company.defaultLang === "bg" ? "bg" : "en"}
              role={company.role ?? null}
              isGlobalAdmin={false}
            />
          </Section>
        </div>
      </div>
    </DashboardLayout>
  );
}
