import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  chunkArticleForTranslation,
  reassembleChunkedTranslation,
  shouldChunkForTranslation,
  OLLAMA_CHUNK_MAX_CHARS,
  OLLAMA_CHUNK_TARGET_MIN_CHARS,
  OLLAMA_CHUNK_MAX_PROTECTED_TOKENS,
} from "./ollama-chunking";
import { protectTokens } from "./protected-tokens";
import { sanitiseTranslationContent } from "@/lib/ai/feed-item-translation";
import { TRANSLATION_FIXTURES } from "./translation-fixtures";

/**
 * The split is the part of this feature that can be got wrong quietly: a lost or
 * duplicated character does not throw, it just silently changes what the reader is
 * told the article said. The properties asserted here are mostly conservation ones —
 * everything that goes in comes back, in order, with its shape intact — mirroring the
 * identity-round-trip pattern madlad-segmentation.test.ts already established for
 * MADLAD's own sentence-level split.
 *
 * The real-size fixtures (~6k, ~7k, ~22k, ~27k chars, and the exact 26,947-char
 * regression case) exist because the bug this module fixes was never visible on a
 * fixture the size of a unit test — it only showed up on an article too big to fit in
 * one prompt-based call, which is exactly the case the small fixtures above never
 * reach.
 */

const sanitised = (content: string): string => sanitiseTranslationContent(content) ?? "";

/** "Translates" a chunked article to itself and checks the round trip is lossless. */
function roundTrip(title: string | null, content: string | null) {
  const chunked = chunkArticleForTranslation(title, content);
  const translatedChunks = chunked.chunks.map((c) => c.text);
  return { ...reassembleChunkedTranslation(chunked, chunked.title, translatedChunks), chunked };
}

// ─── A realistic, varied sentence pool for building large synthetic articles ──────
//
// Varied rather than one sentence repeated: a repeated sentence looks like the
// decoding-loop shape detectRepetition exists to catch, which is not what these
// fixtures are testing, and it would let a splitting bug hide behind identical
// neighbours.
const SENTENCE_POOL = [
  "The new revision brings a redesigned chassis and a wider range of mounting options.",
  "Reviewers noted the improved thermal performance under sustained load.",
  "Early benchmarks show a measurable gain over the previous generation.",
  "The manufacturer says the change was driven directly by customer feedback.",
  "Supply constraints delayed the rollout in several regional markets.",
  "A firmware update addressed the initial reports of instability.",
  "The design team focused on reducing weight without weakening the frame.",
  "Independent testing largely confirmed the vendor's own published figures.",
  "Pricing remains close to the outgoing model despite the added features.",
  "Availability is expected to widen over the coming quarter.",
  "The accompanying software received a parallel round of updates.",
  "Warranty terms were extended slightly compared with the prior release.",
  "A wider colour range is promised for later in the product cycle.",
  "Component sourcing shifted to a second supplier after early shortages.",
  "The packaging was redesigned to cut shipping volume by nearly a third.",
];

/** One paragraph of AT LEAST `minChars` characters, built from the varied pool. */
function paragraph(seed: number, minChars: number): string {
  const sentences: string[] = [];
  let len = 0;
  let i = seed;
  while (len < minChars) {
    const s = SENTENCE_POOL[i % SENTENCE_POOL.length];
    sentences.push(s);
    len += s.length + 1;
    i += 1;
  }
  return sentences.join(" ");
}

/**
 * A multi-paragraph article body of AT LEAST `minChars` characters — plain prose, no
 * markup, so `sanitiseTranslationContent` is a no-op and the reported length is exact.
 */
function articleOfAtLeast(minChars: number, paragraphChars = 350): string {
  const paragraphs: string[] = [];
  let total = 0;
  let seed = 0;
  while (total < minChars) {
    const p = paragraph(seed, paragraphChars);
    paragraphs.push(p);
    total += p.length + 2;
    seed += 5;
  }
  return paragraphs.join("\n\n");
}

/**
 * An article body of EXACTLY `targetChars` characters, cut at the nearest sentence
 * boundary at or before the target and then padded with more of the pool (never mid-
 * sentence) until it lands on the exact count. Used only for the "this exact reported
 * size" regression case, where the precise number is the point.
 */
function articleOfExactly(targetChars: number): string {
  let body = articleOfAtLeast(targetChars + 400);
  // Cut back to the nearest sentence end at or before the target so the fixture
  // itself is well-formed prose, not a fixture concern the chunker has to paper over.
  // `targetChars - 2` (not `targetChars`) because lastIndexOf's search position bounds
  // where the match may START, not where it must END — a ". " starting AT the position
  // would still leave its trailing space one character past the target.
  const cut = body.lastIndexOf(". ", targetChars - 2);
  body = body.slice(0, cut + 1);
  // Pad the remainder onto the END of the last paragraph, sentence by sentence, then
  // trim any overshoot with a run of period characters — irrelevant to what is being
  // tested here (whole-article coverage), only the EXACT total length matters.
  let i = 0;
  while (body.length < targetChars) {
    const s = " " + SENTENCE_POOL[i % SENTENCE_POOL.length];
    if (body.length + s.length <= targetChars) {
      body += s;
    } else {
      // Pad the final stretch onto ONE trailing word rather than with whitespace —
      // `sanitiseTranslationContent` collapses any run of 2+ spaces down to one, which
      // silently shrank this fixture below its intended exact length the first time.
      const remaining = targetChars - body.length;
      if (remaining === 1) body += ".";
      else if (remaining > 1) body += " " + "x".repeat(remaining - 2) + ".";
      break;
    }
    i += 1;
  }
  return body;
}

// ─── Basic structure ────────────────────────────────────────────────────────────

describe("chunkArticleForTranslation — basic structure", () => {
  it("separates the title from the body entirely", () => {
    const chunked = chunkArticleForTranslation("A Title", articleOfAtLeast(6000));
    assert.equal(chunked.title, "A Title");
    // The title never appears as text INSIDE a chunk.
    for (const chunk of chunked.chunks) {
      assert.ok(!chunk.text.startsWith("A Title"));
    }
  });

  it("returns null title for a bodyless-of-title article", () => {
    const chunked = chunkArticleForTranslation(null, articleOfAtLeast(4000));
    assert.equal(chunked.title, null);
  });

  it("produces exactly one chunk for a short article", () => {
    const chunked = chunkArticleForTranslation("Title", "Just one short paragraph of text.");
    assert.equal(chunked.chunks.length, 1);
  });

  it("produces no chunks for an empty body", () => {
    const chunked = chunkArticleForTranslation("Title", "");
    assert.deepEqual(chunked.chunks, []);
  });

  it("never produces a chunk over the hard ceiling", () => {
    const chunked = chunkArticleForTranslation("Title", articleOfAtLeast(22_000));
    for (const chunk of chunked.chunks) {
      assert.ok(
        chunk.text.length <= OLLAMA_CHUNK_MAX_CHARS,
        `chunk of ${chunk.text.length} chars exceeds the ${OLLAMA_CHUNK_MAX_CHARS} ceiling`
      );
    }
  });

  it("never produces an empty chunk", () => {
    const chunked = chunkArticleForTranslation("Title", articleOfAtLeast(10_000));
    for (const chunk of chunked.chunks) {
      assert.ok(chunk.text.length > 0);
    }
  });

  it("the first chunk carries no leading separator", () => {
    const chunked = chunkArticleForTranslation("Title", articleOfAtLeast(10_000));
    assert.equal(chunked.chunks[0].leadingSeparator, "");
  });
});

// ─── The identity round trip — the strongest guarantee ─────────────────────────

describe("chunkArticleForTranslation — lossless round trip", () => {
  it("reproduces a short fixture exactly", () => {
    for (const fixture of TRANSLATION_FIXTURES) {
      const { translatedContent } = roundTrip(fixture.title, fixture.content);
      assert.equal(translatedContent, sanitised(fixture.content), fixture.name);
    }
  });

  it("reproduces a ~6,000-char article exactly, across several chunks", () => {
    const content = articleOfAtLeast(6000);
    const { translatedContent, chunked } = roundTrip("Title", content);
    assert.ok(chunked.chunks.length >= 2, "an article this size must actually be chunked");
    assert.equal(translatedContent, sanitised(content));
  });

  it("reproduces a ~7,000-char article exactly", () => {
    const content = articleOfAtLeast(7000);
    const { translatedContent } = roundTrip("Title", content);
    assert.equal(translatedContent, sanitised(content));
  });

  it("reproduces a ~22,000-char article exactly", () => {
    const content = articleOfAtLeast(22_000);
    const { translatedContent, chunked } = roundTrip("Title", content);
    assert.ok(chunked.chunks.length >= 7, `expected several chunks, got ${chunked.chunks.length}`);
    assert.equal(translatedContent, sanitised(content));
  });

  it("reproduces a ~27,000-char article exactly", () => {
    const content = articleOfAtLeast(27_000);
    const { translatedContent } = roundTrip("Title", content);
    assert.equal(translatedContent, sanitised(content));
  });

  it("never cuts inside a word — every chunk boundary falls on whitespace or a paragraph break", () => {
    // A weaker, more literal check alongside the round trip: reconstruct the article
    // WITHOUT translating (chunk texts joined by their own leading separators) and
    // confirm no two chunks glue together without the whitespace their boundary owns.
    const content = articleOfAtLeast(15_000);
    const chunked = chunkArticleForTranslation("Title", content);
    for (let i = 1; i < chunked.chunks.length; i += 1) {
      const sep = chunked.chunks[i].leadingSeparator;
      assert.ok(sep.length > 0, `chunk ${i} has no separator from its predecessor`);
      assert.ok(/^\s+$/.test(sep), `separator "${sep}" is not pure whitespace`);
    }
  });
});

// ─── The reported regression: a 26,947-character article ───────────────────────

describe("chunkArticleForTranslation — the reported 26,947-char article", () => {
  const content = articleOfExactly(26_947);

  it("the fixture itself is exactly the reported size", () => {
    assert.equal(content.length, 26_947);
  });

  it("is chunked, not truncated — every chunk together covers the WHOLE article", () => {
    const chunked = chunkArticleForTranslation("Title", content);
    assert.equal(chunked.contentChars, 26_947, "the reported original length must be uncapped");

    const totalChunkChars = chunked.chunks.reduce((sum, c) => sum + c.text.length, 0);
    // Strictly more than the old ~3000-char truncation ceiling — the whole point.
    assert.ok(
      totalChunkChars > OLLAMA_CHUNK_MAX_CHARS * 5,
      `only ${totalChunkChars} chars were chunked out of 26,947`
    );
  });

  it("the LAST chunk ends at the article's own ending, not somewhere in the opening third", () => {
    // The concrete shape of the old bug: everything past ~3000 chars was silently
    // dropped, so the tail of a 26,947-char article never reached the model at all.
    // The last 20 characters of the SOURCE must be the last 20 of the last chunk —
    // a direct check that the split reaches all the way to the article's real end.
    const chunked = chunkArticleForTranslation("Title", content);
    const lastChunk = chunked.chunks.at(-1)!;
    assert.ok(
      content.endsWith(lastChunk.text.slice(-20)),
      `last chunk does not end where the article does: "...${lastChunk.text.slice(-40)}"`
    );
  });

  it("round-trips losslessly at this exact size", () => {
    const { translatedContent } = roundTrip("Title", content);
    assert.equal(translatedContent, sanitised(content));
  });

  it("produces chunks in the 2,500–3,000 char band, except possibly the last", () => {
    const chunked = chunkArticleForTranslation("Title", content);
    for (const chunk of chunked.chunks.slice(0, -1)) {
      assert.ok(
        chunk.text.length >= OLLAMA_CHUNK_TARGET_MIN_CHARS - 200,
        `non-final chunk of ${chunk.text.length} chars is far below the target band`
      );
      assert.ok(chunk.text.length <= OLLAMA_CHUNK_MAX_CHARS);
    }
  });
});

// ─── Paragraph-first preference ─────────────────────────────────────────────────

describe("chunkArticleForTranslation — paragraph boundaries preferred over sentence packing", () => {
  it("cuts at a paragraph break once the target band is reached, rather than packing tighter", () => {
    // Five ~700-char paragraphs: the second boundary (~1400 chars) is still below the
    // target band, so packing continues; somewhere past the target band the NEXT
    // paragraph boundary should be taken rather than reaching all the way to the max.
    const paragraphs = Array.from({ length: 6 }, (_, i) => paragraph(i * 3, 700));
    const content = paragraphs.join("\n\n");
    const chunked = chunkArticleForTranslation("Title", content, {
      maxChunkChars: 3000,
      targetMinChars: 1800,
    });

    assert.ok(
      chunked.chunks.length >= 2,
      "six ~700-char paragraphs must split into more than one chunk"
    );
    // Every chunk boundary (other than the very end) must land exactly on a
    // paragraph separator here, since every atom is itself a whole paragraph-sized
    // piece and the target band sits below the hard ceiling.
    for (let i = 1; i < chunked.chunks.length; i += 1) {
      assert.ok(chunked.chunks[i].leadingSeparator.includes("\n\n"));
    }
  });
});

// ─── Custom size options ────────────────────────────────────────────────────────

describe("chunkArticleForTranslation — configurable ceiling", () => {
  it("honours a smaller maxChunkChars", () => {
    const content = articleOfAtLeast(5000);
    const chunked = chunkArticleForTranslation("Title", content, { maxChunkChars: 1000 });
    for (const chunk of chunked.chunks) {
      assert.ok(chunk.text.length <= 1000);
    }
    assert.ok(chunked.chunks.length >= 5);
  });
});

// ─── reassembleChunkedTranslation ────────────────────────────────────────────────

describe("reassembleChunkedTranslation", () => {
  it("joins chunks in order with their own separators", () => {
    const chunked = chunkArticleForTranslation("Title", "First paragraph.\n\nSecond paragraph.");
    const out = reassembleChunkedTranslation(
      chunked,
      "Заглавие",
      chunked.chunks.map(() => "Преведено.")
    );
    assert.equal(out.translatedTitle, "Заглавие");
    assert.equal(out.translatedContent, "Преведено.");
  });

  it("drops a chunk that translated to nothing, but keeps the separator structure honest", () => {
    const chunked = chunkArticleForTranslation(
      "Title",
      articleOfAtLeast(6000).split("\n\n").slice(0, 3).join("\n\n")
    );
    if (chunked.chunks.length < 2) return; // guard: only meaningful with 2+ chunks
    const translations = chunked.chunks.map((_, i) => (i === 0 ? "" : "Текст."));
    const out = reassembleChunkedTranslation(chunked, null, translations);
    assert.ok(
      !out.translatedContent?.startsWith(" "),
      "no leading separator from a dropped first chunk"
    );
  });

  it("returns null content when every chunk is empty", () => {
    const chunked = chunkArticleForTranslation("Title", "One paragraph.");
    const out = reassembleChunkedTranslation(
      chunked,
      null,
      chunked.chunks.map(() => "")
    );
    assert.equal(out.translatedContent, null);
  });
});

// ─── Realistic, protected-token-dense technical fixtures ──────────────────────────
//
// The reported live failures: a whole SHORT article (well under the 3000-char routing
// threshold) carrying enough model/SKU-shaped identifiers that a single unchunked call
// fails `protected_token` on every retry. Modelled on real TechPowerUp-style hardware
// reviews rather than one repeated token, because a uniform "SPEC0000X ×N" fixture
// cannot exercise the realistic shape: identifiers spread thinly across many SENTENCES
// (each sentence individually harmless), not concentrated in one data dump.

/** Distinct, realistic hardware/model identifiers — CPUs, GPUs, RAM, motherboards,
 *  storage, connectors — the density a TechPowerUp-style review actually carries. */
const TECH_IDENTIFIERS = [
  "BE173BU",
  "7700X3D",
  "5800X3D",
  "X670E",
  "B650E",
  "RTX-4090",
  "RTX-4080",
  "DDR5-6000",
  "DDR5-5600",
  "SN850X9",
  "SN770X2",
  "PCIe-5.0",
  "M2-2280",
  "WD-SN850",
  "Z790-AORUS",
  "B550M-PRO",
  "RX-7900",
  "RX-7800",
  "TUF-B650",
  "ROG-X670E",
  "AM5-B650",
  "LGA-1700",
  "MSI-Z790",
  "GDDR6-X6",
  "HBM2-E5",
  "NVMe-4.0",
  "USB4-40G",
  "TB4-40G",
  "QHD-165",
  "OLED-4K3",
];

/** Review-style filler sentences carrying no identifiers at all. */
const TECH_FILLER = [
  "The build quality feels solid, with no noticeable flex in the chassis.",
  "Thermals stayed well within limits during the sustained load test.",
  "The included cable is short, so a longer replacement may be worth buying.",
  "Menu navigation is straightforward once you learn the button layout.",
  "Colour accuracy out of the box was better than expected for the price.",
  "Noise levels under load were audible but never became intrusive.",
  "Software support has improved noticeably since the previous generation.",
  "Packaging was minimal but the unit arrived without any visible damage.",
];

/** One review sentence naming `id` — the realistic shape, not a bare token dump. */
function identifierSentence(id: string): string {
  return `The ${id} handled every test in our suite without a single hitch.`;
}

/**
 * A TechPowerUp-style review body of AT LEAST `minChars`: two identifier-bearing
 * sentences followed by one filler sentence, repeated (cycling through `ids` as
 * needed) — dense enough to land in the reported ~1-token-per-100-chars band for a
 * ~2,681-char body, while still reading as review prose (identifiers spread across
 * many short sentences) rather than a bare list. Stops as soon as `minChars` is
 * reached, so the caller's target length is respected even when `ids` is short or long.
 */
function technicalArticle(ids: readonly string[], minChars: number): string {
  const sentences: string[] = [];
  let len = 0;
  let i = 0;
  while (len < minChars) {
    const s = identifierSentence(ids[i % ids.length]);
    sentences.push(s);
    len += s.length + 1;
    i += 1;
    if (i % 2 === 0 && len < minChars) {
      const filler = TECH_FILLER[Math.floor(i / 2) % TECH_FILLER.length];
      sentences.push(filler);
      len += filler.length + 1;
    }
  }
  return sentences.join(" ");
}

describe("shouldChunkForTranslation", () => {
  it("routes to chunked when content exceeds the char ceiling alone", () => {
    const content = articleOfAtLeast(4000);
    assert.equal(protectTokens(content).values.length, 0, "fixture must carry no identifiers");
    assert.ok(shouldChunkForTranslation(content));
  });

  it("does NOT route to chunked for a short article with few protected tokens", () => {
    const content = technicalArticle(TECH_IDENTIFIERS.slice(0, 2), 500);
    assert.ok(content.length < OLLAMA_CHUNK_MAX_CHARS);
    assert.ok(protectTokens(content).values.length <= OLLAMA_CHUNK_MAX_PROTECTED_TOKENS);
    assert.ok(!shouldChunkForTranslation(content));
  });

  it("routes to chunked for a SHORT, protected-token-dense article — the reported live shape", () => {
    // ~2681 chars, well under the 3000-char routing ceiling — exactly the reported
    // UPERFECT BE173BU shape: short enough to look like an ordinary single-call body.
    const content = technicalArticle(TECH_IDENTIFIERS, 2681);
    assert.ok(content.length < OLLAMA_CHUNK_MAX_CHARS, `fixture is ${content.length} chars`);
    const tokenCount = protectTokens(content).values.length;
    assert.ok(
      tokenCount > OLLAMA_CHUNK_MAX_PROTECTED_TOKENS,
      `fixture only carries ${tokenCount} protected tokens — expected the dense shape`
    );
    assert.ok(shouldChunkForTranslation(content));
  });

  it("honours a custom maxProtectedTokens threshold", () => {
    const content = technicalArticle(TECH_IDENTIFIERS.slice(0, 3), 400);
    const tokenCount = protectTokens(content).values.length;
    assert.ok(shouldChunkForTranslation(content, { maxProtectedTokens: tokenCount - 1 }));
    assert.ok(!shouldChunkForTranslation(content, { maxProtectedTokens: tokenCount }));
  });

  it("returns false for an empty or null body", () => {
    assert.ok(!shouldChunkForTranslation(null));
    assert.ok(!shouldChunkForTranslation(""));
  });
});

describe("chunkArticleForTranslation — the protected-token invariant", () => {
  it("splits a short but protected-token-dense article into multiple chunks", () => {
    const content = technicalArticle(TECH_IDENTIFIERS, 2681);
    const chunked = chunkArticleForTranslation("Title", content);
    assert.ok(
      chunked.chunks.length > 1,
      "a protected-token-dense article must be split even though it is short"
    );
  });

  it("every produced chunk satisfies BOTH ceilings — the hard invariant", () => {
    const fixtures = [
      technicalArticle(TECH_IDENTIFIERS, 2681), // short, dense (the live failure shape)
      articleOfAtLeast(9000), // long, sparse (few/no identifiers)
      // Long AND dense — both mechanisms must cooperate across the whole article.
      Array.from({ length: 4 }, () => technicalArticle(TECH_IDENTIFIERS, 2200)).join("\n\n"),
    ];

    for (const content of fixtures) {
      const chunked = chunkArticleForTranslation("Title", content);
      for (const chunk of chunked.chunks) {
        assert.ok(
          chunk.text.length <= OLLAMA_CHUNK_MAX_CHARS,
          `chunk of ${chunk.text.length} chars exceeds the char ceiling`
        );
        assert.ok(
          chunk.protectedTokenCount <= OLLAMA_CHUNK_MAX_PROTECTED_TOKENS,
          `chunk carries ${chunk.protectedTokenCount} protected tokens — exceeds the ceiling`
        );
        // Self-consistency: the reported count matches what protectTokens would
        // actually measure on this chunk's own text — the diagnostic is not a guess.
        assert.equal(protectTokens(chunk.text).values.length, chunk.protectedTokenCount);
      }
    }
  });

  it("restarts protected-token indices at [[0]] for every chunk that carries any", () => {
    const content = technicalArticle(TECH_IDENTIFIERS, 2681);
    const chunked = chunkArticleForTranslation("Title", content);
    const dense = chunked.chunks.filter((c) => c.protectedTokenCount > 0);
    assert.ok(dense.length >= 2, "expected several chunks to carry protected tokens");
    for (const chunk of dense) {
      assert.match(
        protectTokens(chunk.text).text,
        /\[\[0\]\]/,
        `chunk's own placeholder numbering must restart at 0, got: ${chunk.text.slice(0, 80)}`
      );
    }
  });

  it("still produces large, char-sized chunks for prose with few protected tokens", () => {
    // Requirement: normal text must not be over-split just because the packer now
    // also watches a token budget it never comes close to.
    const content = articleOfAtLeast(22_000);
    const chunked = chunkArticleForTranslation("Title", content);
    for (const chunk of chunked.chunks) {
      assert.equal(chunk.protectedTokenCount, 0);
    }
    const nonFinal = chunked.chunks.slice(0, -1);
    assert.ok(nonFinal.length > 0);
    for (const chunk of nonFinal) {
      assert.ok(
        chunk.text.length >= OLLAMA_CHUNK_TARGET_MIN_CHARS - 200,
        `non-final chunk of ${chunk.text.length} chars is far below the target band — ` +
          "the token budget must not shrink chunks that never approach it"
      );
    }
  });

  it("recursively splits a SINGLE sentence that alone exceeds the token budget, at word boundaries", () => {
    // No sentence punctuation at all — segmentArticle hands this back as ONE piece, so
    // the outer packer's paragraph/sentence-level flush has nothing smaller to act on;
    // only the word-level fallback (splitTextByProtectedTokenBudget) can satisfy the
    // budget here.
    const specLine = TECH_IDENTIFIERS.map((id) => `Model ${id}`).join(", ");
    assert.ok(protectTokens(specLine).values.length > 5, "fixture must be token-dense");

    const chunked = chunkArticleForTranslation("Title", specLine, { maxProtectedTokens: 3 });
    assert.ok(chunked.chunks.length > 1, "the single oversized sentence must be split further");
    for (const chunk of chunked.chunks) {
      assert.ok(chunk.protectedTokenCount <= 3, `chunk carries ${chunk.protectedTokenCount}`);
      assert.equal(chunk.splitReason, "protected_tokens");
    }
    // Never cuts inside a word: every chunk after the first is a clean word boundary,
    // and no identifier appears truncated in any chunk.
    for (const id of TECH_IDENTIFIERS) {
      assert.ok(
        chunked.chunks.some((c) => c.text.includes(id)),
        `${id} must survive intact in some chunk`
      );
    }
    // Lossless reassembly even across a word-level split.
    const rejoined = chunked.chunks
      .map((c, i) => (i === 0 ? c.text : c.leadingSeparator + c.text))
      .join("");
    assert.equal(rejoined, specLine);
  });

  it("round-trips losslessly on a long, protected-token-dense article", () => {
    const content = Array.from({ length: 4 }, () => technicalArticle(TECH_IDENTIFIERS, 2200)).join(
      "\n\n"
    );
    const chunked = chunkArticleForTranslation("Title", content);
    const translatedChunks = chunked.chunks.map((c) => c.text);
    const { translatedContent } = reassembleChunkedTranslation(
      chunked,
      chunked.title,
      translatedChunks
    );
    assert.equal(translatedContent, sanitised(content));
  });
});

// ─── The three reported live-failure shapes ────────────────────────────────────────
//
// Reconstructed to match the reported evidence (article length and protected-token
// count), not literal scrapes of the live pages — the live text was not available here.
// Each carries the product's own model number repeated (as a real review does) plus a
// spread of comparison/spec identifiers, landing in the same ~2681-char / 24-30-token
// band the logs reported.

describe("chunkArticleForTranslation — the three reported live failures", () => {
  function heroArticle(hero: string, others: readonly string[], minChars: number): string {
    const ids = [hero, hero, hero, ...others, hero]; // the reviewed product is named repeatedly
    return technicalArticle(ids, minChars);
  }

  const cases: Array<{ name: string; hero: string }> = [
    { name: "UPERFECT BE173BU", hero: "BE173BU" },
    { name: "AMD Ryzen 7 7700X3D", hero: "7700X3D" },
    { name: "AMD Ryzen 7 5800X3D", hero: "5800X3D" },
  ];

  for (const { name, hero } of cases) {
    it(`${name}: enters chunked mode and every chunk stays within the protected-token ceiling`, () => {
      const others = TECH_IDENTIFIERS.filter((id) => id !== hero).slice(0, 22);
      const content = heroArticle(hero, others, 2681);
      const tokenCount = protectTokens(content).values.length;

      // The reported shape: short (under the char ceiling) but token-dense.
      assert.ok(
        content.length < OLLAMA_CHUNK_MAX_CHARS,
        `${name} fixture is ${content.length} chars`
      );
      assert.ok(tokenCount >= 20, `${name} fixture only carries ${tokenCount} protected tokens`);
      assert.ok(shouldChunkForTranslation(content), `${name} must now enter chunked mode`);

      const chunked = chunkArticleForTranslation("Title", content);
      assert.ok(chunked.chunks.length > 1, `${name} must be split into multiple chunks`);
      for (const chunk of chunked.chunks) {
        assert.ok(
          chunk.protectedTokenCount <= OLLAMA_CHUNK_MAX_PROTECTED_TOKENS,
          `${name}: a chunk still carries ${chunk.protectedTokenCount} protected tokens`
        );
      }
      // The hero product's own model number must survive, intact, somewhere.
      assert.ok(chunked.chunks.some((c) => c.text.includes(hero)));

      const translatedChunks = chunked.chunks.map((c) => c.text);
      const { translatedContent } = reassembleChunkedTranslation(
        chunked,
        chunked.title,
        translatedChunks
      );
      assert.equal(translatedContent, sanitised(content));
    });
  }
});
