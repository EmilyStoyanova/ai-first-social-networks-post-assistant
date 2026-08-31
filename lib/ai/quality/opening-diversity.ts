/**
 * Realised-opening diversity.
 *
 * WHY THIS EXISTS. Hook/structure/CTA rotation (lib/ai/post-pattern.ts) chooses
 * a different archetype for every post and records it in
 * `promptSnapshot.contentPattern`. That records the INTENT. Nothing recorded
 * what the model actually wrote, and nothing compared it to what it wrote last
 * time — so a run whose stored history showed textbook rotation (Bold
 * Statement, Question, Story Opening, Statistic, Empathy, Imperative, Contrast,
 * Pain Point…) could still open eleven consecutive Facebook posts with the very
 * same sentence shape. Every archetype had been dutifully assigned; every one
 * came back as "Има ли ти мислил, че …".
 *
 * This module closes that gap, and ONLY that gap. It compares the realised first
 * line of a candidate against the realised first lines of recent posts from the
 * same company and channel, deterministically and with no LLM call. It is
 * deliberately NOT a return to gating abstract style: it never asks "did this
 * post honour its assigned hook?" — an unanswerable question that used to
 * destroy usable content — only "does this opening repeat what we just
 * published?", which is a comparison against real text.
 *
 * IT IS A RETRY TRIGGER, NEVER A GATE. A flagged candidate asks for another
 * attempt; a candidate still flagged after the last attempt is saved anyway.
 * Style must not be able to destroy content (see generation-compliance.ts).
 *
 * THE RULE IS CONTEXTUAL. No opening phrase is banned outright here. A
 * rhetorical question is a perfectly good hook — it is repeating one that is the
 * problem. "Има ли ти мислил" is separately rejected in every context, but for a
 * different reason entirely: it is malformed Bulgarian, and that lives in
 * language-quality.ts.
 */

// ─── Tunables ────────────────────────────────────────────────────────────────

/** How many leading tokens of the opening take part in the comparison. */
export const OPENING_WINDOW_TOKENS = 8;

/**
 * An identical run of this many leading tokens is a repeated opening on its own,
 * whatever the rest of the sentence does. Four is long enough that two posts
 * hitting it by accident are saying the same thing ("има ли ти мислил",
 * "при ремонт на банята") and short enough to catch the family in the data,
 * where the shared lead was five tokens and the Jaccard score only 0.45.
 */
export const OPENING_PREFIX_TOKENS = 4;

/** Jaccard over the opening window at or above which two openings are the same one. */
export const OPENING_SIMILARITY_THRESHOLD = 0.5;

/** Below this many tokens an opening is too short to compare without guessing. */
export const MIN_COMPARABLE_TOKENS = 4;

/**
 * How many recent openings may already use the narrow rhetorical-reflection
 * family before another one is a repeat. One — the same budget a hook archetype
 * gets from the LRU, which spreads eight archetypes across a ten-post window.
 */
export const RHETORICAL_FAMILY_LIMIT = 1;

/**
 * How many recent openings may be questions of ANY kind before a further
 * question opening reads as a tic. Deliberately loose: an ordinary question is a
 * legitimate hook and must stay available until it dominates the window.
 */
export const QUESTION_FORM_LIMIT = 4;

/** Tokens scanned when classifying the opening's rhetorical form. */
const FORM_SCAN_TOKENS = 6;

/** Cap on the raw opening kept for prompts and diagnostics. Never a whole post. */
const MAX_EXCERPT_CHARS = 120;

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * The rhetorical shape of an opening line.
 *
 * - `rhetorical_question` — the narrow "have you ever thought…" reflection
 *   device: a question built on a verb of knowing/considering addressed at the
 *   reader. This is the family that took over the Facebook feed.
 * - `question` — any other question opening.
 * - `statement` — everything else.
 */
export type OpeningForm = "rhetorical_question" | "question" | "statement";

export type OpeningMatchType = "near_exact" | "repeated_form" | "saturated_form";

export interface OpeningSignature {
  /** The opening's comparison tokens, space-joined. Letters only, lowercased. */
  normalized: string;
  /** Leading tokens of the opening, capped at OPENING_WINDOW_TOKENS. */
  tokens: string[];
  /** Readable opening text for prompts and logs, capped and whitespace-collapsed. */
  excerpt: string;
  form: OpeningForm;
}

export interface OpeningDiversityResult {
  /** True when this opening repeats recent output and the attempt should be retried. */
  flagged: boolean;
  matchType: OpeningMatchType | null;
  /** The recent post this opening collided with; null when nothing matched. */
  matchedPostId: string | null;
  /** Highest opening similarity found; null when there was no comparable history. */
  similarity: number | null;
  candidateForm: OpeningForm;
  /** A short excerpt of the repeated opening — enough to name it in a retry prompt. */
  matchedOpening: string | null;
}

/** The minimum a caller must supply. Satisfied by `RecentPost` as-is. */
export interface RecentOpening {
  id: string;
  text: string;
}

/** Neutral result for a candidate with no usable opening, or no history to compare against. */
function clean(form: OpeningForm, similarity: number | null = null): OpeningDiversityResult {
  return {
    flagged: false,
    matchType: null,
    matchedPostId: null,
    similarity,
    candidateForm: form,
    matchedOpening: null,
  };
}

// ─── Normalisation ───────────────────────────────────────────────────────────

const URL_RE = /(https?:\/\/\S+|www\.\S+)/gi;
const EMOJI_RE = /[\p{Extended_Pictographic}\p{Emoji_Presentation}️]/gu;
/** First sentence boundary. A line break counts: a Facebook hook is often its own line. */
const OPENING_BOUNDARY_RE = /[.!?…]|\r?\n/;
const LETTERS_RE = /\p{L}+/gu;

/**
 * The first line/sentence of a post, as a comparable signature.
 *
 * Digits and punctuation are dropped on purpose. "Кой смесител пасва на баня
 * номер 3?" and "…номер 7?" are the same opening, and a comparison that lets a
 * numeral separate them is measuring the wrong thing.
 */
export function extractOpeningSignature(text: string): OpeningSignature {
  const cleaned = (text ?? "").replace(URL_RE, " ").replace(EMOJI_RE, " ");

  const boundary = cleaned.search(OPENING_BOUNDARY_RE);
  const rawOpening = (boundary === -1 ? cleaned : cleaned.slice(0, boundary)).trim();
  const terminator = boundary === -1 ? "" : cleaned.charAt(boundary);

  const excerpt = rawOpening.replace(/\s+/g, " ").slice(0, MAX_EXCERPT_CHARS).trim();
  const allTokens = (rawOpening.toLowerCase().match(LETTERS_RE) ?? []).map(String);
  const tokens = allTokens.slice(0, OPENING_WINDOW_TOKENS);

  return {
    normalized: tokens.join(" "),
    tokens,
    excerpt,
    form: classifyForm(tokens, terminator === "?"),
  };
}

// A question addressed to the reader about their own thinking/knowing. The
// Bulgarian side needs both halves — the interrogative particle "ли" AND a verb
// of cognition — because either alone is far too broad: "ли" appears in most
// Bulgarian questions, and "знаеш" appears in plenty of statements.
const BG_QUESTION_PARTICLE_RE = /(^|\s)ли(\s|$)/;
const BG_COGNITION_RE =
  /(^|\s)(мислил|мислила|мислили|замислял|замисляла|замисляли|знаеш|знаете|чувал|чувала|чували|представял|представяла|представяли|представи|чудил|чудила|чудили|питал|питала|питали)(\s|$)/;
const EN_REFLECTION_RE =
  /(\b(have|has|did|do|does|are|were|ever)\s+you\b|\bever\s+(wondered|thought|noticed|found)\b|\bwhat\s+if\b|\bdid\s+you\s+know\b)/;

function classifyForm(tokens: readonly string[], isQuestion: boolean): OpeningForm {
  if (!isQuestion) return "statement";
  const head = tokens.slice(0, FORM_SCAN_TOKENS).join(" ");
  const bulgarianReflection = BG_QUESTION_PARTICLE_RE.test(head) && BG_COGNITION_RE.test(head);
  if (bulgarianReflection || EN_REFLECTION_RE.test(head)) return "rhetorical_question";
  return "question";
}

// ─── Comparison ──────────────────────────────────────────────────────────────

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function samePrefix(a: readonly string[], b: readonly string[]): boolean {
  if (a.length < OPENING_PREFIX_TOKENS || b.length < OPENING_PREFIX_TOKENS) return false;
  for (let i = 0; i < OPENING_PREFIX_TOKENS; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Compares a candidate's realised opening against recent realised openings.
 *
 * Compares against exactly the posts it is handed and performs no lookup of its
 * own — so history scope (company, channel, exclusions) is entirely the caller's
 * to define, and a caller scoped to one company+channel cannot leak into
 * another. See generate-draft-post.service.ts, which passes the same
 * company+channel window the Jaccard check already uses.
 */
export function checkOpeningDiversity(params: {
  candidateText: string;
  /** Most-recent-first. Only `id` and `text` are read. */
  recentPosts: readonly RecentOpening[];
}): OpeningDiversityResult {
  const candidate = extractOpeningSignature(params.candidateText);
  if (candidate.tokens.length === 0) return clean(candidate.form);

  const history = params.recentPosts
    .map((p) => ({ id: p.id, signature: extractOpeningSignature(p.text) }))
    .filter((h) => h.signature.tokens.length > 0);

  if (history.length === 0) return clean(candidate.form);

  // ── 1. Near-exact: this exact opening, or near enough to it ────────────────
  const candidateSet = new Set(candidate.tokens);
  let bestScore = 0;
  let bestMatch: (typeof history)[number] | null = null;
  let prefixMatch: (typeof history)[number] | null = null;

  for (const entry of history) {
    const score = jaccard(candidateSet, new Set(entry.signature.tokens));
    if (score > bestScore) {
      bestScore = score;
      bestMatch = entry;
    }
    if (!prefixMatch && samePrefix(candidate.tokens, entry.signature.tokens)) {
      prefixMatch = entry;
    }
  }

  const similarity = Math.round(bestScore * 1000) / 1000;
  const comparable = candidate.tokens.length >= MIN_COMPARABLE_TOKENS;
  const nearExact =
    prefixMatch ?? (comparable && bestScore >= OPENING_SIMILARITY_THRESHOLD ? bestMatch : null);

  if (nearExact) {
    return {
      flagged: true,
      matchType: "near_exact",
      matchedPostId: nearExact.id,
      similarity,
      candidateForm: candidate.form,
      matchedOpening: nearExact.signature.excerpt,
    };
  }

  // ── 2. Repeated rhetorical device: different words, same trick ─────────────
  // Only the narrow reflection family, and only against realised history. A
  // rhetorical question stays available the moment the window has none.
  if (candidate.form === "rhetorical_question") {
    const family = history.filter((h) => h.signature.form === "rhetorical_question");
    if (family.length >= RHETORICAL_FAMILY_LIMIT) {
      return {
        flagged: true,
        matchType: "repeated_form",
        matchedPostId: family[0].id,
        similarity,
        candidateForm: candidate.form,
        matchedOpening: family[0].signature.excerpt,
      };
    }
  }

  // ── 3. Saturation: questions have taken over the window ───────────────────
  // A declarative opening can never fail here — there is no such thing as too
  // many statements, and this must not become a quota on ordinary writing.
  if (candidate.form !== "statement") {
    const questions = history.filter((h) => h.signature.form !== "statement");
    if (questions.length >= QUESTION_FORM_LIMIT) {
      return {
        flagged: true,
        matchType: "saturated_form",
        matchedPostId: questions[0].id,
        similarity,
        candidateForm: candidate.form,
        matchedOpening: questions[0].signature.excerpt,
      };
    }
  }

  return { ...clean(candidate.form, similarity) };
}
