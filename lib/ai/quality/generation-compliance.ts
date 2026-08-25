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
 *   - CTA: Follow, Comment Prompt, Share, Website Visit, Open Question, Reflection
 *   - Angle "Tips & Tricks": 2–4 distinct actionable tips
 *   - Angle "Myth vs Fact": the opening names a misconception AND corrects it
 *   - Hook "Contrast": a recognizable contrast construction in the opening
 *   - Structure "List": 3–5 distinct, scannable list items
 *
 * Deliberately NOT checked, and never a failure reason:
 *   - CTA "Try It" — no clear, low-false-positive textual signal
 *   - CTA "No CTA" — we never verify the ABSENCE of a call to action, so
 *     reporting it as checked would certify something never tested
 *   - Every angle other than "Tips & Tricks" and "Myth vs Fact"
 *   - Every hook other than "Contrast" — including "Bold Statement". The only
 *     deterministic signal available there is one-sided: we can tell that an
 *     opening is NOT a claim (it is a question), but never that a claim is
 *     confident or counterintuitive. A one-sided test reported as "checked and
 *     passed" would certify exactly nothing, which is the same false-PASS
 *     defect this gate's `status` field exists to remove. Confidence and
 *     counterintuitiveness need a semantic judge, not a regex.
 *   - Every structure other than "List". "Story Arc" (setup → conflict →
 *     resolution) is stylistically too flexible to validate without an LLM
 *     judge, and a brittle heuristic there would reject good posts for the
 *     wrong reason. "List" is the exception because its own prompt instruction
 *     is literally countable: "Present 3–5 points in a numbered or bulleted,
 *     scannable format."
 *
 * RESULT SEMANTICS. `passed: true` used to mean "no check produced a failure
 * reason" — which is also what an all-unsupported pattern produced, so a post
 * nothing had looked at reported as compliant. `status` separates the two:
 * `not_checked` means compliance was never verified. It is still non-blocking
 * (`passed` stays true, so an unsupported pattern never triggers a retry or an
 * abort) but it must never be displayed or read as a pass.
 */

import type { ContentAngle } from "../content-angle";
import type { CtaType, PostPattern } from "../post-pattern";

/**
 * - `passed`      — at least one requirement was checked, and every check passed.
 * - `failed`      — a requirement was checked and missed. This is the ONLY
 *                   status that blocks (retry, then POST_FAILED_COMPLIANCE).
 * - `not_checked` — nothing about this angle/hook/structure/CTA combination is
 *                   deterministically measurable. Compliance was NOT verified.
 */
export type ComplianceStatus = "passed" | "failed" | "not_checked";

export interface ComplianceResult {
  status: ComplianceStatus;
  /** True when at least one dimension was actually evaluated. */
  evaluated: boolean;
  /**
   * False ONLY when a checked requirement failed. An unverified result keeps
   * `passed: true` so that "we cannot check this" never blocks generation —
   * read `status`/`evaluated` to tell verified from unverified.
   */
  passed: boolean;
  reasons: string[];
  /** Which dimensions this run actually evaluated. */
  checked: { angle: boolean; hook: boolean; cta: boolean; structure: boolean };
}

export interface ComplianceCheckParams {
  text: string;
  angle: ContentAngle;
  pattern: PostPattern;
}

/** Neutral result for callers with no angle/pattern to check against. */
export const NO_COMPLIANCE_CHECK: ComplianceResult = {
  status: "not_checked",
  evaluated: false,
  passed: true,
  reasons: [],
  checked: { angle: false, hook: false, cta: false, structure: false },
};

// ─── Text helpers ───────────────────────────────────────────────────────────

// JS regex `\b` is ASCII-only — it never fires correctly around Cyrillic
// letters (they are not `\w`), so `/вместо\b/i` silently fails to match. This
// hand-rolled lookaround stands in for a Cyrillic-aware word boundary.
const CYRILLIC = "а-яА-ЯёЁ";
function bgWord(word: string): string {
  return `(?<![${CYRILLIC}])${word}(?![${CYRILLIC}])`;
}

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Drops the hashtag block posts end with, so it is never mistaken for content. */
const TRAILING_HASHTAGS_RE = /(?:\s*#[^\s#]+)+\s*$/;
function stripTrailingHashtags(text: string): string {
  return text.replace(TRAILING_HASHTAGS_RE, "").trim();
}

/**
 * The post as readable units: lines first (a list item rarely ends in a full
 * stop), then sentences within each line. Trailing hashtags are gone.
 */
function segments(text: string): string[] {
  return stripTrailingHashtags(text)
    .split(/\n+/)
    .flatMap((line) => splitSentences(line))
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

const UNCHECKED_CTA_TYPES: readonly CtaType[] = ["Try It", "No CTA"];

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
};

const CTA_MISSING_DESCRIPTIONS: Partial<Record<CtaType, string>> = {
  Follow: "follow/connect invitation",
  "Comment Prompt": "comment/opinion request",
  Share: "share invitation",
  "Website Visit": "link/website visit prompt",
  "Open Question": "closing open-ended question",
};

// ─── CTA "Reflection" ───────────────────────────────────────────────────────
// CTA_INSTRUCTIONS.Reflection: "Close with a question or prompt that invites the
// reader to reflect on their own situation." Two things make this measurable
// without guessing at meaning:
//
//   1. It must CLOSE the post. A question in the opening line is a hook, not a
//      CTA — so the opening segment is never eligible, however reflective it
//      reads ("но къде отиват пътниците?" is about the article, not the reader).
//   2. It must address the READER. "Reflect on their own situation" means a
//      second-person reference is not optional, and requiring one is what stops
//      this from degrading into "accepts any question".
//
// Both conditions must hold in the closing segments. A reflective imperative
// ("замислете се", "ask yourself") counts without a question mark — it is
// already second-person and already a prompt.

/** How many closing segments count as "the end of the post". */
const REFLECTION_TAIL_SEGMENTS = 2;

const READER_REFERENCE_PATTERNS: RegExp[] = [
  new RegExp(bgWord("вие"), "i"),
  new RegExp(bgWord("ви"), "i"),
  new RegExp(bgWord("вас"), "i"),
  new RegExp(bgWord("ваш(?:а|о|и|ия|ият|ите)?"), "i"),
  new RegExp(bgWord("бихте"), "i"),
  new RegExp(bgWord("ти"), "i"),
  new RegExp(bgWord("теб(?:е)?"), "i"),
  new RegExp(bgWord("тво(?:й|я|е|и|ят|ята|ето|ите)"), "i"),
  // Deliberately NOT "би" — that is third person ("той би"), not the reader.
  /\byou(?:r|rs|rself)?\b/i,
];

const REFLECTIVE_PROMPT_PATTERNS: RegExp[] = [
  /помисл(?:ете|и)\s/i,
  /замисл(?:ете|и)\s*се/i,
  /запитайте\s*се/i,
  /представете\s*си/i,
  /преценете\s/i,
  /\bask\s+yourself\b/i,
  /\b(?:think|reflect)\s+(?:about|on)\b/i,
  /\btake\s+a\s+moment\s+to\b/i,
  /\bconsider\s+(?:how|what|which|whether|your)\b/i,
];

/**
 * The closing portion of the post. The opening segment is excluded on purpose
 * (see above) unless it is the only thing there is.
 */
function closingSegments(text: string): string[] {
  const all = segments(text);
  if (all.length <= 1) return all;
  return all.slice(Math.max(1, all.length - REFLECTION_TAIL_SEGMENTS));
}

function checkReflectionCta(text: string): { passed: boolean; reason: string | null } {
  const tail = closingSegments(text).join(" ");
  const readerDirected = READER_REFERENCE_PATTERNS.some((re) => re.test(tail));
  const reflectiveQuestion = readerDirected && tail.includes("?");
  const reflectivePrompt = REFLECTIVE_PROMPT_PATTERNS.some((re) => re.test(tail));

  if (reflectiveQuestion || reflectivePrompt) return { passed: true, reason: null };
  return {
    passed: false,
    reason:
      "Reflection CTA is required; no reader-directed reflective question or prompt was found near the end of the post.",
  };
}

function checkCta(text: string, ctaType: CtaType): { passed: boolean; reason: string | null } {
  if (UNCHECKED_CTA_TYPES.includes(ctaType)) return { passed: true, reason: null };
  if (ctaType === "Reflection") return checkReflectionCta(text);

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

// ─── Angle "Myth vs Fact" — misconception named, then corrected ─────────────
// ANGLE_INSTRUCTIONS["Myth vs Fact"]: "Open by debunking a common misconception
// about the topic." Debunking has two halves, and BOTH are required in the
// opening: something presented as commonly believed, and something that
// contradicts or replaces it. Requiring the pair is what keeps this
// conservative — a correction word alone ("но", "actually") is ordinary
// connective prose and appears in almost every post, so on its own it proves
// nothing. The literal words "мит"/"факт" are one accepted phrasing among many,
// never a requirement.

const MYTH_OPENING_CHARS = 400;

const MISCONCEPTION_PATTERNS: RegExp[] = [
  // Bulgarian
  new RegExp(bgWord("мит(?:ът|а|овете)?"), "i"),
  new RegExp(bgWord("заблуда(?:та)?"), "i"),
  /често\s+се\s+(?:смята|мисли|вярва|приема|твърди)/i,
  /(?:смята|мисли|вярва|приема)\s+се,?\s+че/i,
  /(?:повечето|много|мнозина)\s+(?:хора\s+)?(?:мислят|смятат|вярват|предполагат|очакват)/i,
  /(?:може(?:те)?|бихте)\s+да\s+(?:мислите|смятате|предполагате|помислите)/i,
  /(?:мислите|смятате|предполагате|очаквате),?\s+че/i,
  /погрешно\s+(?:се\s+)?(?:смята|мисли|вярва)/i,
  /не\s+е\s+вярно/i,
  /(?:звучи|изглежда)\s+логично/i,
  // English
  /\bmyths?\b/i,
  /\bmisconceptions?\b/i,
  /\b(?:most|many)\s+(?:people\s+)?(?:think|believe|assume|expect)\b/i,
  /\byou(?:'|’)?(?:d|ll)?\s+(?:might|may|probably)\s+(?:think|assume|believe|expect)\b/i,
  /\b(?:it(?:'|’)s|is)\s+(?:often|commonly|widely)\s+(?:said|believed|assumed|thought)\b/i,
  /\bconventional\s+wisdom\b/i,
];

const CORRECTION_PATTERNS: RegExp[] = [
  // Bulgarian
  new RegExp(bgWord("факт(?:ът|а|ите)?"), "i"),
  new RegExp(bgWord("всъщност"), "i"),
  new RegExp(bgWord("но"), "i"),
  new RegExp(bgWord("обаче"), "i"),
  /в\s+действителност/i,
  /(?:истината|реалността)\s+е/i,
  /(?:данните|проучванията|статистиката|числата)\s+показва(?:т)?/i,
  // English
  /\bfacts?\b/i,
  /\bactually\b/i,
  /\bin\s+reality\b/i,
  /\bthe\s+truth\s+is\b/i,
  /\b(?:but|however|yet)\b/i,
  /\b(?:the\s+)?(?:data|research|studies|numbers)\s+shows?\b/i,
];

// "Не X, а Y." / "Not X, but Y." — a complete debunk in one construction: the
// misconception and its replacement are both inside the pattern itself.
const NEGATION_REPLACEMENT_PATTERNS: RegExp[] = [
  new RegExp(`${bgWord("не")}\\s+[^,.!?]{1,60},\\s*${bgWord("а")}\\s+`, "i"),
  /\bnot\s+[^,.!?]{1,60},?\s*but\s+/i,
];

function checkMythVsFact(text: string): { passed: boolean; reason: string | null } {
  const opening = stripTrailingHashtags(text).slice(0, MYTH_OPENING_CHARS);

  const debunked =
    NEGATION_REPLACEMENT_PATTERNS.some((re) => re.test(opening)) ||
    (MISCONCEPTION_PATTERNS.some((re) => re.test(opening)) &&
      CORRECTION_PATTERNS.some((re) => re.test(opening)));

  if (debunked) return { passed: true, reason: null };
  return {
    passed: false,
    reason:
      "Myth vs Fact requires the opening to challenge a clear misconception and replace it with a supported fact.",
  };
}

// ─── Hook "Contrast" — recognizable contrast construction in the opening ──

const CONTRAST_OPENING_CHARS = 220;

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

// ─── Structure "List" — 3–5 distinct scannable items ───────────────────────
// STRUCTURE_INSTRUCTIONS.List: "Present 3–5 points in a numbered or bulleted,
// scannable format." The instruction names the format AND the count, so this is
// the one structure that can be measured without judging prose. Only genuine
// markers count: a paragraph of comma-separated clauses is not a list, and a
// bullet holding nothing but hashtags is not a point.

const MIN_LIST_ITEMS = 3;
const MAX_LIST_ITEMS = 5;

function countListItems(text: string): number {
  const seen = new Set<string>();
  for (const raw of extractListItems(text)) {
    const item = stripTrailingHashtags(raw);
    if (!item) continue; // a hashtag-only bullet is not a point
    seen.add(item.toLowerCase().replace(/\s+/g, " "));
  }
  return seen.size;
}

function checkListStructure(text: string): { passed: boolean; reason: string | null } {
  const count = countListItems(text);
  if (count >= MIN_LIST_ITEMS && count <= MAX_LIST_ITEMS) return { passed: true, reason: null };
  return {
    passed: false,
    reason: `List structure requires ${MIN_LIST_ITEMS}–${MAX_LIST_ITEMS} scannable list items; found ${count}.`,
  };
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function validateGenerationCompliance(params: ComplianceCheckParams): ComplianceResult {
  const { text, angle, pattern } = params;
  const reasons: string[] = [];

  const angleChecked = angle === "Tips & Tricks" || angle === "Myth vs Fact";
  if (angle === "Tips & Tricks") {
    const tips = checkTipsAndTricks(text, pattern.ctaType);
    if (!tips.passed && tips.reason) reasons.push(tips.reason);
  } else if (angle === "Myth vs Fact") {
    const myth = checkMythVsFact(text);
    if (!myth.passed && myth.reason) reasons.push(myth.reason);
  }

  const hookChecked = pattern.hookType === "Contrast";
  if (hookChecked) {
    const hook = checkContrastHook(text);
    if (!hook.passed && hook.reason) reasons.push(hook.reason);
  }

  const structureChecked = pattern.structure === "List";
  if (structureChecked) {
    const list = checkListStructure(text);
    if (!list.passed && list.reason) reasons.push(list.reason);
  }

  const ctaChecked = !UNCHECKED_CTA_TYPES.includes(pattern.ctaType);
  if (ctaChecked) {
    const cta = checkCta(text, pattern.ctaType);
    if (!cta.passed && cta.reason) reasons.push(cta.reason);
  }

  const evaluated = angleChecked || hookChecked || structureChecked || ctaChecked;
  const passed = reasons.length === 0;

  return {
    // Nothing measurable was measured → the gate certifies nothing. It stays
    // non-blocking (`passed` is still true) but must not read as a pass.
    status: !evaluated ? "not_checked" : passed ? "passed" : "failed",
    evaluated,
    passed,
    reasons,
    checked: {
      angle: angleChecked,
      hook: hookChecked,
      cta: ctaChecked,
      structure: structureChecked,
    },
  };
}
