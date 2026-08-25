/**
 * Post-generation compliance gate.
 *
 * ENFORCEMENT SCOPE — deliberately narrow. This gate enforces exactly one
 * thing: that a generated post contains no banned term. Nothing else it could
 * measure is allowed to block a save.
 *
 * It used to also gate the STYLISTIC pattern a post was generated under — the
 * selected CTA, hook, structure, and angle — with text heuristics, and a
 * candidate that missed one was retried and then discarded outright
 * (POST_FAILED_COMPLIANCE). That cost far more than it bought. A "Share" CTA
 * the model wrote as "изпрати това на приятел" is a genuine share invitation
 * that no finite pattern list recognises, so three attempts later a perfectly
 * usable post was thrown away over the phrasing of its closing sentence. Style
 * is a preference, and a preference must not be able to destroy content.
 *
 * The angle/hook/structure/CTA instructions therefore remain in the generation
 * prompt (see prompt-builder.ts) and the model still tries to honour them. They
 * are simply no longer verified afterwards, and can no longer trigger a retry or
 * an abort. `checked` reports them as `false` so that nothing downstream can
 * read an unenforced dimension as a verified pass.
 *
 * A banned word is different in kind: a hard product prohibition with an exact,
 * unambiguous textual signal. It keeps the full retry-then-abort behaviour.
 *
 * RESULT SEMANTICS. `passed: true` alone never meant "verified" — an
 * all-unsupported pattern produced it too. `status` separates the two:
 * `not_checked` means compliance was never verified. Since the banned-word
 * check always runs, `status` is `not_checked` only for the neutral
 * `NO_COMPLIANCE_CHECK` placeholder (no candidate text was ever measured); a
 * real call always resolves to `passed` or `failed`.
 */

/**
 * - `passed`      — every enforced check passed.
 * - `failed`      — an enforced check missed. The ONLY status that blocks
 *                   (retry, then POST_FAILED_COMPLIANCE).
 * - `not_checked` — no text was measured at all. Compliance was NOT verified.
 */
export type ComplianceStatus = "passed" | "failed" | "not_checked";

/**
 * Every dimension the gate reports on, enforced or not.
 *
 * The four stylistic names are retained purely so `checked` can state — rather
 * than silently omit — that they were not verified. Only `bannedWords` is ever
 * evaluated; see `EnforcedComplianceDimension`.
 */
export type ComplianceDimension = "angle" | "hook" | "structure" | "cta" | "bannedWords";

/** The dimensions that are actually enforced, and so the only ones that can fail. */
export type EnforcedComplianceDimension = "bannedWords";

export interface ComplianceFailure {
  dimension: EnforcedComplianceDimension;
  reason: string;
}

export interface ComplianceResult {
  status: ComplianceStatus;
  /** True when at least one dimension was actually evaluated. */
  evaluated: boolean;
  /**
   * False ONLY when an enforced check failed. Read `status`/`checked` to tell a
   * verified pass from a dimension that was never measured.
   */
  passed: boolean;
  reasons: string[];
  /** Structured failure information — only populated when status === "failed". */
  failures: ComplianceFailure[];
  /**
   * Which dimensions this run actually evaluated. The stylistic four are always
   * `false`: they are generation guidance, never a post-generation gate.
   */
  checked: Record<ComplianceDimension, boolean>;
}

export interface ComplianceCheckParams {
  text: string;
}

/**
 * Which dimensions a real run evaluates. Stylistic dimensions are guidance
 * only, so they are reported as unchecked rather than as a pass.
 */
const CHECKED_DIMENSIONS: Record<ComplianceDimension, boolean> = {
  angle: false,
  hook: false,
  structure: false,
  cta: false,
  bannedWords: true,
};

/** Neutral result for callers with no text to check at all. */
export const NO_COMPLIANCE_CHECK: ComplianceResult = {
  status: "not_checked",
  evaluated: false,
  passed: true,
  reasons: [],
  failures: [],
  checked: { angle: false, hook: false, structure: false, cta: false, bannedWords: false },
};

// ─── Banned word: "Стоп" ────────────────────────────────────────────────────
// Product decision: the standalone Bulgarian word "стоп" must never appear in
// generated post text — in any casing ("Стоп", "СТОП"), with any trailing
// punctuation ("Стоп!"), or inside a longer phrase ("Стоп на...", "Кажи стоп
// на..."), and especially not as the opening hook. It runs on every candidate,
// unconditionally — it does not depend on the angle/hook/structure/CTA the
// candidate was generated under.
//
// JS regex `\b` is ASCII-only — it never fires correctly around Cyrillic
// letters (they are not `\w`), so `/стоп\b/i` silently fails to match. The
// hand-rolled lookaround below stands in for a Cyrillic-aware word boundary,
// and is what keeps this from also rejecting "автостоп" (hitchhiking) or
// "стопанство" (economy/farm): in both, "стоп" is directly adjacent to more
// Cyrillic letters, so the lookaround fails and only the standalone word matches.

const CYRILLIC = "а-яА-ЯёЁ";
function bgWord(word: string): string {
  return `(?<![${CYRILLIC}])${word}(?![${CYRILLIC}])`;
}

const BANNED_STOP_WORD_RE = new RegExp(bgWord("стоп"), "i");

const BANNED_STOP_WORD_REASON =
  'The word "Стоп" is not allowed anywhere in the post (in any casing or with any punctuation), and especially not as the opening hook.';

function checkBannedWords(text: string): { passed: boolean; reason: string | null } {
  if (BANNED_STOP_WORD_RE.test(text)) {
    return { passed: false, reason: BANNED_STOP_WORD_REASON };
  }
  return { passed: true, reason: null };
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function validateGenerationCompliance(params: ComplianceCheckParams): ComplianceResult {
  const reasons: string[] = [];
  const failures: ComplianceFailure[] = [];

  const bannedWords = checkBannedWords(params.text);
  if (!bannedWords.passed && bannedWords.reason) {
    reasons.push(bannedWords.reason);
    failures.push({ dimension: "bannedWords", reason: bannedWords.reason });
  }

  const passed = reasons.length === 0;

  return {
    status: passed ? "passed" : "failed",
    evaluated: true,
    passed,
    reasons,
    failures,
    checked: { ...CHECKED_DIMENSIONS },
  };
}
