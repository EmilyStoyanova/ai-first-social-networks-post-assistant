/**
 * The round trip between the bulk generation form and the content-mix settings.
 *
 * "Configure content mix" is a link out of a half-filled form. Followed
 * naively it costs the user everything they had typed — channel, period,
 * per-day times, the batch's own mix — to change one number two pages away. So
 * the trip is made explicitly: the form snapshots itself on the way out, the
 * settings page shows the way back, and the form restores itself on return.
 *
 * Three decisions shape what is here:
 *
 *   • The draft lives in `sessionStorage`, keyed by company. It is scratch state
 *     for one flow in one tab, not a preference: it must not outlive the tab,
 *     must not follow the user to another browser, and must never be confused
 *     with the saved mix, which is company configuration.
 *   • It is consumed once. `takeBulkDraft` reads and deletes in the same call,
 *     so a restored form leaves nothing behind to be restored again on a later,
 *     unrelated visit.
 *   • The return trip is a marker, not a URL. `?from=bulk` says "there is a way
 *     back"; the href is rebuilt from the slug. Echoing a caller-supplied URL
 *     into a link is how open redirects start, and this needs no such thing —
 *     there is exactly one page the bulk form lives on.
 *
 * Everything below is pure except the three `sessionStorage` wrappers, so the
 * parsing — the part with edge cases — is testable without a browser.
 */

/**
 * Bumped whenever the draft's shape changes. A draft written by an older
 * deployment is dropped rather than half-read: a form restored from a shape it
 * does not understand is worse than one that simply opens fresh.
 */
const DRAFT_VERSION = 1;

/**
 * Mirrors `BulkPlanState` from `components/company/bulk-generate-fields.tsx`,
 * declared structurally rather than imported so a lib module does not reach up
 * into a component. The assignment back into `setPlan` on restore is what keeps
 * the two honest: if the state shape changes, that line stops compiling.
 */
export interface BulkDraftPlan {
  numberOfPosts: number;
  startDate: string;
  endDate: string;
  distribution: "even" | "custom";
  counts: Record<string, number>;
  times: Record<string, string[]>;
}

/** Everything the bulk form must look identical after, minus what it refetches. */
export interface BulkFormDraft {
  version: number;
  mode: "single" | "multiple";
  /**
   * Every channel the topic is written for. Empty only when the company has no
   * connected channel to preselect.
   *
   * Was a single `channel` string before generation could address more than one.
   * A draft written by that version is still restored — see `parseChannels` —
   * rather than dropped, because the version was not bumped: nothing else about
   * the shape changed, and discarding a half-filled form over a field that can
   * be read perfectly well would be a regression dressed as caution.
   */
  channels: string[];
  contentLanguage: "default" | "en" | "bg";
  imageOverride: "inherit" | "generate" | "skip";
  /** A sentinel or a content-source id; checked against the live list on restore. */
  contentSource: string;
  sourceLinkOverride: "inherit" | "include" | "exclude";
  /** "" = system default. */
  llmConfigId: string;
  plan: BulkDraftPlan;
  /** The batch's one-off mix; null = "untouched, use the saved default". */
  mixOverride: Record<string, number> | null;
}

/** What a caller hands in — the version is this module's business, not theirs. */
export type BulkFormDraftInput = Omit<BulkFormDraft, "version">;

// ─── The round-trip links ─────────────────────────────────────────────────────

/** Marks a settings visit as "arrived from the bulk form, and going back". */
export const BULK_RETURN_PARAM = "from";
export const BULK_RETURN_VALUE = "bulk";

/** Anchor ids, so the two ends of the trip cannot disagree on where to land. */
export const CONTENT_MIX_ANCHOR = "content-mix";
export const BULK_FORM_ANCHOR = "bulk-generate";

/**
 * The content-mix editor itself, not the settings page it sits at the bottom of.
 *
 * `fromBulk` is false for the ordinary in-app links to this page, which must
 * keep behaving exactly as they always have — no back link, no scrolling, no
 * draft in play.
 */
export function contentMixSettingsHref(slug: string, fromBulk: boolean): string {
  const query = fromBulk ? `?${BULK_RETURN_PARAM}=${BULK_RETURN_VALUE}` : "";
  return `/companies/${slug}/settings/channels${query}#${CONTENT_MIX_ANCHOR}`;
}

/** The bulk form, by anchor — the page also holds the whole post list. */
export function bulkGenerationHref(slug: string): string {
  return `/companies/${slug}/posts#${BULK_FORM_ANCHOR}`;
}

/** Whether a `searchParams` value asks for the way back to be shown. */
export function isReturnToBulk(value: string | string[] | undefined): boolean {
  const first = Array.isArray(value) ? value[0] : value;
  return first === BULK_RETURN_VALUE;
}

// ─── Parsing ──────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

function isCountMap(value: unknown): value is Record<string, number> {
  return (
    isRecord(value) &&
    Object.values(value).every((n) => typeof n === "number" && Number.isFinite(n))
  );
}

function isTimesMap(value: unknown): value is Record<string, string[]> {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (times) => Array.isArray(times) && times.every((t) => typeof t === "string")
    )
  );
}

/**
 * The draft's channels, reading either spelling.
 *
 * `channels` is the current shape. `channel` is what a draft saved before
 * multi-channel generation holds, and it maps cleanly onto a selection of one —
 * so it is read rather than refused. An empty string there meant "no connected
 * channel to preselect", which is an empty selection, not a channel named "".
 *
 * Returns null only for a value that is neither, which rejects the whole draft
 * like every other malformed field.
 */
function parseChannels(value: Record<string, unknown>): string[] | null {
  if (Array.isArray(value.channels)) {
    return value.channels.every((c) => typeof c === "string") ? (value.channels as string[]) : null;
  }
  if (typeof value.channel === "string") {
    return value.channel === "" ? [] : [value.channel];
  }
  return null;
}

function parsePlan(value: unknown): BulkDraftPlan | null {
  if (!isRecord(value)) return null;
  const distribution = oneOf(value.distribution, ["even", "custom"] as const);
  if (
    distribution === null ||
    typeof value.numberOfPosts !== "number" ||
    !Number.isFinite(value.numberOfPosts) ||
    typeof value.startDate !== "string" ||
    typeof value.endDate !== "string" ||
    !isCountMap(value.counts) ||
    !isTimesMap(value.times)
  ) {
    return null;
  }
  return {
    numberOfPosts: value.numberOfPosts,
    startDate: value.startDate,
    endDate: value.endDate,
    distribution,
    counts: value.counts,
    times: value.times,
  };
}

/**
 * A stored draft, or null when there is nothing usable to restore.
 *
 * Any bad field rejects the WHOLE draft rather than being dropped or defaulted.
 * A form restored from a partial snapshot is a form nobody filled in: the user
 * would have to spot which of a dozen fields quietly reverted, which is worse
 * than one that plainly opens fresh. Values are validated for shape only — that
 * the restored channel and source still exist is the form's question, since only
 * it knows what is on offer right now.
 */
export function parseBulkDraft(raw: string | null): BulkFormDraft | null {
  if (!raw) return null;

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.version !== DRAFT_VERSION) return null;

  const mode = oneOf(value.mode, ["single", "multiple"] as const);
  const contentLanguage = oneOf(value.contentLanguage, ["default", "en", "bg"] as const);
  const imageOverride = oneOf(value.imageOverride, ["inherit", "generate", "skip"] as const);
  const sourceLinkOverride = oneOf(value.sourceLinkOverride, [
    "inherit",
    "include",
    "exclude",
  ] as const);
  const plan = parsePlan(value.plan);
  const channels = parseChannels(value);

  if (
    mode === null ||
    contentLanguage === null ||
    imageOverride === null ||
    sourceLinkOverride === null ||
    plan === null ||
    channels === null ||
    typeof value.contentSource !== "string" ||
    typeof value.llmConfigId !== "string"
  ) {
    return null;
  }

  // null is a meaningful value here ("use the saved default"), so it is kept as
  // itself rather than collapsed into an empty object.
  const mixOverride = value.mixOverride === null ? null : value.mixOverride;
  if (mixOverride !== null && !isCountMap(mixOverride)) return null;

  return {
    version: DRAFT_VERSION,
    mode,
    channels,
    contentLanguage,
    imageOverride,
    contentSource: value.contentSource,
    sourceLinkOverride,
    llmConfigId: value.llmConfigId,
    plan,
    mixOverride,
  };
}

/** What a draft is stored under. Per company: two tabs, two companies, two drafts. */
export function bulkDraftKey(slug: string): string {
  return `bulk-generate-draft:${slug}`;
}

/**
 * A restored value, or the fallback when what was saved is no longer on offer —
 * a channel disconnected, or a content source deleted, while the user was away.
 */
export function stillAvailable<T extends string>(
  value: string,
  allowed: readonly string[],
  fallback: T
): T {
  return allowed.includes(value) ? (value as T) : fallback;
}

// ─── sessionStorage ───────────────────────────────────────────────────────────

/**
 * Storage can be absent (server render) or throw (Safari private browsing, or a
 * blocked third-party context). Every caller here treats that as "no draft",
 * which costs the user a re-typed form and nothing else — never an exception out
 * of a render or a click handler.
 */
function draftStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function saveBulkDraft(slug: string, draft: BulkFormDraftInput): void {
  const store = draftStorage();
  if (!store) return;
  try {
    store.setItem(bulkDraftKey(slug), JSON.stringify({ ...draft, version: DRAFT_VERSION }));
  } catch {
    // Quota or a blocked store: the trip still works, the form just opens fresh.
  }
}

/**
 * The stored draft, removed as it is read.
 *
 * Consuming it here is what keeps the restore tied to this one trip: nothing is
 * left behind to reapply itself the next time the page is opened for an
 * unrelated reason.
 */
export function takeBulkDraft(slug: string): BulkFormDraft | null {
  const store = draftStorage();
  if (!store) return null;
  try {
    const raw = store.getItem(bulkDraftKey(slug));
    store.removeItem(bulkDraftKey(slug));
    return parseBulkDraft(raw);
  } catch {
    return null;
  }
}

export function clearBulkDraft(slug: string): void {
  const store = draftStorage();
  if (!store) return;
  try {
    store.removeItem(bulkDraftKey(slug));
  } catch {
    // Nothing to do — an unreachable store holds no draft to begin with.
  }
}

// ─── The bulk run in flight ───────────────────────────────────────────────────

/**
 * The queued run this tab is watching.
 *
 * Bulk generation is a job now: the request returns in milliseconds and the work
 * happens elsewhere, over minutes. Which means the browser can leave and come
 * back — and if the only record of the job id were React state, coming back
 * would show a form that looks idle over a run that is still writing posts. The
 * obvious thing to do next would be to press Generate again, and the queue would
 * refuse it as ALREADY_RUNNING.
 *
 * So the id is written down. Stored beside the draft and for the same reasons:
 * `sessionStorage`, keyed by company, one tab's business. It is deliberately NOT
 * consumed on read — unlike the draft, this has to survive every visit until the
 * run it names actually finishes.
 */
export interface ActiveBulkJob {
  jobId: string;
  /** Stamped on every post the run writes; known from the 202. */
  batchId: string | null;
  /** Topics asked for — the denominator to show before any progress exists. */
  requestedTopics: number;
  /** When this tab started watching. ISO; used only for display. */
  startedAt: string;
}

/** Per company, like the draft: two tabs on two companies watch two runs. */
export function activeBulkJobKey(slug: string): string {
  return `bulk-generate-job:${slug}`;
}

/**
 * A stored job reference, or null when there is nothing usable.
 *
 * Only `jobId` is load-bearing — everything else is display detail the status
 * endpoint will supply again on the first poll — so a missing `batchId` or an
 * unreadable count degrades to a default rather than throwing the reference
 * away. Losing the id is what costs the user their run; losing a denominator for
 * one render costs nothing.
 */
export function parseActiveBulkJob(raw: string | null): ActiveBulkJob | null {
  if (!raw) return null;

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.jobId !== "string" || value.jobId === "") return null;

  return {
    jobId: value.jobId,
    batchId: typeof value.batchId === "string" ? value.batchId : null,
    requestedTopics:
      typeof value.requestedTopics === "number" && Number.isFinite(value.requestedTopics)
        ? value.requestedTopics
        : 0,
    startedAt: typeof value.startedAt === "string" ? value.startedAt : "",
  };
}

export function saveActiveBulkJob(slug: string, job: ActiveBulkJob): void {
  const store = draftStorage();
  if (!store) return;
  try {
    store.setItem(activeBulkJobKey(slug), JSON.stringify(job));
  } catch {
    // The run still happens; this tab just cannot resume watching it after a
    // navigation, which is exactly the pre-existing behaviour.
  }
}

/**
 * The run this tab is watching, WITHOUT consuming it.
 *
 * The deliberate difference from `takeBulkDraft`. A draft describes a form
 * nobody has submitted, so restoring it once is the whole of its job; this
 * describes work that is actually happening, and it has to still be here on the
 * next visit, and the one after that, until the run reaches a terminal state.
 */
export function readActiveBulkJob(slug: string): ActiveBulkJob | null {
  const store = draftStorage();
  if (!store) return null;
  try {
    return parseActiveBulkJob(store.getItem(activeBulkJobKey(slug)));
  } catch {
    return null;
  }
}

/**
 * Forgets the run.
 *
 * Called when the job reaches a terminal state — completed, failed or cancelled
 * — and when the status endpoint answers 404, which means the row is gone (a
 * pruned queue, or a job id from a database that has since been reset). A
 * reference to a job that no longer exists would otherwise put the form into a
 * permanent, unresumable "generating" state.
 */
export function clearActiveBulkJob(slug: string): void {
  const store = draftStorage();
  if (!store) return;
  try {
    store.removeItem(activeBulkJobKey(slug));
  } catch {
    // An unreachable store holds no reference to begin with.
  }
}
