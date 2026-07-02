// Obvious platform-level unsafe terms. Intentionally minimal for Phase 5.D.
// Future: replace with provider moderation API or safety classifier.
const PLATFORM_SAFETY_KEYWORDS: string[] = [
  "kill",
  "murder",
  "suicide",
  "bomb",
  "terrorist",
  "terrorism",
  "weapon",
  "pornography",
  "explicit",
  "xxx",
  "hate speech",
  "self-harm",
  "overdose",
];

export interface SafetyCheckResult {
  flagged: boolean;
  matchedTerms: string[];
}

function normalizeForSearch(text: string): string {
  return text.toLowerCase().replace(/[^\w\s]/g, " ");
}

export function checkContentSafety(params: {
  text: string;
  brandForbiddenWords: string[];
}): SafetyCheckResult {
  const { text, brandForbiddenWords } = params;
  const normalized = normalizeForSearch(text);
  const matchedTerms: string[] = [];

  for (const term of PLATFORM_SAFETY_KEYWORDS) {
    const needle = normalizeForSearch(term);
    if (normalized.includes(needle)) {
      matchedTerms.push(term);
    }
  }

  for (const word of brandForbiddenWords) {
    if (!word) continue;
    const needle = normalizeForSearch(word);
    if (normalized.includes(needle) && !matchedTerms.includes(word)) {
      matchedTerms.push(word);
    }
  }

  return {
    flagged: matchedTerms.length > 0,
    matchedTerms,
  };
}
