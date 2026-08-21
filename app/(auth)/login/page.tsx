import type { Metadata } from "next";
import { LoginForm } from "@/components/auth/login-form";
import { LoginIntroDetails, LoginIntroLead } from "@/components/auth/login-intro";

export const metadata: Metadata = {
  title: "Login – AI-First Post Assistant",
};

interface Props {
  searchParams: Promise<{
    registered?: string;
    verified?: string;
    error?: string;
    callbackUrl?: string;
  }>;
}

function sanitizeCallbackUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  if (!raw.startsWith("/") || raw.startsWith("//")) return undefined;
  return raw;
}

function parseTokenError(error: string | undefined): "token_expired" | "invalid_token" | undefined {
  if (error === "token_expired") return "token_expired";
  if (error === "invalid_token") return "invalid_token";
  return undefined;
}

export default async function LoginPage({ searchParams }: Props) {
  const { registered, verified, error, callbackUrl } = await searchParams;

  return (
    <main className="bg-bg relative flex min-h-screen w-full flex-col justify-center overflow-hidden px-4 pt-16 pb-12 sm:px-6 lg:px-10 lg:py-16">
      {/* Two soft accent washes — one behind the intro, one behind the card.
          Both are drawn from existing palette tokens, so no new hue enters. */}
      <div
        aria-hidden="true"
        className="rounded-pill bg-tile-accent-bg pointer-events-none absolute -top-40 -left-32 h-[32rem] w-[32rem] opacity-50 blur-3xl"
      />
      <div
        aria-hidden="true"
        className="rounded-pill bg-tile-info-bg pointer-events-none absolute -right-40 -bottom-40 h-[28rem] w-[28rem] opacity-40 blur-3xl"
      />

      {/*
       * Split screen at lg: intro ~57% / login ~43%. Column 1 holds the intro in
       * two rows; the card spans both and centres against them. Below lg the
       * grid collapses to source order — lead, card, details — so the form stays
       * one short scroll from the top.
       */}
      <div className="relative mx-auto grid w-full max-w-6xl grid-cols-1 gap-x-12 gap-y-10 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] lg:items-start lg:gap-x-16 lg:gap-y-8">
        <div className="lg:col-start-1 lg:row-start-1">
          <LoginIntroLead />
        </div>

        <div className="lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:self-center">
          <LoginForm
            registered={registered === "1"}
            verified={verified === "1"}
            tokenError={parseTokenError(error)}
            callbackUrl={sanitizeCallbackUrl(callbackUrl)}
          />
        </div>

        <div className="lg:col-start-1 lg:row-start-2">
          <LoginIntroDetails />
        </div>
      </div>
    </main>
  );
}
