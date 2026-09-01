import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { auth } from "@/lib/auth";
import { getCompany } from "@/lib/services/company/get-company.service";
import { getBufferConnection } from "@/lib/services/buffer/get-buffer-connection.service";
import { getAnalyticsKeyStatus } from "@/lib/services/analytics/manage-analytics-key.service";
import {
  getPostMetricsForPosts,
  type PostMetricsView,
} from "@/lib/services/analytics/get-post-metrics.service";
import { listPosts } from "@/lib/services/company/list-posts.service";
import { resolvePostStatusFilter } from "@/lib/posts/post-status-filter";
import { DashboardLayout } from "@/components/dashboard/dashboard-layout";
import { CompanyWorkspaceHeader } from "@/components/company/company-workspace-header";
import { GeneratedPostsSection } from "@/components/company/generated-posts-section";

interface Props {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return { title: `Posts – ${slug} – AI-First Post Assistant` };
}

export default async function CompanyPostsPage({ params, searchParams }: Props) {
  const session = await auth();
  if (!session) redirect("/login");

  const [{ slug }, sp] = await Promise.all([params, searchParams]);

  const company = await getCompany(slug, session.user.id, session.user.isGlobalAdmin);
  if (!company) notFound();

  const tNav = await getTranslations("navigation");
  const canManage = company.role === "OWNER" || session.user.isGlobalAdmin;
  const canDelete = canManage;

  const [postsData, bufferConnection] = await Promise.all([
    listPosts(slug, session.user.id, session.user.isGlobalAdmin),
    getBufferConnection(company.id),
  ]);

  const analyticsStatus = await getAnalyticsKeyStatus(
    slug,
    session.user.id,
    session.user.isGlobalAdmin
  );
  // An editor gets FORBIDDEN from the key-status service (it is owner-scoped),
  // which must not hide metrics from them — only the ability to manage the key.
  // Treat an unreadable status as "not configured" and let the cards say so.
  const analyticsEnabled = analyticsStatus.success && analyticsStatus.data.configured;

  const postMetrics: Map<string, PostMetricsView> = await getPostMetricsForPosts(
    company.id,
    postsData?.success ? postsData.posts.map((p) => p.id) : [],
    analyticsEnabled
  );

  const initialPosts = postsData?.success ? postsData.posts : [];

  return (
    <DashboardLayout
      user={{
        name: session.user.name,
        email: session.user.email,
        isGlobalAdmin: session.user.isGlobalAdmin,
      }}
      activeCompany={{ slug: company.slug, name: company.name }}
      breadcrumb={[{ label: tNav("companies"), href: "/companies" }, { label: company.name }]}
    >
      <div>
        <CompanyWorkspaceHeader company={company} activeTab="posts" />

        <div className="mt-8">
          <GeneratedPostsSection
            postMetrics={Object.fromEntries(postMetrics)}
            canManageAnalyticsKey={canManage}
            // Parsed here so the first paint already honours a shared link;
            // an unrecognized value falls back to "all" rather than an empty grid.
            initialStatusFilter={resolvePostStatusFilter(sp.status)}
            slug={slug}
            initialPosts={initialPosts}
            canDelete={canDelete}
            role={canManage ? "owner" : "editor"}
            bufferConnected={bufferConnection.connected}
            isGlobalAdmin={session.user.isGlobalAdmin}
          />
        </div>
      </div>
    </DashboardLayout>
  );
}
