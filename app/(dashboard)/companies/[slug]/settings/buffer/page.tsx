import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { auth } from "@/lib/auth";
import { getCompany } from "@/lib/services/company/get-company.service";
import { getBufferConnection } from "@/lib/services/buffer/get-buffer-connection.service";
import { getAnalyticsKeyStatus } from "@/lib/services/analytics/manage-analytics-key.service";
import { SettingsShell } from "@/components/company/settings-shell";
import { BufferConnectionCard } from "@/components/company/buffer-connection-card";
import { AnalyticsKeyCard } from "@/components/company/analytics-key-card";
import { Section } from "@/components/ui/Section";

interface Props {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return { title: `Integrations – ${slug} – AI-First Post Assistant` };
}

export default async function BufferSettingsPage({ params, searchParams }: Props) {
  const session = await auth();
  if (!session) redirect("/login");

  const [{ slug }, sp] = await Promise.all([params, searchParams]);

  const company = await getCompany(slug, session.user.id, session.user.isGlobalAdmin);
  if (!company) notFound();

  const t = await getTranslations("companyPage");
  const canManage = company.role === "OWNER" || session.user.isGlobalAdmin;

  const [bufferConnection, analyticsKeyStatus] = await Promise.all([
    getBufferConnection(company.id),
    getAnalyticsKeyStatus(slug, session.user.id, session.user.isGlobalAdmin),
  ]);

  // The OAuth callback lands here with ?buffer=connected|error, which is what
  // makes the result visible at all — before Phase 4b it was sent to a page
  // that renders no Buffer card, so it was never shown.
  const bufferParam = typeof sp.buffer === "string" ? sp.buffer : null;

  // The key-status service is owner-scoped and answers FORBIDDEN to editors.
  // That is a permission limit, not a setup state, so it is reported as one:
  // the card is told it cannot read the status rather than being handed a
  // fabricated "not configured", which used to show editors a "Disabled" badge
  // on companies where the key was working perfectly well.
  const canReadStatus = analyticsKeyStatus.success;

  return (
    <SettingsShell
      company={company}
      user={{
        name: session.user.name,
        email: session.user.email,
        isGlobalAdmin: session.user.isGlobalAdmin,
      }}
      active="buffer"
    >
      <Section id="buffer" title={t("sections.integrations")}>
        <BufferConnectionCard
          slug={slug}
          initialConnection={{
            connected: bufferConnection.connected,
            bufferUserId: bufferConnection.bufferUserId,
            connectedAt: bufferConnection.connectedAt?.toISOString() ?? null,
          }}
          canManage={canManage}
          bufferParam={bufferParam}
        />

        {/* Analytics key — its own card because it is a different credential with
            a different lifecycle, and removing it must not read as affecting
            publishing. */}
        <AnalyticsKeyCard
          slug={slug}
          canManage={canManage}
          canReadStatus={canReadStatus}
          initialStatus={
            analyticsKeyStatus.success
              ? analyticsKeyStatus.data
              : {
                  // Buffer's own connection state is readable by any member, so
                  // it stays truthful even when the key status is not.
                  bufferConnected: bufferConnection.connected,
                  configured: false,
                  last4: null,
                  addedAt: null,
                  lastValidAt: null,
                }
          }
        />
      </Section>
    </SettingsShell>
  );
}
