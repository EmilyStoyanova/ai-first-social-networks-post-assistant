import {
  assertTranslationCoverage,
  assessBulgarian,
  detectRepetition,
  isBulgarianTarget,
  TranslationParseError,
  type TranslationReplyMode,
} from "@/lib/ai/feed-item-translation";

/**
 * The quality gate applied to a translation AFTER an engine has produced it.
 *
 * The prompt-based engine runs these same checks inside `parseTranslationResponse`,
 * where they follow the JSON parsing they belong to. A dedicated NMT engine returns
 * plain strings and has no JSON step at all — but it must clear exactly the same bar,
 * because the bar is about the TEXT, not the transport: an untranslated English body,
 * a Macedonian one, or a decoding loop are all equally unusable however they arrived.
 *
 * Kept as its own module rather than folded into `feed-item-translation.ts` so the
 * validated, byte-stable parsing logic there is not disturbed; the checks themselves
 * are the exported primitives from that file, so the two paths cannot drift apart on
 * what counts as Bulgarian or what counts as a loop.
 */

export interface TranslatedText {
  translatedTitle: string | null;
  translatedContent: string | null;
}

/**
 * Throws a {@link TranslationParseError} when the translation is unusable.
 *
 * Reasons match the prompt-based path exactly (`empty_translation`, `wrong_language`,
 * `repetition`, `incomplete_translation`) so a failure is recorded, logged and retried
 * identically whichever engine produced it.
 *
 * `sourceContent` is the body this translation was made FROM, in the same
 * representation as `text` — placeholders and all, since this gate is handed the
 * placeholder form for the language check's own reasons (see the caller). Supplied, the
 * translation is additionally checked for completeness; omitted, that check is skipped,
 * so no existing caller changes behaviour by not passing it.
 */
export function assertUsableTranslation(
  text: TranslatedText,
  targetLang: string,
  mode: TranslationReplyMode,
  sourceContent?: string | null
): void {
  const title = text.translatedTitle?.trim() ?? "";

  if (mode === "title_only") {
    if (title === "") {
      throw new TranslationParseError("Translation returned no title.", "empty_translation");
    }
    assertTargetLanguage(title, targetLang);
    return;
  }

  const content = text.translatedContent?.trim() ?? "";
  if (content === "") {
    throw new TranslationParseError("Translation returned no content.", "empty_translation");
  }

  // Title and body are judged together: a headline is far too short to assess on its
  // own, and judging it separately is how a two-word title gets condemned.
  assertTargetLanguage(`${title}\n${content}`, targetLang);

  const loop = detectRepetition(content);
  if (loop) {
    throw new TranslationParseError(
      `Translation degenerated into a ${loop.kind} loop ("${loop.sample}" ×${loop.count}).`,
      "repetition",
      { repetition: loop }
    );
  }

  // Last, for the same reason as in `parseTranslationResponse`: a reply that is also
  // in the wrong language, or is a decoding loop, is more usefully named as that.
  assertTranslationCoverage(sourceContent, content);
}

/**
 * Throws `wrong_language` when a Bulgarian target got something measurably not it.
 *
 * Mirrors `assertBulgarianEnough` in feed-item-translation.ts, including the two
 * distinct messages — "the source appears untranslated" and "carries Serbian/
 * Macedonian/Russian letters" are different operator problems and must stay
 * distinguishable in the logs.
 */
function assertTargetLanguage(text: string, targetLang: string): void {
  if (!isBulgarianTarget(targetLang)) return;
  const a = assessBulgarian(text);
  if (a.verdict === "bulgarian") return;

  if (a.verdict === "not_cyrillic") {
    const totalLetters = a.cyrillicLetters + a.latinLetters + a.otherLetters;
    const drift = a.otherLetters > 0 ? `, ${a.otherLetters} in another script entirely` : "";
    throw new TranslationParseError(
      `Translation is not Bulgarian — only ${a.cyrillicLetters} of ${totalLetters} letters are Cyrillic${drift} (the source appears untranslated).`,
      "wrong_language"
    );
  }
  throw new TranslationParseError(
    `Translation is not Bulgarian — ${a.foreignWords} distinct word(s) and ${a.foreignCyrillic} of ${a.cyrillicLetters} Cyrillic letters (${(a.foreignRatio * 100).toFixed(1)}%) carry Serbian/Macedonian/Russian letters: ${a.distinctForeign.join(", ")}.`,
    "wrong_language"
  );
}
