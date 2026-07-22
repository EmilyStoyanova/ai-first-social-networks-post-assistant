/**
 * Worker bootstrap (Phase 1 — infrastructure only).
 *
 * Boots a worker process that:
 *   1. loads + validates config from the environment,
 *   2. registers itself in the `workers` table (status: starting),
 *   3. starts heartbeats,
 *   4. starts the polling loop (status: idle),
 *   5. shuts down cleanly on SIGTERM/SIGINT (draining → stopped).
 *
 * It does NOT claim or execute jobs, touch the cron routes, or enqueue anything.
 * The `claim`/`processJob` hooks below are deliberate no-ops that Phase 2 fills in.
 *
 * Run from the repo root so the shared client and env resolve:
 *   npx tsx worker/src/index.ts
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import type { PrismaClient, Prisma } from "@prisma/client";

import { loadWorkerConfig } from "./config";
import { createLogger } from "./logger";
import { WorkerRegistry } from "./registry";
import { PollingRunner } from "./runner";
import type { WorkerStore } from "./store";

// Load the repo-root .env regardless of the current working directory, so the
// worker sees the same DATABASE_URL etc. as the Next app.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
loadEnv({ path: path.join(repoRoot, ".env") });

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Adapts the shared Prisma client to the registry's storage seam. */
function createPrismaWorkerStore(prisma: PrismaClient): WorkerStore {
  return {
    upsert: async (input) => {
      const metadata =
        input.metadata === null ? undefined : (input.metadata as Prisma.InputJsonValue);
      await prisma.worker.upsert({
        where: { name: input.name },
        create: {
          name: input.name,
          status: input.status,
          hostname: input.hostname,
          pid: input.pid,
          concurrency: input.concurrency,
          metadata,
          startedAt: input.startedAt,
          lastHeartbeatAt: input.lastHeartbeatAt,
        },
        update: {
          status: input.status,
          hostname: input.hostname,
          pid: input.pid,
          concurrency: input.concurrency,
          metadata,
          startedAt: input.startedAt,
          lastHeartbeatAt: input.lastHeartbeatAt,
          stoppedAt: null,
        },
      });
    },
    update: async (name, patch) => {
      await prisma.worker.update({
        where: { name },
        data: {
          ...(patch.status !== undefined ? { status: patch.status } : {}),
          ...(patch.lastHeartbeatAt !== undefined
            ? { lastHeartbeatAt: patch.lastHeartbeatAt }
            : {}),
          ...(patch.stoppedAt !== undefined ? { stoppedAt: patch.stoppedAt } : {}),
        },
      });
    },
  };
}

async function main(): Promise<void> {
  const config = loadWorkerConfig();
  const logger = createLogger(`worker:${config.workerId}`);
  logger.info("boot", {
    hostname: config.hostname,
    pid: config.pid,
    concurrency: config.concurrency,
    pollIntervalMs: config.pollIntervalMs,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
  });

  // Import the shared client AFTER config validation so a bad env fails with a
  // clear message before any connection is constructed.
  const { prisma } = await import("@/lib/db/client");
  const store = createPrismaWorkerStore(prisma);
  const registry = new WorkerRegistry({ store, config, logger });

  await registry.register();
  registry.startHeartbeat();

  const runner = new PollingRunner({
    config,
    logger,
    registry,
    // Phase 1: claiming and execution are intentionally disabled.
    claim: async () => null,
    processJob: async () => {},
  });
  runner.start();
  logger.info("ready", { status: registry.currentStatus() });

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutdown", { signal });
    try {
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
