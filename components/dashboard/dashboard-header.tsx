import { LogoutButton } from "./logout-button";

interface SessionUser {
  name?: string | null;
  email?: string | null;
}

interface Props {
  user: SessionUser;
}

export function DashboardHeader({ user }: Props) {
  const displayName = user.name ?? user.email ?? "User";

  return (
    <header className="border-b border-gray-200 bg-white">
      <div className="mx-auto flex w-full max-w-7xl items-center justify-between px-4 py-4 sm:px-6 lg:px-8">
        <div className="flex items-baseline gap-2">
          <span className="text-base font-bold tracking-tight text-gray-900">
            AI-First Social Networks
          </span>
          <span className="hidden text-sm text-gray-400 sm:inline">Post Assistant</span>
        </div>

        <div className="flex items-center gap-4">
          <span className="hidden text-sm text-gray-600 sm:block">{displayName}</span>
          <LogoutButton />
        </div>
      </div>
    </header>
  );
}
