/**
 * The wall-clock bound shared by every translation provider.
 *
 * Lives here rather than in translate-feed-item.service.ts so a provider can enforce
 * its own per-call budget without importing the service that builds it — the service
 * builds providers through the factory, so the dependency has to run one way only.
 */

/** One model call (or one item) exceeded its wall-clock budget. */
export class TranslationTimeoutError extends Error {
  readonly code = "TRANSLATION_TIMEOUT" as const;
  constructor(ms: number, scope: "attempt" | "item") {
    super(`Translation ${scope} exceeded its ${ms}ms budget.`);
    this.name = "TranslationTimeoutError";
  }
}

/**
 * Rejects with a {@link TranslationTimeoutError} if `work` has not settled within `ms`.
 *
 * The underlying request is NOT cancelled — the provider owns its own AbortSignal and will
 * tear the socket down at its own (much longer) cap. This bound exists so a hung article
 * stops occupying the batch, not to manage the socket: control returns immediately, the item
 * is recorded failed, and the run moves to the next article. A late settle is swallowed
 * rather than surfacing as an unhandled rejection.
 */
export function withTranslationTimeout<T>(
  work: Promise<T>,
  ms: number,
  scope: "attempt" | "item"
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TranslationTimeoutError(ms, scope)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}
