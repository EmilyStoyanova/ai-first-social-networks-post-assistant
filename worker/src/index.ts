/**
 * Worker bootstrap.
 *
 * Boots a worker process that:
 *   1. loads + validates config from the environment,
 *   2. registers itself in the `workers` table (status: starting),
 *   3. starts heartbeats,
 *   4. recovers any stale-leased jobs, then starts the polling loop (idle),
 *   5. claims + dispatches jobs through the orchestrator (Phase 2),
 *   6. shuts down cleanly on SIGTERM/SIGINT (draining → stopped).
 *
 * The worker is an ORCHESTRATOR ONLY: it manages the queue, claiming, retries,
 * diagnostics and persistence. All real work lives in the registered handlers,
 * which are thin adapters over the existing services. Registered so far: the
 * dummy handler (Phase 2), RSS ingestion (Phase 3), RSS translation (Phase 4),
 * post generation (Phase 5), the Buffer analytics refresh, the publishing sweep,
 * and manual MULTI-CHANNEL bulk generation.
 *
 * That last one is the only job a person is actively waiting on, and the only
 * one queued for arithmetic rather than cadence: one topic across three channels
 * is three full generations, so ten topics is thirty — well past any HTTP
 * function cap. Single-post manual generation is NOT migrated and stays a
 * synchronous request path, which it comfortably fits in.
 *
 * The publishing sweep is the one job whose CADENCE matters rather than just its
 * completion: it is the only path that hands scheduled posts to Buffer, and a
 * manually scheduled post is only publishable for 90 minutes after its slot. It is
 * driven by an external 30-minute scheduler calling /api/v1/internal/cron/publish,
 * with the daily generation tick enqueuing the same job as a floor. A worker that
 * is down therefore does not merely delay posts — it strands them.
 *
 * Run from the repo root so the shared client and env resolve:
 *   npx tsx worker/src/index.ts
 */

// MUST be first: loads .env before any import below can reach the Prisma client.
import "./load-env";

import { loadWorkerConfig } from "./config";
import { createLogger } from "./logger";
import { WorkerRegistry } from "./registry";
import { PollingRunner } from "./runner";
import { JobOrchestrator } from "./orchestrator";
import { HandlerRegistry } from "./handler-registry";
import { dummyHandler, DUMMY_JOB_TYPE } from "./dummy-handler";
import { rssIngestionHandler, RSS_INGESTION_JOB_TYPE } from "./rss-ingestion-handler";
import { rssTranslationHandler, RSS_TRANSLATION_JOB_TYPE } from "./rss-translation-handler";
import { postGenerationHandler, POST_GENERATION_JOB_TYPE } from "./post-generation-handler";
import { analyticsSyncHandler, ANALYTICS_SYNC_JOB_TYPE } from "./analytics-sync-handler";
import { publishSweepHandler, PUBLISH_SWEEP_JOB_TYPE } from "./publish-sweep-handler";
import { bulkGenerationHandlerFor, BULK_GENERATION_JOB_TYPE } from "./bulk-generation-handler";
import { createPrismaWorkerStore, createPrismaJobStore } from "./prisma-adapters";
import type { JobRecord } from "./job-store";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const config = loadWorkerConfig();
  const logger = createLogger(`worker:${config.workerId}`);
  logger.info("boot", {
    hostname: config.hostname,
    pid: config.pid,
    concurrency: config.concurrency,
    pollIntervalMs: config.pollIntervalMs,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    leaseTtlMs: config.leaseTtlMs,
  });

  // Import the shared client AFTER config validation so a bad env fails with a
  // clear message before any connection is constructed.
  const { prisma } = await import("@/lib/db/client");

  const registry = new WorkerRegistry({
    store: createPrismaWorkerStore(prisma),
    config,
    logger,
  });

  // The engine: queue management, claiming, orchestration, retries, diagnostics.
  // Handlers are thin adapters over the existing services (orchestrator-only).
  const handlers = new HandlerRegistry()
    .register(DUMMY_JOB_TYPE, dummyHandler)
    .register(RSS_INGESTION_JOB_TYPE, rssIngestionHandler)
    .register(RSS_TRANSLATION_JOB_TYPE, rssTranslationHandler)
    .register(POST_GENERATION_JOB_TYPE, postGenerationHandler)
    .register(ANALYTICS_SYNC_JOB_TYPE, analyticsSyncHandler)
    .register(PUBLISH_SWEEP_JOB_TYPE, publishSweepHandler)
    // The one interactive job: a person is waiting on it, so it reports progress
    // as it goes and resumes rather than repeats on a retry.
    .register(BULK_GENERATION_JOB_TYPE, bulkGenerationHandlerFor(config));
  const orchestrator = new JobOrchestrator({
    store: createPrismaJobStore(prisma),
    registry: handlers,
    config,
    logger,
  });

  await registry.register();
  registry.startHeartbeat();

  // Recover anything a previous crashed worker left leased, then poll.
  await orchestrator.reapOnce();

  const runner = new PollingRunner<JobRecord>({
    config,
    logger,
    registry,
    claim: () => orchestrator.claim(),
    processJob: (job) => orchestrator.process(job),
  });
  runner.start();
  logger.info("ready", { status: registry.currentStatus(), handlers: handlers.types() });

  // Periodic stale-lease recovery. Cheap; runs independently of the poll loop.
  const reapIntervalMs = Math.max(30_000, Math.floor(config.leaseTtlMs / 2));
  const reaper = setInterval(() => void orchestrator.reapOnce(), reapIntervalMs);

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutdown", { signal });
    try {
      clearInterval(reaper);
      await registry.setStatus("draining");
      await Promise.race([runner.stop(), delay(config.shutdownGraceMs)]);
      await registry.markStopped();
      await prisma.$disconnect();
      process.exit(0);
    } catch (err) {
      logger.error("shutdown failed", { error: String(err) });
      process.exit(1);
    }
  };

  process.once("SIGTERM", (signal) => void shutdown(signal));
  process.once("SIGINT", (signal) => void shutdown(signal));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
