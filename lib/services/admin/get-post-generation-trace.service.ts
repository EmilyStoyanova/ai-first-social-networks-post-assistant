import { prisma } from "@/lib/db/client";
import type { Prisma } from "@prisma/client";

/**
 * Reading back everything a post's generation did — the admin side of the trace.
 *
 * ── Global admin only, and that is a product decision, not a shortcut ────────
 *
 * A trace holds the exact prompts, the raw model replies and a full snapshot of
 * the brand guidelines in force at the time. That is deep operational detail
 * about how the system works, and it is exactly what an operator needs when a
 * post comes out wrong — but it is not a company-facing view. Everything here is
 * therefore gated on `User.isGlobalAdmin`, with no company-membership path at
 * all, so there is no role to get wrong later.
 *
 * ── Linked runs are followed, once ──────────────────────────────────────────
 *
 * A post's translation and classification steps hold the verdict and a reference
 * (`linkedRunId`) rather than a copy of the prompts and the raw reply — see
 * lib/generation-trace/feed-item-artifacts.ts. This service resolves those
 * references in ONE extra query and returns them alongside, so the UI renders a
 * complete timeline without an N+1 and without the writer having duplicated an
 * article's translation into every post written from it.
 *
 * A reference that no longer resolves (its feed item was deleted with its source)
 * is simply absent from `linkedRuns`, and the UI says the detail is no longer
 * available. That is the truth, and it is why `linkedRunId` is not a foreign key.
 */

export interface TraceStepView {
  id: string;
  sequence: number;
  type: string;
  label: string | null;
  status: "success" | "failed" | "skipped";
  attempt: number | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  input: Prisma.JsonValue | null;
  output: Prisma.JsonValue | null;
  metadata: Prisma.JsonValue | null;
  errorMessage: string | null;
  linkedRunId: string | null;
}

export interface TraceRunView {
  id: string;
  kind: string;
  trigger: string;
  status: string;
  channel: string | null;
  language: string | null;
  postId: string | null;
  feedItemId: string | null;
  contentGroupId: string | null;
  generationBatchId: string | null;
  scheduleId: string | null;
  jobId: string | null;
  llmProvider: string | null;
  llmModel: string | null;
  attempts: number;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  options: Prisma.JsonValue | null;
  /** True when any captured value hit a size cap — the UI must say so. */
  truncated: boolean;
  requestedBy: { id: string; name: string | null; email: string } | null;
  steps: TraceStepView[];
}

export interface PostGenerationTraceView {
  postId: string;
  /** Newest last, so the timeline reads in the order things happened. */
  runs: TraceRunView[];
  /**
   * Feed-item runs referenced by `linkedRunId` on any step above, keyed by id.
   * The full translation/classification/extraction detail, stored once.
   */
  linkedRuns: Record<string, TraceRunView>;
}

export type GetPostGenerationTraceResult =
  | { success: true; data: PostGenerationTraceView }
  | { success: false; code: "FORBIDDEN" | "NOT_FOUND" };

const RUN_SELECT = {
  id: true,
  kind: true,
  trigger: true,
  status: true,
  channel: true,
  language: true,
  postId: true,
  feedItemId: true,
  contentGroupId: true,
  generationBatchId: true,
  scheduleId: true,
  jobId: true,
  llmProvider: true,
  llmModel: true,
  attempts: true,
  startedAt: true,
  completedAt: true,
  durationMs: true,
  errorCode: true,
  errorMessage: true,
  options: true,
  truncated: true,
  user: { select: { id: true, name: true, email: true } },
  steps: {
    orderBy: { sequence: "asc" },
    select: {
      id: true,
      sequence: true,
      type: true,
      label: true,
      status: true,
      attempt: true,
      startedAt: true,
      completedAt: true,
      durationMs: true,
      input: true,
      output: true,
      metadata: true,
      errorMessage: true,
      linkedRunId: true,
    },
  },
} satisfies Prisma.GenerationRunSelect;

type RunRow = Prisma.GenerationRunGetPayload<{ select: typeof RUN_SELECT }>;

function toView(row: RunRow): TraceRunView {
  return {
    id: row.id,
    kind: row.kind,
    trigger: row.trigger,
    status: row.status,
    channel: row.channel,
    language: row.language,
    postId: row.postId,
    feedItemId: row.feedItemId,
    contentGroupId: row.contentGroupId,
    generationBatchId: row.generationBatchId,
    scheduleId: row.scheduleId,
    jobId: row.jobId,
    llmProvider: row.llmProvider,
    llmModel: row.llmModel,
    attempts: row.attempts,
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    durationMs: row.durationMs,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    options: row.options,
    truncated: row.truncated,
    requestedBy: row.user ? { id: row.user.id, name: row.user.name, email: row.user.email } : null,
    steps: row.steps.map((step) => ({
      id: step.id,
      sequence: step.sequence,
      type: step.type,
      label: step.label,
      status: step.status,
      attempt: step.attempt,
      startedAt: step.startedAt?.toISOString() ?? null,
      completedAt: step.completedAt?.toISOString() ?? null,
      durationMs: step.durationMs,
      input: step.input,
      output: step.output,
      metadata: step.metadata,
      errorMessage: step.errorMessage,
      linkedRunId: step.linkedRunId,
    })),
  };
}

export interface GetPostGenerationTraceDb {
  post: {
    findUnique: (args: {
      where: { id: string };
      select: { id: true };
    }) => Promise<{ id: string } | null>;
  };
  generationRun: {
    findMany: (args: {
      where: Record<string, unknown>;
      orderBy: { startedAt: "asc" };
      select: typeof RUN_SELECT;
    }) => Promise<RunRow[]>;
  };
}

export async function getPostGenerationTrace(
  postId: string,
  isGlobalAdmin: boolean,
  db: GetPostGenerationTraceDb = prisma as unknown as GetPostGenerationTraceDb
): Promise<GetPostGenerationTraceResult> {
  if (!isGlobalAdmin) return { success: false, code: "FORBIDDEN" };

  // The post itself, so a deleted post reads as NOT_FOUND rather than as a post
  // with an empty trace — those are different answers, and only one of them
  // means "this post predates tracing".
  const post = await db.post.findUnique({ where: { id: postId }, select: { id: true } });
  if (!post) return { success: false, code: "NOT_FOUND" };

  const runs = await db.generationRun.findMany({
    where: { postId },
    orderBy: { startedAt: "asc" },
    select: RUN_SELECT,
  });

  const linkedIds = [
    ...new Set(
      runs.flatMap((run) =>
        run.steps.map((s) => s.linkedRunId).filter((id): id is string => id !== null)
      )
    ),
  ];

  const linkedRows =
    linkedIds.length === 0
      ? []
      : await db.generationRun.findMany({
          where: { id: { in: linkedIds } },
          orderBy: { startedAt: "asc" },
          select: RUN_SELECT,
        });

  return {
    success: true,
    data: {
      postId,
      runs: runs.map(toView),
      linkedRuns: Object.fromEntries(linkedRows.map((row) => [row.id, toView(row)])),
    },
  };
}
