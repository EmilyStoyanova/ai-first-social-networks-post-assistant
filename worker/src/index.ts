/**
 * Worker bootstrap.
 *
 * Boots a worker process that:
 *   1. loads + validates config from the environment,
 *   2. registers itself in the `workers` table (status: starting),
 *   3. opens the wake listener, if a secret is configured,
 *   4. recovers any stale-leased jobs, then starts the polling loop (idle),
 *   5. claims + dispatches jobs through the orchestrator (Phase 2),
 *   6. goes dormant when the queue stays empty — connection closed, nothing sent
 *      to the database — until a wake signal or the fallback interval,
 *   7. shuts down cleanly on SIGTERM/SIGINT (draining → stopped).
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
import {
  rssClassificationHandler,
  RSS_CLASSIFICATION_JOB_TYPE,
} from "./rss-classification-handler";
import { postGenerationHandler, POST_GENERATION_JOB_TYPE } from "./post-generation-handler";
import { analyticsSyncHandler, ANALYTICS_SYNC_JOB_TYPE } from "./analytics-sync-handler";
import { publishSweepHandler, PUBLISH_SWEEP_JOB_TYPE } from "./publish-sweep-handler";
import { bulkGenerationHandlerFor, BULK_GENERATION_JOB_TYPE } from "./bulk-generation-handler";
import { topicGenerationHandlerFor, TOPIC_GENERATION_JOB_TYPE } from "./topic-generation-handler";
import {
  productPageExtractionHandler,
  PRODUCT_PAGE_EXTRACTION_JOB_TYPE,
} from "./product-page-extraction-handler";
import {
  competitorIntelligenceExtractionHandler,
  COMPETITOR_INTELLIGENCE_EXTRACTION_JOB_TYPE,
} from "./competitor-intelligence-extraction-handler";
import {
  competitorRelevanceHandler,
  COMPETITOR_RELEVANCE_JOB_TYPE,
} from "./competitor-relevance-handler";
import { createPrismaWorkerStore, createPrismaJobStore } from "./prisma-adapters";
import { WakeSignal } from "./wake-signal";
import { createWakeServer } from "./wake-server";
import { WakeGuard } from "@/lib/security/wake-auth";
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
    dormantAfterMs: config.dormantAfterMs,
    fallbackPollMs: config.fallbackPollMs,
    reapIntervalMs: config.reapIntervalMs,
    wakeListener: config.wakeSecret ? `${config.wakeHost}:${config.wakePort}` : "disabled",
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
    // Gives every ingested article a HIGH/MEDIUM/REJECTED verdict against the
    // company's configured topics, after translation and before generation.
    .register(RSS_CLASSIFICATION_JOB_TYPE, rssClassificationHandler)
    .register(POST_GENERATION_JOB_TYPE, postGenerationHandler)
    .register(ANALYTICS_SYNC_JOB_TYPE, analyticsSyncHandler)
    .register(PUBLISH_SWEEP_JOB_TYPE, publishSweepHandler)
    // Turns a scraped product page into the facts its extraction instruction
    // asked for, before any post is written from it.
    .register(PRODUCT_PAGE_EXTRACTION_JOB_TYPE, productPageExtractionHandler)
    // Competitive Analysis (Part 3B) — fully isolated from every pipeline
    // above: never shares a job type, a dedupe key, or a queue selection with
    // normal RSS translation/extraction/classification.
    .register(COMPETITOR_INTELLIGENCE_EXTRACTION_JOB_TYPE, competitorIntelligenceExtractionHandler)
    .register(COMPETITOR_RELEVANCE_JOB_TYPE, competitorRelevanceHandler)
    // The two interactive jobs: a person is waiting on each, so they report
    // progress as they go and resume rather than repeat on a retry.
    .register(BULK_GENERATION_JOB_TYPE, bulkGenerationHandlerFor(config))
    .register(TOPIC_GENERATION_JOB_TYPE, topicGenerationHandlerFor(config));
  const orchestrator = new JobOrchestrator({
    store: createPrismaJobStore(prisma),
    registry: handlers,
    config,
    logger,
  });

  await registry.register();
  // Heartbeats are no longer started here: the registry runs them only while
  // BUSY, driven by setStatus. An idle worker writes nothing.

  // Recover anything a previous crashed worker left leased, then poll.
  await orchestrator.reapOnce();

  // The latch between the wake listener and the poll loop. Always constructed —
  // it costs nothing and keeps the runner's wiring identical whether or not a
  // secret is configured.
  const wakeSignal = new WakeSignal();

  /**
   * Whether the wake listener is actually accepting requests.
   *
   * Distinct from "a WakeSignal exists", which is unconditionally true and so
   * tells an operator nothing. This is what the `dormant` log reports, and the
   * difference between the two is exactly the case worth being able to read off
   * a log: a worker whose wake port never opened.
   */
  let wakeListenerReady = false;

  /**
   * Back-reference filled in once the runner exists, so the wake handler can say
   * whether the signal it just received actually found a sleeping worker. A wake
   * that arrives while the loop is already claiming is not a problem — it is
   * absorbed by the claim that was going to happen anyway — but it looks
   * identical in the log to one that mattered unless the distinction is written
   * down. Needed because the listener is deliberately opened first.
   */
  let runnerRef: PollingRunner<JobRecord> | null = null;

  // ── Wake listener, opened BEFORE the loop starts ──────────────────────────
  //
  // Ordered this way so the socket is accepting before the worker can reach its
  // first dormancy, and so `wakeListenerReady` is settled before anything reads
  // it. Optional by design — without it the worker still runs every job, just on
  // the fallback interval, so a missing secret degrades latency not correctness.
  const wakeServer = config.wakeSecret
    ? createWakeServer({
        guard: new WakeGuard({
          secret: config.wakeSecret,
          rateMaxPerWindow: config.wakeMaxPerMinute,
        }),
        logger,
        host: config.wakeHost,
        port: config.wakePort,
        onWake: () => {
          // One line per authorized wake. Wakes are enqueue-driven and rate
          // limited, so this cannot become the recurring noise dormancy exists
          // to remove — and without it a wake that arrived and a wake that never
          // did are indistinguishable from the worker's side.
          logger.info("wake received", { dormant: runnerRef?.isDormant() ?? false });
          wakeSignal.notify();
        },
      })
    : null;

  if (wakeServer) {
    try {
      await wakeServer.listen();
      wakeListenerReady = true;
    } catch (err) {
      // A port already in use must not take the worker down with it. The queue
      // still drains on the fallback interval.
      logger.error("wake listener failed to start", { error: String(err) });
    }
  } else {
    logger.warn("wake listener disabled", { reason: "WORKER_WAKE_SECRET not set" });
  }

  const runner = new PollingRunner<JobRecord>({
    config,
    logger,
    registry,
    wakeSignal,
    wakeable: () => wakeListenerReady,
    claim: () => orchestrator.claim(),
    processJob: (job) => orchestrator.process(job),
    // The last thing before the loop stops touching the database. Closing the
    // connection is required, not tidy: an open pooled connection can keep a
    // serverless compute from suspending even with no queries flowing, so
    // skipping this would leave the bill unchanged.
    onDormant: () => prisma.$disconnect(),
    onActiveBurst: async (reason) => {
      // Explicit rather than relying on Prisma's lazy reconnect, so a broken
      // connection surfaces here — logged, at the start of the burst — instead
      // of as a failed claim.
      await prisma.$connect();
      // Stale-lease recovery at the head of each burst. With one worker this is
      // complete: the only expired lease it can find is one this process
      // abandoned by crashing, and a crashed process is not the one polling.
      // Multi-worker deployments set WORKER_REAP_INTERVAL_MS instead, where a
      // lease abandoned by a DIFFERENT process needs recovering without waiting
      // for this one to wake.
      await orchestrator.reapOnce();
      logger.info("active", { reason });
    },
  });
  runnerRef = runner;
  runner.start();

  logger.info("ready", {
    status: registry.currentStatus(),
    handlers: handlers.types(),
    wakeable: wakeListenerReady,
  });

  // Periodic stale-lease recovery, off by default. A timer here would be a
  // recurring query on an otherwise silent database — precisely what dormancy
  // exists to remove — so it is opt-in for the multi-worker case that needs it.
  const reaper =
    config.reapIntervalMs > 0
      ? setInterval(() => void orchestrator.reapOnce(), config.reapIntervalMs)
      : null;

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutdown", { signal });
    try {
      if (reaper) clearInterval(reaper);
      // Closed first, so nothing can wake the loop while it is unwinding.
      await wakeServer?.close();
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
