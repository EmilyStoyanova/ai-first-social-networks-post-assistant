/**
 * Maps a job `type` string to its handler. This is the ONLY place a job type is
 * bound to behaviour.
 *
 * ARCHITECTURE: the worker is an orchestrator, not a home for business logic.
 * Handlers are thin adapters that resolve inputs from the payload and delegate
 * to the EXISTING services (text/image/embedding generation, Buffer). They must
 * not reimplement any generation. See the "worker is orchestrator-only" rule.
 */

import type { Logger } from "./logger";
import type { JobRecord } from "./job-store";

/** A handler's return value, persisted as the job's `result` (void → null). */
export type JobResult = Record<string, unknown> | void;

export interface JobContext {
  job: JobRecord;
  logger: Logger;
}

export type JobHandler = (ctx: JobContext) => Promise<JobResult>;

export class HandlerRegistry {
  private readonly handlers = new Map<string, JobHandler>();

  /** Bind a handler to a job type. Throws on a duplicate registration. */
  register(type: string, handler: JobHandler): this {
    if (this.handlers.has(type)) {
      throw new Error(`Handler already registered for job type "${type}"`);
    }
    this.handlers.set(type, handler);
    return this;
  }

  get(type: string): JobHandler | undefined {
    return this.handlers.get(type);
  }

  /** Registered job types, for diagnostics/logging. */
  types(): string[] {
    return [...this.handlers.keys()];
  }
}
