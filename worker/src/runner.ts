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
 *
 * ── Why the wait is armed before the connection is released ──────────────────
 *
 * "Unconditional" has to mean unconditional on the disconnect, too, and that is
 * a correction rather than a nicety. Releasing the connection means
 * `prisma.$disconnect()`, which means the Neon pool's `end()`, which resolves
 * only once every checked-out client has been handed back — a client leaked by a
 * socket that died mid-query never is, and the promise then never settles.
 *
 * When that await sat AHEAD of the wait, a hung disconnect meant no timer was
 * ever armed and no listener was ever subscribed: the worker logged `dormant`
 * and became permanently unreachable by both paths at once, recoverable only by
 * a restart. So the wait is constructed first — its executor runs synchronously,
 * arming the fallback and taking the subscription before a single await — and
 * the disconnect happens underneath it, bounded, where the worst it can cost is
 * one cycle of connection that should have been closed.
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
   * Whether the EXTERNAL wake path is actually live — the listener bound, not
   * merely the in-process latch constructed.
   *
   * Reported in the `dormant` log. The distinction is the whole diagnostic
   * value: the latch is always present, so a flag derived from it says "true"
   * on a worker whose wake port never opened, which is exactly the worker whose
   * log you would be reading to find that out. Absent here means unknown, and
   * falls back to whether a latch exists at all.
   */
  wakeable?: () => boolean;
  /**
   * Called as the loop goes dormant. Where the database connection is released.
   *
   * Closing it is not housekeeping — an open pooled connection can be enough on
   * its own to hold the compute awake, so a dormancy that skipped this would
   * send no queries and still cost the same.
   *
   * It runs UNDER the dormant wait rather than ahead of it, and is abandoned
   * after `dormantCleanupTimeoutMs`. It may hang forever without consequence
   * beyond a connection staying open for one cycle.
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
  /**
   * Stops the loop waiting on the dormant hook (set only while it is running).
   *
   * Shutdown must not sit behind a disconnect that has already proved it is not
   * coming back — the bound exists so the loop stays live, not so `stop()` has
   * to serve it out.
   */
  private abortCleanup: (() => void) | null = null;
  /** Whether the current dormant wait has already resolved. See becomeDormant. */
  private dormantWaitSettled = false;
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
    // Both, and in this order: the loop may be parked on either the dormant wait
    // or the disconnect underneath it, and shutdown should not wait out whichever
    // one it happens to be.
    this.abortCleanup?.();
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
   * Wait for a wake or the fallback, releasing the connection underneath it.
   *
   * The ORDER of the first two statements is the load-bearing part. `dormantWait`
   * arms the fallback timer and takes the wake subscription synchronously, in
   * its executor, before this function has awaited anything at all. Only then is
   * the connection released. A disconnect that hangs therefore delays nothing
   * that matters: the timer is already ticking and the latch already has a
   * listener, so both wake paths are live for the whole of it.
   */
  private async becomeDormant(quietMs: number): Promise<void> {
    this.dormant = true;
    this.deps.logger.info("dormant", {
      quietMs,
      fallbackPollMs: this.deps.config.fallbackPollMs,
      // The real listener state where it is known — see `wakeable` on the deps.
      wakeable: this.deps.wakeable?.() ?? this.deps.wakeSignal !== undefined,
    });

    // Armed first. Nothing below can prevent a wake.
    const wait = this.dormantWait();

    // A wake that was already latched settles that wait synchronously, in which
    // case there is nothing to sleep through and no reason to close a connection
    // we are about to reopen.
    if (!this.dormantWaitSettled) await this.releaseConnection();

    const reason = await wait;
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

  /**
   * Run the dormant hook, giving up on it after `dormantCleanupTimeoutMs`.
   *
   * Giving up means only that the LOOP stops waiting — the hook keeps running,
   * and its eventual settlement is still observed, both so a late success can be
   * logged and so a late rejection can never surface as an unhandled rejection
   * and take the process down. That is why the handlers are attached to the
   * promise immediately rather than raced against a timer: a `Promise.race`
   * leaves the loser unhandled, which for a `$disconnect()` that fails after we
   * stopped caring is precisely the crash this whole path exists to avoid.
   *
   * Never rejects.
   */
  private releaseConnection(): Promise<void> {
    const hook = this.deps.onDormant;
    if (!hook) return Promise.resolve();

    const timeoutMs = this.deps.config.dormantCleanupTimeoutMs;
    const startedAt = this.now();

    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.abortCleanup = null;
        resolve();
      };

      const timer = setTimeout(() => {
        // Loud, and specific about the consequence: this is the signature of a
        // pool whose `end()` is waiting on a client that will never come back,
        // and the operator's question is whether the worker is still alive. It
        // is — that is the point of the line.
        this.deps.logger.warn("dormant cleanup timed out", {
          timeoutMs,
          note: "connection may still be open; wake and fallback are unaffected",
        });
        finish();
      }, timeoutMs);
      // The fallback timer is already armed and is not unref'd, so it — not this
      // one — is what keeps the process alive while dormant.
      timer.unref?.();

      // Assigned after the timer exists, so the handle can never be invoked
      // before the closure it clears is initialised. Lets stop() reclaim the loop
      // immediately rather than serving out a bound that only exists to keep a
      // RUNNING worker live.
      this.abortCleanup = finish;

      let running: Promise<unknown>;
      try {
        running = Promise.resolve(hook());
      } catch (err) {
        // A hook that threw synchronously rather than returning a rejection.
        this.deps.logger.warn("dormant hook failed", { error: String(err) });
        finish();
        return;
      }

      running.then(
        () => {
          if (settled) {
            this.deps.logger.info("dormant cleanup finished late", {
              afterMs: this.now() - startedAt,
            });
          }
          finish();
        },
        (err) => {
          // A connection that would not close is not a reason to keep polling;
          // the worst case is that the database stays awake this cycle, which is
          // the behaviour we had before dormancy existed.
          this.deps.logger.warn(settled ? "dormant cleanup failed late" : "dormant hook failed", {
            error: String(err),
          });
          finish();
        }
      );
    });
  }

  /**
   * Resolves on a wake signal, on the fallback timer, or on stop().
   *
   * Fully synchronous: by the time it returns, the timer is armed and the
   * subscription is taken. Callers rely on that — see `becomeDormant`.
   */
  private dormantWait(): Promise<WakeReason> {
    this.dormantWaitSettled = false;
    return new Promise<WakeReason>((resolve) => {
      let settled = false;
      let unsubscribe: (() => void) | null = null;
      /**
       * Set when `finish` runs before `subscribe` has returned — which happens
       * whenever a wake was already latched, since `subscribe` then fires its
       * listener synchronously. `unsubscribe` is still null at that moment, so
       * without this the listener would never be removed and every latched wake
       * would leave a dead subscriber behind for the life of the process.
       */
      let unsubscribePending = false;

      const finish = (reason: WakeReason) => {
        if (settled) return;
        settled = true;
        this.dormantWaitSettled = true;
        clearTimeout(timer);
        if (unsubscribe) unsubscribe();
        else unsubscribePending = true;
        this.wake = null;
        // The reason to wait for the disconnect was to sleep with it closed, and
        // that reason has just expired — we are reconnecting next. Without this,
        // a disconnect that hangs would turn every wake into a full
        // `dormantCleanupTimeoutMs` of latency, which for the pathological pool
        // this bound exists for is every wake there is.
        this.abortCleanup?.();
        resolve(reason);
      };

      const timer = setTimeout(() => finish("fallback"), this.deps.config.fallbackPollMs);
      // Deliberately NOT unref'd: while dormant this timer may be the only thing
      // keeping the event loop alive, and a worker that exited because it had
      // nothing scheduled would be a worker that never came back.

      this.wake = () => finish("stopping");
      unsubscribe = this.deps.wakeSignal?.subscribe(() => finish("signal")) ?? null;
      if (unsubscribePending) {
        unsubscribe?.();
        unsubscribe = null;
      }
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
