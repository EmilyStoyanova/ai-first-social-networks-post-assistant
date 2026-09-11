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
 *
 * ── One timeout, and it is the configured one ────────────────────────────────
 *
 * This client does NOT dial with global `fetch`. undici enforces a 300s
 * `headersTimeout` that measures the wait for the response's first byte, and the
 * sidecar sends no byte until the whole Writer → Editor → QA loop is done — so
 * `fetch` abandoned a live 45-minute run at five minutes with
 * `UND_ERR_HEADERS_TIMEOUT`, having never consulted the configured budget. The
 * transport in `loopback-transport.ts` is `node:http`, which has no headers or
 * body timeout at all, making `CREW_SIDECAR_TIMEOUT_MS` the single authoritative
 * end-to-end deadline. Nothing global changes; only this client is affected.
 *
 * ── What a timeout does NOT do ───────────────────────────────────────────────
 *
 * Abandoning the request does not cancel the generation. The sidecar's handler
 * runs `run_flow` synchronously and cannot see the disconnect, so CrewAI and
 * Ollama keep working and the single-flight slot stays held until the run ends
 * on its own. A `timeout` here therefore means "we stopped waiting", not "it
 * stopped running", and the next request will legitimately be refused
 * `crew_busy`. That is truthful rather than convenient: the sidecar reports the
 * occupancy on `/health`, and `sidecar/crewai/occupancy.py` records whether the
 * occupant's client is still connected.
 */

import { z } from "zod";
import {
  crewFailureResponseSchema,
  crewPostResponseSchema,
  DEFAULT_MAX_QA_REPAIRS,
  resolveQaState,
  validateCallCounts,
  type CrewFailureCode,
  type CrewPostRequest,
  type CrewPostResponse,
} from "./crew-contract";
import type { QaState } from "./provenance";
import type { ParsedLlmPost } from "@/lib/ai/parse-llm-post";
import { loopbackFetch, UNDICI_DEFAULT_HEADERS_TIMEOUT_MS } from "./loopback-transport";
import { requestTimeoutMs } from "@/lib/http/request-deadline";

/**
 * Hard abort cap for ONE `/crew/post` call.
 *
 * Sized from the loop's own worst case rather than guessed: `3 + 3R` agent
 * calls per outer attempt (9 at R=2), each bounded by Ollama's 300s per-call
 * ceiling. It is a ceiling against a wedged run holding a job lease, NOT an
 * expectation — the operational value comes from measured p95 and is set by
 * `CREW_SIDECAR_TIMEOUT_MS`.
 *
 * QA REPAIR calls are deliberately NOT added to this arithmetic. They are
 * bounded (`maxQaRepairs` per evaluation) and they are the cheapest call the
 * loop makes — a verdict under the `QaVerdict` grammar measured at ~50 output
 * tokens against `qwen3.5:35b-a3b-q4_K_M`, versus a full post from the Writer —
 * so they fit inside the headroom this ceiling already carries over the ~22.5
 * min a real outer attempt cost in validation. If a deployment starts seeing
 * repairs on most evaluations, raise `CREW_SIDECAR_TIMEOUT_MS`; that is the
 * knob, not this bound.
 */
export const OLLAMA_CALL_CEILING_MS = 300_000;

export function crewSidecarCeilingMs(maxQaRounds: number): number {
  return (3 + 3 * maxQaRounds) * OLLAMA_CALL_CEILING_MS;
}

export const DEFAULT_CREW_SIDECAR_TIMEOUT_MS = crewSidecarCeilingMs(2);

/** Re-exported so callers can name the limit this client exists to escape. */
export { UNDICI_DEFAULT_HEADERS_TIMEOUT_MS };

/** Max QA REVISION cycles. Two, per the strategy's own bound (requirement 5). */
export const DEFAULT_MAX_QA_ROUNDS = 2;

/**
 * Max QA REPAIR calls on one candidate — re-exported from the contract, which
 * both ends of the boundary read.
 */
export { DEFAULT_MAX_QA_REPAIRS };

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
  /**
   * The candidate as the model wrote it. Kept for the attempt trace only —
   * the multi-agent loop no longer parses it.
   */
  raw: string;
  /**
   * The structured candidate, validated against `LlmPostSchema` by the response
   * contract. This is what the caller consumes; no `JSON.parse` of model text
   * happens on the CrewAI path any more.
   */
  parsed: ParsedLlmPost;
  qaState: QaState;
  qaRevisions: number;
  /**
   * QA calls spent re-asking the SAME candidate because the previous verdict
   * broke the QA contract. Zero on a healthy run; already inside
   * `agentCalls.qa`. Surfaced so a caller can tell a critic that needed a nudge
   * to PHRASE its verdict from one that needed another revision round.
   */
  qaRepairs: number;
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
  readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;
  /**
   * Which transport is in use, so a live run can PRINT it.
   *
   * `node:http` is the only one with no timeout of its own. `injected` means a
   * test (or the verifier's own `deps.fetchImpl`) supplied the transport and
   * owns its deadlines — which is fine for a double, and would silently
   * reintroduce undici's 300s cap if anyone ever injected global `fetch` here.
   */
  readonly transport: "node:http" | "injected";

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
    // NOT global `fetch`: undici's 300s headersTimeout would preempt every
    // budget larger than itself, which is every realistic one. See the module
    // header and `loopback-transport.ts`.
    this.transport = fetchImpl ? "injected" : "node:http";
    this.fetchImpl = fetchImpl ?? loopbackFetch();
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
    const maxQaRepairs = request.attemptContext.maxQaRepairs ?? DEFAULT_MAX_QA_REPAIRS;

    // The effective budget, computed ONCE so the signal and the timeout message
    // cannot disagree. Under an ambient cron deadline this is the smaller of the
    // configured budget and the headroom left — still an application decision,
    // never a transport one.
    const budgetMs = requestTimeoutMs(this.timeoutMs);

    let res: Response;
    try {
      // The single deadline in the stack: `budgetMs` via this signal. The
      // transport adds none of its own, so nothing can expire earlier.
      console.info(
        `[crew-sidecar] POST /crew/post transport=${this.transport} budget=${budgetMs}ms` +
          (this.transport === "injected" && budgetMs > UNDICI_DEFAULT_HEADERS_TIMEOUT_MS
            ? ` (WARNING: an injected transport may impose its own limit; undici's default is ${UNDICI_DEFAULT_HEADERS_TIMEOUT_MS}ms)`
            : "")
      );
      res = await this.fetchImpl(`${this.baseUrl}/crew/post`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-worker-api-key": this.apiKey,
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(budgetMs),
      });
    } catch (err) {
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        console.warn("[crew-sidecar] transport failure: category=timeout");
        // The generation is almost certainly STILL RUNNING: nothing here can
        // cancel a synchronous CrewAI kickoff, so the sidecar keeps its slot
        // until the run finishes and the next call is honestly `crew_busy`.
        throw new CrewSidecarError(
          "timeout",
          `CrewAI sidecar request exceeded its ${budgetMs}ms budget. The sidecar's ` +
            `generation is not cancelled by this and may still be running.`
        );
      }
      // A transport-imposed deadline is a DIFFERENT fault from the configured
      // one, and conflating them is what made the original defect look like an
      // unreachable sidecar. Named explicitly so it can never be misread again.
      const transportDeadline = transportCauseCode(err);
      if (
        transportDeadline === "UND_ERR_HEADERS_TIMEOUT" ||
        transportDeadline === "UND_ERR_BODY_TIMEOUT"
      ) {
        console.warn(
          `[crew-sidecar] transport failure: category=transport_deadline code=${transportDeadline}`
        );
        throw new CrewSidecarError(
          "invalid_response",
          `The HTTP transport abandoned the request after its own ${transportDeadline} ` +
            `(undici's default is ${UNDICI_DEFAULT_HEADERS_TIMEOUT_MS}ms), not after the configured ` +
            `${budgetMs}ms budget. This client must dial with the node:http transport; an injected ` +
            `fetch based on undici reintroduces the defect.`
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

    const counters = validateCallCounts(response, maxQaRounds, maxQaRepairs);
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
      parsed: response.candidate.json,
      qaState: qa.state,
      qaRevisions: response.qa.revisions,
      qaRepairs: response.qa.repairs,
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
