/**
 * Post generation job handler — a THIN ADAPTER over the existing cron service.
 *
 * The worker is an orchestrator only: this handler contains no generation, LLM,
 * image, or scheduling logic. It delegates to `runGenerationCron` (the same
 * service the cron route used to call inline), maps its summary to compact
 * job-result diagnostics, and re-throws on a top-level failure so the queue
 * applies its retry / terminal-failure policy.
 *
 * Note: `runGenerationCron` already isolates per-company failures (one bad company
 * does not fail the run) and owns its own soft time budget / out-of-band deadline,
 * so a completed run with `failedCompanies > 0` is NOT retried — only a genuine
 * run-level failure (status "failed") throws. This mirrors the ingestion and
 * translation handlers exactly.
 */

import type { JobHandler } from "./handler-registry";
import {
  runGenerationCron,
  type GenerationCronSummary,
} from "@/lib/services/cron/run-generation-cron.service";
import { POST_GENERATION_JOB_TYPE } from "@/lib/queue/job-types";

export { POST_GENERATION_JOB_TYPE };

/**
 * Compact, operator-facing diagnostics persisted as the job's `result`. A `type`
 * (not `interface`) so it carries an index signature and satisfies `JobResult`
 * (Record<string, unknown>). Only the top-level company counts the orchestrator
 * already provides are surfaced — the handler stays thin and never reaches into
 * the per-company generation internals.
 */
export type PostGenerationDiagnostics = {
  runId: string;
  examinedCompanies: number;
  processedCompanies: number;
  failedCompanies: number;
  skippedCompanies: number;
  remainingCompanies: number;
  durationMs: number;
  timedOut: boolean;
};

export function toDiagnostics(summary: GenerationCronSummary): PostGenerationDiagnostics {
  return {
    runId: summary.runId,
    examinedCompanies: summary.examined,
    processedCompanies: summary.processed,
    failedCompanies: summary.failed,
    skippedCompanies: summary.skipped,
    remainingCompanies: summary.remaining,
    durationMs: summary.durationMs,
    timedOut: summary.timedOut,
  };
}

/**
 * Factory so tests can inject the generation runner; production wires the real
 * `runGenerationCron` service (with its own production defaults — the worker never
 * reaches into generation internals, time budgets, or scheduling).
 */
export function createPostGenerationHandler(
  runGeneration: () => Promise<GenerationCronSummary> = () => runGenerationCron()
): JobHandler {
  return async ({ job, logger }) => {
    logger.info("post generation starting", { jobId: job.id, attempt: job.attempts });

    const summary = await runGeneration();
    const diagnostics = toDiagnostics(summary);

    if (summary.status === "failed") {
      logger.error("post generation run failed", { jobId: job.id, error: summary.error });
      // Throw so the orchestrator requeues (retry) or fails terminally per policy.
      throw new Error(summary.error ?? "Post generation run failed");
    }

    logger.info("post generation completed", { jobId: job.id, ...diagnostics });
    return diagnostics;
  };
}

/** The production handler, wired to the real generation service. */
export const postGenerationHandler: JobHandler = createPostGenerationHandler();
