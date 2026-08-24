/**
 * Post-generation compliance gate (Step 2).
 *
 * A real generated post was assigned {angle: "Tips & Tricks", hook: "Contrast",
 * structure: "Story Arc", cta: "Follow"} — the prompt carried explicit
 * instructions for all four — but the accepted text had 0 actionable tips, no
 * contrast opening, and no follow CTA. Nothing after generation ever checked
 * whether the model actually complied with the pattern it was given; this gate
 * is that check, run on the PARSED candidate before it is accepted.
 *
 * Deterministic and LLM-free by design. Only checks that are genuinely
 * defensible with text heuristics are implemented:
 *   - CTA: Follow, Comment Prompt, Share, Website Visit, Open Question, No CTA
 *   - Angle "Tips & Tricks": 2–4 distinct actionable tips
 *   - Hook "Contrast": a recognizable contrast construction in the opening
 *
 * Deliberately NOT checked, and never a failure reason:
 *   - CTA "Reflection" / "Try It" — no clear, low-false-positive textual signal
 *   - Every angle other than "Tips & Tricks"
 *   - Every hook other than "Contrast"
 *   - STRUCTURE, entirely. "Story Arc" (setup → conflict → resolution) is
 *     stylistically too flexible to validate with regex/text heuristics without
 *     an LLM judge, and a brittle heuristic here would reject good posts for the
 *     wrong reason. `checked.structure` is always false — this is the
 *     documented limitation, not a silent gap.
 */

import type { ContentAngle } from "../content-angle";
import type { CtaType, PostPattern } from "../post-pattern";

export interface ComplianceResult {
  passed: boolean;
  reasons: string[];
  /** Which dimensions this run actually evaluated — structure never is. */
  checked: { angle: boolean; hook: boolean; cta: boolean; structure: false };
}

export interface ComplianceCheckParams {
  text: string;
  angle: ContentAngle;
  pattern: PostPattern;
}

/** Neutral result for callers with no angle/pattern to check against. */
export const NO_COMPLIANCE_CHECK: ComplianceResult = {
  passed: true,
  reasons: [],
  checked: { angle: false, hook: false, cta: false, structure: false },
};

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Matches a leading list marker: "-", "*", "•", "‣", "1.", "2)", etc.
const LIST_ITEM_RE = /^\s*(?:[-*•‣]|\d+[.)])\s+(.+)$/gm;

function extractListItems(text: string): string[] {
  const items: string[] = [];
  for (const match of text.matchAll(LIST_ITEM_RE)) {
    items.push(match[1].trim());
  }
  return items;
}

// ─── CTA compliance ─────────────────────────────────────────────────────────
// Patterns are deliberately broad (multiple phrasings, EN + BG) rather than one
// exact string — "do not blindly require exact phrases".

const UNCHECKED_CTA_TYPES: readonly CtaType[] = ["Reflection", "Try It"];

const CTA_PATTERNS: Partial<Record<CtaType, RegExp[]>> = {
  Follow: [
    /\bfollow\s+(?:us|me|along|this\s+page|our\s+page|for\s+more)\b/i,
    /\b(?:hit|tap)\s+(?:the\s+)?follow\b/i,
    /\bconnect\s+with\s+(?:us|me)\b/i,
    /следвайте\s*(?:ни|нас)?/i,
    /последвайте\s*(?:ни|нас)?/i,
  ],
  "Comment Prompt": [
    /\bcomment\s+(?:below|your|with)\b/i,
    /\blet\s+us\s+know\b/i,
    /\btell\s+us\b/i,
    /\bwhat(?:'|’)s\s+your\s+(?:take|opinion|experience|view)\b/i,
    /\bshare\s+your\s+(?:thoughts|opinion|experience)\b/i,
    /коментар(?:ирайте)?/i,
    /какво\s+мислите/i,
    /споделете\s+мнението\s+си/i,
  ],
  Share: [/\bshare\s+(?:this|it)\b/i, /\btag\s+a\s+friend\b/i, /сподели(?:те)?\s+(?:тази|това|с)/i],
  "Website Visit": [
    /\bvisit\s+(?:our|the)\s+(?:website|site|link)\b/i,
    /\blink\s+in\s+bio\b/i,
    /\b(?:click|check\s+out)\s+the\s+link\b/i,
    /посетете\s+/i,
    /кликнете\s+/i,
    /линк(?:ът)?\s+в\s+био/i,
  ],
  "Open Question": [/\?\s*$/],
  "No CTA": [],
};

const CTA_MISSING_DESCRIPTIONS: Partial<Record<CtaType, string>> = {
  Follow: "follow/connect invitation",
  "Comment Prompt": "comment/opinion request",
  Share: "share invitation",
  "Website Visit": "link/website visit prompt",
  "Open Question": "closing open-ended question",
};

function checkCta(text: string, ctaType: CtaType): { passed: boolean; reason: string | null } {
  if (ctaType === "No CTA") return { passed: true, reason: null };
  if (UNCHECKED_CTA_TYPES.includes(ctaType)) return { passed: true, reason: null };

  const patterns = CTA_PATTERNS[ctaType] ?? [];
  if (patterns.some((re) => re.test(text))) return { passed: true, reason: null };

  return {
    passed: false,
    reason: `${ctaType} CTA is required; no ${CTA_MISSING_DESCRIPTIONS[ctaType]} was found.`,
  };
}

// ─── Angle "Tips & Tricks" — 2–4 actionable tips ───────────────────────────
// Prefers a numbered/bulleted list (the strongest, least ambiguous signal —
// and the shape ANGLE_INSTRUCTIONS already asks the model for). Falls back to
// counting substantial sentences after the opening (hook) sentence, excluding
// anything that matches the active CTA — so the CTA is never counted as a tip.
// This is a heuristic, not a semantic classifier: it cannot tell a genuine
// instruction from an unusually long generic sentence. It is intentionally
// conservative about what counts (list items, or full sentences past the
// hook) rather than trying to split clauses within one sentence, which is
// exactly the "multiple clauses expressing one instruction" trap.

const MIN_TIP_WORDS = 3;

function countActionableTips(text: string, ctaType: CtaType): number {
  const listItems = extractListItems(text).filter((item) => wordCount(item) >= MIN_TIP_WORDS);
  if (listItems.length >= 2) return listItems.length;

  const sentences = splitSentences(text);
  if (sentences.length <= 1) return 0;

  const ctaPatterns = CTA_PATTERNS[ctaType] ?? [];
  const body = sentences.slice(1); // drop the opening/hook sentence
  return body.filter((s) => wordCount(s) >= MIN_TIP_WORDS && !ctaPatterns.some((re) => re.test(s)))
    .length;
}

function checkTipsAndTricks(
  text: string,
  ctaType: CtaType
): { passed: boolean; reason: string | null } {
  const count = countActionableTips(text, ctaType);
  if (count >= 2 && count <= 4) return { passed: true, reason: null };
  return {
    passed: false,
    reason: `Tips & Tricks requires 2–4 actionable tips; found ${count}.`,
  };
}

// ─── Hook "Contrast" — recognizable contrast construction in the opening ──

const CONTRAST_OPENING_CHARS = 220;

// JS regex `\b` is ASCII-only — it never fires correctly around Cyrillic
// letters (they are not `\w`), so `/вместо\b/i` silently fails to match. This
// hand-rolled lookaround stands in for a Cyrillic-aware word boundary.
const CYRILLIC = "а-яА-ЯёЁ";
function bgWord(word: string): string {
  return `(?<![${CYRILLIC}])${word}(?![${CYRILLIC}])`;
}

const CONTRAST_PATTERNS: RegExp[] = [
  // Bulgarian
  new RegExp(bgWord("вместо"), "i"),
  new RegExp(`${bgWord("повечето")}[^.!?]{0,60}${bgWord("но")}`, "i"),
  new RegExp(`${bgWord("не")}\\s+[^,.!?]{1,60},\\s*${bgWord("а")}\\s+`, "i"),
  new RegExp(bgWord("срещу"), "i"),
  new RegExp(bgWord("докато"), "i"),
  // English
  /\binstead\s+of\b/i,
  /\b(?:most|many)\b[^.!?]{0,60}\b(?:but|however|yet)\b/i,
  /\bnot\s+[^,.!?]{1,60},?\s*but\s+/i,
  /\bversus\b|\bvs\.?\b/i,
  /\bwhile\b|\bwhereas\b/i,
];

function checkContrastHook(text: string): { passed: boolean; reason: string | null } {
  const opening = text.slice(0, CONTRAST_OPENING_CHARS);
  if (CONTRAST_PATTERNS.some((re) => re.test(opening))) return { passed: true, reason: null };
  return {
    passed: false,
    reason:
      "Contrast hook is required; no recognizable contrast construction was found in the opening.",
  };
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function validateGenerationCompliance(params: ComplianceCheckParams): ComplianceResult {
  const { text, angle, pattern } = params;
  const reasons: string[] = [];

  const angleChecked = angle === "Tips & Tricks";
  if (angleChecked) {
    const tips = checkTipsAndTricks(text, pattern.ctaType);
    if (!tips.passed && tips.reason) reasons.push(tips.reason);
  }

  const hookChecked = pattern.hookType === "Contrast";
  if (hookChecked) {
    const hook = checkContrastHook(text);
    if (!hook.passed && hook.reason) reasons.push(hook.reason);
  }

  const ctaChecked = !UNCHECKED_CTA_TYPES.includes(pattern.ctaType);
  const cta = checkCta(text, pattern.ctaType);
  if (!cta.passed && cta.reason) reasons.push(cta.reason);

  return {
    passed: reasons.length === 0,
    reasons,
    checked: { angle: angleChecked, hook: hookChecked, cta: ctaChecked, structure: false },
  };
}
