import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { auth } from "@/lib/auth";
import { getCompany } from "@/lib/services/company/get-company.service";
import { listMedia } from "@/lib/services/company/list-media.service";
import { DashboardLayout } from "@/components/dashboard/dashboard-layout";
import { CompanyWorkspaceHeader } from "@/components/company/company-workspace-header";
import { MediaGallery } from "@/components/company/media-gallery";

interface Props {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return { title: `Media – ${slug} – AI-First Post Assistant` };
}

function str(v: string | string[] | undefined): string | undefined {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v[0];
  return undefined;
}

function int(v: string | undefined, fallback: number): number {
  const n = parseInt(v ?? "", 10);
  return isNaN(n) ? fallback : n;
}

export default async function MediaGalleryPage({ params, searchParams }: Props) {
  const session = await auth();
  if (!session) redirect("/login");

  const [{ slug }, sp] = await Promise.all([params, searchParams]);

  const company = await getCompany(slug, session.user.id, session.user.isGlobalAdmin);
  if (!company) notFound();

  const tNav = await getTranslations("navigation");

  const channel = str(sp.channel);
  const provider = str(sp.provider);
  const sort = str(sp.sort) ?? "newest";
  const page = int(str(sp.page), 1);
  const pageSize = int(str(sp.pageSize), 24);

  const result = await listMedia(slug, session.user.id, session.user.isGlobalAdmin, {
    channel,
    provider,
    sort,
    page,
    pageSize,
  });

  const items = result.success ? result.items : [];
  const total = result.success ? result.total : 0;

  return (
    <DashboardLayout
      user={{
        name: session.user.name,
        email: session.user.email,
        isGlobalAdmin: session.user.isGlobalAdmin,
      }}
      breadcrumb={[{ label: tNav("companies"), href: "/companies" }, { label: company.name }]}
    >
      <div>
        <CompanyWorkspaceHeader company={company} activeTab="media" />

        <div className="mt-8">
          <MediaGallery
            slug={slug}
            items={items}
            total={total}
            page={page}
            pageSize={pageSize}
            channel={channel ?? ""}
            provider={provider ?? ""}
            sort={sort}
            canDelete={company.role === "OWNER" || session.user.isGlobalAdmin}
          />
        </div>
      </div>
    </DashboardLayout>
  );
}
