import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  ANALYSIS_ERROR_CODES,
  analysisErrorCodeValue,
  extractionRetryRemains,
  resolveAnalysisError,
} from "./analysis-error";
import { MAX_EXTRACTION_ATTEMPTS } from "@/lib/ai/competitor-intelligence-extraction";
import { toCompetitorContentItem, type CompetitorContentRow } from "./competitor-content-dto";

describe("extractionRetryRemains", () => {
  it("(1) is true below the attempt cap", () => {
    assert.equal(extractionRetryRemains({ attemptCount: 0, competitorArchived: false }), true);
    assert.equal(
      extractionRetryRemains({
        attemptCount: MAX_EXTRACTION_ATTEMPTS - 1,
        competitorArchived: false,
      }),
      true
    );
  });

  it("(2) is false once the attempt cap is reached, never past it", () => {
    assert.equal(
      extractionRetryRemains({ attemptCount: MAX_EXTRACTION_ATTEMPTS, competitorArchived: false }),
      false
    );
    assert.equal(
      extractionRetryRemains({
        attemptCount: MAX_EXTRACTION_ATTEMPTS + 5,
        competitorArchived: false,
      }),
      false
    );
  });

  it("is false for an archived competitor even with attempt budget left", () => {
    // The drain excludes archived competitors at selection — retries would
    // never actually happen, so promising one would be a lie.
    assert.equal(extractionRetryRemains({ attemptCount: 0, competitorArchived: true }), false);
  });
});

describe("analysisErrorCodeValue", () => {
  it("stores a canonical token, never a localized sentence", () => {
    assert.equal(analysisErrorCodeValue("no_readable_content"), "code:no_readable_content");
    assert.equal(
      analysisErrorCodeValue("content_too_short", { chars: 12, minimum: 40 }),
      "code:content_too_short:12:40"
    );
  });

  it("round-trips every declared code", () => {
    for (const code of ANALYSIS_ERROR_CODES) {
      const resolved = resolveAnalysisError(analysisErrorCodeValue(code), true);
      assert.equal(resolved?.kind, code);
    }
  });
});

describe("resolveAnalysisError — deterministic conditions", () => {
  it("(14) resolves the two conditions this pipeline decides on purpose", () => {
    assert.deepEqual(resolveAnalysisError("code:no_readable_content", true), {
      kind: "no_readable_content",
    });
    assert.deepEqual(resolveAnalysisError("code:content_too_short:12:40", true), {
      kind: "content_too_short",
      chars: 12,
      minimum: 40,
    });
  });

  it("recognizes the English sentences stored BEFORE this split", () => {
    // What makes existing rows localize with no migration and no re-analysis.
    assert.deepEqual(resolveAnalysisError("No readable content to analyze.", true), {
      kind: "no_readable_content",
    });
    assert.deepEqual(
      resolveAnalysisError("Content too short to analyze (10 chars, minimum 40).", true),
      {
        kind: "content_too_short",
        chars: 10,
        minimum: 40,
      }
    );
  });

  it("falls back to the generic wording when a legacy value carries no numbers", () => {
    assert.deepEqual(resolveAnalysisError("code:content_too_short", true), {
      kind: "content_too_short",
      chars: null,
      minimum: null,
    });
    assert.deepEqual(resolveAnalysisError("code:content_too_short:abc:40", true), {
      kind: "content_too_short",
      chars: null,
      minimum: 40,
    });
  });

  it("returns null for a healthy row — an empty column is not an error", () => {
    assert.equal(resolveAnalysisError(null, true), null);
    assert.equal(resolveAnalysisError(undefined, true), null);
    assert.equal(resolveAnalysisError("   ", true), null);
  });
});

describe("resolveAnalysisError — provider/internal failures", () => {
  it("(15) never exposes raw provider text — it classifies it as unknown", () => {
    const raw = [
      "Anthropic API error 529: overloaded_error at https://api.internal/v1/messages",
      "Competitive Intelligence extraction call exceeded its 60000ms budget.",
      "No usable extraction reply.",
      "ECONNREFUSED 10.0.0.4:5432",
    ];
    for (const message of raw) {
      const resolved = resolveAnalysisError(message, true);
      assert.deepEqual(resolved, { kind: "unknown", retryable: true });
      // The decisive property: nothing that crosses the boundary carries the
      // original text in any field.
      assert.equal(
        JSON.stringify(resolved).includes(message),
        false,
        "the raw message must not survive into the resolved value"
      );
    }
  });

  it("does not mistake a provider error that MENTIONS short content for the deterministic code", () => {
    const sentence = "Model refused: content too short to analyze reliably per policy.";
    assert.deepEqual(resolveAnalysisError(sentence, true), { kind: "unknown", retryable: true });
  });

  it("treats an unrecognized future code as unknown rather than printing the token", () => {
    assert.deepEqual(resolveAnalysisError("code:something_new", true), {
      kind: "unknown",
      retryable: true,
    });
  });
});

describe("(15) the API boundary itself", () => {
  const row = (
    analysisError: string | null,
    over: { attemptCount?: number; archived?: boolean } = {}
  ): CompetitorContentRow => ({
    id: "ci-1",
    competitorId: "comp-1",
    status: "failed",
    analysisError,
    attemptCount: over.attemptCount ?? 1,
    topic: null,
    subtopic: null,
    summary: null,
    angle: null,
    targetAudience: null,
    problemAddressed: null,
    keyMessage: null,
    tone: null,
    ctaText: null,
    contentType: null,
    commercialIntent: null,
    ctaType: null,
    angleCategory: null,
    hookType: null,
    structurePattern: null,
    productsServicesMentioned: [],
    originalLanguage: null,
    relevance: "pending",
    relevanceReason: null,
    matchedResearchTopics: [],
    relevanceProfileVersion: null,
    relevanceEvaluatedAt: null,
    competitor: { name: "Rival Ltd", archivedAt: over.archived ? new Date() : null },
    feedItem: { title: "T", content: "Body", url: "https://x.test/a", publishedAt: null },
    manualEntry: null,
  });

  it("strips raw provider text before it can ever reach a client", () => {
    // Resolved in the DTO rather than the component on purpose: the raw
    // message must not cross the wire at all, not merely go unrendered.
    const secret = "Anthropic API error: invalid x-api-key sk-ant-REDACTED-abc123";
    const dto = toCompetitorContentItem(row(secret, { attemptCount: 1 }));

    assert.deepEqual(dto.analysisError, { kind: "unknown", retryable: true });
    assert.equal(JSON.stringify(dto).includes("sk-ant"), false);
    assert.equal(JSON.stringify(dto).includes(secret), false);
  });

  it("(3) an exhausted retry budget still never leaks the raw provider text", () => {
    const secret = "TimeoutError: upstream did not respond within 60000ms (host 10.4.2.9)";
    const dto = toCompetitorContentItem(row(secret, { attemptCount: MAX_EXTRACTION_ATTEMPTS }));

    assert.deepEqual(dto.analysisError, { kind: "unknown", retryable: false });
    assert.equal(JSON.stringify(dto).includes("TimeoutError"), false);
    assert.equal(JSON.stringify(dto).includes("10.4.2.9"), false);
  });

  it("(1) an unknown error with attempt budget left is retryable", () => {
    const dto = toCompetitorContentItem(
      row("some provider hiccup", { attemptCount: MAX_EXTRACTION_ATTEMPTS - 1 })
    );
    assert.deepEqual(dto.analysisError, { kind: "unknown", retryable: true });
  });

  it("(2) an unknown error at the attempt cap is terminal", () => {
    const dto = toCompetitorContentItem(
      row("some provider hiccup", { attemptCount: MAX_EXTRACTION_ATTEMPTS })
    );
    assert.deepEqual(dto.analysisError, { kind: "unknown", retryable: false });
  });

  it("an archived competitor's row is terminal even with attempt budget left — the drain will not pick it up", () => {
    const dto = toCompetitorContentItem(
      row("some provider hiccup", { attemptCount: 0, archived: true })
    );
    assert.deepEqual(dto.analysisError, { kind: "unknown", retryable: false });
  });

  it("deterministic conditions keep their own wording regardless of retry state", () => {
    // The retryable/terminal split only ever qualifies the GENERIC message —
    // "no readable content" is equally true whichever way retries stand.
    const atCap = row("code:no_readable_content", { attemptCount: MAX_EXTRACTION_ATTEMPTS });
    assert.deepEqual(toCompetitorContentItem(atCap).analysisError, {
      kind: "no_readable_content",
    });
  });

  it("still carries the deterministic conditions through, classified", () => {
    assert.deepEqual(toCompetitorContentItem(row("code:no_readable_content")).analysisError, {
      kind: "no_readable_content",
    });
    assert.equal(toCompetitorContentItem(row(null)).analysisError, null);
  });
});

describe("analysis error i18n", () => {
  const load = (locale: string) =>
    JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "i18n", "messages", `${locale}.json`), "utf8")
    ).competitiveAnalysis.content.analysisError as Record<string, string>;

  const KEYS = [
    "no_readable_content",
    "content_too_short",
    "content_too_short_detail",
    "unknown",
    "unknownTerminal",
  ] as const;

  it("(4) the retryable and terminal generic messages are correct in both locales", () => {
    const en = load("en");
    const bg = load("bg");

    assert.equal(en.unknown, "Analysis failed. It will be retried automatically.");
    assert.equal(en.unknownTerminal, "Analysis failed.");
    assert.equal(bg.unknown, "Анализът не бе успешен. Ще бъде направен нов опит автоматично.");
    assert.equal(bg.unknownTerminal, "Анализът не бе успешен.");

    // The terminal message must not still promise a retry.
    assert.equal(/retried/i.test(en.unknownTerminal), false);
    assert.equal(/автоматично/.test(bg.unknownTerminal), false);
  });

  it("(14) every renderable state has an English AND a Bulgarian message", () => {
    const en = load("en");
    const bg = load("bg");
    for (const key of KEYS) {
      assert.equal(typeof en[key], "string", `en is missing ${key}`);
      assert.equal(typeof bg[key], "string", `bg is missing ${key}`);
    }
  });

  it("the Bulgarian messages are genuinely Bulgarian, not pasted English", () => {
    const bg = load("bg");
    for (const key of KEYS) {
      assert.match(bg[key]!, /[Ѐ-ӿ]/, `bg.${key} must be written in Cyrillic`);
    }
  });

  it("every code this module can resolve has a message key", () => {
    const en = load("en");
    for (const code of ANALYSIS_ERROR_CODES) {
      assert.equal(typeof en[code], "string", `no message for ${code}`);
    }
    assert.equal(typeof en.unknown, "string", "the generic fallback must exist");
  });

  it("the detail message keeps both placeholders the component passes", () => {
    for (const locale of ["en", "bg"]) {
      const message = load(locale).content_too_short_detail!;
      assert.ok(message.includes("{chars}"), `${locale} lost {chars}`);
      assert.ok(message.includes("{minimum}"), `${locale} lost {minimum}`);
    }
  });
});
