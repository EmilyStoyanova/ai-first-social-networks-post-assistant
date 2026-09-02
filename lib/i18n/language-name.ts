/**
 * ISO 639-1 code → the language's name in the VIEWER's locale (2026-09-02
 * mixed-language fix).
 *
 * `CompetitorIntelligence.originalLanguage` stores a machine-canonical ISO
 * code ("en", "bg", "de", …) — correct as storage, but the Content detail
 * drawer rendered it raw, so a Bulgarian UI printed a bare "en". A language
 * code is a finite, deterministic vocabulary, so this is a pure mapping and
 * never an AI call (§6 of the governing instruction).
 *
 * `Intl.DisplayNames` rather than a hand-maintained table: the model may
 * return ANY ISO 639-1 code, not just the two the app's UI is translated into,
 * and the runtime already ships every name in every locale. The code itself
 * stays untouched in the database — this is display-layer only.
 */

/**
 * Returns e.g. `"английски"` for `("en", "bg")` and `"Bulgarian"` for
 * `("bg", "en")`.
 *
 * Falls back to the raw code (upper-cased, so it reads as a code rather than a
 * broken word) when the value is not a resolvable language tag — the field is
 * model-produced and nothing guarantees it is well-formed. Returns `null` for
 * an absent code so callers can omit the field entirely rather than render a
 * placeholder.
 */
export function languageDisplayName(
  code: string | null | undefined,
  locale: string
): string | null {
  const trimmed = (code ?? "").trim();
  if (trimmed === "") return null;

  try {
    // `of()` returns the input unchanged for a well-formed but unknown tag,
    // and throws RangeError for a structurally invalid one (e.g. "english").
    const name = new Intl.DisplayNames([locale], { type: "language" }).of(trimmed);
    if (!name || name.toLowerCase() === trimmed.toLowerCase()) return trimmed.toUpperCase();
    return name;
  } catch {
    return trimmed.toUpperCase();
  }
}
