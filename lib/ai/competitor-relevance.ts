/**
 * Competitive Intelligence — RELEVANCE (Part 3B, §7/§8/§11 of the governing
 * instruction).
 *
 * The SOLE owner of `relevance` / `relevanceReason` / `matchedResearchTopics` /
 * `relevanceProfileVersion` on `CompetitorIntelligence`. Never owns, and never
 * receives, anything from `competitor-intelligence-extraction.ts`'s output
 * beyond the already-extracted intrinsic fields — this step evaluates content
 * that has ALREADY been analyzed against the company's CURRENT Research
 * Profile, and nothing else. That separation is what lets a Research Profile
 * change (`update-research-profile.service.ts` bumping `profileVersion`)
 * recompute just these four columns via `recompute-stale-relevance.service.ts`
 * without ever re-running the extraction model call (§12).
 *
 * Deliberately reuses none of `lib/ai/topic-priorities.ts` or
 * `lib/ai/feed-item-classification.ts`'s verdict/threshold logic — per the
 * approved plan (§3.6), the HIGH/MEDIUM/REJECTED tiering is a different
 * decision built for a different question ("should generation draw from
 * this?"), and `relevant`/`related`/`out_of_scope` is an independent,
 * purpose-built scale for "does this competitor content speak to what we are
 * trying to learn?". No shared type or decision function with that module.
 */

export const COMPETITOR_RELEVANCE_VERDICTS = ["relevant", "related", "out_of_scope"] as const;
export type CompetitorRelevanceVerdict = (typeof COMPETITOR_RELEVANCE_VERDICTS)[number];

export const MAX_RELEVANCE_OUTPUT_TOKENS = 400;
export const RELEVANCE_ATTEMPT_TIMEOUT_MS = 30_000;
export const MAX_RELEVANCE_REPAIR_ATTEMPTS = 1;
export const MAX_STORED_RELEVANCE_REASON_CHARS = 300;
export const MAX_STORED_MATCHED_RESEARCH_TOPICS = 10;
/** Rows processed per company per recompute run — see
 *  `recompute-stale-relevance.service.ts`'s "no unbounded synchronous loop"
 *  requirement (§12/§27 of the governing instruction). */
export const RELEVANCE_BATCH_SIZE = 25;
/** 2026-09 relevance-retry fix — mirrors `MAX_EXTRACTION_ATTEMPTS`'s role for
 *  extraction. Bounds how many times `recomputeRelevanceForRow` will retry a
 *  row against the SAME profile version before settling it (pending +
 *  explanatory reason) so the drain stops reselecting it — see
 *  `recompute-stale-relevance.service.ts`'s module comment. */
export const MAX_RELEVANCE_ATTEMPTS = 3;

/** What relevance is judged FROM — the already-extracted intrinsic fields.
 *  Deliberately a narrow read-only view, not the whole CompetitorIntelligence
 *  row, so nothing here can accidentally start depending on extraction- or
 *  pipeline-status columns. */
export interface RelevanceSubject {
  topic: string | null;
  subtopic: string | null;
  summary: string | null;
  angle: string | null;
  keyMessage: string | null;
  targetAudience: string | null;
  problemAddressed: string | null;
  productsServicesMentioned: string[];
}

/** The Research Profile fields relevance is judged AGAINST — never markets-only
 *  or topics-only; both matter to "does this speak to what we're tracking". */
export interface RelevanceProfile {
  researchTopics: string[];
  markets: string[];
}

function hasNoSubject(s: RelevanceSubject): boolean {
  return (
    !s.topic &&
    !s.subtopic &&
    !s.summary &&
    !s.angle &&
    !s.keyMessage &&
    !s.targetAudience &&
    !s.problemAddressed &&
    s.productsServicesMentioned.length === 0
  );
}

/** Whether a research profile has anything at all to judge against. An empty
 *  profile can support no verdict but `out_of_scope` — mirrors
 *  `classificationMode`'s "none configured" handling. */
export function hasResearchInterests(profile: RelevanceProfile): boolean {
  return profile.researchTopics.length > 0 || profile.markets.length > 0;
}

// ─── The reply contract ───────────────────────────────────────────────────

export const RELEVANCE_JSON_SCHEMA = {
  type: "object",
  properties: {
    relevance: { type: "string", enum: [...COMPETITOR_RELEVANCE_VERDICTS] },
    reason: { type: "string" },
    matchedResearchTopics: { type: "array", items: { type: "string" } },
  },
  required: ["relevance", "reason", "matchedResearchTopics"],
  additionalProperties: false,
} as const;

export interface RelevanceVerdict {
  relevance: CompetitorRelevanceVerdict;
  reason: string;
  /** Verbatim entries from `profile.researchTopics` only — see the vetting in
   *  `parseRelevanceResponse`. */
  matchedResearchTopics: string[];
}

export type RelevanceOutcome =
  ({ status: "ok" } & RelevanceVerdict) | { status: "invalid"; problem: string; feedback: string };

export class RelevanceParseError extends Error {
  readonly code = "RELEVANCE_EMPTY_RESPONSE" as const;
  constructor(message: string) {
    super(message);
    this.name = "RelevanceParseError";
  }
}

function findJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      if (inString) escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function invalid(problem: string, feedback: string): RelevanceOutcome {
  return { status: "invalid", problem, feedback };
}

/**
 * Parses and vets a relevance reply. `matchedResearchTopics` entries not
 * copied verbatim from `profile.researchTopics` are refused rather than
 * silently dropped — the same precision rule
 * `parseClassificationResponse` enforces for its own matched-topics list, and
 * for the identical reason: a verdict resting on an invented topic is a
 * failure, not a detail to clean up quietly.
 */
export function parseRelevanceResponse(
  raw: string | null | undefined,
  profile: RelevanceProfile
): RelevanceOutcome {
  const text = (raw ?? "").trim();
  if (text === "") {
    throw new RelevanceParseError("The relevance model returned an empty response.");
  }

  const json = findJsonObject(text);
  if (json === null) {
    return invalid(
      "The relevance model replied with prose instead of the required JSON object.",
      "Your reply was not JSON. Answer with a SINGLE JSON object and nothing else — no prose before or after it, no markdown fences."
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return invalid(
      "The relevance model's JSON could not be parsed.",
      "Your JSON was malformed. Answer again with a single valid JSON object, and check that every string is quoted and every list closed."
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return invalid(
      "The relevance model's reply was not a JSON object.",
      "Answer with a single JSON object with the keys described, not an array or a bare value."
    );
  }

  const obj = parsed as Record<string, unknown>;

  const label = asString(obj.relevance);
  if (!label || !(COMPETITOR_RELEVANCE_VERDICTS as readonly string[]).includes(label)) {
    return invalid(
      `"relevance" was ${JSON.stringify(obj.relevance)}, which is not one of the allowed labels.`,
      '"relevance" must be exactly one of "relevant", "related", or "out_of_scope".'
    );
  }
  const relevance = label as CompetitorRelevanceVerdict;

  const topicIndex = new Map(profile.researchTopics.map((t) => [t.trim().toLowerCase(), t]));
  const rawMatched = Array.isArray(obj.matchedResearchTopics) ? obj.matchedResearchTopics : [];
  const matched: string[] = [];
  const invented: string[] = [];
  const seen = new Set<string>();
  for (const entry of rawMatched) {
    const candidate = asString(entry);
    if (!candidate) continue;
    const hit = topicIndex.get(candidate.toLowerCase());
    if (!hit) {
      if (!invented.some((t) => t.toLowerCase() === candidate.toLowerCase()))
        invented.push(candidate);
      continue;
    }
    if (seen.has(hit)) continue;
    seen.add(hit);
    matched.push(hit);
  }
  if (invented.length > 0) {
    return invalid(
      `The reply cited ${invented.length} research topic(s) that are not in the profile: ${invented.join(", ")}.`,
      `${JSON.stringify(invented[0])} is not one of the research topics. Every entry in "matchedResearchTopics" must be copied VERBATIM from the list given — do not translate, rephrase, or invent one. If nothing matches, leave the list empty.`
    );
  }

  if (relevance !== "out_of_scope" && matched.length === 0) {
    return invalid(
      `"relevance" was "${relevance}" but no research topic was cited in "matchedResearchTopics".`,
      'A "relevant" or "related" verdict must cite at least one research topic it matches, copied verbatim. If nothing genuinely matches, answer "out_of_scope" with an empty list instead.'
    );
  }
  if (relevance === "out_of_scope" && matched.length > 0) {
    return invalid(
      '"relevance" was "out_of_scope" but a research topic was cited in "matchedResearchTopics".',
      'Those contradict each other. If the content genuinely matches a research topic, answer "relevant" or "related" instead; otherwise leave "matchedResearchTopics" empty.'
    );
  }

  const reason = asString(obj.reason);
  if (!reason) {
    return invalid(
      "The verdict came with no explanation.",
      'The "reason" field must be one short sentence saying why the content does or does not match the research profile.'
    );
  }

  return {
    status: "ok",
    relevance,
    reason: reason.slice(0, MAX_STORED_RELEVANCE_REASON_CHARS),
    matchedResearchTopics: matched.slice(0, MAX_STORED_MATCHED_RESEARCH_TOPICS),
  };
}

// ─── Prompts ───────────────────────────────────────────────────────────────

export function buildRelevanceSystemPrompt(): string {
  return [
    "You judge whether a piece of ALREADY-ANALYZED competitor content is relevant to a company's research interests.",
    "",
    "You are given the content's already-determined topic/subtopic/angle/key message/etc, and the company's Research Profile (topics it wants to track, and markets it cares about). Judge ONLY whether this content speaks to those research interests — do not re-analyze the content itself, and do not judge whether the company should copy or respond to it.",
    "",
    "## Verdicts",
    "",
    '- "relevant" — the content is substantially about one or more of the research topics (or markets), the kind of thing the company most wants to see.',
    '- "related" — the content touches a research topic or market, but only partially, tangentially, or as one of several subjects, not centrally.',
    '- "out_of_scope" — the content matches none of the research topics or markets.',
    "",
    "## Rules",
    "",
    "1. Judge meaning, not keyword overlap — a topic written in one language matches content in another when the meanings correspond.",
    '2. Every entry in "matchedResearchTopics" must be copied VERBATIM from the research topics list given below — never translated, rephrased, or invented. Leave it empty for "out_of_scope".',
    '3. A "relevant" or "related" verdict must cite at least one research topic it rests on.',
    '4. Markets inform your judgement (e.g. content clearly about a market the company tracks counts toward relevance) but are never themselves listed in "matchedResearchTopics" — that field is for RESEARCH TOPICS only.',
    "",
    "Reply with a single JSON object and nothing else:",
    "",
    "{",
    '  "relevance": "relevant" | "related" | "out_of_scope",',
    '  "reason": "<one short sentence>",',
    '  "matchedResearchTopics": ["<topic copied verbatim from the list>"]',
    "}",
  ].join("\n");
}

export function buildRelevanceUserPrompt(
  subject: RelevanceSubject,
  profile: RelevanceProfile
): string {
  const lines: string[] = ["## Content already analyzed", ""];
  const field = (label: string, value: string | null) => {
    if (value) lines.push(`${label}: ${value}`);
  };
  field("Topic", subject.topic);
  field("Subtopic", subject.subtopic);
  field("Summary", subject.summary);
  field("Angle", subject.angle);
  field("Key message", subject.keyMessage);
  field("Target audience", subject.targetAudience);
  field("Problem addressed", subject.problemAddressed);
  if (subject.productsServicesMentioned.length > 0) {
    lines.push(`Products/services mentioned: ${subject.productsServicesMentioned.join(", ")}`);
  }
  if (hasNoSubject(subject)) {
    lines.push("(No intrinsic fields were extracted for this content.)");
  }

  lines.push(
    "",
    "## Research Profile",
    "",
    profile.researchTopics.length > 0
      ? `Research topics:\n${profile.researchTopics.map((t) => `- ${t}`).join("\n")}`
      : "Research topics: (none configured)",
    "",
    profile.markets.length > 0
      ? `Markets:\n${profile.markets.map((m) => `- ${m}`).join("\n")}`
      : "Markets: (none configured)"
  );

  return lines.join("\n");
}

export function buildRelevanceRepairPrompt(
  originalUserPrompt: string,
  badReply: string,
  feedback: string
): string {
  return [
    originalUserPrompt,
    "",
    "## Your previous answer was rejected",
    "",
    badReply.trim().slice(0, 500),
    "",
    feedback,
    "",
    "Answer again with a single valid JSON object and nothing else.",
  ].join("\n");
}
