import type { GenerationTracer } from "@/lib/generation-trace/tracer";
import type {
  JsonRepair,
  TranslationPrompts,
  TranslationReplyMode,
} from "@/lib/ai/feed-item-translation";

/**
 * The translation provider abstraction.
 *
 * Everything ABOVE this line — the claim, the attempt counter, the backoff, the
 * trace run, the DB write — belongs to `translate-feed-item.service.ts` and is the
 * same whichever engine produced the text. Everything BELOW it is one engine's
 * private business: how it is prompted (or not), how it retries, and what it
 * considers an acceptable reply.
 *
 * Two engines implement it:
 *   • `ollama`  — the prompt-based, JSON-structured path that has always run this
 *                 pipeline (Qwen on the self-hosted text worker, or any configured
 *                 LLM provider). Unchanged, and the default.
 *   • `madlad`  — google/madlad400-3b-mt, a dedicated translation model served by
 *                 the SAME text worker on the SAME port under `POST /translate`.
 *
 * The kind is chosen once per call from the environment (see
 * `translation-provider-config.ts`); nothing downstream branches on it.
 */

/** The engines a deployment may select through `TRANSLATION_PROVIDER`. */
export const TRANSLATION_PROVIDER_KINDS = ["ollama", "madlad"] as const;

export type TranslationProviderKind = (typeof TRANSLATION_PROVIDER_KINDS)[number];

/** One article, as handed to an engine. */
export interface ArticleTranslationRequest {
  /** Diagnostics only — every log line names the exact item. */
  feedItemId: string;
  /** The article's own URL. Diagnostics only. */
  url: string;
  title: string | null;
  content: string | null;
  targetLang: string;
  /**
   * The reply contract for this item. "title_only" means the article has no body,
   * so no engine may return one — decided by the caller, never by the engine.
   */
  mode: TranslationReplyMode;
  /**
   * The prompt bundle the caller already built (system/user prompt, the Ollama
   * `format` schema, the capped body). Prompt-based engines send it as-is;
   * a dedicated NMT engine such as MADLAD ignores it entirely and works from
   * `title`/`content` above. Passed rather than rebuilt so the trace's `source`
   * step and the engine can never disagree about what was sent.
   */
  prompts: TranslationPrompts;
}

/** The budget and observers one article's translation runs under. */
export interface ArticleTranslationContext {
  /** Observation only — an engine records what it did, it never branches on this. */
  tracer: GenerationTracer;
  now: () => Date;
  /**
   * The diagnostic fields the caller assembled (feed item id, title, source URL,
   * prompt/article lengths, the engine's own name). Merged into every log line an
   * engine writes, so one article's story reads continuously across both layers.
   */
  diag: Record<string, unknown>;
  /** Wall-clock cap for ONE model call. */
  attemptTimeoutMs: number;
  /** Absolute epoch-ms deadline for the whole item, across all in-request retries. */
  itemDeadlineMs: number;
  /** The item budget itself, for the error message when that deadline passes. */
  itemTimeoutMs: number;
  /**
   * Called at the start of every model call with the call number (1-based).
   *
   * The caller needs the count even when `translate` THROWS — "how many calls did
   * this failure cost?" is the first question asked of a failed article, and a
   * return value cannot answer it. Optional so a test can ignore it.
   */
  reportTry?: (tries: number) => void;
  /**
   * MADLAD-only: caps how many NEW HTTP batches this call may start before it must
   * stop and report partial progress (see {@link MadladPartialProgressError}) instead
   * of continuing to the next batch. `undefined` means "no cap" — the original,
   * single-call-to-completion behaviour, unchanged for every article whose estimated
   * cost fits inside one item budget. Every other engine ignores this field entirely.
   */
  maxBatchesThisCall?: number;
  /**
   * Raw (pre-restoration) segment/chunk translations already banked by an earlier,
   * interrupted call for this same article, keyed by a per-engine unit key —
   * MADLAD's own ARTICLE segment index, or the Ollama chunked-translation path's
   * `"title"` / chunk index (see ollama-chunking.ts). `undefined`/empty means
   * starting fresh. Restoration, repair and the quality gate all run exactly once,
   * only after every unit has a reply — whether that reply came from this call or
   * an earlier one is invisible to them. Every other engine ignores this field.
   */
  resumeSegments?: Record<string, string>;
}

/**
 * Thrown instead of returning an {@link ArticleTranslation} when an engine's own
 * per-call progress cap (MADLAD's `context.maxBatchesThisCall`, or the Ollama
 * chunked path running out of item budget mid-chunk) stopped it before every unit
 * had a translation.
 *
 * This is NOT a failure: the units that did complete succeeded, and
 * `translatedSegments` is exactly what a follow-up call's `resumeSegments` needs to
 * pick up where this one left off. It is a distinct type from every other
 * translation error specifically so the caller can tell "made bounded progress, come
 * back for the rest" apart from "something went wrong" — conflating the two would
 * make a healthy, expected pause in an oversized article's translation look like a
 * fault to retry-with-backoff.
 *
 * Deliberately thrown rather than returned: `ArticleTranslation` is the shared
 * "translation accepted" contract both engines return through, and a partial result
 * must never satisfy a caller that only checks "did translate() resolve" — the
 * existing quality gate, repair and reassembly logic must stay completely unaware
 * that partial progress exists at all, which throwing (instead of adding a variant to
 * the success type) guarantees by construction.
 *
 * Named engine-neutrally (not `MadladPartialProgressError`, its original name) once a
 * second engine — the Ollama chunked-translation path — started throwing it too: the
 * mechanism it signals (bounded progress, safe to resume) is identical for both, and
 * one shared type is what lets `translate-feed-item.service.ts` bank/resume either
 * engine's progress through a single catch block. `processedBatchCount`/
 * `totalBatchCount` keep their names for the same reason — "batch" now means "one
 * unit of resumable translation work," an HTTP batch for MADLAD, a chunk or the title
 * for Ollama chunking.
 */
export class TranslationPartialProgressError extends Error {
  constructor(
    message: string,
    /** Raw (pre-restoration) reply for every unit translated so far, keyed by article index. */
    readonly translatedSegments: Record<string, string>,
    /** Units completed across every call for this article so far, including this one. */
    readonly processedBatchCount: number,
    /** Total units this article needs — `processedBatchCount` reaches this when done. */
    readonly totalBatchCount: number
  ) {
    super(message);
    this.name = "TranslationPartialProgressError";
  }
}

/** What an engine returns when it has produced an acceptable translation. */
export interface ArticleTranslation {
  translatedTitle: string | null;
  /** Null in title-only mode — the article had no body, so the translation has none. */
  translatedContent: string | null;
  /** ATTEMPTS actually spent. >1 means the engine regenerated at least once. */
  tries: number;
  /**
   * HTTP calls to the model actually spent, when that differs from `tries`.
   *
   * For a prompt-based engine one attempt is one call, so this is absent and the caller
   * falls back to `tries`. For a segment-at-a-time NMT engine one attempt is one call
   * PER SEGMENT, and conflating the two would report a 12-call article as costing one.
   */
  modelCalls?: number;
  /** True when a reply had to be salvaged before it could be read. Always false for NMT. */
  usedRepair: boolean;
  /** Exactly which salvages were applied; empty on the clean path. */
  repairs: JsonRepair[];
  /** Raw payload of the call that SUCCEEDED — the source of the metrics logged above. */
  raw: unknown;
}

/**
 * One translation engine.
 *
 * `translate` either returns an accepted translation or throws. It throws exactly
 * what the service already knows how to record: `TranslationParseError` when the
 * output was unusable, `TranslationTimeoutError` when a budget ran out, and any
 * other Error for a transport fault. It never writes to the database and never
 * decides an item's fate — that stays with the caller.
 */
export interface TranslationProvider {
  readonly kind: TranslationProviderKind;
  /**
   * The label stored on the feed item and shown in the trace as the provider.
   *
   * This names WHO SERVED the model, not which engine ran. For `madlad` it is
   * "TEXT_WORKER", because that is the service answering `/translate`. For `ollama` it
   * stays the label of whichever LLM provider the admin default resolves to
   * ("TEXT_WORKER", "GROQ", …), because that is what production has always recorded and
   * what the UI reads. The ENGINE is `kind`, reported separately everywhere.
   */
  readonly providerLabel: string;
  /** The exact model, e.g. "qwen3:8b" or "google/madlad400-3b-mt". */
  readonly model: string;
  /**
   * The most model calls one article can cost this engine.
   *
   * Declared rather than assumed, because it differs by engine and the caller logs
   * it before the first call: a chat model regenerates a rejected reply, while a
   * beam-search NMT model would only reproduce it, so MADLAD's ceiling is 1.
   */
  readonly maxTries: number;
  translate(
    request: ArticleTranslationRequest,
    context: ArticleTranslationContext
  ): Promise<ArticleTranslation>;
}

/**
 * A transport-level fault talking to a translation engine: unreachable worker,
 * non-2xx reply, or a malformed envelope.
 *
 * Deliberately distinct from `TranslationParseError` (the engine answered, but the
 * TEXT was unusable). Only this class may ever justify falling back to another
 * engine — a bad translation never does. See `madlad-translation.provider.ts`.
 */
export class TranslationTransportError extends Error {
  readonly code = "TRANSLATION_TRANSPORT_ERROR" as const;
  constructor(message: string) {
    super(message);
    this.name = "TranslationTransportError";
  }
}
