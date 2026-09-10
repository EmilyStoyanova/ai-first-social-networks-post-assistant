import { prisma } from "@/lib/db/client";
import type {
  GenerationRunKind,
  GenerationRunStatus,
  GenerationStepStatus,
  GenerationStrategy,
  GenerationTrigger,
  ModelVerification,
  Prisma,
  SocialChannel,
  StrategySource,
} from "@prisma/client";

/**
 * The write side of the trace, as a narrow interface.
 *
 * Same pattern as every service in this codebase: the real Prisma client
 * satisfies the shape, and tests inject a fake that captures the write. It
 * matters more here than usual — a tracing bug that only appears against a real
 * database is a bug nobody would notice until the day they needed the trace.
 */

export interface PersistableStep {
  sequence: number;
  type: string;
  label: string | null;
  status: GenerationStepStatus;
  attempt: number | null;
  startedAt: Date | null;
  completedAt: Date | null;
  durationMs: number | null;
  input: Prisma.InputJsonValue | null;
  output: Prisma.InputJsonValue | null;
  metadata: Prisma.InputJsonValue | null;
  errorMessage: string | null;
  linkedRunId: string | null;
}

/**
 * Which orchestration ran, why it was chosen, and what it cost.
 *
 * A nested object rather than eighteen more fields on `PersistableRun`, so the
 * two concerns stay legible: everything above describes a generation run,
 * everything here describes the STRATEGY decision and its measurement. It is
 * flattened onto the row by the store, because a report groups by these columns.
 *
 * Null throughout on a run that recorded nothing, and that is the only correct
 * default: `degraded: false` would assert of a single-agent run that its (absent)
 * critic did not degrade, and `strategy: "single"` would let an unobserved run be
 * counted into an arm.
 */
export interface PersistableStrategy {
  generationStrategy: GenerationStrategy | null;
  generationStrategySource: StrategySource | null;
  experimentKey: string | null;
  experimentArm: GenerationStrategy | null;
  experimentUnitId: string | null;
  experimentBucket: number | null;
  experimentAllocation: number | null;
  inferenceFingerprint: string | null;
  modelTag: string | null;
  modelDigest: string | null;
  modelVerification: ModelVerification | null;
  qaState: string | null;
  qaRevisionRounds: number | null;
  agentCalls: number | null;
  agentLatencyMs: number | null;
  degraded: boolean | null;
  degradedStages: string[];
}

export interface PersistableRun {
  id: string;
  companyId: string | null;
  postId: string | null;
  feedItemId: string | null;
  kind: GenerationRunKind;
  trigger: GenerationTrigger;
  status: GenerationRunStatus;
  channel: SocialChannel | null;
  language: string | null;
  userId: string | null;
  contentGroupId: string | null;
  generationBatchId: string | null;
  scheduleId: string | null;
  jobId: string | null;
  llmProvider: string | null;
  llmModel: string | null;
  attempts: number;
  startedAt: Date;
  completedAt: Date | null;
  durationMs: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  options: Prisma.InputJsonValue | null;
  truncated: boolean;
  /**
   * The strategy decision and its measurement. Null when the run never learned
   * one — a feed-item operation (translation, classification, extraction) has no
   * generation strategy at all, and must not be given one.
   */
  strategy: PersistableStrategy | null;
  steps: PersistableStep[];
}

export interface GenerationTraceStore {
  saveRun(run: PersistableRun): Promise<void>;
}

/**
 * The production store: one nested insert per run.
 *
 * Deliberately a single statement rather than a row-per-step drip. A run is
 * written once, at the end, when every step is known — so the database sees one
 * short write instead of fifteen interleaved with the LLM calls it is tracing,
 * and a run can never be half-persisted.
 */
export const prismaTraceStore: GenerationTraceStore = {
  async saveRun(run) {
    await prisma.generationRun.create({
      data: {
        id: run.id,
        companyId: run.companyId,
        postId: run.postId,
        feedItemId: run.feedItemId,
        kind: run.kind,
        trigger: run.trigger,
        status: run.status,
        channel: run.channel,
        language: run.language,
        userId: run.userId,
        contentGroupId: run.contentGroupId,
        generationBatchId: run.generationBatchId,
        scheduleId: run.scheduleId,
        jobId: run.jobId,
        llmProvider: run.llmProvider,
        llmModel: run.llmModel,
        attempts: run.attempts,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        durationMs: run.durationMs,
        errorCode: run.errorCode,
        errorMessage: run.errorMessage,
        ...(run.options === null ? {} : { options: run.options }),
        truncated: run.truncated,
        // Spread rather than eighteen conditional keys: every field is already
        // nullable in the schema, so an all-null strategy writes all-nulls, which
        // is what a run with no strategy means. `degradedStages` is a scalar list
        // and Postgres has no null for one, so an absent strategy writes `[]`.
        ...(run.strategy === null ? {} : run.strategy),
        steps: {
          create: run.steps.map((step) => ({
            sequence: step.sequence,
            type: step.type,
            label: step.label,
            status: step.status,
            attempt: step.attempt,
            startedAt: step.startedAt,
            completedAt: step.completedAt,
            durationMs: step.durationMs,
            ...(step.input === null ? {} : { input: step.input }),
            ...(step.output === null ? {} : { output: step.output }),
            ...(step.metadata === null ? {} : { metadata: step.metadata }),
            errorMessage: step.errorMessage,
            linkedRunId: step.linkedRunId,
          })),
        },
      },
      select: { id: true },
    });
  },
};
