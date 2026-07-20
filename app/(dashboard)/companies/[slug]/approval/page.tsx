import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { auth } from "@/lib/auth";
import { getCompany } from "@/lib/services/company/get-company.service";
import { listPosts } from "@/lib/services/company/list-posts.service";
import { getBufferConnection } from "@/lib/services/buffer/get-buffer-connection.service";
import { DashboardLayout } from "@/components/dashboard/dashboard-layout";
import { CompanyWorkspaceHeader } from "@/components/company/company-workspace-header";
import { ApprovalQueueSection } from "@/components/company/approval-queue-section";

interface Props {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return { title: `Approval – ${slug} – AI-First Post Assistant` };
}

export default async function ApprovalQueuePage({ params }: Props) {
  const session = await auth();
  if (!session) redirect("/login");

  const { slug } = await params;

  const company = await getCompany(slug, session.user.id, session.user.isGlobalAdmin);
  if (!company) notFound();

  const tNav = await getTranslations("navigation");
  const canManage = company.role === "OWNER" || session.user.isGlobalAdmin;

  const [postsResult, bufferConnection] = await Promise.all([
    listPosts(slug, session.user.id, session.user.isGlobalAdmin, "pending_approval"),
    getBufferConnection(company.id),
  ]);

  const pendingPosts = postsResult.success ? postsResult.posts : [];

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
        <CompanyWorkspaceHeader
          company={company}
          activeTab="approval"
          stats={{ pendingApprovals: pendingPosts.length }}
        />

        <div className="mt-8">
          <ApprovalQueueSection
            slug={slug}
            initialPosts={pendingPosts}
            role={canManage ? "owner" : "editor"}
            bufferConnected={bufferConnection.connected}
          />
        </div>
      </div>
    </DashboardLayout>
  );
}
