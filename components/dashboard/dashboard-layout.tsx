import { DashboardHeader } from "./dashboard-header";

interface SessionUser {
  name?: string | null;
  email?: string | null;
}

interface Props {
  user: SessionUser;
  children: React.ReactNode;
}

export function DashboardLayout({ user, children }: Props) {
  return (
    <div className="flex min-h-screen flex-col bg-gray-50">
      <DashboardHeader user={user} />
      {/*
       * flex-1 lets the main area grow to fill remaining viewport height.
       * The max-w-7xl + padding mirrors the header so content aligns.
       * A future sidebar slot can be added here as a sibling to <main>.
       */}
      <main className="flex-1">
        <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8">{children}</div>
      </main>
    </div>
  );
}
