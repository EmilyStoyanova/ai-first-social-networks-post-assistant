/**
 * Server-instance startup hook.
 *
 * Exists for one job: teaching the wake notifier how THIS host defers work.
 *
 * `enqueueJob` is shared by the Next app and the worker process, so it cannot
 * import `next/server` — `after()` throws where there is no request, and four
 * worker handlers enqueue their own follow-ups in a plain Node process. Instead
 * the notifier keeps a scheduler seam, and the side that actually has `after()`
 * installs it here, once, when the server boots.
 *
 * The result is that a wake request started during a request survives the
 * response being sent, which on a serverless function it otherwise would not.
 */

export async function register(): Promise<void> {
  // `after()` is a Node-runtime API; the Edge runtime boots this file too.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const [{ after }, { setWakeScheduler }] = await Promise.all([
    import("next/server"),
    import("@/lib/queue/wake-notifier"),
  ]);

  setWakeScheduler((task) => {
    try {
      after(task);
    } catch {
      // No request scope (a build-time or background call inside the Next
      // process). Detached is still better than not signalling at all.
      void task().catch(() => {});
    }
  });
}
