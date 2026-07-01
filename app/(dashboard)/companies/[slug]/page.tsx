import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getCompany } from "@/lib/services/company/get-company.service";
import { getBrandGuidelines } from "@/lib/services/company/get-brand-guidelines.service";
import { DashboardLayout } from "@/components/dashboard/dashboard-layout";
import { CompanyHeader } from "@/components/company/company-header";
import { CompanyOverview } from "@/components/company/company-overview";
import { CompanySectionCard } from "@/components/company/company-section-card";
import { BrandGuidelinesForm } from "@/components/company/brand-guidelines-form";
import { Section } from "@/components/ui/Section";

interface Props {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return { title: `${slug} – AI-First Post Assistant` };
}

const UPCOMING_MODULES = [
  {
    icon: "📡",
    title: "Channels",
    description:
      "Set up and manage your social media channels across Facebook, LinkedIn, Instagram, and TikTok.",
  },
  {
    icon: "👥",
    title: "Members",
    description: "Invite team members and manage their roles for this company.",
  },
  {
    icon: "✍️",
    title: "Posts",
    description: "Create, schedule, and manage posts across all configured channels.",
  },
  {
    icon: "🖼️",
    title: "Media Gallery",
    description: "Upload and organize media assets for use in your social content.",
  },
  {
    icon: "📊",
    title: "Analytics",
    description: "Track engagement and performance across all social media channels.",
  },
] as const;

export default async function CompanyPage({ params }: Props) {
  const session = await auth();
  if (!session) redirect("/login");

  const { slug } = await params;

  const company = await getCompany(slug, session.user.id, session.user.isGlobalAdmin);
  if (!company) notFound();

  const brandGuidelines = await getBrandGuidelines(company.id);

  return (
    <DashboardLayout
      user={{ name: session.user.name, email: session.user.email }}
      breadcrumb={[{ label: "Companies", href: "/companies" }, { label: company.name }]}
    >
      <div className="space-y-8">
        <CompanyHeader company={company} />
        <CompanyOverview company={company} />

        <Section title="Brand">
          <BrandGuidelinesForm
            slug={slug}
            initialValues={brandGuidelines}
            role={company.role}
            isGlobalAdmin={session.user.isGlobalAdmin}
          />
        </Section>

        <Section title="Modules">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {UPCOMING_MODULES.map((mod) => (
              <CompanySectionCard
                key={mod.title}
                icon={mod.icon}
                title={mod.title}
                description={mod.description}
              />
            ))}
          </div>
        </Section>
      </div>
    </DashboardLayout>
  );
}
