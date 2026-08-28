/**
 * Enqueue a background job onto the Postgres queue (the `jobs` table).
 *
 * This is the only enqueue path the Next app uses; route handlers call it instead
 * of touching Prisma directly. Deduplication is enforced by the DB, not by a
 * read-then-write race: a `dedupeKey` collides with the partial unique index
 * `jobs_dedupe_active_key` (WHERE status IN ('queued','active')) and Prisma raises
 * P2002, which we translate into a `deduplicated` result rather than an error.
 *
 * ── The wake signal ─────────────────────────────────────────────────────────
 *
 * The worker closes its database connection once the queue has been quiet for a
 * minute, so an idle system stops paying for compute. Enqueueing therefore ends
 * by poking it — strictly AFTER the row is committed, strictly best-effort. The
 * row is what makes the job exist; the signal only decides whether it starts in
 * seconds or on the worker's next fallback tick. See `lib/queue/wake-notifier.ts`
 * for why that indirection exists and why the worker never signals itself.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { scheduleWakeNotification, type WakeDeliveryResult } from "@/lib/queue/wake-notifier";

/**
 * Report a wake that did not land. Failures only — a successful signal happens
 * on every enqueue and logging those would be pure noise.
 *
 * It is worth a line because this is the one part of the wake path with no
 * feedback of its own: a funnel that is down, a URL pointing at nothing, or a
 * secret that stopped matching all look exactly like a healthy system from here,
 * and the symptom lands half an hour later on a machine somebody else is
 * watching. The job is unaffected either way — it is committed, and the worker's
 * fallback tick will find it — so this is a diagnostic, not an error path.
 */
function reportWakeFailure(result: WakeDeliveryResult): void {
  if (result.ok) return;
  console.warn("[queue] wake signal not delivered", {
    status: result.status,
    error: result.error,
    // `error` alone is "fetch failed" for every connection-level fault, and "the
    // operation was aborted due to timeout" for every stall, which distinguishes
    // nothing. The three fields below are where the answer actually is:
    // `errorName` separates an abort from a connect failure, `elapsedMs`
    // separates "gave up at the deadline" from "failed instantly", and `dns`
    // says which address family the connection would have tried first. `cause`
    // is allow-listed by `describeTransportError` so nothing from the signed
    // request can travel with it.
    ...(result.errorName ? { errorName: result.errorName } : {}),
    ...(result.elapsedMs !== undefined ? { elapsedMs: result.elapsedMs } : {}),
    ...(result.cause ? { cause: result.cause } : {}),
    ...(result.dns ? { dns: result.dns } : {}),
    note: "job is queued; the worker will pick it up on its fallback interval",
  });
}

export interface EnqueueJobInput {
  type: string;
  /** Type-specific input; validated per-type by the handler. Defaults to `{}`. */
  payload?: Prisma.InputJsonValue;
  /** Stable key that blocks a second non-terminal job of the same kind. */
  dedupeKey?: string;
  priority?: number;
  maxAttempts?: number;
  cronRunId?: string;
  /**
   * The company this job acts for, when it acts for exactly one.
   *
   * Null for the recurring sweeps, which fan out across every company. Set for a
   * job somebody requested for their own company — it is what lets a status
   * endpoint scope a read by company without parsing the payload, so a job id
   * from one company can never be used to read another's.
   */
  companyId?: string | null;
  /** The user who asked, for the same job. Null for anything cron-driven. */
  createdBy?: string | null;
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
  companyId: string | null;
  createdBy: string | null;
}

export interface EnqueueJobDeps {
  /** Insert seam — defaults to Prisma; tests inject a fake to simulate P2002. */
  insertJob?: (data: JobInsert) => Promise<{ id: string }>;
  /**
   * Wake seam — defaults to the notifier, which is itself a no-op unless the
   * process is a Next server with a wake URL and secret configured. Must be
   * synchronous and must not throw; the enqueue does not wait for it and does
   * not care whether it worked.
   */
  notifyWake?: () => void;
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
      companyId: data.companyId,
      createdBy: data.createdBy,
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
  const notifyWake =
    deps.notifyWake ?? (() => scheduleWakeNotification({ onResult: reportWakeFailure }));

  /**
   * Wrapped rather than called bare so that a notifier which somehow throws —
   * an injected fake, a future implementation — cannot turn a committed job into
   * a failed request. The row is already in Postgres by the time this runs; the
   * worker will find it either way.
   */
  const signal = () => {
    try {
      notifyWake();
    } catch {
      // Deliberately silent. Nothing here is recoverable and nothing here matters
      // to the caller.
    }
  };

  try {
    const job = await insertJob({
      type: input.type,
      payload: input.payload ?? {},
      dedupeKey: input.dedupeKey ?? null,
      priority: input.priority ?? 0,
      maxAttempts: input.maxAttempts ?? 5,
      cronRunId: input.cronRunId ?? null,
      companyId: input.companyId ?? null,
      createdBy: input.createdBy ?? null,
    });
    signal();
    return { enqueued: true, deduplicated: false, jobId: job.id };
  } catch (err) {
    if (isUniqueViolation(err)) {
      // A non-terminal job with this dedupeKey already exists — treat as success.
      //
      // Signalled anyway, and that is not belt-and-braces. The job this
      // collided with is `queued` or `active`; if it is `active` the worker is
      // busy and the signal costs a no-op, but if it is `queued` then a worker
      // is dormant and MISSED the signal sent when that job was created. This is
      // the path that recovers it — without it, a dropped signal would strand a
      // deduped job until the fallback tick, and every retrying caller would be
      // told "already queued" while nothing moved.
      signal();
      return { enqueued: false, deduplicated: true, jobId: null };
    }
    throw err;
  }
}
