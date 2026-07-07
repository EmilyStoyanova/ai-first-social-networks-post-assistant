import { LanguageSwitcher } from "@/components/ui/LanguageSwitcher";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative">
      <div className="absolute top-4 right-4 z-10">
        <LanguageSwitcher />
      </div>
      {children}
    </div>
  );
}
