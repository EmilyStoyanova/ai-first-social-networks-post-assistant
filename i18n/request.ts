import { getRequestConfig } from "next-intl/server";
import { cookies } from "next/headers";

const LOCALES = ["en", "bg"] as const;
type Locale = (typeof LOCALES)[number];

function isLocale(v: string | undefined): v is Locale {
  return LOCALES.includes(v as Locale);
}

export default getRequestConfig(async () => {
  const cookieStore = await cookies();
  const raw = cookieStore.get("NEXT_LOCALE")?.value;
  const locale: Locale = isLocale(raw) ? raw : "en";

  return {
    locale,
    messages: ((await import(`./messages/${locale}.json`)) as { default: Record<string, unknown> })
      .default,
  };
});
