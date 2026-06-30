import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { DashboardLayout } from "@/components/dashboard/dashboard-layout";

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
    <DashboardLayout user={{ name: user?.name, email: user?.email }}>
      <div className="rounded-2xl border border-gray-200 bg-white px-8 py-10 shadow-sm">
        <h1 className="text-2xl font-bold tracking-tight text-gray-900">Welcome back{greeting}!</h1>
        <p className="mt-2 text-sm text-gray-500">
          Your dashboard is being built. Here&apos;s what&apos;s coming next:
        </p>

        <ul className="mt-6 space-y-3">
          {["Companies", "Posts", "Media Gallery", "Analytics"].map((item) => (
            <li key={item} className="flex items-center gap-2 text-sm text-gray-600">
              <span className="h-1.5 w-1.5 rounded-full bg-blue-500" />
              {item}
            </li>
          ))}
        </ul>
      </div>
    </DashboardLayout>
  );
}
