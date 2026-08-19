/**
 * How an analytics figure is written out.
 *
 * Deliberately free of `Intl`: these run in Server Components and in the chart's
 * Client Component, and `Intl.NumberFormat` with no explicit locale resolves it
 * from the ambient runtime — which differs between the two sides and produces
 * the text mismatch React throws #418 for. The same reasoning as
 * `lib/i18n/format-date.ts`, arrived at the same way.
 *
 * `null` is the shared vocabulary for "this network did not report it", and
 * every function here renders it as an em dash rather than as 0. That is the
 * NULL ≠ 0 rule at its last mile: everything upstream can preserve the
 * distinction perfectly and it still ends as a lie if the formatter coalesces.
 */

/** What an unreported metric looks like. Never "0". */
export const NO_VALUE = "—";

/**
 * A count, abbreviated past a thousand.
 *
 * KPI cards sit in a fixed-width grid and a six-figure impression count would
 * either wrap or shrink the type; "128K" keeps the row scannable. Exact figures
 * stay available on the post cards, which have room for them.
 */
export function compactCount(value: number | null): string {
  if (value === null) return NO_VALUE;

  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${trim(value / 1_000_000)}M`;
  if (abs >= 10_000) return `${trim(value / 1_000)}K`;

  // Below 10K the exact number fits, and seeing "1.2K" where "1,234" would do
  // loses precision for no gain.
  return String(Math.round(value));
}

/** One decimal, with a trailing ".0" dropped. */
function trim(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}

/**
 * An average, to one decimal.
 *
 * Averages are not rounded to whole numbers: "3 reactions per post" and "3.4"
 * are different claims, and the fraction is the informative part when a source
 * has published four times.
 */
export function formatAverage(value: number | null): string {
  if (value === null) return NO_VALUE;
  return trim(value);
}

/** Buffer sends a percentage already — 12.5 means 12.5%. */
export function formatRate(value: number | null): string {
  if (value === null) return NO_VALUE;
  return `${trim(value)}%`;
}
