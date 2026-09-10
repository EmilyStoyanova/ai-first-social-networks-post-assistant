import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  briefFromClassification,
  briefFromUnderstanding,
  formatBrief,
  NO_ARTICLE_BRIEF,
} from "./research-brief";
import type { ArticleUnderstanding } from "../article-understanding";

const UNDERSTANDING: ArticleUnderstanding = {
  mainSubject: "Residents are protesting new tourism development in a protected coastal area.",
  centralThesis: "The development would breach the area's protected status.",
  centralConflict: "Local livelihoods against conservation rules.",
  articleType: "news",
  secondaryTopics: ["tourism", "planning permission"],
  incidentalTopics: ["beaches", "hotels"],
  entities: ["Coastal Council"],
  confidence: 0.82,
  evidence: [{ chunkIndex: 0, reason: "States the protest explicitly." }],
};

describe("no research agent exists", () => {
  it("the module takes no provider and makes no model call", () => {
    // Requirement 3, asserted structurally rather than trusted. The brief is a
    // FORMATTER over an understanding that already exists; a provider parameter
    // or an llm call here would be the fourth agent creeping back in — and it
    // would creep in quietly, as one convenient `await provider.generate(...)`.
    const source = readFileSync(
      join(process.cwd(), "lib", "ai", "agents", "research-brief.ts"),
      "utf8"
    );
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    for (const token of ["ILlmProvider", "provider", "generate(", "await ", "async "]) {
      assert.equal(
        code.includes(token),
        false,
        `research-brief.ts must not reference "${token}" — it would mean a model call`
      );
    }
  });

  it("every exported function is synchronous and pure of I/O", () => {
    for (const fn of [briefFromUnderstanding, briefFromClassification, formatBrief]) {
      assert.equal(fn.constructor.name, "Function", `${fn.name} must not be async`);
    }
  });
});

describe("briefFromUnderstanding", () => {
  it("maps every field through unchanged", () => {
    const brief = briefFromUnderstanding(UNDERSTANDING);
    assert.equal(brief.mainSubject, UNDERSTANDING.mainSubject);
    assert.equal(brief.centralThesis, UNDERSTANDING.centralThesis);
    assert.equal(brief.centralConflict, UNDERSTANDING.centralConflict);
    assert.equal(brief.articleType, "news");
    assert.deepEqual([...brief.secondaryTopics], ["tourism", "planning permission"]);
    assert.deepEqual([...brief.incidentalTopics], ["beaches", "hotels"]);
    assert.equal(brief.confidence, 0.82);
    assert.equal(brief.source, "understanding");
  });
});

describe("briefFromClassification — the lossy projection persisted today", () => {
  it("keeps the subject and records that the brief is a projection", () => {
    const brief = briefFromClassification({
      mainSubject: "Choosing a wall colour for a north-facing room",
      primaryTopic: "interior paint",
      matchedTopics: ["paint", "interiors"],
      reason: "The article matches the company's paint topic.",
    });
    assert.equal(brief.mainSubject, "Choosing a wall colour for a north-facing room");
    assert.equal(brief.source, "classification_projection");
    assert.deepEqual([...brief.secondaryTopics], ["interior paint", "paint", "interiors"]);
  });

  it("leaves the absent fields ABSENT rather than guessing them", () => {
    const brief = briefFromClassification({
      mainSubject: "Choosing a wall colour",
      primaryTopic: null,
      matchedTopics: [],
      reason: "The article matches the company's paint topic.",
    });
    // The relevance rationale is NOT the article's thesis. Putting it there
    // would hand the Writer the company's matching logic as the article's point.
    assert.equal(brief.centralThesis, null);
    assert.equal(brief.centralConflict, null);
    assert.equal(brief.articleType, null);
    assert.equal(brief.confidence, null);
    assert.deepEqual([...brief.entities], []);
  });

  it("dedupes a primary topic that also appears in the matched list", () => {
    const brief = briefFromClassification({
      mainSubject: "A subject",
      primaryTopic: "paint",
      matchedTopics: ["paint", "paint"],
      reason: null,
    });
    assert.deepEqual([...brief.secondaryTopics], ["paint"]);
  });

  it("degrades to the no-article brief when the article was never classified", () => {
    const brief = briefFromClassification({
      mainSubject: null,
      primaryTopic: null,
      matchedTopics: [],
      reason: null,
    });
    assert.deepEqual(brief, NO_ARTICLE_BRIEF);
  });

  it("treats a whitespace-only subject as no subject", () => {
    const brief = briefFromClassification({
      mainSubject: "   ",
      primaryTopic: null,
      matchedTopics: [],
      reason: null,
    });
    assert.equal(brief.source, "none");
  });
});

describe("formatBrief", () => {
  it("renders the full understanding", () => {
    const text = formatBrief(briefFromUnderstanding(UNDERSTANDING));
    assert.match(text, /Residents are protesting/);
    assert.match(text, /The article's own thesis:/);
    assert.match(text, /The central tension:/);
    assert.match(text, /Article type: news/);
    assert.match(text, /tourism, planning permission/);
    assert.match(text, /NOT what the article is about: beaches, hotels/);
    assert.match(text, /Confidence in the subject above: 0\.82/);
  });

  it("OMITS a section rather than emitting an empty heading", () => {
    // An empty heading tells a model the field exists and it ought to fill it,
    // which is an invitation to invent — the exact failure the understanding
    // prompts guard against with "never invent one to fill it".
    const text = formatBrief(
      briefFromUnderstanding({
        ...UNDERSTANDING,
        centralThesis: null,
        centralConflict: null,
        secondaryTopics: [],
        incidentalTopics: [],
        entities: [],
      })
    );
    assert.doesNotMatch(text, /own thesis/);
    assert.doesNotMatch(text, /central tension/);
    assert.doesNotMatch(text, /in service of/);
    assert.doesNotMatch(text, /in passing/);
    assert.doesNotMatch(text, /Named in the article/);
  });

  it("warns the Writer when the brief is only a projection", () => {
    const text = formatBrief(
      briefFromClassification({
        mainSubject: "Choosing a wall colour",
        primaryTopic: "paint",
        matchedTopics: [],
        reason: null,
      })
    );
    assert.match(text, /Do not invent a thesis it does not state/);
  });

  it("renders nothing at all for a mission post", () => {
    assert.equal(formatBrief(NO_ARTICLE_BRIEF), "");
  });
});
