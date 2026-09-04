/**
 * The HTTP client for the local CrewAI sidecar.
 *
 * Modelled on `lib/ai/llm/text-worker.provider.ts` — same `x-worker-api-key`
 * header, same `transportCauseCode` diagnostics, same rule that the internal
 * host is never echoed into a client-facing message — because it solves the
 * same problem against the same kind of self-hosted loopback service.
 *
 * ── The two guards that are specific to this client ─────────────────────────
 *
 * **Loopback only.** The sidecar binds `127.0.0.1` and its whole security
 * posture assumes the caller is on the same machine. A `CREW_SIDECAR_URL`
 * pointing anywhere else is a configuration mistake with a security
 * consequence, so it is refused at construction rather than dialled.
 *
 * **Configured only.** Every multi-agent run executes in the Mac worker
 * process, which is where the sidecar lives. If this client is ever reached
 * from a serverless function, a loopback URL would resolve to that FUNCTION's
 * own loopback and either hang or connect to something unrelated. So an unset
 * URL is `not_configured` — a loud, terminal failure — and never an
 * approximation, a retry against a guessed host, or a fall back to another
 * strategy.
 *
 * ── No fallback, deliberately ───────────────────────────────────────────────
 *
 * There is no code path here that reaches a hosted provider or the single-agent
 * loop. A multi-agent run that cannot reach its sidecar fails as a multi-agent
 * run. Falling back would move an `ab_split` post into the other arm, which
 * silently corrupts the experiment the strategy exists to run — and would do so
 * in exactly the conditions (sidecar down) most likely to correlate with
 * something else.
 */

import { z } from "zod";
import {
  crewFailureResponseSchema,
  crewPostResponseSchema,
  resolveQaState,
  validateCallCounts,
  type CrewFailureCode,
  type CrewPostRequest,
  type CrewPostResponse,
} from "./crew-contract";
import type { QaState } from "./provenance";
import { requestSignal } from "@/lib/http/request-deadline";

/**
 * Hard abort cap for ONE `/crew/post` call.
 *
 * Sized from the loop's own worst case rather than guessed: `3 + 3R` agent
 * calls per outer attempt (9 at R=2), each bounded by Ollama's 300s per-call
 * ceiling. It is a ceiling against a wedged run holding a job lease, NOT an
 * expectation — the operational value comes from measured p95 and is set by
 * `CREW_SIDECAR_TIMEOUT_MS`.
 */
export const OLLAMA_CALL_CEILING_MS = 300_000;

export function crewSidecarCeilingMs(maxQaRounds: number): number {
  return (3 + 3 * maxQaRounds) * OLLAMA_CALL_CEILING_MS;
}

export const DEFAULT_CREW_SIDECAR_TIMEOUT_MS = crewSidecarCeilingMs(2);

/** Max QA REVISION cycles. Two, per the strategy's own bound (requirement 5). */
export const DEFAULT_MAX_QA_ROUNDS = 2;

export class CrewSidecarError extends Error {
  constructor(
    readonly code: CrewFailureCode,
    message: string
  ) {
    super(message);
    this.name = "CrewSidecarError";
  }
}

/**
 * The hosts a sidecar may live on. Loopback literals only — never a name that
 * could resolve elsewhere, and never `0.0.0.0`, which as a destination is not
 * loopback at all.
 */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function isLoopbackUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return LOOPBACK_HOSTS.has(url.hostname);
}

export interface CrewSidecarConfig {
  url: string;
  apiKey: string;
  timeoutMs?: number;
}

/**
 * Reads the sidecar's configuration from the environment.
 *
 * These are MAC-WORKER RUNTIME variables and are deliberately absent from
 * Vercel: nothing in a serverless deployment may hold or dial a loopback URL.
 * Returns null when unset, which the caller turns into `not_configured`.
 */
export function crewSidecarConfigFromEnv(
  env: Record<string, string | undefined> = process.env
): CrewSidecarConfig | null {
  const url = env.CREW_SIDECAR_URL;
  const apiKey = env.CREW_SIDECAR_API_KEY;
  if (!url || !apiKey) return null;
  const rawTimeout = env.CREW_SIDECAR_TIMEOUT_MS;
  const timeoutMs = rawTimeout ? Number(rawTimeout) : undefined;
  return {
    url,
    apiKey,
    timeoutMs:
      timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0
        ? timeoutMs
        : undefined,
  };
}

/** What one successful sidecar call yielded, already validated. */
export interface CrewPostOutcome {
  /** The candidate's raw JSON text — parsed by the existing `parseLlmPost`. */
  raw: string;
  qaState: QaState;
  qaRevisions: number;
  qaIssues: CrewPostResponse["qa"]["issues"];
  agentCalls: CrewPostResponse["agentCalls"];
  latencyMs: number;
  model: CrewPostResponse["model"];
  degradedStages: readonly string[];
}

/**
 * undici rejects every transport failure as the same opaque `TypeError: fetch
 * failed`; the actual reason (DNS, refused connection, no route) is only on
 * `err.cause`. Returns the cause's short syscall code so an operator can tell
 * "sidecar is down" from "sidecar URL is wrong for this process" without shell
 * access.
 */
function transportCauseCode(err: unknown): string | undefined {
  const cause: unknown = err instanceof Error ? err.cause : undefined;
  if (cause && typeof cause === "object" && "code" in cause) {
    const code = (cause as { code: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class CrewSidecarClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(config: CrewSidecarConfig, fetchImpl?: FetchLike) {
    if (!isLoopbackUrl(config.url)) {
      // Refused at construction, not at call time: a non-loopback sidecar URL is
      // never a transient condition, and dialling it once to find out would be
      // the outbound request the whole posture forbids.
      throw new CrewSidecarError(
        "not_configured",
        "CREW_SIDECAR_URL must be a loopback address (127.0.0.1, localhost or [::1])."
      );
    }
    this.baseUrl = config.url.replace(/\/$/, "");
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_CREW_SIDECAR_TIMEOUT_MS;
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
  }

  /**
   * Builds a client from the environment, or throws `not_configured`.
   *
   * Throwing rather than returning null is the point: a caller that has decided
   * to run multi-agent must not be able to continue without a sidecar, and a
   * nullable return invites exactly the `?? singleAgent` fallback this design
   * forbids.
   */
  static fromEnv(env?: Record<string, string | undefined>, fetchImpl?: FetchLike) {
    const config = crewSidecarConfigFromEnv(env);
    if (!config) {
      throw new CrewSidecarError(
        "not_configured",
        "CREW_SIDECAR_URL and CREW_SIDECAR_API_KEY are required for multi-agent generation. " +
          "They are Mac-worker runtime configuration and are not set in serverless environments."
      );
    }
    return new CrewSidecarClient(config, fetchImpl);
  }

  async generate(request: CrewPostRequest): Promise<CrewPostOutcome> {
    const maxQaRounds = request.attemptContext.maxQaRounds;

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/crew/post`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-worker-api-key": this.apiKey,
        },
        body: JSON.stringify(request),
        signal: requestSignal(this.timeoutMs),
      });
    } catch (err) {
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        console.warn("[crew-sidecar] transport failure: category=timeout");
        throw new CrewSidecarError(
          "timeout",
          `CrewAI sidecar request exceeded its ${this.timeoutMs}ms budget.`
        );
      }
      const causeCode = transportCauseCode(err);
      // The server-side log carries the full cause (host and port included) for
      // an operator; the thrown message gets only the short code, so the
      // internal sidecar host is never echoed back through an API response.
      console.warn(
        `[crew-sidecar] transport failure: category=unreachable name=${
          err instanceof Error ? err.name : "unknown"
        } cause=${err instanceof Error && err.cause instanceof Error ? err.cause.message : "unknown"}`
      );
      throw new CrewSidecarError(
        "unavailable",
        `CrewAI sidecar unreachable${causeCode ? ` (${causeCode})` : ""}.`
      );
    }

    console.info(`[crew-sidecar] response: status=${res.status} ok=${res.ok}`);

    if (!res.ok) throw await this.failureFor(res);

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new CrewSidecarError("invalid_response", "CrewAI sidecar returned a non-JSON body.");
    }

    // An explicit failure body on a 200 — the sidecar describing its own
    // failure. Checked before the success schema so its code survives verbatim
    // instead of being flattened into `invalid_response` by a strict parse.
    const declaredFailure = crewFailureResponseSchema.safeParse(body);
    if (declaredFailure.success) {
      throw new CrewSidecarError(
        declaredFailure.data.code,
        declaredFailure.data.message ?? `CrewAI sidecar reported ${declaredFailure.data.code}.`
      );
    }

    const parsed = crewPostResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new CrewSidecarError(
        "invalid_response",
        `CrewAI sidecar reply did not match the contract: ${describeIssues(parsed.error)}`
      );
    }
    const response = parsed.data;

    const counters = validateCallCounts(response, maxQaRounds);
    if (counters) {
      // A counter violation is a Flow regression, not a bad post: the run may
      // have produced perfectly good text while skipping a stage the design
      // requires. Refused as `invalid_response` so it is fixed rather than
      // retried into.
      throw new CrewSidecarError("invalid_response", counters.problem);
    }

    const qa = resolveQaState(response);
    if (!qa.ok) throw new CrewSidecarError(qa.code, qa.problem);

    return {
      raw: response.candidate.raw,
      qaState: qa.state,
      qaRevisions: response.qa.revisions,
      qaIssues: response.qa.issues,
      agentCalls: response.agentCalls,
      latencyMs: response.latencyMs,
      model: response.model,
      degradedStages: response.degradedStages,
    };
  }

  /**
   * Classifies a non-2xx status.
   *
   * `503` is the sidecar's own serialization signal (`crew_busy`) — a clean,
   * retryable "one generation at a time" rather than a fault — and it maps to
   * `unavailable` so the queue's retry policy handles it exactly as it handles a
   * sidecar that is down.
   */
  private async failureFor(res: Response): Promise<CrewSidecarError> {
    const text = await res.text().catch(() => "");
    const declared = safeJson(text);
    const declaredFailure = declared ? crewFailureResponseSchema.safeParse(declared) : null;
    if (declaredFailure?.success) {
      return new CrewSidecarError(
        declaredFailure.data.code,
        declaredFailure.data.message ?? `CrewAI sidecar reported ${declaredFailure.data.code}.`
      );
    }
    if (res.status === 503) {
      return new CrewSidecarError(
        "unavailable",
        "CrewAI sidecar is busy (one generation at a time)."
      );
    }
    return new CrewSidecarError(
      res.status >= 500 ? "unavailable" : "invalid_response",
      `CrewAI sidecar error ${res.status}.`
    );
  }
}

function safeJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Zod issues as one short line — paths only, never the reply's own content. */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.code}`)
    .join("; ");
}
