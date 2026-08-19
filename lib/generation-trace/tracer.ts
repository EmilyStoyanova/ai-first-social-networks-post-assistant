import type {
  GenerationRunKind,
  GenerationStepStatus,
  GenerationTrigger,
  Prisma,
  SocialChannel,
} from "@prisma/client";
import { sanitizeForTrace } from "./redact";
import { prismaTraceStore, type GenerationTraceStore, type PersistableStep } from "./store";
import type { GenerationStepType } from "./step-types";

/**
 * The recorder every traced pipeline talks to.
 *
 * ── Two rules, and they are the whole contract ──────────────────────────────
 *
 *  1. **It cannot fail the work it observes.** Every public method swallows its
 *     own errors, `flush()` included. A generation that produced a good post
 *     must never be turned into a failed request because a JSON column was too
 *     big or the database blinked. Failures are logged under `[generation-trace]`
 *     with the run id, so "the trace is missing" is diagnosable rather than
 *     silent — which is the other half of the requirement, and the half that is
 *     easy to forget once errors are being swallowed.
 *
 *  2. **It buffers and writes once.** Steps accumulate in memory and are
 *     persisted by a single nested insert at `flush()`. A run is therefore
 *     either wholly there or wholly absent — never a timeline missing its middle
 *     — and the database sees one short write rather than fifteen interleaved
 *     with the LLM calls being traced. The cost is that a process killed
 *     mid-generation leaves no trace at all, which is the right trade: that run
 *     produced no post either.
 *
 * ── What "disabled" means ───────────────────────────────────────────────────
 *
 * `GenerationTracer.disabled()` returns a tracer that accepts every call and
 * writes nothing. Call sites therefore never branch on whether tracing is on —
 * there is no `if (tracer)` anywhere in the generation pipeline, which is what
 * keeps this from changing generation behaviour.
 */

export interface TraceRunInit {
  kind: GenerationRunKind;
  trigger: GenerationTrigger;
  companyId?: string | null;
  postId?: string | null;
  feedItemId?: string | null;
  channel?: string | null;
  language?: string | null;
  userId?: string | null;
  contentGroupId?: string | null;
  generationBatchId?: string | null;
  scheduleId?: string | null;
  jobId?: string | null;
  /** What was ASKED for — the request options, before anything was resolved. */
  options?: unknown;
  /** Injected in tests. Defaults to the Prisma-backed store. */
  store?: GenerationTraceStore;
  /** Injected in tests so durations are deterministic. */
  now?: () => Date;
  /** Injected in tests so run ids are stable. */
  newId?: () => string;
}

export interface TraceStepInput {
  type: GenerationStepType | string;
  /** Defaults to `success` — the overwhelmingly common case. */
  status?: GenerationStepStatus;
  label?: string | null;
  attempt?: number | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
  /** Explicit duration; otherwise derived from startedAt/completedAt. */
  durationMs?: number | null;
  input?: unknown;
  output?: unknown;
  metadata?: unknown;
  error?: unknown;
  /** The run holding this step's full detail — see GenerationStep.linkedRunId. */
  linkedRunId?: string | null;
}

const VALID_CHANNELS: ReadonlySet<string> = new Set([
  "facebook",
  "linkedin",
  "instagram",
  "tiktok",
]);

/** Only a real channel value reaches the enum column; anything else is dropped. */
function toChannel(raw: string | null | undefined): SocialChannel | null {
  if (!raw) return null;
  const lower = raw.toLowerCase();
  return VALID_CHANNELS.has(lower) ? (lower as SocialChannel) : null;
}

function messageOf(error: unknown): string | null {
  if (error === null || error === undefined) return null;
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export class GenerationTracer {
  readonly id: string;
  readonly enabled: boolean;

  private readonly store: GenerationTraceStore | null;
  private readonly now: () => Date;
  private readonly steps: PersistableStep[] = [];
  private readonly startedAt: Date;

  private companyId: string | null;
  private postId: string | null;
  private feedItemId: string | null;
  private readonly kind: GenerationRunKind;
  private trigger: GenerationTrigger;
  private channel: SocialChannel | null;
  private language: string | null;
  private userId: string | null;
  private contentGroupId: string | null;
  private generationBatchId: string | null;
  private scheduleId: string | null;
  private jobId: string | null;
  private llmProvider: string | null = null;
  private llmModel: string | null = null;
  private attempts = 0;
  private errorCode: string | null = null;
  private errorMessage: string | null = null;
  private options: Prisma.InputJsonValue | null = null;
  private truncated = false;
  private flushed = false;

  private constructor(init: TraceRunInit, enabled: boolean) {
    this.enabled = enabled;
    this.store = enabled ? (init.store ?? prismaTraceStore) : null;
    this.now = init.now ?? (() => new Date());
    this.id = (init.newId ?? (() => crypto.randomUUID()))();
    this.startedAt = this.now();

    this.kind = init.kind;
    this.trigger = init.trigger;
    this.companyId = init.companyId ?? null;
    this.postId = init.postId ?? null;
    this.feedItemId = init.feedItemId ?? null;
    this.channel = toChannel(init.channel);
    this.language = init.language ?? null;
    this.userId = init.userId ?? null;
    this.contentGroupId = init.contentGroupId ?? null;
    this.generationBatchId = init.generationBatchId ?? null;
    this.scheduleId = init.scheduleId ?? null;
    this.jobId = init.jobId ?? null;

    if (init.options !== undefined) this.options = this.sanitize(init.options);
  }

  /**
   * Starts recording a run. Never throws.
   *
   * A caller that supplies its own `store` has said where the run goes, so it is
   * always enabled — that is the injection point tests use. Everything else asks
   * `tracingEnabled()`, which needs a database to write to.
   */
  static start(init: TraceRunInit): GenerationTracer {
    try {
      return new GenerationTracer(init, init.store !== undefined || tracingEnabled());
    } catch (err) {
      console.error("[generation-trace] Could not start a run (tracing skipped):", messageOf(err));
      return GenerationTracer.disabled();
    }
  }

  /** A tracer that accepts everything and writes nothing. */
  static disabled(): GenerationTracer {
    return new GenerationTracer({ kind: "post_generation", trigger: "system" }, false);
  }

  // ── Recording ──────────────────────────────────────────────────────────────

  /** Appends one step. Sequence is assigned here, densely, in call order. */
  step(input: TraceStepInput): void {
    if (!this.enabled) return;
    try {
      const startedAt = input.startedAt ?? null;
      const completedAt = input.completedAt ?? null;
      const durationMs =
        input.durationMs ??
        (startedAt && completedAt ? completedAt.getTime() - startedAt.getTime() : null);

      this.steps.push({
        sequence: this.steps.length + 1,
        type: input.type,
        label: input.label ?? null,
        status: input.status ?? "success",
        attempt: input.attempt ?? null,
        startedAt,
        completedAt,
        durationMs,
        input: input.input === undefined ? null : this.sanitize(input.input),
        output: input.output === undefined ? null : this.sanitize(input.output),
        metadata: input.metadata === undefined ? null : this.sanitize(input.metadata),
        errorMessage: messageOf(input.error),
        linkedRunId: input.linkedRunId ?? null,
      });
    } catch (err) {
      console.error(
        `[generation-trace] Run ${this.id}: step "${input.type}" could not be recorded:`,
        messageOf(err)
      );
    }
  }

  /** A step that did not happen, and why. Only recorded for stages a reader
   *  would otherwise expect to see (see the "only show what occurred" rule —
   *  a skipped step is shown, an inapplicable one is never created at all). */
  skipped(type: GenerationStepType | string, reason: string, metadata?: unknown): void {
    this.step({ type, status: "skipped", label: reason, metadata });
  }

  // ── Run-level facts, learned as the run goes ───────────────────────────────

  setCompany(companyId: string | null | undefined): void {
    if (companyId) this.companyId = companyId;
  }

  setPost(postId: string | null | undefined): void {
    if (postId) this.postId = postId;
  }

  setChannel(channel: string | null | undefined): void {
    const resolved = toChannel(channel);
    if (resolved) this.channel = resolved;
  }

  setLanguage(language: string | null | undefined): void {
    if (language) this.language = language;
  }

  setTrigger(trigger: GenerationTrigger): void {
    this.trigger = trigger;
  }

  setContentGroup(contentGroupId: string | null | undefined): void {
    if (contentGroupId) this.contentGroupId = contentGroupId;
  }

  setLlm(provider: string | null | undefined, model: string | null | undefined): void {
    if (provider) this.llmProvider = provider;
    if (model) this.llmModel = model;
  }

  setAttempts(attempts: number): void {
    if (Number.isFinite(attempts) && attempts > this.attempts) this.attempts = attempts;
  }

  /** Records the terminal failure. Does not itself end the run. */
  fail(code: string, message?: string | null): void {
    this.errorCode = code;
    this.errorMessage = message ?? null;
  }

  // ── Persisting ─────────────────────────────────────────────────────────────

  /**
   * Writes the run and its steps.
   *
   * Idempotent — a second call is a no-op — so a caller may flush on both its
   * success and its failure path without guarding.
   *
   * Never throws, and never rejects. The `void`-returning shape is deliberate:
   * there is nothing a caller could usefully do with a trace-write failure that
   * this method has not already done.
   */
  async flush(): Promise<void> {
    if (!this.enabled || this.flushed || this.store === null) return;
    this.flushed = true;

    const completedAt = this.now();
    try {
      await this.store.saveRun({
        id: this.id,
        companyId: this.companyId,
        postId: this.postId,
        feedItemId: this.feedItemId,
        kind: this.kind,
        trigger: this.trigger,
        status: this.errorCode === null ? "completed" : "failed",
        channel: this.channel,
        language: this.language,
        userId: this.userId,
        contentGroupId: this.contentGroupId,
        generationBatchId: this.generationBatchId,
        scheduleId: this.scheduleId,
        jobId: this.jobId,
        llmProvider: this.llmProvider,
        llmModel: this.llmModel,
        attempts: this.attempts,
        startedAt: this.startedAt,
        completedAt,
        durationMs: completedAt.getTime() - this.startedAt.getTime(),
        errorCode: this.errorCode,
        errorMessage: this.errorMessage,
        options: this.options,
        truncated: this.truncated,
        steps: this.steps,
      });
    } catch (err) {
      // Loud, specific, and non-fatal. This is the one place a trace failure can
      // be diagnosed from, so it names the run, the post and the step count —
      // enough to tell "the write was rejected" from "nothing was recorded".
      console.error(
        `[generation-trace] FAILED to persist run ${this.id} ` +
          `(kind=${this.kind} post=${this.postId ?? "none"} steps=${this.steps.length}). ` +
          `The generation itself is unaffected. Cause:`,
        messageOf(err)
      );
    }
  }

  /** The steps recorded so far. For tests and for the in-process debug view. */
  peekSteps(): readonly PersistableStep[] {
    return this.steps;
  }

  private sanitize(value: unknown): Prisma.InputJsonValue {
    const result = sanitizeForTrace(value);
    if (result.truncated) this.truncated = true;
    return result.value as Prisma.InputJsonValue;
  }
}

/**
 * Tracing is on unless explicitly switched off, and requires somewhere to write.
 *
 * On by default because a trace nobody enabled is a trace nobody has when they
 * need it, and the cost is one insert per generation — against a pipeline whose
 * cheapest step is an LLM call. `GENERATION_TRACE_ENABLED=false` is the escape
 * hatch, for an operator staring at a storage bill rather than for normal
 * running.
 *
 * The `DATABASE_URL` half is not belt-and-braces: with no database configured
 * there is nowhere for a run to go, and the default store would spend a
 * connection timeout finding that out — on every generation, and on every unit
 * test that exercises a traced service without injecting a store. A tracer that
 * cannot persist must cost nothing rather than cost a hang.
 */
export function tracingEnabled(): boolean {
  return process.env.GENERATION_TRACE_ENABLED !== "false" && Boolean(process.env.DATABASE_URL);
}
