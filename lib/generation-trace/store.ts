import { prisma } from "@/lib/db/client";
import type {
  GenerationRunKind,
  GenerationRunStatus,
  GenerationStepStatus,
  GenerationTrigger,
  Prisma,
  SocialChannel,
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
