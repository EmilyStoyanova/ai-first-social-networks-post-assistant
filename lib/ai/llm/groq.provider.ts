import type { ILlmProvider, LlmRequest, LlmResponse } from "./llm-provider";
import { LlmProviderError, LlmRateLimitError } from "../errors";
import { requestSignal } from "@/lib/http/request-deadline";

const DEFAULT_BASE_URL = "https://api.groq.com/openai";

/** Per-request cap for a single Groq call; squeezed smaller under a cron deadline. */
const GROQ_TIMEOUT_MS = 90_000;

/** Initial attempt + this many retries when Groq reports a rate limit. */
const DEFAULT_MAX_ATTEMPTS = 3;
/** Backoff for attempt N when Groq sends no Retry-After: 1s, 2s, 4s… */
const BASE_BACKOFF_MS = 1_000;
/**
 * Never block a request longer than this per wait. A Retry-After above the cap is
 * not worth holding an HTTP request open for — we surface the limit instead and
 * pass the provider's wait to the caller.
 */
const MAX_BACKOFF_MS = 8_000;

interface GroqChatResponse {
  choices: { message: { content: string | null } }[];
}

export interface GroqProviderOptions {
  /** Total attempts including the first. Defaults to DEFAULT_MAX_ATTEMPTS. */
  maxAttempts?: number;
  /** Injectable for tests so backoff does not actually sleep. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Parses a Retry-After header, which is either a (possibly fractional) number of
 * seconds or an HTTP-date. Returns undefined when absent or unparseable.
 */
export function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (trimmed === "") return undefined;

  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));

  const at = Date.parse(trimmed);
  if (!Number.isNaN(at)) return Math.max(0, at - Date.now());

  return undefined;
}

export class GroqProvider implements ILlmProvider {
  private readonly maxAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly baseUrl?: string,
    options: GroqProviderOptions = {}
  ) {
    this.maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    this.sleep = options.sleep ?? defaultSleep;
  }

  async generate(request: LlmRequest): Promise<LlmResponse> {
    const base = (this.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");

    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(`${base}/v1/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: this.model,
            temperature: request.temperature ?? 0.7,
            max_tokens: request.maxTokens ?? 1024,
            messages: [
              { role: "system", content: request.systemPrompt },
              { role: "user", content: request.userPrompt },
            ],
          }),
          // Bounded by the ambient cron deadline so a hung Groq call cannot run past it.
          signal: requestSignal(GROQ_TIMEOUT_MS),
        });
      } catch (err) {
        if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
          throw new LlmProviderError("Groq request exceeded its deadline");
        }
        throw new LlmProviderError(
          `Groq unreachable: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      if (res.ok) {
        const data = (await res.json()) as GroqChatResponse;
        const text = data.choices[0]?.message?.content ?? "";
        return { text, raw: data };
      }

      const body = await res.text().catch(() => res.statusText);
      const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
      const isRateLimited = res.status === 429 || body.includes("rate_limit_exceeded");

      if (!isRateLimited) {
        throw new LlmProviderError(`Groq API error ${res.status}: ${body}`);
      }

      // Honour Retry-After when Groq sends one, else exponential backoff.
      const wait = retryAfterMs ?? Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
      const attemptsLeft = attempt < this.maxAttempts;

      // A wait longer than the cap is surfaced rather than slept through; the
      // caller gets retryAfterMs so it can tell the user when to come back.
      if (!attemptsLeft || wait > MAX_BACKOFF_MS) {
        throw new LlmRateLimitError(
          `Groq API error ${res.status}: ${body}`,
          retryAfterMs ?? undefined
        );
      }

      console.warn(
        `[groq] rate limited (attempt ${attempt}/${this.maxAttempts}) — retrying in ${wait}ms`
      );
      await this.sleep(wait);
    }
  }
}
