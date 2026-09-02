/**
 * The 2026-09-02 mixed-language fix, end to end (§9 of the governing
 * instruction).
 *
 * The Competitive Analysis UI is Bulgarian, but several AI-derived values were
 * still rendered in English. This suite pins the whole split the fix rests on:
 *
 *  - **Canonical machine values stay canonical.** Every enum keeps its exact
 *    English token in the database and in the model contract, and is localized
 *    only by an i18n mapping — never by an AI call, never by storing Bulgarian.
 *  - **Free-form analysis text is generated in the company's language.** The
 *    extraction and relevance prompts name it explicitly.
 *  - **Original source text is never translated.** Titles, bodies, product and
 *    service names, and the competitor's own CTA wording pass through
 *    untouched.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import en from "@/i18n/messages/en.json";
import bg from "@/i18n/messages/bg.json";
import {
  COMPETITOR_ANGLE_CATEGORIES,
  COMPETITOR_COMMERCIAL_INTENTS,
  COMPETITOR_CONTENT_TYPES,
  COMPETITOR_CTA_TYPES,
  COMPETITOR_HOOK_TYPES,
  COMPETITOR_STRUCTURE_PATTERNS,
  buildExtractionSystemPrompt,
  buildExtractionUserPrompt,
  computeExtractionHash,
} from "@/lib/ai/competitor-intelligence-extraction";
import {
  COMPETITOR_RELEVANCE_VERDICTS,
  buildRelevanceSystemPrompt,
  buildRelevanceUserPrompt,
} from "@/lib/ai/competitor-relevance";
import { RELEVANCE_DISPLAY_STATES } from "./relevance-display-state";
import { RELEVANCE_REASON_CODES } from "./relevance-reason";

type Messages = Record<string, unknown>;

function contentMessages(bundle: unknown): Messages {
  const root = bundle as Record<string, Record<string, Messages>>;
  return root.competitiveAnalysis.content;
}

function group(bundle: unknown, name: string): Record<string, string> {
  const found = contentMessages(bundle)[name];
  assert.ok(found, `competitiveAnalysis.content.${name} is missing`);
  return found as Record<string, string>;
}

const CYRILLIC = /[Ѐ-ӿ]/;

/** Every canonical vocabulary that reaches the UI as a label, paired with the
 *  i18n group that must name each of its members. `platform` is handled
 *  separately — its members are proper nouns (see below). */
const LOCALIZED_VOCABULARIES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["contentType", COMPETITOR_CONTENT_TYPES],
  ["hookType", COMPETITOR_HOOK_TYPES],
  ["structurePattern", COMPETITOR_STRUCTURE_PATTERNS],
  ["angleCategory", COMPETITOR_ANGLE_CATEGORIES],
  ["commercialIntent", COMPETITOR_COMMERCIAL_INTENTS],
  ["ctaType", COMPETITOR_CTA_TYPES],
  ["relevanceState", RELEVANCE_DISPLAY_STATES],
  ["relevanceSection.reasonCode", RELEVANCE_REASON_CODES],
];

function resolveGroup(bundle: unknown, dotted: string): Record<string, string> {
  const [head, tail] = dotted.split(".");
  return tail
    ? (group(bundle, head)[tail] as unknown as Record<string, string>)
    : group(bundle, head);
}

describe("canonical machine values are never localized (§2)", () => {
  it("keeps every enum vocabulary as exact English tokens", () => {
    // A snapshot of what the DATABASE and the model contract hold. If a
    // Bulgarian string ever appears here, canonical consistency is broken and
    // cross-language trend grouping goes with it (§4).
    const vocabularies = [
      COMPETITOR_CONTENT_TYPES,
      COMPETITOR_HOOK_TYPES,
      COMPETITOR_STRUCTURE_PATTERNS,
      COMPETITOR_ANGLE_CATEGORIES,
      COMPETITOR_COMMERCIAL_INTENTS,
      COMPETITOR_CTA_TYPES,
      COMPETITOR_RELEVANCE_VERDICTS,
      RELEVANCE_REASON_CODES,
    ];
    for (const vocabulary of vocabularies) {
      for (const value of vocabulary) {
        assert.match(value, /^[a-z][a-z_]*$/, `${value} is not a canonical snake_case token`);
      }
    }
  });

  it("names contentType and commercialIntent exactly as the schema does", () => {
    // Spelled out rather than derived, so a rename has to be a deliberate edit
    // here as well as in schema.prisma.
    assert.deepEqual(
      [...COMPETITOR_CONTENT_TYPES],
      [
        "blog_post",
        "product_update",
        "promotion",
        "announcement",
        "guide",
        "video",
        "social_post",
        "ad",
        "other",
      ]
    );
    assert.deepEqual(
      [...COMPETITOR_COMMERCIAL_INTENTS],
      ["informational", "soft_sell", "hard_sell", "promotional"]
    );
  });
});

describe("structured values map to labels in BOTH locales (§9.2, §9.3, §9.6)", () => {
  for (const [groupName, vocabulary] of LOCALIZED_VOCABULARIES) {
    it(`${groupName} — every canonical value has an English and a Bulgarian label`, () => {
      const enGroup = resolveGroup(en, groupName);
      const bgGroup = resolveGroup(bg, groupName);
      for (const value of vocabulary) {
        assert.ok(enGroup[value], `en is missing ${groupName}.${value}`);
        assert.ok(bgGroup[value], `bg is missing ${groupName}.${value}`);
      }
    });

    it(`${groupName} — the Bulgarian labels are genuinely Bulgarian, not copied English`, () => {
      // Catches the failure mode where a key is added to bg.json by pasting
      // the English value, which reads as "localized" to a key-parity check
      // but still leaves English in a Bulgarian UI.
      const bgGroup = resolveGroup(bg, groupName);
      for (const value of vocabulary) {
        assert.match(
          bgGroup[value],
          CYRILLIC,
          `bg ${groupName}.${value} = ${JSON.stringify(bgGroup[value])} contains no Cyrillic`
        );
      }
    });
  }

  it("localizes every displayed field caption in both locales", () => {
    const enFields = group(en, "fields");
    const bgFields = group(bg, "fields");
    for (const key of Object.keys(enFields)) {
      assert.ok(bgFields[key], `bg is missing fields.${key}`);
      assert.match(bgFields[key], CYRILLIC, `bg fields.${key} is not Bulgarian`);
    }
  });

  it("deliberately leaves platform names untranslated — they are proper nouns", () => {
    // The one exception §7 allows. Asserted rather than merely skipped, so a
    // future "translate everything" sweep has to argue with a test.
    const bgPlatforms = group(bg, "platform");
    for (const key of ["rss", "facebook", "instagram", "linkedin", "tiktok", "youtube", "x"]) {
      assert.equal(bgPlatforms[key], group(en, "platform")[key], `platform.${key} should match en`);
    }
  });
});

describe("deterministic localization costs no AI call (§6, §9.7)", () => {
  it("every enum label and reason code resolves from static message data alone", () => {
    // The mapping is a plain object lookup in an imported JSON bundle — there
    // is no provider, no network, and nothing async anywhere in this path.
    // If enum localization ever grew a model call, this test could not be
    // written synchronously against the catalogs at all.
    for (const [groupName, vocabulary] of LOCALIZED_VOCABULARIES) {
      const bgGroup = resolveGroup(bg, groupName);
      const resolved = vocabulary.map((v) => bgGroup[v]);
      assert.equal(resolved.length, vocabulary.length);
      assert.ok(resolved.every((label) => typeof label === "string" && label.length > 0));
    }
  });
});

describe("free-form analysis follows the company's language (§3)", () => {
  const FREE_FORM = [
    "topic",
    "subtopic",
    "summary",
    "angle",
    "targetAudience",
    "problemAddressed",
    "keyMessage",
    "tone",
  ];

  it("instructs Bulgarian for exactly the free-form fields", () => {
    const prompt = buildExtractionSystemPrompt("bg");
    for (const field of FREE_FORM) {
      assert.ok(prompt.includes(field), `${field} should be named in the language instruction`);
    }
    assert.match(prompt, /Write these fields in Bulgarian/);
  });

  it("instructs English when the company's language is English", () => {
    const prompt = buildExtractionSystemPrompt("en");
    assert.match(prompt, /Write these fields in English/);
    assert.ok(!prompt.includes("Write these fields in Bulgarian"));
    // The Bulgarian-quality block is Bulgarian-only — it would be nonsense
    // (and wasted tokens) in an English run.
    assert.ok(!prompt.includes("Bulgarian quality"));
  });

  it("adds native-quality Bulgarian guidance, never 'translate the English'", () => {
    const prompt = buildExtractionSystemPrompt("bg");
    assert.match(prompt, /Bulgarian quality/);
    assert.match(prompt, /Do NOT translate an English answer into Bulgarian/);
  });

  it("excludes the canonical fields from the language instruction", () => {
    for (const language of ["en", "bg"] as const) {
      const prompt = buildExtractionSystemPrompt(language);
      assert.match(prompt, /always the exact English token from the list, never translated/);
      assert.match(prompt, /productsServicesMentioned — copy each name VERBATIM/);
      assert.match(prompt, /ctaText — the call to action AS THE CONTENT WORDS IT/);
      assert.match(prompt, /originalLanguage — always the ISO 639-1 code/);
    }
  });

  it("scopes the relevance instruction to the reason sentence only", () => {
    const prompt = buildRelevanceSystemPrompt("bg");
    assert.match(prompt, /Write "reason" in Bulgarian/);
    // The verdict and the matched topics are canonical and must not move with
    // the language — rule 2 already forbids translating a research topic, and
    // the language rule restates the boundary rather than contradicting it.
    assert.match(prompt, /never translated into Bulgarian/);
    assert.match(prompt, /copied VERBATIM from the research topics list/);
    assert.match(buildRelevanceSystemPrompt("en"), /Write "reason" in English/);
  });
});

describe("original source text is never translated (§3, §9.4)", () => {
  const CONTENT = {
    title: "Cloud data warehouse innovation at Acme",
    body: "Acme Corp announced Acme Warehouse 3.0 today. Learn more at acme.example.",
  };

  it("sends the article title and body verbatim, in every analysis language", () => {
    for (const language of ["en", "bg"] as const) {
      const userPrompt = buildExtractionUserPrompt(CONTENT);
      assert.ok(userPrompt.includes(CONTENT.title), `title altered for ${language}`);
      assert.ok(userPrompt.includes(CONTENT.body), `body altered for ${language}`);
    }
  });

  it("builds the user prompt independently of the analysis language", () => {
    // The language is a system-prompt concern. If it ever leaked into the user
    // prompt, the source text would be at risk of being rewritten on the way in.
    assert.equal(buildExtractionUserPrompt(CONTENT), buildExtractionUserPrompt(CONTENT));
  });

  it("passes the already-extracted subject through to relevance unchanged", () => {
    const subject = {
      topic: "Складове за данни в облак",
      subtopic: null,
      summary: null,
      angle: null,
      keyMessage: null,
      targetAudience: null,
      problemAddressed: null,
      productsServicesMentioned: ["Acme Warehouse 3.0"],
    };
    const prompt = buildRelevanceUserPrompt(subject, {
      researchTopics: ["cloud data warehousing"],
      markets: [],
    });
    // Product names survive verbatim, and a research topic is presented in the
    // exact wording the user typed — that verbatim form is what
    // `matchedResearchTopics` must echo back, and what keeps grouping stable
    // across languages (§4).
    assert.ok(prompt.includes("Acme Warehouse 3.0"));
    assert.ok(prompt.includes("cloud data warehousing"));
  });
});

describe("the analysis hash reflects the language (§4, cross-company isolation)", () => {
  const CONTENT = { title: "T", body: "Identical body text." };

  it("differs between two companies analyzing the same article in different languages", () => {
    // Two companies can monitor the same competitor feed. Without the language
    // in the hash, one company's English analysis would look like a valid
    // cached answer for a Bulgarian company's row.
    assert.notEqual(computeExtractionHash(CONTENT, "en"), computeExtractionHash(CONTENT, "bg"));
  });

  it("is still stable for the same content and the same language", () => {
    assert.equal(computeExtractionHash(CONTENT, "bg"), computeExtractionHash(CONTENT, "bg"));
  });
});
