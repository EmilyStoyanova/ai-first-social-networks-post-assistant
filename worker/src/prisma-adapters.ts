/**
 * Prisma-backed adapters for the worker's storage seams. The only modules that
 * touch the Prisma client — everything else depends on the WorkerStore /
 * JobStore interfaces so the engine stays unit-testable without a database.
 *
 * The atomic claim uses raw SQL (`FOR UPDATE SKIP LOCKED`) because Prisma cannot
 * express it; the rest use the typed client.
 */

import { Prisma, type PrismaClient } from "@prisma/client";

import type { WorkerStore } from "./store";
import type { ClaimInput, EnqueueInput, JobRecord, JobStore, ReapResult } from "./job-store";

/** Adapts the shared Prisma client to the Worker registry's storage seam. */
export function createPrismaWorkerStore(prisma: PrismaClient): WorkerStore {
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

/** Row shape returned by the atomic-claim raw query. */
interface ClaimedRow {
  id: string;
  type: string;
  payload: unknown;
  attempts: number;
  max_attempts: number;
}

/** Adapts the shared Prisma client to the job queue's storage seam. */
export function createPrismaJobStore(prisma: PrismaClient): JobStore {
  return {
    enqueue: async (input: EnqueueInput) => {
      const job = await prisma.job.create({
        data: {
          type: input.type,
          payload: input.payload as Prisma.InputJsonValue,
          dedupeKey: input.dedupeKey ?? null,
          priority: input.priority ?? 0,
          runAt: input.runAt ?? new Date(),
          maxAttempts: input.maxAttempts ?? 5,
          companyId: input.companyId ?? null,
          createdBy: input.createdBy ?? null,
          cronRunId: input.cronRunId ?? null,
        },
        select: { id: true },
      });
      return job.id;
    },

    claim: async (input: ClaimInput): Promise<JobRecord | null> => {
      // One statement: lock the highest-priority due row (skipping rows other
      // workers hold), flip it to active, extend the lease, bump attempts.
      const rows = await prisma.$queryRaw<ClaimedRow[]>(Prisma.sql`
        UPDATE "jobs"
        SET status = 'active'::"JobStatus",
            locked_by = ${input.workerId},
            lease_expires_at = ${input.leaseExpiresAt},
            attempts = attempts + 1,
            started_at = COALESCE(started_at, ${input.now}),
            updated_at = ${input.now}
        WHERE id = (
          SELECT id FROM "jobs"
          WHERE status = 'queued'::"JobStatus" AND run_at <= ${input.now}
          ORDER BY priority DESC, run_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        RETURNING id, type, payload, attempts, max_attempts
      `);

      const row = rows[0];
      if (!row) return null;
      return {
        id: row.id,
        type: row.type,
        payload: row.payload,
        attempts: Number(row.attempts),
        maxAttempts: Number(row.max_attempts),
      };
    },

    complete: async (id, result, now) => {
      await prisma.job.update({
        where: { id },
        data: {
          status: "completed",
          result: result == null ? Prisma.DbNull : (result as Prisma.InputJsonValue),
          finishedAt: now,
          lockedBy: null,
          leaseExpiresAt: null,
        },
      });
    },

    fail: async ({ id, error, now, retryAt }) => {
      if (retryAt) {
        await prisma.job.update({
          where: { id },
          data: {
            status: "queued",
            runAt: retryAt,
            lastError: error,
            lockedBy: null,
            leaseExpiresAt: null,
          },
        });
        return;
      }
      await prisma.job.update({
        where: { id },
        data: {
          status: "failed",
          lastError: error,
          finishedAt: now,
          lockedBy: null,
          leaseExpiresAt: null,
        },
      });
    },

    reapExpired: async (now): Promise<ReapResult> => {
      const requeued = await prisma.$executeRaw(Prisma.sql`
        UPDATE "jobs"
        SET status = 'queued'::"JobStatus",
            locked_by = NULL,
            lease_expires_at = NULL,
            last_error = 'lease expired — requeued by reaper',
            run_at = ${now},
            updated_at = ${now}
        WHERE status = 'active'::"JobStatus"
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at < ${now}
          AND attempts < max_attempts
      `);
      const failed = await prisma.$executeRaw(Prisma.sql`
        UPDATE "jobs"
        SET status = 'failed'::"JobStatus",
            locked_by = NULL,
            lease_expires_at = NULL,
            last_error = 'lease expired — attempts exhausted',
            finished_at = ${now},
            updated_at = ${now}
        WHERE status = 'active'::"JobStatus"
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at < ${now}
          AND attempts >= max_attempts
      `);
      return { requeued, failed };
    },
  };
}
