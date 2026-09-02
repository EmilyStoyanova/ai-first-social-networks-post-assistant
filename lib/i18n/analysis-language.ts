/**
 * The language AI-generated **analysis text** is written in — Competitive
 * Analysis's own vocabulary (2026-09-02 mixed-language fix; re-anchored
 * 2026-09-02 ownership-boundary fix).
 *
 * ── Why this is anchored to the RESEARCH PROFILE, not the viewer or Brand ──
 * Free-form analysis (topic, summary, tone, relevance reason, …) is persisted
 * once per `CompetitorIntelligence` row. Keying it to the viewer's
 * `NEXT_LOCALE` would mean storing one copy per locale — a schema change, and
 * an AI call per locale per row. So the stored analysis follows
 * `CompetitorResearchProfile.analysisLanguage` — Competitive Analysis's own
 * setting, deliberately NOT `Company.defaultLang`. A company must be able to
 * use Competitive Analysis without ever configuring Brand / Content Creation,
 * and a later Brand language change must never silently re-language existing
 * competitor analysis. `Company.defaultLang` remains Content Creation's own,
 * entirely independent anchor for generated posts
 * (`prompt-builder.ts`'s `languageInstruction`) — this module has no
 * involvement in that path and never did.
 *
 * Everything that CAN be localized deterministically — every enum label, every
 * field caption, every relevance state — stays per-viewer through next-intl and
 * is unaffected by this. See `relevance-reason.ts` and `language-name.ts` for
 * the two deterministic pieces that used to leak English despite that.
 */

export const ANALYSIS_LANGUAGES = ["en", "bg"] as const;

export type AnalysisLanguage = (typeof ANALYSIS_LANGUAGES)[number];

/**
 * `CompetitorResearchProfile.analysisLanguage` is a plain `String` column
 * (`@default("en")`), exactly like `Company.defaultLang` — the `en | bg`
 * restriction lives only in `research-profile.schema.ts`'s write validator,
 * never in the database — so every read normalizes rather than casting. An
 * unrecognized value, or no persisted Research Profile at all (a company that
 * has never saved one, or `undefined`/`null` passed for a fresh application
 * locale that isn't `en`/`bg`), falls back to this function's own safe
 * default instead of throwing: a company must still get analyzed.
 */
export function resolveAnalysisLanguage(value: string | null | undefined): AnalysisLanguage {
  const normalized = (value ?? "").trim().toLowerCase();
  return (ANALYSIS_LANGUAGES as readonly string[]).includes(normalized)
    ? (normalized as AnalysisLanguage)
    : "en";
}

/**
 * The language's name **in English** — for interpolation into an English
 * system prompt, where "Bulgarian" is what the model is being instructed in.
 * Not for the UI: user-facing language names come from `language-name.ts`,
 * which renders them in the viewer's own locale.
 */
export function analysisLanguageEnglishName(language: AnalysisLanguage): string {
  return language === "bg" ? "Bulgarian" : "English";
}
