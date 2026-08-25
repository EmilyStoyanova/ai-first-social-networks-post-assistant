/**
 * The two "requeue this source" controls in the RSS articles panel, as logic rather
 * than as JSX.
 *
 * Both buttons do the same shape of thing — POST to a per-source endpoint, get back
 * a count of rows reopened, and report it — so the parts that can actually be WRONG
 * (which endpoint, which message, whether the control may be pressed) live here where
 * they are testable. This project has no component-test harness; extracting the
 * decision out of the component is how the panel's behaviour gets covered, the same
 * way feed-item-classification-filter.ts covers the filter row above it.
 */

/** The queueing actions a source card offers. */
export type SourceQueueAction = "reclassify" | "retranslate";

export const SOURCE_QUEUE_ACTIONS: readonly SourceQueueAction[] = ["reclassify", "retranslate"];

/**
 * The endpoint for one action. Built in one place because both routes are nested
 * identically under the source and differ only in the last segment — a typo there
 * would hit a real, adjacent endpoint that does something else entirely.
 */
export function sourceQueueActionEndpoint(
  slug: string,
  sourceId: string,
  action: SourceQueueAction
): string {
  return `/api/v1/companies/${slug}/content-sources/${sourceId}/${action}`;
}

/**
 * Whether a control must be disabled right now.
 *
 * Deliberately mutual: EITHER action running disables BOTH buttons, not just its
 * own. The two act on overlapping rows and both reset attempt counts, so letting a
 * retranslation start while a reclassification is still in flight is the UI-level
 * version of the duplicate work the dedupe key prevents server-side. `loading`
 * (the article list refetching) disables them too, since the list underneath is what
 * the reported count is checked against.
 */
export function isSourceQueueActionDisabled(
  state: { running: SourceQueueAction | null; loading: boolean },
  _action: SourceQueueAction
): boolean {
  return state.running !== null || state.loading;
}

/**
 * Which message a reported count should produce.
 *
 * Zero is its own message rather than "0 articles queued", which reads as a failure
 * when it almost always means the source was already up to date — nothing had
 * failed, nothing was stale, and there was simply nothing to redo.
 */
export function queuedMessageKey(reopened: number): "queued" | "queuedNone" {
  return reopened > 0 ? "queued" : "queuedNone";
}

/** The i18n key for an action's message, under the namespace that action reads. */
export function queuedMessageFor(
  action: SourceQueueAction,
  reopened: number
): "reclassifyQueued" | "reclassifyQueuedNone" | "retranslateQueued" | "retranslateQueuedNone" {
  const suffix = queuedMessageKey(reopened);
  return action === "reclassify"
    ? suffix === "queued"
      ? "reclassifyQueued"
      : "reclassifyQueuedNone"
    : suffix === "queued"
      ? "retranslateQueued"
      : "retranslateQueuedNone";
}
