import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getCompany } from "@/lib/services/company/get-company.service";
import { listPosts } from "@/lib/services/company/list-posts.service";
import { getBufferConnection } from "@/lib/services/buffer/get-buffer-connection.service";
import { DashboardLayout } from "@/components/dashboard/dashboard-layout";
import { PageHeader } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
import { ApprovalQueueSection } from "@/components/company/approval-queue-section";

interface Props {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return { title: `Approval Queue – ${slug} – AI-First Post Assistant` };
}

export default async function ApprovalQueuePage({ params }: Props) {
  const session = await auth();
  if (!session) redirect("/login");

  const { slug } = await params;

  const company = await getCompany(slug, session.user.id, session.user.isGlobalAdmin);
  if (!company) notFound();

  const [postsResult, bufferConnection] = await Promise.all([
    listPosts(slug, session.user.id, session.user.isGlobalAdmin, "pending_approval"),
    getBufferConnection(company.id),
  ]);

  const pendingPosts = postsResult.success ? postsResult.posts : [];
  const canManage = company.role === "OWNER" || session.user.isGlobalAdmin;

  return (
    <DashboardLayout
      user={{
        name: session.user.name,
        email: session.user.email,
        isGlobalAdmin: session.user.isGlobalAdmin,
      }}
      breadcrumb={[
        { label: "Companies", href: "/companies" },
        { label: company.name, href: `/companies/${slug}` },
        { label: "Approval Queue" },
      ]}
    >
      <div className="space-y-6">
        <PageHeader
          title="Approval Queue"
          description={`${pendingPosts.length} post${pendingPosts.length === 1 ? "" : "s"} pending approval`}
          actions={
            <Button href={`/companies/${slug}`} variant="secondary" size="sm">
              ← Back to Company
            </Button>
          }
        />

        <ApprovalQueueSection
          slug={slug}
          initialPosts={pendingPosts}
          canApprove={canManage}
          canPublish={canManage}
          bufferConnected={bufferConnection.connected}
        />
      </div>
    </DashboardLayout>
  );
}
