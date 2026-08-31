/**
 * Language quality: two narrow, deterministic guards on generated text.
 *
 * This is NOT a grammar checker, and must not grow into one. It answers two
 * questions that have unambiguous textual signals and no judgement in them:
 *
 * 1. Did the model emit a construction we KNOW it gets wrong? The list is
 *    hand-curated from observed output, not derived. Its first member is
 *    "Има ли ти мислил" — word-order salad that no Bulgarian speaker produces
 *    (the correct form is "Мислил ли си"), which the model nonetheless wrote at
 *    the head of eleven of twenty consecutive Facebook posts.
 *
 * 2. Is the post even in the language the channel asked for? A Bulgarian channel
 *    received posts opening "Ever found yourself fumbling with two separate
 *    taps…". No amount of style guidance is relevant to a post in the wrong
 *    language, and nothing downstream was checking.
 *
 * BOTH ARE ABSOLUTE, unlike opening diversity next door: a malformed phrase is
 * wrong on its own terms and an English post on a Bulgarian channel is
 * unpublishable, neither of which depends on what was posted last week. That is
 * exactly why they live here and not in opening-diversity.ts, and why a correct
 * reflection opener ("Мислил ли си някога…") passes this file untouched — it is
 * good Bulgarian, and whether it is REPETITIVE Bulgarian is the other file's
 * question.
 *
 * ADDING A RULE. Append to MALFORMED_CONSTRUCTIONS with a regex tight enough
 * that it cannot fire on well-formed text, and add both a positive and a
 * negative test. A rule that is merely a style preference does not belong here.
 */

export type LanguageFailureKind = "malformed_construction" | "wrong_language";

export interface LanguageFailure {
  kind: LanguageFailureKind;
  /** Stable identifier — the construction's id, or "wrong_language". */
  id: string;
  /** Model-facing explanation, used verbatim in the retry prompt. */
  reason: string;
}

export interface LanguageQualityResult {
  /** False when no supported language was declared — then nothing was checked. */
  evaluated: boolean;
  passed: boolean;
  failures: LanguageFailure[];
}

/** The languages this file knows how to judge. Anything else is not evaluated. */
export type SupportedLanguage = "BG" | "EN";

export interface MalformedConstruction {
  id: string;
  language: SupportedLanguage;
  pattern: RegExp;
  reason: string;
}

/**
 * Constructions the model produces that are simply wrong. Deliberately tiny.
 *
 * Each pattern must be anchored on the specific broken word order or agreement,
 * never on a keyword — "мислил" on its own is perfectly good Bulgarian and
 * appears in the correct form ("Мислил ли си…") that must keep passing.
 */
export const MALFORMED_CONSTRUCTIONS: readonly MalformedConstruction[] = [
  {
    id: "bg_ima_li_ti_mislil",
    language: "BG",
    // "има ли ти/ви/си/сте + мислил/замислял/чувал/знаел" — the interrogative
    // built on "има" instead of on the verb itself. The grammatical form puts
    // the participle first: "Мислил ли си…", "Замислял ли си се…".
    pattern:
      /(^|[^\p{L}])има\s+ли\s+(ти|ви|си|сте)\s+(мислил|мислила|мислили|замислял|замисляла|замисляли|чувал|чувала|чували|знаел|знаела|знаели|представял|представяла|представяли)/iu,
    reason:
      'The construction "Има ли ти мислил" is not grammatical Bulgarian — the interrogative is built on the participle, not on "има". Write "Мислил ли си…", "Замислял ли си се…" or rephrase the sentence entirely.',
  },
];

/**
 * How many letters a post needs before its script mix is evidence of anything.
 * A three-word teaser is not a language sample.
 */
export const MIN_SCRIPT_SAMPLE_LETTERS = 40;

/**
 * Share of letters that must belong to the required language's script.
 *
 * Set at half deliberately. Real Bulgarian marketing copy sits at 0.85–1.00 even
 * when it names "Grohe Eurosmart Cosmopolitan" and a model code; genuinely
 * English copy sits at 0.00. Nothing legitimate lands near the middle, so the
 * threshold only has to be high-confidence, not finely tuned.
 */
export const MIN_EXPECTED_SCRIPT_RATIO = 0.5;

const URL_RE = /(https?:\/\/\S+|www\.\S+)/gi;
/** Hashtags and @mentions — routinely English on a Bulgarian post, and not prose. */
const TAG_RE = /[#@][^\s#@]+/g;
const EMOJI_RE = /[\p{Extended_Pictographic}\p{Emoji_Presentation}️]/gu;

const CYRILLIC_RE = /\p{Script=Cyrillic}/gu;
const LATIN_RE = /\p{Script=Latin}/gu;

function normalizeLanguage(language: string | null | undefined): SupportedLanguage | null {
  const upper = (language ?? "").trim().toUpperCase();
  return upper === "BG" || upper === "EN" ? upper : null;
}

/**
 * Letter counts by script, after removing everything that is legitimately
 * foreign in any language: URLs, hashtags, @mentions and emoji. Brand names and
 * model codes are NOT removed — they stay in the count, which is why the
 * threshold is a ratio and not a boolean.
 */
function scriptProfile(text: string): { cyrillic: number; latin: number; total: number } {
  const prose = text.replace(URL_RE, " ").replace(TAG_RE, " ").replace(EMOJI_RE, " ");
  const cyrillic = (prose.match(CYRILLIC_RE) ?? []).length;
  const latin = (prose.match(LATIN_RE) ?? []).length;
  return { cyrillic, latin, total: cyrillic + latin };
}

function checkScript(text: string, language: SupportedLanguage): LanguageFailure | null {
  const { cyrillic, latin, total } = scriptProfile(text);
  if (total < MIN_SCRIPT_SAMPLE_LETTERS) return null;

  const expected = language === "BG" ? cyrillic : latin;
  const ratio = expected / total;
  if (ratio >= MIN_EXPECTED_SCRIPT_RATIO) return null;

  return {
    kind: "wrong_language",
    id: "wrong_language",
    reason:
      language === "BG"
        ? "The post must be written in Bulgarian, but it is predominantly in another language. Rewrite the entire post in Bulgarian (brand names, model codes, hashtags and URLs may stay as they are)."
        : "The post must be written in English, but it is predominantly in another language. Rewrite the entire post in English.",
  };
}

/**
 * Runs both guards. Returns `evaluated: false` — and passes — when no supported
 * language was declared, because a check that could not run must never read as
 * a check that succeeded.
 */
export function checkLanguageQuality(params: {
  text: string;
  language?: string | null;
}): LanguageQualityResult {
  const language = normalizeLanguage(params.language);
  if (!language) return { evaluated: false, passed: true, failures: [] };

  const failures: LanguageFailure[] = [];

  for (const rule of MALFORMED_CONSTRUCTIONS) {
    if (rule.language !== language) continue;
    if (rule.pattern.test(params.text)) {
      failures.push({ kind: "malformed_construction", id: rule.id, reason: rule.reason });
    }
  }

  const script = checkScript(params.text, language);
  if (script) failures.push(script);

  return { evaluated: true, passed: failures.length === 0, failures };
}
