import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { auth } from "@/lib/auth";
import { getCompany } from "@/lib/services/company/get-company.service";
import { getBrandGuidelines } from "@/lib/services/company/get-brand-guidelines.service";
import { SettingsShell } from "@/components/company/settings-shell";
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
    <SettingsShell
      company={company}
      user={{
        name: session.user.name,
        email: session.user.email,
        isGlobalAdmin: session.user.isGlobalAdmin,
      }}
      active="brand"
    >
      <Section id="brand" title={t("sections.brand")}>
        <BrandGuidelinesForm
          slug={slug}
          initialValues={brandGuidelines}
          initialAutomationMode={company.automationMode ?? "semi_automated"}
          role={company.role ?? null}
          isGlobalAdmin={false}
        />
      </Section>
    </SettingsShell>
  );
}
