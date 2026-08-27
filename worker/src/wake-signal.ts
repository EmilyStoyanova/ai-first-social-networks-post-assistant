/**
 * The in-process edge between "something arrived on the wake port" and "the poll
 * loop should stop sleeping".
 *
 * Deliberately carries no information. A wake means only *look at the queue*, so
 * ten wakes and one wake are the same instruction and collapsing them is correct
 * rather than a shortcut — the loop claims until the queue is empty regardless of
 * how many times it was asked to.
 *
 * The one piece of state that matters is `pending`. A wake can land in the gap
 * between the loop's last empty claim and the moment it actually starts
 * sleeping; without a latch that signal would be delivered to nobody and the
 * worker would sleep through the job that prompted it. Holding it means the
 * sleep ends the instant it begins instead.
 */

export type WakeListener = () => void;

export class WakeSignal {
  private pending = false;
  private readonly listeners = new Set<WakeListener>();

  /**
   * Record a wake and tell anyone waiting.
   *
   * Never throws — it is called from an HTTP handler that must answer the
   * request whatever the loop is doing, and a listener that fails is not that
   * request's problem.
   */
  notify(): void {
    this.pending = true;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // A listener is the runner ending its own sleep. If that throws, the
        // fallback timer still fires.
      }
    }
  }

  /**
   * Clear any latched wake, reporting whether there was one.
   *
   * Called by the loop each time round while it is awake: a signal arriving
   * while the worker is already claiming has been honoured by definition, and
   * leaving it latched would send the next sleep straight back to work.
   */
  consumePending(): boolean {
    const had = this.pending;
    this.pending = false;
    return had;
  }

  hasPending(): boolean {
    return this.pending;
  }

  /**
   * Listen for the next wake, returning the unsubscribe.
   *
   * A latched wake fires the listener immediately and synchronously — which is
   * what closes the race described above, since the caller subscribes before it
   * commits to sleeping.
   */
  subscribe(listener: WakeListener): () => void {
    this.listeners.add(listener);
    if (this.pending) {
      this.pending = false;
      try {
        listener();
      } catch {
        // As above.
      }
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Live listener count. Exposed so tests can assert nothing leaks. */
  listenerCount(): number {
    return this.listeners.size;
  }
}
