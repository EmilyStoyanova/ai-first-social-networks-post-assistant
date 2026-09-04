/**
 * The wire contract for `POST /crew/post` — the only call the app ever makes
 * into the CrewAI sidecar.
 *
 * Both ends of a process boundary read this module's shape, exactly as
 * `lib/queue/topic-generation-payload.ts` is read by both the enqueuing route
 * and the executing worker. The sidecar is a SEPARATE PROCESS in a separate
 * language that can be restarted, upgraded and re-pinned independently of this
 * repo, so the boundary gets a real schema rather than a cast.
 *
 * ── Why the response is validated strictly ──────────────────────────────────
 *
 * A malformed sidecar reply must become `invalid_response`, never a candidate.
 * The failure mode this guards against is specific and quiet: a reply whose
 * `qa.finalDecision` is missing or unrecognised would, under a lenient parse,
 * default to something — and any default is wrong. Defaulting to `pass` accepts
 * a post no critic approved; defaulting to `unavailable` records a degraded run
 * that actually converged. So an unparseable verdict is refused outright and
 * the caller treats it as an infrastructure problem.
 *
 * ── Why the counters are validated, not merely recorded ─────────────────────
 *
 * "A Writer revision must never bypass the Editor" is a property of the Python
 * Flow, and this side cannot see the Flow. What it CAN see is the arithmetic the
 * Flow reports about itself, and that arithmetic is falsifiable: a run that
 * routed R_w revisions to the Writer must show at least R_w matching Editor
 * calls, because every Writer revision is followed by one. `validateCallCounts`
 * checks that, so a Flow regression that skipped the Editor is caught by the
 * client rather than discovered months later in the output.
 */

import { z } from "zod";
import type { QaState } from "./provenance";

// ─── Request ──────────────────────────────────────────────────────────────────

/**
 * The writing brief, formatted from an article's existing understanding.
 *
 * Deliberately the SHAPE of a brief and not a pointer at one: the sidecar has
 * no database, no Prisma and no secrets, so everything it needs to write must
 * travel in the request. See `lib/ai/agents/research-brief.ts` — the brief is
 * built by a pure function from an understanding that already exists, and NO
 * research agent and no extra LLM call produce it.
 */
export interface CrewArticleBrief {
  /** One sentence: what the article is actually about. */
  mainSubject: string;
  centralThesis: string | null;
  centralConflict: string | null;
  articleType: string | null;
  secondaryTopics: readonly string[];
  incidentalTopics: readonly string[];
  entities: readonly string[];
  /** 0–1, when the understanding carried one. */
  confidence: number | null;
  /**
   * Where the fields above came from. `understanding` is the full
   * `ArticleUnderstanding`; `classification_projection` is the lossy set of
   * scalars a FeedItem persists today; `none` is a mission/evergreen post with
   * no article at all. Carried so a measurement can tell whether a weak result
   * came from the strategy or from a thin brief.
   */
  source: "understanding" | "classification_projection" | "none";
}

export interface CrewGenerationRequirements {
  /**
   * The system and user prompts EXACTLY as the single-agent arm would receive
   * them, straight from `buildPrompts`.
   *
   * This is the load-bearing decision of the whole contract. Brand voice,
   * forbidden words, channel policy, the angle/hook/structure/CTA levers, the
   * source-article window, the topic memory and the language instruction are all
   * already composed into these two strings by one shared builder. Re-deriving
   * any of them for the sidecar would create a second definition of "what a post
   * for this company must be" — and the moment the two drifted, the experiment
   * would be comparing prompts rather than orchestration.
   */
  systemPrompt: string;
  userPrompt: string;
  /** Channel character limit, when the channel has one. */
  maxTextLength: number | null;
  /** The JSON shape the Writer's final candidate must be emitted in. */
  responseContract: "llm_post_json";
}

/** The sampling the sidecar must apply — pinned by the caller, never chosen. */
export interface CrewInferenceConfig {
  model: string;
  baseUrl: string;
  temperature?: number;
  topP?: number;
  topK?: number;
  seed?: number;
  numCtx?: number;
  numPredict?: number;
  repeatPenalty?: number;
  stop?: readonly string[];
}

export interface CrewAttemptContext {
  /** 1-based OUTER attempt — a deterministic-gate retry, not a QA round. */
  attempt: number;
  maxAttempts: number;
  /** Max QA REVISION cycles, i.e. cycles after the first QA evaluation. */
  maxQaRounds: number;
  /**
   * Why the previous outer attempt was rejected, when there was one. The gate's
   * own reason, so the Writer is told what to change rather than merely to try
   * again.
   */
  previousRejection: string | null;
}

export interface CrewPostRequest {
  articleUnderstanding: CrewArticleBrief;
  platform: string;
  language: string;
  brandContext: {
    companyName: string;
    companyDescription: string | null;
    toneOfVoice: string | null;
    targetAudience: string | null;
    forbiddenWords: readonly string[];
  };
  generationRequirements: CrewGenerationRequirements;
  inferenceConfig: CrewInferenceConfig;
  attemptContext: CrewAttemptContext;
}

// ─── Response ─────────────────────────────────────────────────────────────────

/**
 * Every way the sidecar can fail, named.
 *
 * Explicit rather than a single "error", because the caller's policy genuinely
 * differs per code: `qa_parse_error` degrades and keeps the candidate,
 * `non_converged` consumes an outer attempt, `unavailable` and `timeout` are
 * infrastructure faults that release the claimed article, and
 * `invalid_response` says the sidecar's own contract is broken and must be
 * fixed rather than retried into.
 */
export const CREW_FAILURE_CODES = [
  "timeout",
  "unavailable",
  "qa_parse_error",
  "non_converged",
  "invalid_response",
  /**
   * `CREW_SIDECAR_URL` is unset. Its own code, and never a fallback: on a
   * serverless function a loopback URL would reach the FUNCTION's own loopback,
   * so "not configured" must be loud rather than approximated.
   */
  "not_configured",
] as const;

export type CrewFailureCode = (typeof CREW_FAILURE_CODES)[number];

const qaStateSchema = z.enum([
  "pass",
  "revise_writer",
  "revise_editor",
  "rejected_unroutable",
  "unavailable",
]);

/**
 * One QA verdict, as reported. `dimension` is what the router acted on; a
 * rejection naming no actionable dimension is what makes a run
 * `rejected_unroutable`, and the sidecar reports that state rather than leaving
 * this side to infer it from an empty field.
 */
const qaIssueSchema = z.object({
  dimension: z.string(),
  severity: z.enum(["style", "clarity", "factual", "content", "unknown"]),
  detail: z.string(),
});

const candidateSchema = z.object({
  /** The post JSON, as a string — parsed by the existing `parseLlmPost`. */
  raw: z.string().min(1),
});

/**
 * `.strict()`, matching the queue payload's own reasoning: a sidecar upgraded
 * ahead of this repo must fail loudly at the schema rather than run with a field
 * silently dropped. For something that writes published posts, a clear error
 * beats a post generated against instructions nobody gave.
 */
export const crewPostResponseSchema = z
  .object({
    status: z.literal("ok"),
    candidate: candidateSchema,
    qa: z
      .object({
        finalDecision: qaStateSchema,
        /** QA REVISION cycles used — never the number of QA evaluations. */
        revisions: z.number().int().nonnegative(),
        issues: z.array(qaIssueSchema).default([]),
        /** Which agent each revision was routed to, in order. */
        routes: z.array(z.enum(["writer", "editor"])).default([]),
      })
      .strict(),
    agentCalls: z
      .object({
        writer: z.number().int().nonnegative(),
        editor: z.number().int().nonnegative(),
        qa: z.number().int().nonnegative(),
      })
      .strict(),
    latencyMs: z.number().nonnegative(),
    model: z
      .object({
        tag: z.string().min(1),
        digest: z.string().min(1).nullable(),
      })
      .strict(),
    /** Stages that did not complete. Empty on a clean run. */
    degradedStages: z.array(z.string()).default([]),
  })
  .strict();

export type CrewPostResponse = z.infer<typeof crewPostResponseSchema>;

/** An explicit failure body, when the sidecar can describe its own failure. */
export const crewFailureResponseSchema = z
  .object({
    status: z.literal("error"),
    code: z.enum(CREW_FAILURE_CODES),
    message: z.string().optional(),
  })
  .strict();

// ─── Counter validation ───────────────────────────────────────────────────────

export interface CallCountProblem {
  problem: string;
}

/**
 * Checks the arithmetic a run reports about itself against the loop it claims
 * to have executed.
 *
 * Four properties, each of which a real Flow regression would break:
 *
 *  1. The initial pass happened at all — one Writer, one Editor, one QA.
 *  2. QA evaluations = 1 + revisions. A revision that produced no QA call means
 *     a revision was accepted without being re-judged.
 *  3. **Every Writer revision was followed by an Editor pass.** This is
 *     requirement 6, and it is the one this function exists for: with `w`
 *     writer-routed revisions and `e` editor-routed ones, `editorCalls` must be
 *     at least `1 + w + e` — the initial pass, plus one Editor for each
 *     writer-routed round, plus one for each editor-routed round. A Flow that
 *     let a Writer revision go straight to QA would report a short Editor count
 *     and be refused here.
 *  4. Revisions never exceeded the bound the caller set.
 *
 * Returns null when the arithmetic holds.
 */
export function validateCallCounts(
  response: CrewPostResponse,
  maxQaRounds: number
): CallCountProblem | null {
  const { writer, editor, qa } = response.agentCalls;
  const revisions = response.qa.revisions;
  const routes = response.qa.routes;

  if (revisions > maxQaRounds) {
    return {
      problem: `QA reported ${revisions} revision cycles, above the ${maxQaRounds} allowed.`,
    };
  }
  if (routes.length !== revisions) {
    return {
      problem: `QA reported ${revisions} revision cycles but named ${routes.length} routes.`,
    };
  }

  // The initial Writer → Editor → QA pass. A `unavailable` QA legitimately
  // makes no QA call, so that stage alone is allowed to be short — and only
  // when the run says so.
  const qaUnavailable = response.qa.finalDecision === "unavailable";
  if (writer < 1) return { problem: "No Writer call was reported." };
  if (editor < 1 && !response.degradedStages.includes("editor")) {
    return { problem: "No Editor call was reported and the Editor was not marked degraded." };
  }
  if (qa < 1 && !qaUnavailable) {
    return { problem: "No QA call was reported and QA was not reported unavailable." };
  }

  const writerRoutes = routes.filter((r) => r === "writer").length;
  const editorRoutes = routes.filter((r) => r === "editor").length;

  if (writer < 1 + writerRoutes) {
    return {
      problem: `${writerRoutes} writer-routed revision(s) reported but only ${writer} Writer call(s).`,
    };
  }

  // Requirement 6, as arithmetic. Skipped only when the Editor itself degraded,
  // where a short count is the honest report of a stage that failed.
  if (!response.degradedStages.includes("editor")) {
    const expectedEditor = 1 + writerRoutes + editorRoutes;
    if (editor < expectedEditor) {
      return {
        problem:
          `Editor was bypassed: ${writerRoutes} writer-routed and ${editorRoutes} editor-routed ` +
          `revision(s) require at least ${expectedEditor} Editor call(s), but ${editor} were reported.`,
      };
    }
  }

  if (!qaUnavailable && qa < 1 + revisions) {
    return {
      problem: `${revisions} revision cycle(s) require at least ${1 + revisions} QA call(s), but ${qa} were reported.`,
    };
  }

  return null;
}

/**
 * The QA state a response settles on, refusing every route that should not
 * survive to the caller.
 *
 * A response that reaches this side still carrying `revise_writer` or
 * `revise_editor` is a Flow that stopped mid-loop and handed back a candidate
 * nobody finished judging. That is not a verdict, so it is refused as
 * `non_converged` rather than mapped to the nearest acceptable state — mapping
 * it to `pass` would accept an unjudged post, and mapping it to `unavailable`
 * would claim QA never ran when it plainly did.
 */
export function resolveQaState(
  response: CrewPostResponse
): { ok: true; state: QaState } | { ok: false; code: CrewFailureCode; problem: string } {
  const decision = response.qa.finalDecision;
  if (decision === "revise_writer" || decision === "revise_editor") {
    return {
      ok: false,
      code: "non_converged",
      problem: `The sidecar returned mid-loop verdict "${decision}" instead of a terminal one.`,
    };
  }
  return { ok: true, state: decision };
}
