import type { ILlmProvider, LlmRequest } from "@/lib/ai/types";

/**
 * An `ILlmProvider` that reports every call it makes.
 *
 * Written as a DECORATOR rather than as a recorder parameter threaded through
 * the callee, because the callee here is aspect mining — `resolveGenerationAspect`
 * → `extractAspects` — which is two modules deep, is called from the prompt
 * preview as well as from generation, and has nothing else to say to a tracer.
 * Wrapping the provider captures the exact prompt and the exact reply of every
 * call it makes without either module learning that tracing exists.
 *
 * Only the instance handed to the observed work is wrapped. The generation loop
 * gets the bare provider, because it reports its attempts itself and with far
 * more context (which gate rejected them, what the retry was told to change).
 */

export interface ObservedProviderCall {
  systemPrompt: string;
  userPrompt: string;
  request: { temperature?: number; maxTokens?: number };
  startedAt: Date;
  completedAt: Date;
  durationMs: number;
  /** The reply text, or null when the call threw. */
  responseText: string | null;
  /** Whatever the provider forwarded alongside it (token counts, timings). */
  responseRaw?: unknown;
  error?: { name: string; message: string };
}

export function observeProvider(
  provider: ILlmProvider,
  onCall: (call: ObservedProviderCall) => void
): ILlmProvider {
  return {
    async generate(request: LlmRequest) {
      const startedAt = new Date();
      const base = () => {
        const completedAt = new Date();
        return {
          systemPrompt: request.systemPrompt,
          userPrompt: request.userPrompt,
          request: { temperature: request.temperature, maxTokens: request.maxTokens },
          startedAt,
          completedAt,
          durationMs: completedAt.getTime() - startedAt.getTime(),
        };
      };

      // The observer must not be able to break the call it observes — the same
      // rule the attempt recorder in the generation loop follows.
      const report = (call: ObservedProviderCall) => {
        try {
          onCall(call);
        } catch (err) {
          console.error(
            "[generation-trace] Provider observer threw (the call is unaffected):",
            err instanceof Error ? err.message : err
          );
        }
      };

      try {
        const response = await provider.generate(request);
        report({ ...base(), responseText: response.text, responseRaw: response.raw });
        return response;
      } catch (err) {
        report({
          ...base(),
          responseText: null,
          error: {
            name: err instanceof Error ? err.name : "Error",
            message: err instanceof Error ? err.message : String(err),
          },
        });
        throw err;
      }
    },
  };
}
