import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { getDashboardData } from "@/lib/services/dashboard/get-dashboard-data.service";
import {
  getSetupStatuses,
  isSetupComplete,
} from "@/lib/services/dashboard/get-setup-statuses.service";
import { getUserLlmSettings } from "@/lib/services/user/get-user-llm-settings.service";
import { pendingApprovalsHref } from "@/lib/posts/post-status-filter";
import { DashboardLayout } from "@/components/dashboard/dashboard-layout";
import { LlmPreferenceCard } from "@/components/user/llm-preference-card";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";

export const metadata: Metadata = {
  title: "Dashboard – AI-First Post Assistant",
};

const ACTION_LABELS: Record<string, string> = {
  POST_GENERATED: "Post generated",
  POST_SUBMITTED: "Submitted for approval",
  POST_APPROVED: "Post approved",
  POST_REJECTED: "Post rejected",
  POST_EDITED: "Post edited",
  POST_VERSION_RESTORED: "Version restored",
  POST_PUBLISHED: "Published to Buffer",
  POST_PUBLISH_FAILED: "Publish failed",
  POST_PUBLISH_SKIPPED: "Publish skipped",
  POST_RESCHEDULED: "Post rescheduled",
  POST_BULK_GENERATED: "Bulk generation",
  MEDIA_ATTACHED: "Media attached",
};

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  const h = Math.floor(diff / 3_600_000);
  const d = Math.floor(diff / 86_400_000);
  if (m < 2) return "just now";
  if (m < 60) return `${m}m ago`;
  if (h < 24) return `${h}h ago`;
  if (d === 1) return "yesterday";
  return `${d}d ago`;
}

export default async function DashboardPage() {
  const session = await auth();
  if (!session) redirect("/login");

  const t = await getTranslations("dashboard");
  const { user } = session;
  const firstName = user?.name?.split(" ")[0] ?? null;
  const greeting = firstName ? `, ${firstName}` : "";

  const { companies, totalPending, totalDrafts, recentActivity } = await getDashboardData(
    user.id,
    user.isGlobalAdmin
  );

  // Personal preferred-LLM control — only shown when admins have configured at
  // least one active model to choose from.
  const llmSettings = await getUserLlmSettings(user.id);

  const setupStatuses =
    companies.length > 0 ? await getSetupStatuses(companies.map((c) => c.id)) : new Map();

  const companiesNeedingSetup = companies.filter(
    (c) =>
      !isSetupComplete(
        setupStatuses.get(c.id) ?? {
          bufferConnected: false,
          profilesSynced: false,
          hasEnabledChannel: false,
          brandDescribed: false,
        }
      )
  );

  const withPending = companies.filter((c) => c.pendingCount > 0);

  return (
    <DashboardLayout
      user={{ name: user?.name, email: user?.email, isGlobalAdmin: user?.isGlobalAdmin }}
    >
      <div className="space-y-8">
        {/* Header */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-display text-fg">{t("welcome", { greeting })}</h1>
            <p className="text-body text-fg-muted mt-1">{t("tagline")}</p>
          </div>
          <Button href="/companies/new" variant="primary" className="shrink-0">
            {t("quickActions.newCompany")}
          </Button>
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-3 gap-3 sm:gap-4">
          {[
            { value: companies.length, label: t("stats.companies") },
            { value: totalPending, label: t("stats.pendingApprovals") },
            { value: totalDrafts, label: t("stats.drafts") },
          ].map(({ value, label }) => (
            <Card key={label} className="px-3 py-3 sm:px-5 sm:py-4">
              <p className="text-fg text-xl font-bold tabular-nums sm:text-2xl">{value}</p>
              <p className="text-micro text-fg-faint mt-1">{label}</p>
            </Card>
          ))}
        </div>

        {/* Personal AI-model preference */}
        {llmSettings.llms.length > 0 && (
          <LlmPreferenceCard
            llms={llmSettings.llms}
            preferredLlmConfigId={llmSettings.preferredLlmConfigId}
          />
        )}

        {companies.length === 0 ? (
          /* First-run onboarding card */
          <Card className="px-8 py-14 text-center">
            <p className="text-title text-fg">{t("onboarding.title")}</p>
            <p className="text-body text-fg-muted mx-auto mt-2 max-w-sm">
              {t("onboarding.description")}
            </p>
            <div className="mt-6 flex justify-center">
              <Button href="/companies/new" size="lg">
                {t("onboarding.createCompany")}
              </Button>
            </div>
          </Card>
        ) : (
          <>
            {/* Setup needed */}
            {companiesNeedingSetup.length > 0 && (
              <div>
                <h2 className="text-title text-fg mb-3">{t("setupNeeded.title")}</h2>
                <div className="space-y-2">
                  {companiesNeedingSetup.map((c) => (
                    <Card key={c.id} className="px-5 py-4">
                      <div className="flex items-center justify-between gap-4">
                        <p className="text-fg text-sm font-medium">{c.name}</p>
                        <Link
                          href={`/companies/${c.slug}`}
                          className="text-accent hover:text-fg shrink-0 text-xs font-medium transition-colors"
                        >
                          {t("setupNeeded.continueSetup")} →
                        </Link>
                      </div>
                    </Card>
                  ))}
                </div>
              </div>
            )}

            <div className="grid gap-6 lg:grid-cols-2">
              {/* Pending work */}
              <div>
                <h2 className="text-title text-fg mb-3">{t("pendingWork.title")}</h2>
                {withPending.length === 0 ? (
                  <Card className="px-5 py-8">
                    <EmptyState
                      title={t("pendingWork.noPending")}
                      description={t("pendingWork.noPendingDesc")}
                    />
                  </Card>
                ) : (
                  <div className="space-y-2">
                    {withPending.map((c) => (
                      <Card key={c.id} variant="hover" className="px-5 py-4">
                        <div className="flex items-center justify-between gap-4">
                          <div className="min-w-0">
                            <p className="text-fg truncate text-sm font-medium">{c.name}</p>
                            <p className="text-fg-faint mt-0.5 text-xs">
                              {t("pendingWork.posts", { count: c.pendingCount })}
                            </p>
                          </div>
                          <Link
                            href={pendingApprovalsHref(c.slug)}
                            className="text-accent hover:text-fg shrink-0 text-xs font-medium transition-colors"
                          >
                            {t("pendingWork.reviewQueue")} →
                          </Link>
                        </div>
                      </Card>
                    ))}
                  </div>
                )}
              </div>

              {/* Recent activity */}
              <div>
                <h2 className="text-title text-fg mb-3">{t("recentActivity.title")}</h2>
                {recentActivity.length === 0 ? (
                  <Card className="px-5 py-8">
                    <EmptyState
                      title={t("recentActivity.noActivity")}
                      description={t("recentActivity.noActivityDesc")}
                    />
                  </Card>
                ) : (
                  <Card className="px-5 py-2">
                    <ul className="divide-border divide-y">
                      {recentActivity.map((item) => (
                        <li key={item.id} className="flex items-start gap-3 py-3">
                          <span
                            className="bg-status-neutral-dot mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full"
                            aria-hidden
                          />
                          <div className="min-w-0 flex-1">
                            <p className="text-fg text-xs font-medium">
                              {ACTION_LABELS[item.action] ?? item.action}
                            </p>
                            <p className="text-fg-faint mt-0.5 text-xs">
                              <Link
                                href={`/companies/${item.companySlug}`}
                                className="hover:text-accent transition-colors"
                              >
                                {item.companyName}
                              </Link>
                              {item.user
                                ? ` · ${item.user.name ?? item.user.email}`
                                : ` · ${t("recentActivity.system")}`}
                            </p>
                          </div>
                          <span className="text-fg-faint shrink-0 text-xs">
                            {relativeTime(item.createdAt)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </Card>
                )}
              </div>
            </div>
          </>
        )}

        {/* Footer link to companies */}
        {companies.length > 0 && (
          <div className="flex items-center justify-between">
            <p className="text-small text-fg-muted">
              {t("companiesCount", { count: companies.length })}
            </p>
            <Link
              href="/companies"
              className="text-accent hover:text-fg text-small font-medium transition-colors"
            >
              {t("quickActions.viewCompanies")} →
            </Link>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
