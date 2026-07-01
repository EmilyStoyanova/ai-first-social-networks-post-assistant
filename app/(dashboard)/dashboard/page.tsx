import type { Metadata } from "next";
import { redirect } from "next/navigation";
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

  const { user } = session;
  const greeting = user?.name ? `, ${user.name}` : "";

  return (
    <DashboardLayout
      user={{ name: user?.name, email: user?.email, isGlobalAdmin: user?.isGlobalAdmin }}
    >
      <div className="space-y-6">
        {/* Welcome card */}
        <Card className="px-8 py-10">
          <h1 className="text-2xl font-bold tracking-tight text-gray-900">
            Welcome back{greeting}!
          </h1>
          <p className="mt-2 text-sm text-gray-500">
            Manage your social media presence from one place.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Button href="/companies" variant="primary">
              Go to Companies
            </Button>
          </div>
        </Card>

        {/* Coming soon modules */}
        <Section title="Coming soon">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { icon: "✍️", label: "Posts" },
              { icon: "🖼️", label: "Media Gallery" },
              { icon: "📊", label: "Analytics" },
              { icon: "⚙️", label: "Settings" },
            ].map(({ icon, label }) => (
              <Card key={label} className="px-5 py-4">
                <span className="text-xl" aria-hidden="true">
                  {icon}
                </span>
                <p className="mt-2 text-sm font-medium text-gray-500">{label}</p>
              </Card>
            ))}
          </div>
        </Section>
      </div>
    </DashboardLayout>
  );
}
