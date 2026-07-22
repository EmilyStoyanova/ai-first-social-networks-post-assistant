/**
 * Storage seam for the Worker registry.
 *
 * The registry depends on this narrow interface rather than the Prisma client
 * directly, so its lifecycle logic is unit-testable without a database. The
 * production adapter (Prisma-backed) is built in index.ts; tests inject a fake.
 *
 * `WorkerLifecycle` mirrors the WorkerStatus enum in prisma/schema.prisma exactly.
 */

export type WorkerLifecycle = "starting" | "idle" | "busy" | "draining" | "stopped";

export interface WorkerUpsertInput {
  name: string;
  status: WorkerLifecycle;
  hostname: string | null;
  pid: number | null;
  concurrency: number;
  metadata: Record<string, unknown> | null;
  startedAt: Date;
  lastHeartbeatAt: Date;
}

export interface WorkerPatch {
  status?: WorkerLifecycle;
  lastHeartbeatAt?: Date;
  stoppedAt?: Date;
}

export interface WorkerStore {
  /** Insert the worker row, or overwrite an existing row with the same name. */
  upsert(input: WorkerUpsertInput): Promise<void>;
  /** Patch the worker row identified by its unique name. */
  update(name: string, patch: WorkerPatch): Promise<void>;
}
