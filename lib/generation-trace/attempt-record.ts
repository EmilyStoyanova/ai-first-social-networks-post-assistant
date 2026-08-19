/**
 * What one generation ATTEMPT did, reported by the retry loop.
 *
 * Types only, and deliberately so: `lib/ai/generate-with-retry.ts` is a pure
 * module with no database and no Prisma import, and it must stay that way. It
 * reports attempts through this callback and knows nothing about where they go —
 * which is also what lets a test observe every attempt without a store.
 *
 * The point of recording attempts individually is the requirement that FAILED
 * ones survive. The loop returns only its last candidate, so a run that took
 * three tries used to leave no evidence of the two that were rejected: not the
 * prompts they were given, not what they wrote, and not which gate turned them
 * down. Those are precisely the attempts somebody opens a trace to read.
 */

import type { ContentAngle } from "@/lib/ai/content-angle";
import type { ContentAspect } from "@/lib/ai/content-aspect";
import type { PostPattern } from "@/lib/ai/post-pattern";
import type { ParsedLlmPost } from "@/lib/ai/parse-llm-post";
import type { DuplicateCheckResult } from "@/lib/ai/quality/duplicate-detection";
import type { SemanticGateResult } from "@/lib/ai/generate-with-retry";

/** Why an attempt was not accepted. Mirrors the loop's own retry triggers. */
export type AttemptRejectionReason =
  | "jaccard_duplicate"
  | "semantic_duplicate"
  | "generic_core_message"
  | "repeated_topic"
  | "parse_error"
  | "provider_error";

export interface GenerationAttemptRecord {
  attempt: number;
  maxAttempts: number;
  /** The prompts EXACTLY as sent for this attempt — a retry's differs. */
  systemPrompt: string;
  userPrompt: string;
  /** Provider parameters for this call, as passed. */
  request: { temperature?: number; maxTokens?: number };
  startedAt: Date;
  completedAt: Date;
  durationMs: number;
  /** The reply text, before parsing. Null when the call itself failed. */
  rawResponse: string | null;
  /** The provider's own payload, when it forwards one (token counts, timings). */
  rawProviderPayload?: unknown;
  /** The parsed post, or null when parsing failed. */
  parsed: ParsedLlmPost | null;
  /** Set when the call or the parse threw. */
  error?: { name: string; message: string; category?: string };
  /** Quality gates, evaluated on this attempt's candidate. */
  duplicate?: DuplicateCheckResult;
  semantic?: SemanticGateResult;
  coreMessageGeneric?: boolean;
  topicRepeated?: boolean;
  /** The diversity levers this attempt actually used. */
  angle?: ContentAngle;
  pattern?: PostPattern;
  aspect?: ContentAspect;
  /** Whether this attempt's candidate was kept. */
  accepted: boolean;
  rejectionReason: AttemptRejectionReason | null;
  /** True when the loop had attempts left and intends to make another call. */
  willRetry: boolean;
}

/**
 * The sink the retry loop reports to. Synchronous and must never throw — the
 * loop calls it inside its own try/catch, but a recorder that throws would still
 * be a recorder that lies about what it captured.
 */
export type GenerationAttemptRecorder = (record: GenerationAttemptRecord) => void;
