/**
 * The polling loop, and the decision to stop polling.
 *
 * A single loop asks `claim` for work, drives the worker's busy/idle status
 * around each unit, and sleeps between empty polls. That much is unchanged.
 *
 * ── ACTIVE and DORMANT ──────────────────────────────────────────────────────
 *
 * What is new is that the loop can stop entirely. The queue lives in a
 * serverless Postgres whose compute suspends after a few minutes of no activity,
 * and a claim poll is activity: polling every two seconds keeps the database
 * running twenty-four hours a day to discover, almost every time, that there is
 * nothing to do. That single query is the dominant cost of an idle system.
 *
 * Slowing the poll down does not fix it, and this is the part worth being
 * precise about: suspension is triggered by a GAP, not by a rate. A poll every
 * minute resets the suspend timer exactly as reliably as one every second — it
 * merely sends fewer queries while doing so. Nothing short of stopping stops the
 * clock.
 *
 * So the loop has two states:
 *
 *   ACTIVE   — claim, run, repeat, sleeping `pollIntervalMs` between empties.
 *              Interactive work starts within a poll interval, as before.
 *   DORMANT  — after `dormantAfterMs` of empty claims: the connection is
 *              released and NOTHING is sent to the database. The loop waits for
 *              an in-process wake or for `fallbackPollMs`, whichever is first,
 *              then reconnects and goes ACTIVE again.
 *
 * The wake is an optimisation and only an optimisation. Postgres remains the
 * only place a job exists; a signal that is dropped, blocked or never sent costs
 * one fallback interval of latency and nothing else. Everything below is written
 * so that no failure of the wake path can lose work — which is why the fallback
 * timer is unconditional rather than a retry, and why waking does not trust the
 * signal about what it will find.
 */

import type { WorkerConfig } from "./config";
import type { Logger } from "./logger";
import type { WorkerLifecycle } from "./store";
import { decideIdleAction } from "./dormancy";
import type { WakeSignal } from "./wake-signal";

/** Minimal shape the runner needs from a claimed job (for logging). The engine
 * carries a richer record; the runner stays generic over it. */
export interface ClaimedJob {
  id: string;
  type: string;
}

/** The runner only needs to drive status — not the whole registry. */
interface StatusSink {
  setStatus(status: WorkerLifecycle): Promise<void>;
}

/** Why a dormant wait ended. */
export type WakeReason = "signal" | "fallback" | "stopping";

interface RunnerDeps<TJob extends ClaimedJob> {
  config: WorkerConfig;
  logger: Logger;
  registry: StatusSink;
  /** Returns the next job to run, or null when the queue has nothing due. */
  claim: () => Promise<TJob | null>;
  /** Executes a claimed job. */
  processJob: (job: TJob) => Promise<void>;
  /** The wake latch. Absent means dormancy is timer-only. */
  wakeSignal?: WakeSignal;
  /**
   * Called immediately before the loop goes dormant, after the last query.
   * Where the database connection is released.
   *
   * Closing it is not housekeeping — an open pooled connection can be enough on
   * its own to hold the compute awake, so a dormancy that skipped this would
   * send no queries and still cost the same.
   */
  onDormant?: () => Promise<void>;
  /**
   * Called after waking, before the first claim. Where the connection is
   * re-established and stale leases are recovered.
   */
  onActiveBurst?: (reason: WakeReason) => Promise<void>;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

export class PollingRunner<TJob extends ClaimedJob = ClaimedJob> {
  private running = false;
  private stopping = false;
  private dormant = false;
  private loopPromise: Promise<void> | null = null;
  /** Resolver that ends an in-flight wait early (set only while waiting). */
  private wake: (() => void) | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: RunnerDeps<TJob>) {
    this.now = deps.now ?? Date.now;
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Whether the loop is currently asleep with its connection released. */
  isDormant(): boolean {
    return this.dormant;
  }

  /** Begin polling. Idempotent — a second call while running is a no-op. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    this.loopPromise = this.loop();
  }

  /**
   * Stop polling and wait for the loop to unwind. Interrupts a poll sleep or a
   * dormant wait so shutdown does not block for a full interval — which matters
   * far more now that one of those intervals is half an hour.
   */
  async stop(): Promise<void> {
    if (!this.loopPromise) return;
    this.stopping = true;
    this.wake?.();
    await this.loopPromise;
    this.loopPromise = null;
  }

  private async loop(): Promise<void> {
    await this.deps.registry.setStatus("idle");

    /** When the current run of empty claims began; null while work is flowing. */
    let emptySince: number | null = null;

    while (!this.stopping) {
      // Any wake that arrived while the loop was already awake has been honoured
      // by the claim that is about to happen. Clearing it here is what stops a
      // signal received mid-burst from cancelling the NEXT dormant wait.
      this.deps.wakeSignal?.consumePending();

      let job: TJob | null = null;
      try {
        job = await this.deps.claim();
      } catch (err) {
        this.deps.logger.error("claim failed", { error: String(err) });
      }

      if (this.stopping) break;

      if (job) {
        // Any job at all restarts the quiet window: the queue is draining, and
        // dormancy is only ever entered from a genuinely empty one.
        emptySince = null;
        await this.deps.registry.setStatus("busy");
        try {
          await this.deps.processJob(job);
        } catch (err) {
          this.deps.logger.error("job failed", { id: job.id, error: String(err) });
        }
        if (!this.stopping) {
          await this.deps.registry.setStatus("idle");
        }
        continue;
      }

      const now = this.now();
      if (emptySince === null) emptySince = now;

      const decision = decideIdleAction({
        emptySinceMs: emptySince,
        nowMs: now,
        dormantAfterMs: this.deps.config.dormantAfterMs,
        pollIntervalMs: this.deps.config.pollIntervalMs,
      });

      if (decision.action === "poll") {
        await this.waitFor(decision.sleepMs);
        continue;
      }

      await this.becomeDormant(decision.quietMs);
      // Fresh quiet window: a woken worker gets the full grace period again
      // before it may go back to sleep, so a burst is never cut short by the
      // clock that sent it dormant in the first place.
      emptySince = null;
    }

    this.running = false;
  }

  /**
   * Release the connection, wait for a wake or the fallback, then come back.
   *
   * The subscription is taken BEFORE the timer is armed and before anything is
   * awaited, so a signal that lands during the disconnect is latched by the
   * WakeSignal and delivered the instant this subscribes — the alternative is a
   * job that arrives in that window sleeping until the fallback.
   */
  private async becomeDormant(quietMs: number): Promise<void> {
    this.dormant = true;
    this.deps.logger.info("dormant", {
      quietMs,
      fallbackPollMs: this.deps.config.fallbackPollMs,
      wakeable: this.deps.wakeSignal !== undefined,
    });

    try {
      await this.deps.onDormant?.();
    } catch (err) {
      // A connection that would not close is not a reason to keep polling; the
      // worst case is that the database stays awake this cycle, which is the
      // behaviour we had before dormancy existed.
      this.deps.logger.warn("dormant hook failed", { error: String(err) });
    }

    const reason = await this.dormantWait();
    this.dormant = false;

    if (this.stopping) return;

    this.deps.logger.info("waking", { reason });
    try {
      await this.deps.onActiveBurst?.(reason);
    } catch (err) {
      // Reconnecting or reaping failed. The loop still proceeds to claim, which
      // will either succeed (Prisma reconnects lazily) or log its own failure
      // and retry on the next tick.
      this.deps.logger.warn("wake hook failed", { error: String(err) });
    }
  }

  /** Resolves on a wake signal, on the fallback timer, or on stop(). */
  private dormantWait(): Promise<WakeReason> {
    return new Promise<WakeReason>((resolve) => {
      let settled = false;
      let unsubscribe: (() => void) | null = null;

      const finish = (reason: WakeReason) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe?.();
        this.wake = null;
        resolve(reason);
      };

      const timer = setTimeout(() => finish("fallback"), this.deps.config.fallbackPollMs);
      // Deliberately NOT unref'd: while dormant this timer may be the only thing
      // keeping the event loop alive, and a worker that exited because it had
      // nothing scheduled would be a worker that never came back.

      this.wake = () => finish("stopping");
      unsubscribe = this.deps.wakeSignal?.subscribe(() => finish("signal")) ?? null;
    });
  }

  /** Sleep that resolves early when stop() calls wake(). */
  private waitFor(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
    });
  }
}
