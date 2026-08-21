import { CalendarCheck, PenLine, Rss, Sparkles, type LucideIcon } from "lucide-react";
import { getTranslations } from "next-intl/server";

/**
 * The product introduction shown beside the login card.
 *
 * It is deliberately split in two: on desktop the pair fills the left column of
 * the split screen top-to-bottom, while on mobile the login card sits BETWEEN
 * them (page grid, `app/(auth)/login/page.tsx`) so a returning user reaches the
 * form after the headline rather than after the whole pitch.
 *
 * Both halves are Server Components — the intro is static copy and ships no JS.
 */

const CAPABILITIES: { key: string; icon: LucideIcon; tile: string }[] = [
  { key: "discovery", icon: Rss, tile: "bg-tile-accent-bg text-tile-accent-fg" },
  { key: "analysis", icon: Sparkles, tile: "bg-tile-info-bg text-tile-info-fg" },
  { key: "generation", icon: PenLine, tile: "bg-tile-warning-bg text-tile-warning-fg" },
  { key: "publishing", icon: CalendarCheck, tile: "bg-tile-success-bg text-tile-success-fg" },
];

const FLOW_STEPS = ["sources", "analysis", "generation", "publishing"] as const;

/** Headline and one-line promise. Renders above the login card on mobile. */
export async function LoginIntroLead() {
  const t = await getTranslations("auth.intro");

  return (
    <div className="max-w-xl">
      <h1 className="text-fg font-serif text-3xl leading-tight font-semibold tracking-tight text-balance sm:text-4xl lg:text-[2.5rem] lg:leading-[1.15]">
        {t("heading")}
      </h1>
      <p className="text-fg-muted mt-4 text-base leading-relaxed sm:text-lg">{t("lead")}</p>
    </div>
  );
}

/** What the platform does. Renders below the login card on mobile. */
export async function LoginIntroDetails() {
  const t = await getTranslations("auth.intro");

  return (
    <div className="max-w-xl">
      <p className="text-fg-muted text-sm leading-relaxed">{t("description")}</p>

      {/* Източници → AI анализ → Генериране → Публикуване */}
      <ol
        aria-label={t("flowLabel")}
        className="mt-5 flex flex-wrap items-center gap-x-1.5 gap-y-2"
      >
        {FLOW_STEPS.map((step, i) => (
          <li key={step} className="flex items-center gap-1.5">
            {i > 0 && (
              <span className="text-fg-faint text-xs" aria-hidden="true">
                →
              </span>
            )}
            <span className="rounded-pill border-border bg-surface text-fg-muted border px-2.5 py-1 text-xs font-medium">
              {t(`flow.${step}`)}
            </span>
          </li>
        ))}
      </ol>

      <ul aria-label={t("capabilitiesLabel")} className="mt-6 grid gap-3 sm:grid-cols-2">
        {CAPABILITIES.map(({ key, icon: Icon, tile }) => (
          <li
            key={key}
            className="rounded-card border-border/70 bg-surface/70 border px-4 py-4 backdrop-blur-[2px]"
          >
            <span
              className={`rounded-control mb-3 flex h-8 w-8 items-center justify-center ${tile}`}
              aria-hidden="true"
            >
              <Icon className="h-4 w-4" />
            </span>
            <p className="text-fg text-sm leading-snug font-semibold">
              {t(`capabilities.${key}.title`)}
            </p>
            <p className="text-fg-muted mt-1 text-xs leading-relaxed">
              {t(`capabilities.${key}.description`)}
            </p>
          </li>
        ))}
      </ul>

      <p className="text-fg-faint mt-5 text-xs leading-relaxed">{t("closing")}</p>
    </div>
  );
}
