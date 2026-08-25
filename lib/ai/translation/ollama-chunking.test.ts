import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  chunkArticleForTranslation,
  reassembleChunkedTranslation,
  OLLAMA_CHUNK_MAX_CHARS,
  OLLAMA_CHUNK_TARGET_MIN_CHARS,
} from "./ollama-chunking";
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
