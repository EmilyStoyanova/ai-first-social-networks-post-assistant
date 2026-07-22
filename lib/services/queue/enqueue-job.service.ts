/**
 * Enqueue a background job onto the Postgres queue (the `jobs` table).
 *
 * This is the only enqueue path the Next app uses; route handlers call it instead
 * of touching Prisma directly. Deduplication is enforced by the DB, not by a
 * read-then-write race: a `dedupeKey` collides with the partial unique index
 * `jobs_dedupe_active_key` (WHERE status IN ('queued','active')) and Prisma raises
 * P2002, which we translate into a `deduplicated` result rather than an error.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";

export interface EnqueueJobInput {
  type: string;
  /** Type-specific input; validated per-type by the handler. Defaults to `{}`. */
  payload?: Prisma.InputJsonValue;
  /** Stable key that blocks a second non-terminal job of the same kind. */
  dedupeKey?: string;
  priority?: number;
  maxAttempts?: number;
  cronRunId?: string;
}

export interface EnqueueJobResult {
  /** True when a new job row was inserted. */
  enqueued: boolean;
  /** True when a non-terminal job with the same dedupeKey already existed. */
  deduplicated: boolean;
  /** The new job's id, or null when the enqueue was deduplicated. */
  jobId: string | null;
}

/** Normalised row handed to the insert seam. */
export interface JobInsert {
  type: string;
  payload: Prisma.InputJsonValue;
  dedupeKey: string | null;
  priority: number;
  maxAttempts: number;
  cronRunId: string | null;
}

export interface EnqueueJobDeps {
  /** Insert seam — defaults to Prisma; tests inject a fake to simulate P2002. */
  insertJob?: (data: JobInsert) => Promise<{ id: string }>;
}

async function defaultInsertJob(data: JobInsert): Promise<{ id: string }> {
  return prisma.job.create({
    data: {
      type: data.type,
      payload: data.payload,
      dedupeKey: data.dedupeKey,
      priority: data.priority,
      maxAttempts: data.maxAttempts,
      cronRunId: data.cronRunId,
    },
    select: { id: true },
  });
}

/** A Prisma unique-constraint violation — here, the active-dedupe guard firing. */
function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

export async function enqueueJob(
  input: EnqueueJobInput,
  deps: EnqueueJobDeps = {}
): Promise<EnqueueJobResult> {
  const insertJob = deps.insertJob ?? defaultInsertJob;
  try {
    const job = await insertJob({
      type: input.type,
      payload: input.payload ?? {},
      dedupeKey: input.dedupeKey ?? null,
      priority: input.priority ?? 0,
      maxAttempts: input.maxAttempts ?? 5,
      cronRunId: input.cronRunId ?? null,
    });
    return { enqueued: true, deduplicated: false, jobId: job.id };
  } catch (err) {
    if (isUniqueViolation(err)) {
      // A non-terminal job with this dedupeKey already exists — treat as success.
      return { enqueued: false, deduplicated: true, jobId: null };
    }
    throw err;
  }
}
