import type { ProtectedValue } from "./protected-tokens";
import type { TranslationProvider } from "./translation-provider";

/**
 * Repairing the ONE segment MADLAD could not carry, without giving up the article.
 *
 * ── The failure this exists for ──────────────────────────────────────────────
 * MADLAD drops a `[[n]]` placeholder whenever it sits next to a brand token. Measured
 * against the real worker by holding a sentence fixed and varying ONLY the neighbours:
 *
 *   "…a closer look at the [[0]] all-in-one liquid cooler."            KEPT
 *   "…a closer look at the MSI [[0]] all-in-one liquid cooler."        LOST
 *   "…a closer look at the MSI MEG [[0]] all-in-one liquid cooler."    LOST
 *
 * One adjacent brand token is enough, and it happens in ordinary prose, not only in
 * headlines (feed item 8cf9a29f, segment 11/59 — a sentence with a subject and a verb).
 * Re-sending the same segment to MADLAD is useless: beam search is deterministic, so a
 * retry reproduces the drop exactly (this is why `maxTries` is 1). The only thing that
 * can produce a DIFFERENT answer is a different engine.
 *
 * ── Why the result is checked rather than trusted ────────────────────────────
 * The prompt-based engine is better at this, but it is NOT reliable — measured on the
 * ten real failing segments of feed item 8cf9a29f, it preserved the identifier in 7 and
 * corrupted it in 3, always by transliteration:
 *
 *   "Gen.2"     → "Ген.2"       (Cyrillic)
 *   "50-Series" → "50-Серия"
 *
 * Both read perfectly well and are silently wrong — exactly the class of loss the
 * placeholders exist to prevent. So a repair is accepted only when every protected
 * value survives BYTE-IDENTICALLY and the right number of times; anything else keeps
 * the original English segment, which is honest and complete rather than plausible and
 * wrong.
 */

/**
 * Least article time that may remain before a repair is STARTED.
 *
 * 20s — twice the slowest repair measured (10.1s, on a glued specification dump; the
 * median was 1.0s and the 9 others all landed under 3s). Below this the segment keeps
 * its original English rather than starting a call that would probably be cut off, so
 * a repair can never be the reason an article misses its own deadline.
 */
export const MIN_REPAIR_BUDGET_MS = 20_000;

/**
 * Wall-clock ceiling for ONE repair, including the prompt engine's own internal
 * regeneration loop. 30s — three times the slowest repair measured, and far below
 * `TRANSLATION_ATTEMPT_TIMEOUT_MS` (90s), which is sized for a whole article rather
 * than one sentence. Applied by handing the repair a NARROWED context, so the prompt
 * engine bounds itself with the code it already has and nothing there changes.
 */
export const REPAIR_BUDGET_MS = 30_000;

/**
 * Share of an article's segments that may be repaired or left English before the whole
 * article is failed instead.
 *
 * 25%, and the number is measured rather than chosen. Four real hardware reviews, every
 * segment translated by the live worker and restored:
 *
 *   MSI MEG CORELIQUID E15 360      59 segments   10 failing   16.9%
 *   Kioxia Exceria Pro G2 4 TB      18 segments    3 failing   16.7%
 *   AVerMedia DualCam (PW313D)      56 segments    9 failing   16.1%
 *   XMG Pro 16 (M25)                29 segments    6 failing   20.7%
 *
 * The rate is strikingly stable at 16-21%, so the "max 5 segments or 10%" rule this
 * started from would have failed ALL FOUR articles outright — it was set before the
 * rate was known. 25% clears the observed band with headroom while still being far
 * from "mostly English": an article at the cap is three-quarters translated, and the
 * existing Bulgarian-share gate ({@link MIN_CYRILLIC_SHARE}, 40%) independently
 * catches anything that drifts further, because a segment left in English is fed to
 * that gate as English rather than being hidden from it.
 */
export const MAX_REPAIR_SHARE = 0.25;

/**
 * Hard ceiling on repairs per article, whatever the share allows.
 *
 * 12 — above the worst article measured (10) and, at the slowest observed repair,
 * ~2 minutes of prompt-engine time, which still fits inside the 210s item budget
 * beside MADLAD's own ~30s. It stops a very long article from spending its whole
 * deadline on repairs; the budget check would catch that anyway, but a bound that
 * depends on a clock is not one you can reason about from the code alone.
 */
export const MAX_REPAIRS_PER_ARTICLE = 12;

/** How many segments of an article of `segmentCount` may be repaired or left English. */
export function maxRepairsFor(segmentCount: number): number {
  return Math.min(Math.ceil(segmentCount * MAX_REPAIR_SHARE), MAX_REPAIRS_PER_ARTICLE);
}

/** Letters (any script) and digits — what may not sit against an identifier's edge. */
const ALPHANUMERIC = /[\p{L}\p{N}]/u;

/**
 * Occurrences of `needle` in `haystack` that are not glued to a longer word.
 *
 * A plain `includes` would accept "E15" inside "E150" — a different model — so both
 * edges must be free of letters and digits. Punctuation is fine on either side, which
 * is what lets "v2.14.3." at the end of a sentence and "(PW313D)" in brackets count.
 * Letters are matched in ANY script, so a Cyrillic neighbour is a boundary violation
 * too rather than an accidental pass.
 */
function countFreeStanding(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    const before = at === 0 ? "" : haystack[at - 1];
    const after = haystack[at + needle.length] ?? "";
    if (!ALPHANUMERIC.test(before) && !ALPHANUMERIC.test(after)) count += 1;
    from = at + needle.length;
  }
}

/**
 * The protected values a repaired segment failed to reproduce exactly.
 *
 * Empty means the repair is acceptable. Multiplicity is part of the test, not an
 * afterthought: `values` carries one entry per OCCURRENCE (see `protectTokens`), so a
 * source naming the same model twice must be answered by a translation naming it
 * twice — no more, because an invented extra occurrence is as much a fabrication as a
 * missing one, and no fewer, because a dropped one is the original bug.
 */
export function unpreservedValues(values: readonly ProtectedValue[], translated: string): string[] {
  const required = new Map<string, number>();
  for (const { value } of values) required.set(value, (required.get(value) ?? 0) + 1);

  const failed: string[] = [];
  for (const [value, count] of required) {
    if (countFreeStanding(translated, value) !== count) failed.push(value);
  }
  return failed;
}

/** What happened to one segment that MADLAD could not carry. */
export interface SegmentRepairRecord {
  /** 1-based, article-level — the same numbering every error message here uses. */
  segment: number;
  /** Whether the repaired text was accepted, or the original English was kept. */
  outcome: "repaired" | "original";
  /** Why the original was kept. Null when the repair was accepted. */
  reason: string | null;
  /** The values that forced the fallback, when identifier verification is what failed. */
  lostValues?: string[];
}

/** Everything a trace or a log line needs to say about an article's repairs. */
export interface RepairReport {
  records: SegmentRepairRecord[];
  /** Engine and model that answered the repairs, once resolved. */
  provider: string | null;
  model: string | null;
}

export function emptyRepairReport(): RepairReport {
  return { records: [], provider: null, model: null };
}

/** Segments whose repair was accepted, 1-based, in article order. */
export function repairedSegments(report: RepairReport): number[] {
  return report.records.filter((r) => r.outcome === "repaired").map((r) => r.segment);
}

/** Segments left in the source language, 1-based, in article order. */
export function originalSegments(report: RepairReport): number[] {
  return report.records.filter((r) => r.outcome === "original").map((r) => r.segment);
}

/** Resolves the engine that repairs a segment. Called at most once per article. */
export type ResolveRepairProvider = () => Promise<TranslationProvider | null>;
