import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSemanticDocument } from "./build-semantic-document";

describe("buildSemanticDocument", () => {
  it("builds all three sections in a fixed order", () => {
    const doc = buildSemanticDocument({
      topic: "Family beaches in Corfu",
      coreMessage: "Toddlers can wade safely in the shallow north-east bays.",
      aspectFocus: "safe swimming conditions for small children",
    });

    assert.equal(
      doc,
      [
        "Topic: Family beaches in Corfu",
        "",
        "Core message:",
        "Toddlers can wade safely in the shallow north-east bays.",
        "",
        "Aspect:",
        "safe swimming conditions for small children",
      ].join("\n")
    );
  });

  it("omits the topic section when topic is missing", () => {
    const doc = buildSemanticDocument({
      coreMessage: "A central claim.",
      aspectFocus: "an aspect focus",
    });

    assert.equal(doc, "Core message:\nA central claim.\n\nAspect:\nan aspect focus");
  });

  it("omits the aspect section when the aspect focus is missing", () => {
    const doc = buildSemanticDocument({
      topic: "A topic",
      coreMessage: "A central claim.",
    });

    assert.equal(doc, "Topic: A topic\n\nCore message:\nA central claim.");
  });

  it("returns just the core message when it is the only field", () => {
    const doc = buildSemanticDocument({ coreMessage: "A central claim." });
    assert.equal(doc, "Core message:\nA central claim.");
  });

  it("treats null, undefined, and blank/whitespace fields as missing", () => {
    assert.equal(
      buildSemanticDocument({ topic: null, coreMessage: "Claim.", aspectFocus: undefined }),
      "Core message:\nClaim."
    );
    assert.equal(
      buildSemanticDocument({ topic: "   ", coreMessage: "Claim.", aspectFocus: "\n\t" }),
      "Core message:\nClaim."
    );
  });

  it("trims surrounding whitespace on each field", () => {
    const doc = buildSemanticDocument({
      topic: "  A topic  ",
      coreMessage: "  A claim.  ",
      aspectFocus: "  an aspect  ",
    });

    assert.equal(doc, "Topic: A topic\n\nCore message:\nA claim.\n\nAspect:\nan aspect");
  });

  it("returns an empty string when no fields are present", () => {
    assert.equal(buildSemanticDocument({}), "");
  });
});
